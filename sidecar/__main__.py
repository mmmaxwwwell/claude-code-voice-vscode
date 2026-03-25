"""Sidecar entry point: parse args, start socket server, wire pipeline events.

Usage::

    python -m sidecar --socket /path/to/socket.sock
    python -m sidecar --socket /path/to/socket.sock --check
"""

from __future__ import annotations

import argparse
import asyncio
import logging
import os
import signal
import sys
import traceback

import numpy as np

from sidecar.audio import AudioInputStream
from sidecar.config_validator import validate_config
from sidecar.errors import VoiceError
from sidecar.logger import configure_logging
from sidecar.pipeline import Pipeline, StatusEvent, TranscriptEvent
from sidecar.protocol import (
    ConfigMessage,
    ControlMessage,
    ErrorMessage,
    StatusMessage,
    TranscriptMessage,
)
from sidecar.server import SocketServer
from sidecar.shutdown import ShutdownRegistry

logger = logging.getLogger("sidecar")


def _load_wav_file(path: str) -> np.ndarray:
    """Load a 16kHz mono WAV file as int16 numpy array."""
    import wave

    with wave.open(path, "rb") as wf:
        if wf.getframerate() != 16000:
            raise ValueError(f"Expected 16kHz WAV, got {wf.getframerate()}Hz")
        if wf.getnchannels() != 1:
            raise ValueError(f"Expected mono WAV, got {wf.getnchannels()} channels")
        if wf.getsampwidth() != 2:
            raise ValueError(f"Expected 16-bit WAV, got {wf.getsampwidth() * 8}-bit")
        raw = wf.readframes(wf.getnframes())
    return np.frombuffer(raw, dtype=np.int16)


def _unhandled_exception_handler(
    exc_type: type[BaseException],
    exc_value: BaseException,
    exc_tb: object,
) -> None:
    """Global unhandled exception handler — log FATAL and exit."""
    tb_str = "".join(traceback.format_exception(exc_type, exc_value, exc_tb))
    logging.getLogger("sidecar").fatal(
        "Unhandled exception: %s\n%s", exc_value, tb_str
    )
    sys.exit(1)


def _check_audio_device() -> None:
    """Verify that an audio input device is available.

    Raises AudioError if no device found.
    """
    from sidecar.audio import _import_sounddevice

    sd = _import_sounddevice()
    # Query default input device — raises if none available
    try:
        sd.query_devices(kind="input")
    except Exception as exc:
        from sidecar.errors import AudioError

        raise AudioError(
            "MIC_NOT_FOUND",
            f"No audio input device found: {exc}",
        ) from exc


def _check_dependencies() -> None:
    """Verify that required Python dependencies can be imported.

    Raises DependencyError if any are missing.
    """
    from sidecar.errors import DependencyError

    deps = ["faster_whisper", "webrtcvad", "openwakeword", "numpy"]
    for dep in deps:
        try:
            __import__(dep)
        except ImportError as exc:
            raise DependencyError(
                "DEPENDENCY_MISSING",
                f"Required dependency '{dep}' is not installed: {exc}",
            ) from exc


def _check_model_files() -> None:
    """Verify that the default model directory exists.

    Does NOT load the full whisper model into memory.
    Raises TranscriptionError if models dir is missing.
    """
    from sidecar.transcriber import MODELS_DIR

    if not MODELS_DIR.exists():
        logger.info("Models directory does not exist yet: %s (will be created on first use)", MODELS_DIR)


def _run_check() -> int:
    """Run all --check validations. Returns 0 on success, error exit_code on failure."""
    checks = [
        ("audio_device", _check_audio_device),
        ("dependencies", _check_dependencies),
        ("model_files", _check_model_files),
    ]

    for name, check_fn in checks:
        try:
            check_fn()
            logger.info("Check passed: %s", name)
        except VoiceError as exc:
            logger.error("Check failed: %s — [%s] %s", name, exc.code, exc.message)
            return exc.exit_code

    logger.info("All checks passed")
    return 0


class SidecarApp:
    """Main application: ties socket server, pipeline, and audio together."""

    def __init__(self, socket_path: str, *, audio_file: str | None = None) -> None:
        self._socket_path = socket_path
        self._audio_file = audio_file
        self._server = SocketServer(socket_path)
        self._pipeline: Pipeline | None = None
        self._config: ConfigMessage | None = None
        self._audio: AudioInputStream | None = None
        self._listen_task: asyncio.Task | None = None
        self._shutdown_event = asyncio.Event()
        self._shutdown_registry = ShutdownRegistry()

        # Register cleanup hooks (executed in reverse order during shutdown)
        self._shutdown_registry.register_hook(
            "log_flush", self._flush_logs
        )
        self._shutdown_registry.register_hook(
            "socket_cleanup", self._cleanup_socket_file
        )
        self._shutdown_registry.register_hook(
            "server_stop", self._server.stop
        )

        # Wire server callbacks
        self._server.on_config = self._handle_config
        self._server.on_control = self._handle_control
        self._server.on_disconnect = self._handle_disconnect

    def _flush_logs(self) -> None:
        """Flush all log handlers."""
        for handler in logging.getLogger().handlers:
            handler.flush()

    def _cleanup_socket_file(self) -> None:
        """Remove the socket file if it exists."""
        if os.path.exists(self._socket_path):
            os.unlink(self._socket_path)

    async def run(self) -> None:
        """Run the sidecar until shutdown is signaled."""
        loop = asyncio.get_running_loop()
        for sig in (signal.SIGTERM, signal.SIGINT):
            loop.add_signal_handler(sig, self._request_shutdown)

        # Register asyncio exception handler
        loop.set_exception_handler(self._asyncio_exception_handler)

        try:
            async with self._server:
                logger.info("Sidecar started, waiting for client connection")
                await self._shutdown_event.wait()
        finally:
            await self._shutdown_registry.shutdown()

        logger.info("Sidecar shut down")

    def _asyncio_exception_handler(
        self, loop: asyncio.AbstractEventLoop, context: dict
    ) -> None:
        """Handle uncaught asyncio exceptions."""
        exc = context.get("exception")
        msg = context.get("message", "Unhandled asyncio exception")
        if exc:
            logger.fatal("%s: %s", msg, exc, exc_info=exc)
        else:
            logger.fatal("%s", msg)
        self._request_shutdown()

    def _request_shutdown(self) -> None:
        """Handle SIGTERM/SIGINT by signaling shutdown."""
        logger.info("Shutdown signal received")
        self._stop_listening()
        self._shutdown_event.set()

    async def _handle_config(self, msg: ConfigMessage) -> None:
        """Handle a config message from the extension.

        Validates the config before applying it. If validation fails, sends
        an ErrorMessage with CONFIG_INVALID code. If a prior valid config
        exists, keeps using it; otherwise the sidecar stays running but
        refuses to start listening until a valid config arrives.
        """
        logger.info("Config received: mode=%s, model=%s", msg.inputMode, msg.whisperModel)

        errors = validate_config(msg)
        if errors:
            error_detail = "; ".join(errors)
            logger.warning("Config validation failed: %s", error_detail)
            await self._server.send(
                ErrorMessage(
                    code="CONFIG_INVALID",
                    message=f"Invalid config: {error_detail}",
                )
            )
            return

        self._config = msg
        # Rebuild pipeline with new config
        self._pipeline = Pipeline(self._config)

    async def _handle_control(self, msg: ControlMessage) -> None:
        """Handle a control message from the extension."""
        logger.info("Control: %s", msg.action)

        if msg.action == "start":
            await self._start_listening()
        elif msg.action == "stop":
            self._stop_listening()
            await self._server.send(StatusMessage(state="ready"))
        elif msg.action == "ptt_start":
            if self._pipeline:
                events = self._pipeline.ptt_start()
                await self._emit_events(events)
        elif msg.action == "ptt_stop":
            if self._pipeline:
                events = self._pipeline.ptt_stop()
                await self._emit_events(events)

    async def _handle_disconnect(self) -> None:
        """Handle client disconnection."""
        logger.info("Client disconnected, stopping listening")
        self._stop_listening()

    async def _start_listening(self) -> None:
        """Start the audio capture and pipeline processing loop."""
        if self._config is None:
            await self._server.send(
                ErrorMessage(
                    code="PROTOCOL_ERROR",
                    message="Config must be sent before starting.",
                )
            )
            return

        if self._listen_task and not self._listen_task.done():
            logger.warning("Already listening, ignoring start")
            return

        # Rebuild pipeline if needed
        if self._pipeline is None:
            self._pipeline = Pipeline(self._config)

        file_source = None
        if self._audio_file:
            file_source = _load_wav_file(self._audio_file)
        self._audio = AudioInputStream(
            device=self._config.micDevice or None,
            file_source=file_source,
        )

        # Register dynamic cleanup hooks for active listening components
        self._shutdown_registry.register_hook(
            "audio_stream_stop", lambda: self._audio.stop() if self._audio else None
        )
        self._shutdown_registry.register_hook(
            "pipeline_teardown", lambda: None  # pipeline is stateless after stop
        )

        self._listen_task = asyncio.get_running_loop().create_task(
            self._listen_loop()
        )
        await self._server.send(StatusMessage(state="listening"))

    def _stop_listening(self) -> None:
        """Stop the audio capture loop."""
        if self._audio:
            self._audio.stop()
        if self._listen_task and not self._listen_task.done():
            self._listen_task.cancel()
        self._listen_task = None
        self._audio = None

    async def _listen_loop(self) -> None:
        """Run audio capture in a thread and feed frames to the pipeline."""
        assert self._audio is not None
        assert self._pipeline is not None

        try:
            # Run the blocking audio generator in a thread
            loop = asyncio.get_running_loop()
            frame_queue: asyncio.Queue = asyncio.Queue()

            def _capture() -> None:
                try:
                    for frame in self._audio.frames():
                        loop.call_soon_threadsafe(frame_queue.put_nowait, frame)
                except VoiceError as e:
                    loop.call_soon_threadsafe(
                        frame_queue.put_nowait, e
                    )
                finally:
                    loop.call_soon_threadsafe(frame_queue.put_nowait, None)

            capture_future = loop.run_in_executor(None, _capture)

            while True:
                item = await frame_queue.get()
                if item is None:
                    break
                if isinstance(item, VoiceError):
                    await self._server.send(
                        ErrorMessage(code=item.code, message=item.message)
                    )
                    break

                events = self._pipeline.process_frame(item)
                await self._emit_events(events)

            await capture_future

        except asyncio.CancelledError:
            logger.debug("Listen loop cancelled")
        except Exception:
            logger.exception("Unexpected error in listen loop")

    async def _emit_events(self, events: list) -> None:
        """Convert pipeline events to protocol messages and send."""
        for event in events:
            if isinstance(event, StatusEvent):
                await self._server.send(StatusMessage(state=event.state))
            elif isinstance(event, TranscriptEvent):
                await self._server.send(
                    TranscriptMessage(text=event.text, action=event.action)
                )


def main() -> None:
    """Parse args, configure logging, run the sidecar."""
    parser = argparse.ArgumentParser(
        prog="sidecar",
        description="Claude Voice sidecar process",
    )
    parser.add_argument(
        "--socket",
        required=True,
        help="Path to the Unix domain socket",
    )
    parser.add_argument(
        "--check",
        action="store_true",
        help="Check dependencies and audio device, then exit",
    )
    parser.add_argument(
        "--audio-file",
        default=None,
        help="Path to a 16kHz mono WAV file to use instead of microphone input (for testing)",
    )
    args = parser.parse_args()

    # Configure structured JSON logging
    configure_logging()

    # Install global exception handler
    sys.excepthook = _unhandled_exception_handler

    if args.check:
        exit_code = _run_check()
        sys.exit(exit_code)

    app = SidecarApp(args.socket, audio_file=args.audio_file)
    asyncio.run(app.run())


if __name__ == "__main__":
    main()
