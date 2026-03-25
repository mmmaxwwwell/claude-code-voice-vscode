"""Audio input stream — captures 16kHz mono int16 frames from microphone or file."""

from __future__ import annotations

import logging
import queue
from typing import Generator

from sidecar.errors import AudioError

logger = logging.getLogger(__name__)

SAMPLE_RATE = 16000
CHANNELS = 1
DTYPE = "int16"
FRAME_DURATION_MS = 30
FRAME_SAMPLES = SAMPLE_RATE * FRAME_DURATION_MS // 1000  # 480


def _import_numpy():
    """Lazy import of numpy to avoid loading C extensions at module level."""
    import numpy as np
    return np


def _import_sounddevice():
    """Lazy import of sounddevice to avoid loading libportaudio at module level."""
    import sounddevice as sd
    return sd


class AudioInputStream:
    """Yields 30ms audio frames from a microphone or file source.

    Args:
        device: Audio device name/index. Empty string or None = system default.
        file_source: Optional numpy int16 array to use instead of mic input.
    """

    def __init__(
        self,
        device: str | None = None,
        file_source: np.ndarray | None = None,
    ) -> None:
        self.device = device if device else None
        self.sample_rate = SAMPLE_RATE
        self.frame_duration_ms = FRAME_DURATION_MS
        self.frame_samples = FRAME_SAMPLES
        self._file_source = file_source
        self._queue: queue.Queue = queue.Queue()
        self._running = False

    def stop(self) -> None:
        """Signal the stream to stop."""
        self._running = False
        self._queue.put(None)

    def _audio_callback(
        self, indata: np.ndarray, frames: int, time_info: object, status: object
    ) -> None:
        """sounddevice callback — enqueue each frame."""
        self._queue.put(indata[:, 0].copy())

    def frames(self) -> Generator[np.ndarray, None, None]:
        """Yield 30ms int16 audio frames.

        When file_source is set, yields frames from the array.
        Otherwise opens the microphone via sounddevice.

        Raises:
            AudioError: On mic not found, permission denied, or device error.
        """
        if self._file_source is not None:
            yield from self._frames_from_file()
            return

        yield from self._frames_from_mic()

    def _frames_from_file(self) -> Generator:
        """Yield frames from the file source array."""
        np = _import_numpy()
        logger.debug("Streaming audio from file source (%d samples)", len(self._file_source))
        data = self._file_source
        assert data is not None
        offset = 0
        while offset < len(data):
            end = offset + self.frame_samples
            if end <= len(data):
                yield data[offset:end].copy()
            else:
                frame = np.zeros(self.frame_samples, dtype=np.int16)
                remaining = len(data) - offset
                frame[:remaining] = data[offset:]
                yield frame
            offset = end

    def _frames_from_mic(self) -> Generator[np.ndarray, None, None]:
        """Yield frames from the microphone."""
        sd = _import_sounddevice()
        self._running = True
        logger.info("Opening microphone: device=%s, rate=%d, frame=%d samples",
                     self.device, self.sample_rate, self.frame_samples)
        try:
            with sd.InputStream(
                samplerate=self.sample_rate,
                channels=CHANNELS,
                dtype=DTYPE,
                blocksize=self.frame_samples,
                device=self.device,
                callback=self._audio_callback,
            ):
                while self._running:
                    frame = self._queue.get()
                    if frame is None:
                        break
                    yield frame
        except sd.PortAudioError:
            raise AudioError("MIC_NOT_FOUND", "No audio input device found")
        except OSError as e:
            if "Permission denied" in str(e) or "Errno 13" in str(e):
                raise AudioError(
                    "MIC_PERMISSION_DENIED",
                    "Microphone access denied — check system permissions",
                )
            raise AudioError("AUDIO_DEVICE_ERROR", f"Audio device error: {e}")
        except Exception as e:
            raise AudioError("AUDIO_DEVICE_ERROR", f"Audio device error: {e}")
