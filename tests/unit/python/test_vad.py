"""Unit tests for sidecar.vad — two-stage Voice Activity Detection."""

from unittest.mock import MagicMock
import numpy as np
import pytest

from sidecar.audio import FRAME_SAMPLES, SAMPLE_RATE
from sidecar.vad import (
    VoiceActivityDetector,
    SpeechStart,
    SpeechEnd,
    DEFAULT_SILENCE_TIMEOUT_MS,
    RING_BUFFER_FRAMES,
)


def _make_silence_frame():
    """Return a 30ms frame of silence (all zeros)."""
    return np.zeros(FRAME_SAMPLES, dtype=np.int16)


def _make_speech_frame(amplitude=5000):
    """Return a 30ms frame with a tone that triggers VAD."""
    t = np.arange(FRAME_SAMPLES, dtype=np.float64) / SAMPLE_RATE
    tone = (amplitude * np.sin(2 * np.pi * 440 * t)).astype(np.int16)
    return tone


def _make_vad(silence_timeout_ms=1500, webrtc_default=False, silero_default=0.1):
    """Create a VoiceActivityDetector with mocked backends.

    Args:
        silence_timeout_ms: Silence timeout for speech end detection.
        webrtc_default: Default return value for webrtcvad.is_speech.
        silero_default: Default return value for silero predict.

    Returns:
        (vad, mock_webrtc_vad_instance, mock_silero_fn)
    """
    mock_webrtcvad_mod = MagicMock()
    mock_vad_instance = MagicMock()
    mock_vad_instance.is_speech.return_value = webrtc_default
    mock_webrtcvad_mod.Vad.return_value = mock_vad_instance

    mock_silero = MagicMock(return_value=silero_default)

    vad = VoiceActivityDetector(
        silence_timeout_ms=silence_timeout_ms,
        _webrtcvad_mod=mock_webrtcvad_mod,
        _silero_fn=mock_silero,
    )
    return vad, mock_vad_instance, mock_silero


class TestVadImports:
    """Verify the module exposes expected classes and constants."""

    def test_default_silence_timeout(self):
        assert DEFAULT_SILENCE_TIMEOUT_MS == 1500

    def test_default_ring_buffer_frames(self):
        assert RING_BUFFER_FRAMES == 10


class TestVadSilence:
    """Feeding silence should produce no events."""

    def test_silence_produces_no_events(self):
        vad, _, _ = _make_vad(webrtc_default=False)
        events = []
        for _ in range(50):  # 50 frames = 1.5s of silence
            events.extend(vad.process_frame(_make_silence_frame()))
        assert len(events) == 0

    def test_silero_not_called_when_webrtc_rejects(self):
        vad, _, mock_silero = _make_vad(webrtc_default=False)
        for _ in range(10):
            vad.process_frame(_make_silence_frame())
        mock_silero.assert_not_called()


class TestVadSpeech:
    """Feeding speech frames should produce speech_start and speech_end events."""

    def test_speech_produces_start_event(self):
        vad, mock_webrtc, mock_silero = _make_vad()

        events = []

        # Feed silence first (fills ring buffer)
        mock_webrtc.is_speech.return_value = False
        for _ in range(15):
            events.extend(vad.process_frame(_make_silence_frame()))

        # Now feed speech
        mock_webrtc.is_speech.return_value = True
        mock_silero.return_value = 0.9
        for _ in range(5):
            events.extend(vad.process_frame(_make_speech_frame()))

        start_events = [e for e in events if isinstance(e, SpeechStart)]
        assert len(start_events) == 1

    def test_speech_start_contains_ring_buffer(self):
        vad, mock_webrtc, mock_silero = _make_vad()

        events = []

        # Feed silence to fill ring buffer
        mock_webrtc.is_speech.return_value = False
        for _ in range(15):
            events.extend(vad.process_frame(_make_silence_frame()))

        # Trigger speech
        mock_webrtc.is_speech.return_value = True
        mock_silero.return_value = 0.9
        for _ in range(3):
            events.extend(vad.process_frame(_make_speech_frame()))

        start_events = [e for e in events if isinstance(e, SpeechStart)]
        assert len(start_events) == 1
        # Ring buffer should contain up to RING_BUFFER_FRAMES frames
        assert len(start_events[0].buffered_audio) == RING_BUFFER_FRAMES

    def test_speech_end_after_silence_timeout(self):
        vad, mock_webrtc, mock_silero = _make_vad(silence_timeout_ms=300)

        events = []

        # Feed silence first
        mock_webrtc.is_speech.return_value = False
        for _ in range(15):
            events.extend(vad.process_frame(_make_silence_frame()))

        # Start speech
        mock_webrtc.is_speech.return_value = True
        mock_silero.return_value = 0.9
        for _ in range(5):
            events.extend(vad.process_frame(_make_speech_frame()))

        # Now silence to trigger end (need enough frames to exceed timeout)
        mock_webrtc.is_speech.return_value = False
        mock_silero.return_value = 0.1
        for _ in range(15):  # 450ms > 300ms timeout
            events.extend(vad.process_frame(_make_silence_frame()))

        start_events = [e for e in events if isinstance(e, SpeechStart)]
        end_events = [e for e in events if isinstance(e, SpeechEnd)]
        assert len(start_events) == 1
        assert len(end_events) == 1

    def test_speech_end_contains_all_audio(self):
        vad, mock_webrtc, mock_silero = _make_vad(silence_timeout_ms=300)

        events = []

        # Fill ring buffer with silence
        mock_webrtc.is_speech.return_value = False
        for _ in range(15):
            events.extend(vad.process_frame(_make_silence_frame()))

        # 5 frames of speech
        mock_webrtc.is_speech.return_value = True
        mock_silero.return_value = 0.9
        for _ in range(5):
            events.extend(vad.process_frame(_make_speech_frame()))

        # Silence to trigger end
        mock_webrtc.is_speech.return_value = False
        mock_silero.return_value = 0.1
        for _ in range(15):
            events.extend(vad.process_frame(_make_silence_frame()))

        end_events = [e for e in events if isinstance(e, SpeechEnd)]
        assert len(end_events) == 1
        # Audio should include ring buffer + speech frames
        assert len(end_events[0].audio) > 5


class TestVadWebrtcRejectsButSileroPasses:
    """WebRTC is stage 1 gate — if it rejects, Silero is not consulted."""

    def test_webrtc_rejection_prevents_speech_start(self):
        vad, mock_webrtc, mock_silero = _make_vad(
            webrtc_default=False, silero_default=0.9
        )
        events = []
        for _ in range(50):
            events.extend(vad.process_frame(_make_speech_frame()))
        assert len(events) == 0


class TestVadSileroRejects:
    """WebRTC passes but Silero rejects — should not trigger speech."""

    def test_silero_rejection_prevents_speech_start(self):
        vad, mock_webrtc, mock_silero = _make_vad(
            webrtc_default=True, silero_default=0.1
        )
        events = []
        for _ in range(50):
            events.extend(vad.process_frame(_make_speech_frame()))
        assert len(events) == 0


class TestVadConfiguration:
    """Test configurable parameters."""

    def test_webrtcvad_mode_3(self):
        """WebRTC VAD should be initialized in aggressive mode 3."""
        mock_webrtcvad_mod = MagicMock()
        mock_webrtcvad_mod.Vad.return_value = MagicMock()
        VoiceActivityDetector(
            _webrtcvad_mod=mock_webrtcvad_mod, _silero_fn=MagicMock()
        )
        mock_webrtcvad_mod.Vad.assert_called_once_with(3)

    def test_custom_silence_timeout(self):
        vad, _, _ = _make_vad(silence_timeout_ms=2000)
        assert vad.silence_timeout_ms == 2000

    def test_default_silence_timeout_is_1500(self):
        vad, _, _ = _make_vad()
        assert vad.silence_timeout_ms == 1500


class TestVadReset:
    """Test that VAD can be reset for new utterances."""

    def test_reset_allows_new_speech_detection(self):
        vad, mock_webrtc, mock_silero = _make_vad(silence_timeout_ms=300)
        events = []

        # First utterance
        mock_webrtc.is_speech.return_value = False
        mock_silero.return_value = 0.1
        for _ in range(15):
            events.extend(vad.process_frame(_make_silence_frame()))

        mock_webrtc.is_speech.return_value = True
        mock_silero.return_value = 0.9
        for _ in range(5):
            events.extend(vad.process_frame(_make_speech_frame()))

        mock_webrtc.is_speech.return_value = False
        mock_silero.return_value = 0.1
        for _ in range(15):
            events.extend(vad.process_frame(_make_silence_frame()))

        starts = [e for e in events if isinstance(e, SpeechStart)]
        ends = [e for e in events if isinstance(e, SpeechEnd)]
        assert len(starts) == 1
        assert len(ends) == 1

        # Reset and do another utterance
        vad.reset()
        events2 = []

        mock_webrtc.is_speech.return_value = False
        mock_silero.return_value = 0.1
        for _ in range(15):
            events2.extend(vad.process_frame(_make_silence_frame()))

        mock_webrtc.is_speech.return_value = True
        mock_silero.return_value = 0.9
        for _ in range(5):
            events2.extend(vad.process_frame(_make_speech_frame()))

        mock_webrtc.is_speech.return_value = False
        mock_silero.return_value = 0.1
        for _ in range(15):
            events2.extend(vad.process_frame(_make_silence_frame()))

        starts2 = [e for e in events2 if isinstance(e, SpeechStart)]
        ends2 = [e for e in events2 if isinstance(e, SpeechEnd)]
        assert len(starts2) == 1
        assert len(ends2) == 1


class TestVadWithAudioFixtures:
    """Test with actual audio fixture files."""

    def test_silence_fixture_no_events(self):
        """silence.wav should produce no speech events."""
        from sidecar.audio import AudioInputStream
        import wave
        import os

        fixture_path = os.path.join(
            os.path.dirname(__file__), "..", "..", "fixtures", "audio", "silence.wav"
        )
        if not os.path.exists(fixture_path):
            pytest.skip("Audio fixture not found")

        with wave.open(fixture_path, "rb") as wf:
            raw = wf.readframes(wf.getnframes())
            audio_data = np.frombuffer(raw, dtype=np.int16)

        # WebRTC VAD should reject silence
        vad, _, _ = _make_vad(webrtc_default=False, silero_default=0.1)
        stream = AudioInputStream(file_source=audio_data)

        events = []
        for frame in stream.frames():
            events.extend(vad.process_frame(frame))

        assert len(events) == 0

    def test_speech_fixture_produces_start_end(self):
        """command-only.wav should produce speech_start and speech_end."""
        from sidecar.audio import AudioInputStream
        import wave
        import os

        fixture_path = os.path.join(
            os.path.dirname(__file__), "..", "..", "fixtures", "audio", "command-only.wav"
        )
        if not os.path.exists(fixture_path):
            pytest.skip("Audio fixture not found")

        with wave.open(fixture_path, "rb") as wf:
            raw = wf.readframes(wf.getnframes())
            audio_data = np.frombuffer(raw, dtype=np.int16)

        total_frames = len(audio_data) // FRAME_SAMPLES

        # Mock WebRTC: first 10 frames silence, middle is speech, last 10 silence
        mock_webrtcvad_mod = MagicMock()
        mock_vad_instance = MagicMock()
        call_count = [0]

        def webrtc_is_speech(data, sample_rate):
            call_count[0] += 1
            if call_count[0] < 10:
                return False
            if call_count[0] > total_frames - 10:
                return False
            return True

        mock_vad_instance.is_speech = webrtc_is_speech
        mock_webrtcvad_mod.Vad.return_value = mock_vad_instance

        mock_silero = MagicMock(return_value=0.9)

        vad = VoiceActivityDetector(
            silence_timeout_ms=300,
            _webrtcvad_mod=mock_webrtcvad_mod,
            _silero_fn=mock_silero,
        )
        stream = AudioInputStream(file_source=audio_data)

        events = []
        for frame in stream.frames():
            events.extend(vad.process_frame(frame))

        start_events = [e for e in events if isinstance(e, SpeechStart)]
        end_events = [e for e in events if isinstance(e, SpeechEnd)]

        assert len(start_events) >= 1, "Expected at least one SpeechStart event"
        assert len(end_events) >= 1, "Expected at least one SpeechEnd event"
        # SpeechStart should have buffered audio (pre-speech ring buffer)
        assert len(start_events[0].buffered_audio) > 0
