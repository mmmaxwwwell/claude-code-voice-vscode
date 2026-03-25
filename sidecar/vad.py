"""Two-stage Voice Activity Detection: WebRTC VAD (gate) → Silero VAD (confirm)."""

from __future__ import annotations

import logging
from collections import deque
from dataclasses import dataclass

from sidecar.audio import FRAME_SAMPLES, SAMPLE_RATE, FRAME_DURATION_MS

logger = logging.getLogger(__name__)

DEFAULT_SILENCE_TIMEOUT_MS = 1500
RING_BUFFER_FRAMES = 10  # ~300ms at 30ms per frame
SILERO_THRESHOLD = 0.5


@dataclass
class SpeechStart:
    """Emitted when speech is detected. Contains pre-speech ring buffer audio."""
    buffered_audio: list[np.ndarray]


@dataclass
class SpeechEnd:
    """Emitted when speech ends after silence timeout. Contains all captured audio."""
    audio: list[np.ndarray]


def _import_webrtcvad():
    """Lazy import of webrtcvad to allow mocking in tests."""
    import webrtcvad
    return webrtcvad


def _import_numpy():
    """Lazy import of numpy to avoid loading C extensions at module level."""
    import numpy as np
    return np


def _load_silero_model():
    """Load Silero VAD ONNX model.

    Returns a callable that takes a float32 audio frame and returns speech probability.
    """
    import onnxruntime as ort
    import os
    np = _import_numpy()

    # Try to find the silero_vad ONNX model
    model_path = None
    try:
        import silero_vad
        if hasattr(silero_vad, "model_dir"):
            candidate = os.path.join(silero_vad.model_dir(), "silero_vad.onnx")
            if os.path.exists(candidate):
                model_path = candidate
    except ImportError:
        pass

    if model_path is None:
        candidates = [
            os.path.expanduser("~/.cache/claude-voice/models/silero_vad.onnx"),
            os.path.join(os.path.dirname(__file__), "..", "models", "silero_vad.onnx"),
        ]
        for c in candidates:
            if os.path.exists(c):
                model_path = c
                break

    if model_path is None:
        raise FileNotFoundError("Silero VAD ONNX model not found")

    session = ort.InferenceSession(model_path)

    h = np.zeros((2, 1, 64), dtype=np.float32)
    c = np.zeros((2, 1, 64), dtype=np.float32)
    sr = np.array([16000], dtype=np.int64)

    def predict(frame_float: np.ndarray) -> float:
        nonlocal h, c
        input_data = frame_float.reshape(1, -1).astype(np.float32)
        ort_inputs = {
            "input": input_data,
            "h": h,
            "c": c,
            "sr": sr,
        }
        ort_outs = session.run(None, ort_inputs)
        prob = ort_outs[0].item()
        h = ort_outs[1]
        c = ort_outs[2]
        return prob

    return predict


class VoiceActivityDetector:
    """Two-stage VAD: WebRTC (fast reject) → Silero ONNX (confirm speech).

    Args:
        silence_timeout_ms: How long silence must persist after speech to emit SpeechEnd.
        ring_buffer_frames: Number of pre-speech frames to buffer (~300ms at 10 frames).
        _webrtcvad_mod: Injected webrtcvad module (for testing). If None, lazy-imports.
        _silero_fn: Injected Silero predict function (for testing). If None, loads model.
    """

    def __init__(
        self,
        silence_timeout_ms: int = DEFAULT_SILENCE_TIMEOUT_MS,
        ring_buffer_frames: int = RING_BUFFER_FRAMES,
        *,
        _webrtcvad_mod=None,
        _silero_fn=None,
    ) -> None:
        self.silence_timeout_ms = silence_timeout_ms
        self._ring_buffer_frames = ring_buffer_frames

        # Stage 1: WebRTC VAD in aggressive mode
        wvad = _webrtcvad_mod or _import_webrtcvad()
        self._webrtc_vad = wvad.Vad(3)

        # Stage 2: Silero VAD via ONNX
        self._silero = _silero_fn or _load_silero_model()

        logger.info("VAD initialized: silence_timeout=%dms, ring_buffer=%d frames",
                    silence_timeout_ms, ring_buffer_frames)

        # State
        self._ring_buffer: deque[np.ndarray] = deque(maxlen=ring_buffer_frames)
        self._in_speech = False
        self._speech_frames: list[np.ndarray] = []
        self._silence_frame_count = 0
        self._silence_frames_for_timeout = silence_timeout_ms // FRAME_DURATION_MS

    def reset(self) -> None:
        """Reset VAD state for a new utterance."""
        self._ring_buffer.clear()
        self._in_speech = False
        self._speech_frames = []
        self._silence_frame_count = 0

    def process_frame(self, frame: np.ndarray) -> list[SpeechStart | SpeechEnd]:
        """Process a single 30ms audio frame. Returns any events triggered.

        Args:
            frame: int16 numpy array of FRAME_SAMPLES (480) samples.

        Returns:
            List of SpeechStart/SpeechEnd events (usually 0 or 1).
        """
        events: list[SpeechStart | SpeechEnd] = []

        # Stage 1: WebRTC VAD — fast rejection of silence
        raw_bytes = frame.tobytes()
        is_speech_webrtc = self._webrtc_vad.is_speech(raw_bytes, SAMPLE_RATE)

        if not is_speech_webrtc:
            if self._in_speech:
                self._silence_frame_count += 1
                self._speech_frames.append(frame.copy())
                if self._silence_frame_count >= self._silence_frames_for_timeout:
                    logger.debug("VAD: speech ended after silence timeout (%d frames)",
                                len(self._speech_frames))
                    events.append(SpeechEnd(audio=self._speech_frames))
                    self._in_speech = False
                    self._speech_frames = []
                    self._silence_frame_count = 0
            else:
                self._ring_buffer.append(frame.copy())
            return events

        # Stage 2: Silero VAD — confirm speech
        frame_float = frame.astype(_import_numpy().float32) / 32768.0
        speech_prob = self._silero(frame_float)

        if speech_prob < SILERO_THRESHOLD:
            if self._in_speech:
                self._silence_frame_count += 1
                self._speech_frames.append(frame.copy())
                if self._silence_frame_count >= self._silence_frames_for_timeout:
                    logger.debug("VAD: speech ended after silence timeout (%d frames)",
                                len(self._speech_frames))
                    events.append(SpeechEnd(audio=self._speech_frames))
                    self._in_speech = False
                    self._speech_frames = []
                    self._silence_frame_count = 0
            else:
                self._ring_buffer.append(frame.copy())
            return events

        # Both stages confirm speech
        self._silence_frame_count = 0

        if not self._in_speech:
            self._in_speech = True
            buffered = list(self._ring_buffer)
            self._speech_frames = buffered + [frame.copy()]
            logger.debug("VAD: speech started (buffered %d pre-speech frames)", len(buffered))
            events.append(SpeechStart(buffered_audio=buffered))
        else:
            self._speech_frames.append(frame.copy())

        return events
