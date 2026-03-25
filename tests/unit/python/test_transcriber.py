"""Unit tests for sidecar.transcriber — faster-whisper STT wrapper."""

from __future__ import annotations

from pathlib import Path
from unittest.mock import MagicMock

import numpy as np
import pytest

from sidecar.errors import DependencyError, TranscriptionError


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _make_audio_buffer(duration_s: float = 1.0, sample_rate: int = 16000) -> np.ndarray:
    """Create a dummy int16 audio buffer."""
    n_samples = int(duration_s * sample_rate)
    return np.zeros(n_samples, dtype=np.int16)


def _make_mock_model(text: str = "hello world"):
    """Return a mock WhisperModel whose transcribe() returns *text*."""
    segment = MagicMock()
    segment.text = text

    model = MagicMock()
    model.transcribe.return_value = ([segment], MagicMock())
    return model


# ---------------------------------------------------------------------------
# Import / dependency guard
# ---------------------------------------------------------------------------

class TestDependencyGuard:
    """DependencyError raised when faster-whisper is not installed."""

    def test_missing_faster_whisper_raises(self, monkeypatch):
        """Attempting to create a Transcriber when faster-whisper is absent
        should raise DependencyError with DEPENDENCY_MISSING code."""
        from sidecar import transcriber as mod

        def _boom():
            raise ImportError("No module named 'faster_whisper'")

        monkeypatch.setattr(mod, "_import_faster_whisper", _boom)

        with pytest.raises(DependencyError, match="DEPENDENCY_MISSING"):
            mod.Transcriber(model_size="tiny")


# ---------------------------------------------------------------------------
# Model loading
# ---------------------------------------------------------------------------

class TestModelLoading:
    """TranscriptionError on model load failure."""

    def test_model_load_failure_raises_transcription_error(self):
        """If the model constructor throws, Transcriber wraps in TranscriptionError."""
        from sidecar import transcriber as mod

        def _bad_fw():
            m = MagicMock()
            m.WhisperModel.side_effect = RuntimeError("corrupt model")
            return m

        with pytest.raises(TranscriptionError, match="MODEL_LOAD_FAILED"):
            mod.Transcriber(model_size="tiny", _faster_whisper_fn=_bad_fw)

    def test_model_loads_with_correct_size_and_path(self):
        """Transcriber passes model_size and cache dir to WhisperModel."""
        from sidecar import transcriber as mod

        fake_fw = MagicMock()
        fake_model = MagicMock()
        fake_fw.WhisperModel.return_value = fake_model

        t = mod.Transcriber(
            model_size="small",
            _faster_whisper_fn=lambda: fake_fw,
        )

        fake_fw.WhisperModel.assert_called_once()
        args, kwargs = fake_fw.WhisperModel.call_args
        assert args[0] == "small"
        assert "download_root" in kwargs
        assert ".cache/claude-voice/models" in kwargs["download_root"]


# ---------------------------------------------------------------------------
# Transcription
# ---------------------------------------------------------------------------

class TestTranscription:
    """Transcribe audio buffer → text."""

    def _make_transcriber(self, text="hello world"):
        from sidecar import transcriber as mod

        mock_model = _make_mock_model(text)
        fake_fw = MagicMock()
        fake_fw.WhisperModel.return_value = mock_model

        t = mod.Transcriber(model_size="tiny", _faster_whisper_fn=lambda: fake_fw)
        return t, mock_model

    def test_transcribe_returns_text(self):
        t, _ = self._make_transcriber("refactor this function")
        result = t.transcribe(_make_audio_buffer())
        assert result == "refactor this function"

    def test_transcribe_joins_multiple_segments(self):
        from sidecar import transcriber as mod

        seg1 = MagicMock()
        seg1.text = "hello "
        seg2 = MagicMock()
        seg2.text = "world"

        mock_model = MagicMock()
        mock_model.transcribe.return_value = ([seg1, seg2], MagicMock())

        fake_fw = MagicMock()
        fake_fw.WhisperModel.return_value = mock_model

        t = mod.Transcriber(model_size="tiny", _faster_whisper_fn=lambda: fake_fw)
        assert t.transcribe(_make_audio_buffer()) == "hello world"

    def test_transcribe_empty_segments_returns_empty(self):
        from sidecar import transcriber as mod

        mock_model = MagicMock()
        mock_model.transcribe.return_value = ([], MagicMock())

        fake_fw = MagicMock()
        fake_fw.WhisperModel.return_value = mock_model

        t = mod.Transcriber(model_size="tiny", _faster_whisper_fn=lambda: fake_fw)
        assert t.transcribe(_make_audio_buffer()) == ""

    def test_transcribe_passes_float32_audio(self):
        """faster-whisper expects float32 normalized audio."""
        t, mock_model = self._make_transcriber()
        buf = _make_audio_buffer()
        t.transcribe(buf)

        call_args = mock_model.transcribe.call_args
        audio_arg = call_args[0][0]
        assert audio_arg.dtype == np.float32

    def test_transcribe_strips_whitespace(self):
        t, _ = self._make_transcriber("  hello world  ")
        result = t.transcribe(_make_audio_buffer())
        assert result == "hello world"

    def test_transcribe_failure_raises_transcription_error(self):
        t, mock_model = self._make_transcriber()
        mock_model.transcribe.side_effect = RuntimeError("decode failed")

        with pytest.raises(TranscriptionError, match="TRANSCRIPTION_FAILED"):
            t.transcribe(_make_audio_buffer())


# ---------------------------------------------------------------------------
# Audio fixture fuzzy match (integration-lite)
# ---------------------------------------------------------------------------

class TestWithAudioFixture:
    """Test with real audio fixture — uses mock model but verifies data flow."""

    FIXTURE_DIR = Path(__file__).parent.parent.parent / "fixtures" / "audio"

    def test_fixture_audio_flows_through(self):
        """Load a WAV fixture and verify it reaches the model's transcribe()."""
        import wave

        from sidecar import transcriber as mod

        fixture = self.FIXTURE_DIR / "command-only.wav"
        if not fixture.exists():
            pytest.skip("Audio fixture not available")

        with wave.open(str(fixture), "rb") as wf:
            raw = wf.readframes(wf.getnframes())
            audio = np.frombuffer(raw, dtype=np.int16)

        mock_model = _make_mock_model("refactor this function send it")
        fake_fw = MagicMock()
        fake_fw.WhisperModel.return_value = mock_model

        t = mod.Transcriber(model_size="tiny", _faster_whisper_fn=lambda: fake_fw)
        result = t.transcribe(audio)

        assert result == "refactor this function send it"
        # Verify transcribe was called with float32 audio of correct length
        call_args = mock_model.transcribe.call_args
        passed_audio = call_args[0][0]
        assert passed_audio.dtype == np.float32
        assert len(passed_audio) == len(audio)
