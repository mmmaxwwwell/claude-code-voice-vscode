"""Wake word detection via openWakeWord (TFLite)."""

from __future__ import annotations

import logging
from dataclasses import dataclass

import numpy as np

from sidecar.audio import FRAME_SAMPLES

logger = logging.getLogger(__name__)

# openWakeWord expects 1280-sample chunks at 16kHz
WAKEWORD_FRAME_SAMPLES = 1280
DEFAULT_THRESHOLD = 0.5


def _import_openwakeword():
    """Lazy import of openwakeword to avoid loading TFLite at module level."""
    import openwakeword
    return openwakeword


@dataclass
class WakeWordDetected:
    """Emitted when the wake word is detected."""
    model_name: str
    frame_index: int  # 1-indexed oww predict call that triggered detection


class WakeWordDetector:
    """Detect a wake word in audio frames using openWakeWord.

    Args:
        model_path: Path to a .tflite or .onnx wake word model file.
            If None, uses openWakeWord's built-in model matching model_name.
        model_name: Name of the wake word model (e.g. "hey_claude").
            Used as the key in openWakeWord's prediction dict.
        threshold: Detection threshold (0.0–1.0). Default 0.5.
        _oww_model: Injected openWakeWord model instance (for testing).
    """

    def __init__(
        self,
        model_path: str | None = None,
        model_name: str = "hey_claude",
        threshold: float = DEFAULT_THRESHOLD,
        *,
        _oww_model=None,
    ) -> None:
        self.model_name = model_name
        self.threshold = threshold

        if _oww_model is not None:
            self._model = _oww_model
        else:
            oww = _import_openwakeword()
            if model_path:
                self._model = oww.Model(wakeword_models=[model_path])
            else:
                self._model = oww.Model()
            logger.info("Wake word model loaded: name=%s, threshold=%.2f", model_name, threshold)

        # Accumulation buffer for resampling 480-sample frames → 1280-sample chunks
        self._buffer = np.array([], dtype=np.int16)
        self._predict_call_count = 0
        self._last_detection_frame_index: int | None = None

    def reset(self) -> None:
        """Reset detector state for a new utterance."""
        self._buffer = np.array([], dtype=np.int16)
        self._predict_call_count = 0
        self._last_detection_frame_index = None
        self._model.reset()

    def process_frame(self, frame: np.ndarray) -> list[WakeWordDetected]:
        """Process a 30ms audio frame (480 samples at 16kHz).

        Accumulates frames until we have >= 1280 samples, then feeds
        to openWakeWord for prediction.

        Returns:
            List of WakeWordDetected events (usually 0 or 1).
        """
        events: list[WakeWordDetected] = []

        self._buffer = np.concatenate([self._buffer, frame])

        while len(self._buffer) >= WAKEWORD_FRAME_SAMPLES:
            chunk = self._buffer[:WAKEWORD_FRAME_SAMPLES]
            self._buffer = self._buffer[WAKEWORD_FRAME_SAMPLES:]

            self._predict_call_count += 1
            predictions = self._model.predict(chunk)

            score = predictions.get(self.model_name, 0.0)
            if score >= self.threshold:
                logger.info("Wake word detected: model=%s, score=%.3f, frame=%d",
                           self.model_name, score, self._predict_call_count)
                self._last_detection_frame_index = self._predict_call_count
                events.append(
                    WakeWordDetected(
                        model_name=self.model_name,
                        frame_index=self._predict_call_count,
                    )
                )

        return events

    def strip_wakeword_audio(self, frames: list[np.ndarray]) -> list[np.ndarray]:
        """Strip wake word audio from a list of captured frames.

        Removes all frames up to and including the frame where the wake word
        was detected. If no detection occurred, returns all frames unchanged.

        The detection frame index maps from oww predict calls (1280-sample chunks)
        back to input frames (480-sample each) by computing how many input frames
        were consumed up to the detection point.

        Args:
            frames: List of audio frames (typically 480 samples each).

        Returns:
            Frames remaining after stripping the wake word portion.
        """
        if self._last_detection_frame_index is None:
            return frames

        # Each oww predict call consumes WAKEWORD_FRAME_SAMPLES samples.
        # Calculate how many input frames were consumed up to detection.
        samples_consumed = self._last_detection_frame_index * WAKEWORD_FRAME_SAMPLES
        frames_consumed = 0
        total_samples = 0
        for i, f in enumerate(frames):
            total_samples += len(f)
            frames_consumed = i + 1
            if total_samples >= samples_consumed:
                break

        return frames[frames_consumed:]
