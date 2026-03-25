"""Unit tests for sidecar.errors — VoiceError hierarchy."""

import pytest

from sidecar.errors import (
    AudioError,
    ConfigError,
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

    def test_catch_config_error_as_voice_error(self):
        with pytest.raises(VoiceError):
            raise ConfigError(code="CONFIG_INVALID", message="bad config")


class TestExitCodes:
    def test_voice_error_default_exit_code(self):
        err = VoiceError(code="UNKNOWN", message="unknown")
        assert err.exit_code == 1

    def test_audio_error_exit_code(self):
        err = AudioError(code="MIC_NOT_FOUND", message="no mic")
        assert err.exit_code == 2

    def test_transcription_error_exit_code(self):
        err = TranscriptionError(code="MODEL_NOT_FOUND", message="missing")
        assert err.exit_code == 3

    def test_dependency_error_exit_code(self):
        err = DependencyError(code="DEPENDENCY_MISSING", message="missing dep")
        assert err.exit_code == 4

    def test_config_error_exit_code(self):
        err = ConfigError(code="CONFIG_INVALID", message="bad config")
        assert err.exit_code == 5

    def test_exit_code_is_class_attribute(self):
        assert VoiceError.exit_code == 1
        assert AudioError.exit_code == 2
        assert TranscriptionError.exit_code == 3
        assert DependencyError.exit_code == 4
        assert ConfigError.exit_code == 5


class TestConfigError:
    def test_is_voice_error(self):
        err = ConfigError(code="CONFIG_INVALID", message="invalid config")
        assert isinstance(err, VoiceError)

    def test_config_invalid_code(self):
        err = ConfigError(code="CONFIG_INVALID", message="bad")
        assert err.code == "CONFIG_INVALID"

    def test_str_includes_code_and_message(self):
        err = ConfigError(code="CONFIG_INVALID", message="missing field")
        assert "CONFIG_INVALID" in str(err)
        assert "missing field" in str(err)
