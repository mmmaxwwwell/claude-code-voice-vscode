"""Unit tests for sidecar.errors — VoiceError hierarchy."""

import pytest

from sidecar.errors import (
    AudioError,
    DependencyError,
    TranscriptionError,
    VoiceError,
)


class TestVoiceError:
    def test_base_class_has_code_and_message(self):
        err = VoiceError(code="SOME_CODE", message="something went wrong")
        assert err.code == "SOME_CODE"
        assert err.message == "something went wrong"

    def test_is_exception(self):
        err = VoiceError(code="X", message="y")
        assert isinstance(err, Exception)

    def test_str_includes_code_and_message(self):
        err = VoiceError(code="FOO", message="bar")
        assert "FOO" in str(err)
        assert "bar" in str(err)


class TestAudioError:
    def test_is_voice_error(self):
        err = AudioError(code="MIC_NOT_FOUND", message="no mic")
        assert isinstance(err, VoiceError)

    def test_mic_not_found(self):
        err = AudioError(code="MIC_NOT_FOUND", message="No microphone detected")
        assert err.code == "MIC_NOT_FOUND"

    def test_mic_permission_denied(self):
        err = AudioError(code="MIC_PERMISSION_DENIED", message="Permission denied")
        assert err.code == "MIC_PERMISSION_DENIED"

    def test_audio_device_error(self):
        err = AudioError(code="AUDIO_DEVICE_ERROR", message="Device failed")
        assert err.code == "AUDIO_DEVICE_ERROR"


class TestTranscriptionError:
    def test_is_voice_error(self):
        err = TranscriptionError(code="MODEL_NOT_FOUND", message="missing")
        assert isinstance(err, VoiceError)

    def test_model_not_found(self):
        err = TranscriptionError(code="MODEL_NOT_FOUND", message="Model not found")
        assert err.code == "MODEL_NOT_FOUND"

    def test_model_load_failed(self):
        err = TranscriptionError(code="MODEL_LOAD_FAILED", message="Load failed")
        assert err.code == "MODEL_LOAD_FAILED"

    def test_transcription_failed(self):
        err = TranscriptionError(code="TRANSCRIPTION_FAILED", message="Failed")
        assert err.code == "TRANSCRIPTION_FAILED"


class TestDependencyError:
    def test_is_voice_error(self):
        err = DependencyError(code="DEPENDENCY_MISSING", message="missing dep")
        assert isinstance(err, VoiceError)

    def test_dependency_missing(self):
        err = DependencyError(code="DEPENDENCY_MISSING", message="faster-whisper not installed")
        assert err.code == "DEPENDENCY_MISSING"


class TestErrorCatchability:
    def test_catch_audio_error_as_voice_error(self):
        with pytest.raises(VoiceError) as exc_info:
            raise AudioError(code="MIC_NOT_FOUND", message="No mic")
        assert exc_info.value.code == "MIC_NOT_FOUND"

    def test_catch_transcription_error_as_voice_error(self):
        with pytest.raises(VoiceError):
            raise TranscriptionError(code="MODEL_NOT_FOUND", message="Missing")

    def test_catch_dependency_error_as_voice_error(self):
        with pytest.raises(VoiceError):
            raise DependencyError(code="DEPENDENCY_MISSING", message="Missing")
