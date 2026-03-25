"""Voice error hierarchy with machine-readable error codes."""


class VoiceError(Exception):
    """Base error for all voice-related failures."""

    exit_code: int = 1

    def __init__(self, code: str, message: str) -> None:
        self.code = code
        self.message = message
        super().__init__(f"[{code}] {message}")


class AudioError(VoiceError):
    """Audio capture and device errors.

    Codes: MIC_NOT_FOUND, MIC_PERMISSION_DENIED, AUDIO_DEVICE_ERROR
    """

    exit_code: int = 2


class TranscriptionError(VoiceError):
    """Speech-to-text errors.

    Codes: MODEL_NOT_FOUND, MODEL_LOAD_FAILED, TRANSCRIPTION_FAILED
    """

    exit_code: int = 3


class DependencyError(VoiceError):
    """Missing runtime dependency errors.

    Codes: DEPENDENCY_MISSING
    """

    exit_code: int = 4


class ConfigError(VoiceError):
    """Configuration validation errors.

    Codes: CONFIG_INVALID
    """

    exit_code: int = 5
