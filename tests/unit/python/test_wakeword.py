"""Unit tests for sidecar.wakeword — openWakeWord wake word detection."""

from unittest.mock import MagicMock, patch
import numpy as np
import os
import pytest
import wave

from sidecar.audio import FRAME_SAMPLES, SAMPLE_RATE
from sidecar.wakeword import (
    WakeWordDetector,
    WakeWordDetected,
    WAKEWORD_FRAME_SAMPLES,
)


def _make_silence_frame(n_samples=FRAME_SAMPLES):
    """Return a frame of silence (all zeros)."""
    return np.zeros(n_samples, dtype=np.int16)


def _make_speech_frame(n_samples=FRAME_SAMPLES, amplitude=5000):
    """Return a frame with a tone."""
    t = np.arange(n_samples, dtype=np.float64) / SAMPLE_RATE
    tone = (amplitude * np.sin(2 * np.pi * 440 * t)).astype(np.int16)
    return tone


def _make_mock_oww(detect_on_call=None):
    """Create a mock openWakeWord model.

    Args:
        detect_on_call: If set, the Nth call to predict() will return a detection.
                        If None, no detections ever.

    Returns:
        mock_model instance with predict() method.
    """
    mock_model = MagicMock()
    call_count = [0]

    def mock_predict(audio):
        call_count[0] += 1
        if detect_on_call is not None and call_count[0] == detect_on_call:
            return {"hey_claude": 0.9}
        return {"hey_claude": 0.0}

    mock_model.predict.side_effect = mock_predict
    mock_model.reset.return_value = None
    return mock_model


def _make_detector(mock_model=None, model_name="hey_claude", threshold=0.5):
    """Create a WakeWordDetector with a mocked model."""
    if mock_model is None:
        mock_model = _make_mock_oww()
    return WakeWordDetector(
        model_name=model_name,
        threshold=threshold,
        _oww_model=mock_model,
    )


class TestWakeWordDetectorInit:
    """Verify detector construction and configuration."""

    def test_configurable_model_name(self):
        detector = _make_detector(model_name="custom_wake_word")
        assert detector.model_name == "custom_wake_word"

    def test_configurable_threshold(self):
        detector = _make_detector(threshold=0.7)
        assert detector.threshold == 0.7

    def test_default_threshold_is_0_5(self):
        detector = _make_detector()
        assert detector.threshold == 0.5


class TestWakeWordDetectorNoDetection:
    """When no wake word is present, no detection events should be emitted."""

    def test_silence_produces_no_detection(self):
        detector = _make_detector()
        events = []
        for _ in range(50):
            events.extend(detector.process_frame(_make_silence_frame()))
        assert len(events) == 0

    def test_speech_without_wakeword_no_detection(self):
        mock_model = _make_mock_oww(detect_on_call=None)
        detector = _make_detector(mock_model=mock_model)
        events = []
        for _ in range(50):
            events.extend(detector.process_frame(_make_speech_frame()))
        assert len(events) == 0


class TestWakeWordDetection:
    """When wake word is present, a detection event should be emitted."""

    def test_detection_emits_event(self):
        # 10 input frames (480 each) = 4800 samples → 3 oww calls (1280 each)
        # Detect on 2nd oww call
        mock_model = _make_mock_oww(detect_on_call=2)
        detector = _make_detector(mock_model=mock_model)
        events = []
        for _ in range(10):
            events.extend(detector.process_frame(_make_speech_frame()))
        detections = [e for e in events if isinstance(e, WakeWordDetected)]
        assert len(detections) == 1

    def test_detection_event_has_model_name(self):
        # Detect on 1st oww call (fires after 3 input frames)
        mock_model = _make_mock_oww(detect_on_call=1)
        detector = _make_detector(mock_model=mock_model, model_name="hey_claude")
        events = []
        for _ in range(10):
            events.extend(detector.process_frame(_make_speech_frame()))
        detections = [e for e in events if isinstance(e, WakeWordDetected)]
        assert len(detections) == 1
        assert detections[0].model_name == "hey_claude"

    def test_detection_includes_frame_index(self):
        # Detect on 2nd oww call
        mock_model = _make_mock_oww(detect_on_call=2)
        detector = _make_detector(mock_model=mock_model)
        events = []
        for _ in range(10):
            events.extend(detector.process_frame(_make_speech_frame()))
        detections = [e for e in events if isinstance(e, WakeWordDetected)]
        assert len(detections) >= 1
        assert detections[0].frame_index == 2  # 1-indexed oww predict call


class TestWakeWordStripping:
    """Wake word audio should be stripped from captured segments."""

    def test_strip_wakeword_audio(self):
        """Frames up to and including the detection point should be stripped."""
        # Detect on 1st oww call (fires after 3 input frames of 480 samples)
        mock_model = _make_mock_oww(detect_on_call=1)
        detector = _make_detector(mock_model=mock_model)

        all_frames = [_make_speech_frame() for _ in range(10)]
        # Process all frames to trigger detection
        for frame in all_frames:
            detector.process_frame(frame)

        # 1 oww call * 1280 samples = 1280 consumed
        # 1280 / 480 = 2.67 → 3 input frames consumed
        remaining = detector.strip_wakeword_audio(all_frames)
        assert len(remaining) == 7  # 10 - 3 frames consumed

    def test_strip_with_no_detection_returns_all(self):
        """If no wake word was detected, all frames should be returned."""
        detector = _make_detector()
        frames = [_make_speech_frame() for _ in range(5)]
        remaining = detector.strip_wakeword_audio(frames)
        assert len(remaining) == len(frames)


class TestWakeWordReset:
    """Test that detector can be reset for new utterances."""

    def test_reset_clears_state(self):
        # Detect on 1st oww call (fires after 3 input frames)
        mock_model = _make_mock_oww(detect_on_call=1)
        detector = _make_detector(mock_model=mock_model)

        # Trigger detection — need at least 3 frames for 1 oww call
        events = []
        for _ in range(5):
            events.extend(detector.process_frame(_make_speech_frame()))
        assert any(isinstance(e, WakeWordDetected) for e in events)

        # Reset
        detector.reset()
        assert detector._last_detection_frame_index is None
        mock_model.reset.assert_called()


class TestWakeWordResampling:
    """openWakeWord expects 1280-sample chunks at 16kHz. Verify accumulation."""

    def test_accumulates_frames_for_oww_chunk_size(self):
        """30ms frames (480 samples) should be accumulated until we have 1280."""
        mock_model = _make_mock_oww()
        detector = _make_detector(mock_model=mock_model)

        # Feed frames and check model is called at correct intervals
        for _ in range(2):
            detector.process_frame(_make_speech_frame())
        # 2 * 480 = 960 < 1280 — model should not have been called yet
        assert mock_model.predict.call_count == 0

        # Feed one more: 3 * 480 = 1440 >= 1280 — model should be called once
        detector.process_frame(_make_speech_frame())
        assert mock_model.predict.call_count == 1


class TestWakeWordWithFixtures:
    """Test with actual audio fixture files."""

    @pytest.fixture
    def fixture_dir(self):
        return os.path.join(
            os.path.dirname(__file__), "..", "..", "fixtures", "audio"
        )

    def _load_wav(self, path):
        with wave.open(path, "rb") as wf:
            raw = wf.readframes(wf.getnframes())
            return np.frombuffer(raw, dtype=np.int16)

    def test_wake_and_command_fixture_detected(self, fixture_dir):
        """wake-and-command.wav should trigger wake word detection."""
        path = os.path.join(fixture_dir, "wake-and-command.wav")
        if not os.path.exists(path):
            pytest.skip("Audio fixture not found")

        audio_data = self._load_wav(path)
        from sidecar.audio import AudioInputStream

        # Mock model that detects on early frames (simulating wake word present)
        total_oww_calls = len(audio_data) // WAKEWORD_FRAME_SAMPLES
        detect_call = max(1, total_oww_calls // 4)  # detect in first quarter
        mock_model = _make_mock_oww(detect_on_call=detect_call)
        detector = _make_detector(mock_model=mock_model)

        stream = AudioInputStream(file_source=audio_data)
        events = []
        for frame in stream.frames():
            events.extend(detector.process_frame(frame))

        detections = [e for e in events if isinstance(e, WakeWordDetected)]
        assert len(detections) == 1, "Expected wake word detection in wake-and-command.wav"

    def test_silence_fixture_not_detected(self, fixture_dir):
        """silence.wav should NOT trigger wake word detection."""
        path = os.path.join(fixture_dir, "silence.wav")
        if not os.path.exists(path):
            pytest.skip("Audio fixture not found")

        audio_data = self._load_wav(path)
        from sidecar.audio import AudioInputStream

        mock_model = _make_mock_oww(detect_on_call=None)
        detector = _make_detector(mock_model=mock_model)

        stream = AudioInputStream(file_source=audio_data)
        events = []
        for frame in stream.frames():
            events.extend(detector.process_frame(frame))

        detections = [e for e in events if isinstance(e, WakeWordDetected)]
        assert len(detections) == 0, "Should not detect wake word in silence"
