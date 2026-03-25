"""Speech-to-text transcription via faster-whisper."""

from __future__ import annotations

import logging
from pathlib import Path

import numpy as np

from sidecar.errors import DependencyError, TranscriptionError

logger = logging.getLogger(__name__)

DEFAULT_MODEL_SIZE = "base"
MODELS_DIR = Path.home() / ".cache" / "claude-voice" / "models"


def _import_faster_whisper():
    """Lazy import of faster-whisper to avoid loading at module level."""
    try:
        import faster_whisper
    except ImportError:
        raise DependencyError(
            "DEPENDENCY_MISSING",
            "faster-whisper is not installed. Install with: pip install faster-whisper",
        )
    return faster_whisper


class Transcriber:
    """Load a faster-whisper model and transcribe audio buffers to text.

    Args:
        model_size: Whisper model size — tiny, base, small, or medium.
        models_dir: Directory for cached models. Defaults to ~/.cache/claude-voice/models/.
        _faster_whisper_fn: Injected import function (for testing).
    """

    def __init__(
        self,
        model_size: str = DEFAULT_MODEL_SIZE,
        models_dir: str | Path | None = None,
        *,
        _faster_whisper_fn=None,
    ) -> None:
        self.model_size = model_size
        self.models_dir = str(models_dir or MODELS_DIR)

        import_fn = _faster_whisper_fn or _import_faster_whisper
        try:
            fw = import_fn()
        except DependencyError:
            raise
        except ImportError as exc:
            raise DependencyError(
                "DEPENDENCY_MISSING",
                f"faster-whisper is not installed: {exc}",
            ) from exc

        try:
            self._model = fw.WhisperModel(
                model_size,
                download_root=self.models_dir,
            )
            logger.info("Whisper model loaded: size=%s, dir=%s", model_size, self.models_dir)
        except Exception as exc:
            raise TranscriptionError(
                "MODEL_LOAD_FAILED",
                f"Failed to load whisper model '{model_size}': {exc}",
            ) from exc

    def transcribe(self, audio: np.ndarray) -> str:
        """Transcribe an int16 audio buffer to text.

        Args:
            audio: 16kHz mono int16 numpy array.

        Returns:
            Transcribed text (stripped of leading/trailing whitespace).
        """
        # faster-whisper expects float32 normalized to [-1, 1]
        audio_f32 = audio.astype(np.float32) / 32768.0

        try:
            segments, _ = self._model.transcribe(audio_f32)
            text = "".join(seg.text for seg in segments)
        except Exception as exc:
            raise TranscriptionError(
                "TRANSCRIPTION_FAILED",
                f"Transcription failed: {exc}",
            ) from exc

        return text.strip()
