"""Sidecar entry point: parse args, start socket server, wire pipeline events.

Usage::

    python -m sidecar --socket /path/to/socket.sock
"""

from __future__ import annotations

import argparse
import asyncio
import logging
import signal
import sys

from sidecar.audio import AudioInputStream
from sidecar.errors import VoiceError
from sidecar.pipeline import Pipeline, StatusEvent, TranscriptEvent
from sidecar.protocol import (
    ConfigMessage,
    ControlMessage,
    ErrorMessage,
    StatusMessage,
    TranscriptMessage,
)
from sidecar.server import SocketServer

logger = logging.getLogger("sidecar")


class SidecarApp:
    """Main application: ties socket server, pipeline, and audio together."""

    def __init__(self, socket_path: str) -> None:
        self._socket_path = socket_path
        self._server = SocketServer(socket_path)
        self._pipeline: Pipeline | None = None
        self._config: ConfigMessage | None = None
        self._audio: AudioInputStream | None = None
        self._listen_task: asyncio.Task | None = None
        self._shutdown_event = asyncio.Event()

        # Wire server callbacks
        self._server.on_config = self._handle_config
        self._server.on_control = self._handle_control
        self._server.on_disconnect = self._handle_disconnect

    async def run(self) -> None:
        """Run the sidecar until shutdown is signaled."""
        loop = asyncio.get_running_loop()
        for sig in (signal.SIGTERM, signal.SIGINT):
            loop.add_signal_handler(sig, self._request_shutdown)

        async with self._server:
            logger.info("Sidecar started, waiting for client connection")
            await self._shutdown_event.wait()

        logger.info("Sidecar shut down")

    def _request_shutdown(self) -> None:
        """Handle SIGTERM/SIGINT by signaling shutdown."""
        logger.info("Shutdown signal received")
        self._stop_listening()
        self._shutdown_event.set()

    async def _handle_config(self, msg: ConfigMessage) -> None:
        """Handle a config message from the extension."""
        logger.info("Config received: mode=%s, model=%s", msg.inputMode, msg.whisperModel)
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

        self._audio = AudioInputStream(device=self._config.micDevice or None)
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
    args = parser.parse_args()

    # Configure logging to stderr at INFO level
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
        stream=sys.stderr,
    )

    app = SidecarApp(args.socket)
    asyncio.run(app.run())


if __name__ == "__main__":
    main()
