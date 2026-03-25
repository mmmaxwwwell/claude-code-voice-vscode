"""Integration tests for the pipeline orchestrator.

Feed audio fixtures through the pipeline with injected (mock) components,
verify correct status events and transcript output for all three modes.
"""

from __future__ import annotations

import pytest

np = pytest.importorskip("numpy", exc_type=ImportError)

from sidecar.audio import FRAME_SAMPLES, SAMPLE_RATE
from sidecar.command_words import Action
from sidecar.pipeline import Pipeline, PipelineEvent, StatusEvent, TranscriptEvent
from sidecar.protocol import ConfigMessage
from sidecar.vad import SpeechEnd, SpeechStart


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _load_wav(path: str) -> np.ndarray:
    """Load a 16kHz mono WAV file as int16 numpy array."""
    import wave

    with wave.open(path, "rb") as wf:
        assert wf.getframerate() == 16000
        assert wf.getnchannels() == 1
        assert wf.getsampwidth() == 2
        raw = wf.readframes(wf.getnframes())
    return np.frombuffer(raw, dtype=np.int16)


def _make_config(**overrides) -> ConfigMessage:
    """Create a ConfigMessage with sensible defaults."""
    defaults = dict(
        inputMode="wakeWord",
        whisperModel="base",
        wakeWord="hey_claude",
        submitWords=["send it", "go", "submit"],
        cancelWords=["never mind", "cancel"],
        silenceTimeout=1500,
        maxUtteranceDuration=60000,
        micDevice="",
    )
    defaults.update(overrides)
    return ConfigMessage(**defaults)


class FakeTranscriber:
    """Returns canned transcription text."""

    def __init__(self, text: str = "refactor this function send it"):
        self._text = text

    def transcribe(self, audio: np.ndarray) -> str:
        return self._text


class FakeVAD:
    """Simulates VAD by emitting SpeechStart after a few frames, SpeechEnd after more."""

    def __init__(self, start_at: int = 2, end_at: int = 10):
        self._start_at = start_at
        self._end_at = end_at
        self._frame_count = 0
        self._speech_frames: list[np.ndarray] = []
        self._in_speech = False

    def reset(self) -> None:
        self._frame_count = 0
        self._speech_frames = []
        self._in_speech = False

    def process_frame(self, frame: np.ndarray) -> list[SpeechStart | SpeechEnd]:
        self._frame_count += 1
        events: list[SpeechStart | SpeechEnd] = []

        if self._frame_count == self._start_at:
            self._in_speech = True
            events.append(SpeechStart(buffered_audio=[]))
        if self._in_speech:
            self._speech_frames.append(frame.copy())
        if self._frame_count == self._end_at:
            self._in_speech = False
            events.append(SpeechEnd(audio=self._speech_frames.copy()))
            self._speech_frames = []

        return events


class FakeWakeWord:
    """Simulates wake word detection at a given frame."""

    def __init__(self, detect_at: int = 3):
        self._detect_at = detect_at
        self._frame_count = 0
        self._detected = False

    def reset(self) -> None:
        self._frame_count = 0
        self._detected = False

    def process_frame(self, frame: np.ndarray) -> list:
        from sidecar.wakeword import WakeWordDetected
        self._frame_count += 1
        if self._frame_count == self._detect_at and not self._detected:
            self._detected = True
            return [WakeWordDetected(model_name="hey_claude", frame_index=1)]
        return []

    def strip_wakeword_audio(self, frames: list[np.ndarray]) -> list[np.ndarray]:
        # Simulate stripping first frame
        if self._detected and len(frames) > 1:
            return frames[1:]
        return frames


class FakeWakeWordNever:
    """Never detects a wake word."""

    def reset(self) -> None:
        pass

    def process_frame(self, frame: np.ndarray) -> list:
        return []

    def strip_wakeword_audio(self, frames: list[np.ndarray]) -> list[np.ndarray]:
        return frames


def _make_pipeline(
    config: ConfigMessage,
    transcriber=None,
    vad=None,
    wakeword=None,
) -> Pipeline:
    """Create a pipeline with injectable fakes."""
    return Pipeline(
        config=config,
        _vad=vad or FakeVAD(),
        _transcriber=transcriber or FakeTranscriber(),
        _wakeword=wakeword or FakeWakeWord(),
    )


def _collect_events(pipeline: Pipeline, audio: np.ndarray) -> list[PipelineEvent]:
    """Feed audio frames into the pipeline and collect all events."""
    events: list[PipelineEvent] = []
    for offset in range(0, len(audio), FRAME_SAMPLES):
        end = offset + FRAME_SAMPLES
        if end > len(audio):
            frame = np.zeros(FRAME_SAMPLES, dtype=np.int16)
            frame[: len(audio) - offset] = audio[offset:]
        else:
            frame = audio[offset:end]
        events.extend(pipeline.process_frame(frame))
    return events


# ---------------------------------------------------------------------------
# Wake Word Mode Tests
# ---------------------------------------------------------------------------

class TestWakeWordMode:
    """Pipeline in wakeWord mode: gate on, ignore speech without wake word."""

    def test_wake_word_detected_produces_transcript(self):
        """Speech with wake word -> status events + transcript with submit."""
        config = _make_config(inputMode="wakeWord")
        pipeline = _make_pipeline(
            config,
            transcriber=FakeTranscriber("refactor this function send it"),
            vad=FakeVAD(start_at=2, end_at=10),
            wakeword=FakeWakeWord(detect_at=3),
        )
        # Create enough audio for VAD to start and end
        audio = np.zeros(FRAME_SAMPLES * 15, dtype=np.int16)
        events = _collect_events(pipeline, audio)

        statuses = [e for e in events if isinstance(e, StatusEvent)]
        transcripts = [e for e in events if isinstance(e, TranscriptEvent)]

        # Should have speech_start, wake_word_detected, speech_end, processing, listening
        status_states = [s.state for s in statuses]
        assert "speech_start" in status_states
        assert "wake_word_detected" in status_states
        assert "speech_end" in status_states
        assert "processing" in status_states

        # Should produce a transcript
        assert len(transcripts) == 1
        assert transcripts[0].text == "refactor this function"
        assert transcripts[0].action == "submit"

    def test_no_wake_word_no_transcript(self):
        """Speech without wake word in wakeWord mode -> no transcript."""
        config = _make_config(inputMode="wakeWord")
        pipeline = _make_pipeline(
            config,
            transcriber=FakeTranscriber("some random speech"),
            vad=FakeVAD(start_at=2, end_at=10),
            wakeword=FakeWakeWordNever(),
        )
        audio = np.zeros(FRAME_SAMPLES * 15, dtype=np.int16)
        events = _collect_events(pipeline, audio)

        transcripts = [e for e in events if isinstance(e, TranscriptEvent)]
        assert len(transcripts) == 0

    def test_cancel_word_discards_transcript(self):
        """Wake word + cancel word -> transcript with cancel action."""
        config = _make_config(inputMode="wakeWord")
        pipeline = _make_pipeline(
            config,
            transcriber=FakeTranscriber("do something never mind"),
            vad=FakeVAD(start_at=2, end_at=10),
            wakeword=FakeWakeWord(detect_at=3),
        )
        audio = np.zeros(FRAME_SAMPLES * 15, dtype=np.int16)
        events = _collect_events(pipeline, audio)

        transcripts = [e for e in events if isinstance(e, TranscriptEvent)]
        assert len(transcripts) == 1
        assert transcripts[0].action == "cancel"
        assert transcripts[0].text == ""


# ---------------------------------------------------------------------------
# Push-to-Talk Mode Tests
# ---------------------------------------------------------------------------

class TestPushToTalkMode:
    """Pipeline in pushToTalk mode: gate off, externally controlled."""

    def test_ptt_start_stop_produces_transcript(self):
        """ptt_start -> feed audio -> ptt_stop -> transcript produced."""
        config = _make_config(inputMode="pushToTalk")
        vad = FakeVAD(start_at=2, end_at=10)
        pipeline = _make_pipeline(
            config,
            transcriber=FakeTranscriber("explain this code send it"),
            vad=vad,
        )

        events: list[PipelineEvent] = []

        # Start push-to-talk
        events.extend(pipeline.ptt_start())

        # Feed some frames
        audio = np.zeros(FRAME_SAMPLES * 15, dtype=np.int16)
        events.extend(_collect_events(pipeline, audio))

        # Stop push-to-talk
        events.extend(pipeline.ptt_stop())

        transcripts = [e for e in events if isinstance(e, TranscriptEvent)]
        assert len(transcripts) == 1
        assert transcripts[0].text == "explain this code"
        assert transcripts[0].action == "submit"

    def test_ptt_no_speech_no_transcript(self):
        """ptt_start -> silence -> ptt_stop -> no transcript."""
        config = _make_config(inputMode="pushToTalk")
        # VAD never triggers
        vad = FakeVAD(start_at=999, end_at=9999)
        pipeline = _make_pipeline(
            config,
            transcriber=FakeTranscriber("should not see this"),
            vad=vad,
        )

        events: list[PipelineEvent] = []
        events.extend(pipeline.ptt_start())
        audio = np.zeros(FRAME_SAMPLES * 5, dtype=np.int16)
        events.extend(_collect_events(pipeline, audio))
        events.extend(pipeline.ptt_stop())

        transcripts = [e for e in events if isinstance(e, TranscriptEvent)]
        assert len(transcripts) == 0


# ---------------------------------------------------------------------------
# Continuous Dictation Mode Tests
# ---------------------------------------------------------------------------

class TestContinuousDictationMode:
    """Pipeline in continuousDictation mode: gate off, command words delimit."""

    def test_speech_with_submit_produces_transcript(self):
        """Speech ending with submit word -> transcript delivered."""
        config = _make_config(inputMode="continuousDictation")
        pipeline = _make_pipeline(
            config,
            transcriber=FakeTranscriber("refactor the auth module send it"),
            vad=FakeVAD(start_at=2, end_at=10),
            wakeword=FakeWakeWordNever(),
        )
        audio = np.zeros(FRAME_SAMPLES * 15, dtype=np.int16)
        events = _collect_events(pipeline, audio)

        transcripts = [e for e in events if isinstance(e, TranscriptEvent)]
        assert len(transcripts) == 1
        assert transcripts[0].text == "refactor the auth module"
        assert transcripts[0].action == "submit"

    def test_speech_without_command_word_accumulates(self):
        """Speech without command word -> no transcript, audio accumulated."""
        config = _make_config(inputMode="continuousDictation")
        pipeline = _make_pipeline(
            config,
            transcriber=FakeTranscriber("just some text here"),
            vad=FakeVAD(start_at=2, end_at=10),
            wakeword=FakeWakeWordNever(),
        )
        audio = np.zeros(FRAME_SAMPLES * 15, dtype=np.int16)
        events = _collect_events(pipeline, audio)

        transcripts = [e for e in events if isinstance(e, TranscriptEvent)]
        # No command word -> accumulated, no transcript emitted yet
        assert len(transcripts) == 0

    def test_multi_segment_accumulation_then_submit(self):
        """Multiple VAD segments accumulate, then submit word delivers all."""
        config = _make_config(inputMode="continuousDictation")

        # First segment: no command word
        vad1 = FakeVAD(start_at=2, end_at=8)
        pipeline = _make_pipeline(
            config,
            transcriber=FakeTranscriber("first part"),
            vad=vad1,
            wakeword=FakeWakeWordNever(),
        )
        audio1 = np.zeros(FRAME_SAMPLES * 12, dtype=np.int16)
        events1 = _collect_events(pipeline, audio1)

        transcripts1 = [e for e in events1 if isinstance(e, TranscriptEvent)]
        assert len(transcripts1) == 0  # accumulated, not delivered

        # Now feed a second segment with submit word
        # We need a new VAD since the old one won't trigger again
        pipeline._vad = FakeVAD(start_at=2, end_at=8)
        pipeline._transcriber = FakeTranscriber("second part send it")
        audio2 = np.zeros(FRAME_SAMPLES * 12, dtype=np.int16)
        events2 = _collect_events(pipeline, audio2)

        transcripts2 = [e for e in events2 if isinstance(e, TranscriptEvent)]
        assert len(transcripts2) == 1
        assert transcripts2[0].action == "submit"
        # Should contain accumulated text from both segments
        assert "first part" in transcripts2[0].text
        assert "second part" in transcripts2[0].text

    def test_cancel_discards_accumulated(self):
        """Cancel word discards accumulated text."""
        config = _make_config(inputMode="continuousDictation")

        # First segment: accumulate
        vad = FakeVAD(start_at=2, end_at=8)
        pipeline = _make_pipeline(
            config,
            transcriber=FakeTranscriber("some accumulated text"),
            vad=vad,
            wakeword=FakeWakeWordNever(),
        )
        audio = np.zeros(FRAME_SAMPLES * 12, dtype=np.int16)
        _collect_events(pipeline, audio)

        # Second segment: cancel
        pipeline._vad = FakeVAD(start_at=2, end_at=8)
        pipeline._transcriber = FakeTranscriber("oops never mind")
        audio2 = np.zeros(FRAME_SAMPLES * 12, dtype=np.int16)
        events2 = _collect_events(pipeline, audio2)

        transcripts = [e for e in events2 if isinstance(e, TranscriptEvent)]
        assert len(transcripts) == 1
        assert transcripts[0].action == "cancel"
        assert transcripts[0].text == ""


# ---------------------------------------------------------------------------
# Max Utterance Duration Tests
# ---------------------------------------------------------------------------

class TestMaxUtteranceDuration:
    """Max utterance duration enforcement."""

    def test_max_duration_forces_speech_end(self):
        """When max utterance duration exceeded, pipeline forces processing."""
        # Set max duration to a very short value (e.g. 300ms = 10 frames)
        config = _make_config(maxUtteranceDuration=300)
        # VAD starts at frame 2 but never ends (end_at very high)
        vad = FakeVAD(start_at=2, end_at=9999)
        pipeline = _make_pipeline(
            config,
            transcriber=FakeTranscriber("long speech send it"),
            vad=vad,
            wakeword=FakeWakeWord(detect_at=3),
        )

        # Feed many frames (more than 300ms worth = 10 frames)
        audio = np.zeros(FRAME_SAMPLES * 30, dtype=np.int16)
        events = _collect_events(pipeline, audio)

        # Should have forced a transcript even though VAD didn't end
        transcripts = [e for e in events if isinstance(e, TranscriptEvent)]
        assert len(transcripts) >= 1


# ---------------------------------------------------------------------------
# Status Event Tests
# ---------------------------------------------------------------------------

class TestStatusEvents:
    """Pipeline emits correct status events."""

    def test_wake_word_mode_status_sequence(self):
        """Verify status event sequence for wake word mode."""
        config = _make_config(inputMode="wakeWord")
        pipeline = _make_pipeline(
            config,
            transcriber=FakeTranscriber("test send it"),
            vad=FakeVAD(start_at=2, end_at=10),
            wakeword=FakeWakeWord(detect_at=3),
        )
        audio = np.zeros(FRAME_SAMPLES * 15, dtype=np.int16)
        events = _collect_events(pipeline, audio)

        statuses = [e for e in events if isinstance(e, StatusEvent)]
        states = [s.state for s in statuses]

        # Expected sequence: speech_start, wake_word_detected, speech_end, processing, listening
        assert states[0] == "speech_start"
        assert "wake_word_detected" in states
        assert "speech_end" in states
        assert "processing" in states
        # After processing, should go back to listening
        assert states[-1] == "listening"

    def test_empty_transcription_silently_discarded(self):
        """Empty transcription from whisper -> no transcript event."""
        config = _make_config(inputMode="wakeWord")
        pipeline = _make_pipeline(
            config,
            transcriber=FakeTranscriber(""),
            vad=FakeVAD(start_at=2, end_at=10),
            wakeword=FakeWakeWord(detect_at=3),
        )
        audio = np.zeros(FRAME_SAMPLES * 15, dtype=np.int16)
        events = _collect_events(pipeline, audio)

        transcripts = [e for e in events if isinstance(e, TranscriptEvent)]
        assert len(transcripts) == 0
