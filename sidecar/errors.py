"""Voice error hierarchy with machine-readable error codes."""


class VoiceError(Exception):
    """Base error for all voice-related failures."""

    def __init__(self, code: str, message: str) -> None:
        self.code = code
        self.message = message
        super().__init__(f"[{code}] {message}")


class AudioError(VoiceError):
    """Audio capture and device errors.

    Codes: MIC_NOT_FOUND, MIC_PERMISSION_DENIED, AUDIO_DEVICE_ERROR
    """


class TranscriptionError(VoiceError):
    """Speech-to-text errors.

    Codes: MODEL_NOT_FOUND, MODEL_LOAD_FAILED, TRANSCRIPTION_FAILED
    """


class DependencyError(VoiceError):
    """Missing runtime dependency errors.

    Codes: DEPENDENCY_MISSING
    """
