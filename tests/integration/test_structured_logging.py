"""Integration test: structured JSON log output with correlation IDs for utterance lifecycle.

Verifies that when audio flows through the pipeline, log entries are emitted as
structured JSON with correlation IDs that tie together speech_start, transcription,
command word detection, and speech_end for a single utterance.
"""

from __future__ import annotations

import json
import logging
from io import StringIO

import pytest

np = pytest.importorskip("numpy", exc_type=ImportError)

from sidecar.audio import FRAME_SAMPLES
from sidecar.logger import configure_logging, _JsonFormatter
from sidecar.pipeline import Pipeline, StatusEvent, TranscriptEvent
from sidecar.protocol import ConfigMessage
from sidecar.vad import SpeechEnd, SpeechStart


# ---------------------------------------------------------------------------
# Fakes (same pattern as test_pipeline.py)
# ---------------------------------------------------------------------------


class FakeVAD:
    """Simulates VAD by emitting SpeechStart/SpeechEnd at configured frames."""

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


class FakeTranscriber:
    """Returns canned transcription text."""

    def __init__(self, text: str = "refactor this function send it"):
        self._text = text

    def transcribe(self, audio: np.ndarray) -> str:
        return self._text


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
        if self._detected and len(frames) > 1:
            return frames[1:]
        return frames


def _make_config(**overrides) -> ConfigMessage:
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


def _collect_events(pipeline: Pipeline, num_frames: int = 15) -> list:
    """Feed silent frames into the pipeline and collect events."""
    audio = np.zeros(FRAME_SAMPLES * num_frames, dtype=np.int16)
    events = []
    for offset in range(0, len(audio), FRAME_SAMPLES):
        end = offset + FRAME_SAMPLES
        frame = audio[offset:end]
        events.extend(pipeline.process_frame(frame))
    return events


# ---------------------------------------------------------------------------
# Tests
# ---------------------------------------------------------------------------


class TestStructuredLoggingIntegration:
    """Verify structured JSON log output with correlation IDs through the pipeline."""

    def _capture_logs(self) -> tuple[logging.Handler, StringIO]:
        """Add a StringIO handler to root logger, return (handler, stream)."""
        stream = StringIO()
        handler = logging.StreamHandler(stream)
        handler.setFormatter(_JsonFormatter())
        root = logging.getLogger()
        root.addHandler(handler)
        root.setLevel(logging.DEBUG)
        return handler, stream

    def _parse_log_lines(self, stream: StringIO) -> list[dict]:
        """Parse JSON log lines from captured stream."""
        stream.seek(0)
        lines = []
        for line in stream:
            line = line.strip()
            if line:
                lines.append(json.loads(line))
        return lines

    def test_utterance_lifecycle_has_correlation_id(self):
        """A full utterance lifecycle should have consistent correlation IDs.

        From speech_start through transcription to speech_end, all log entries
        for that utterance should share the same correlation ID.
        """
        handler, stream = self._capture_logs()
        try:
            config = _make_config(inputMode="wakeWord")
            pipeline = Pipeline(
                config,
                _vad=FakeVAD(start_at=2, end_at=10),
                _transcriber=FakeTranscriber("refactor this function send it"),
                _wakeword=FakeWakeWord(detect_at=3),
            )

            events = _collect_events(pipeline, num_frames=15)

            # Should have produced a transcript
            transcripts = [e for e in events if isinstance(e, TranscriptEvent)]
            assert len(transcripts) == 1

            # Parse log output
            log_entries = self._parse_log_lines(stream)

            # There should be log entries with correlationId
            entries_with_corr = [e for e in log_entries if "correlationId" in e]
            assert len(entries_with_corr) > 0, (
                "Expected log entries with correlationId during utterance lifecycle"
            )

            # All correlation IDs for this utterance should be the same
            corr_ids = {e["correlationId"] for e in entries_with_corr}
            assert len(corr_ids) == 1, (
                f"Expected one unique correlation ID per utterance, got {corr_ids}"
            )

            # The correlation ID should be a non-empty string
            corr_id = corr_ids.pop()
            assert isinstance(corr_id, str) and len(corr_id) > 0

        finally:
            logging.getLogger().removeHandler(handler)

    def test_different_utterances_have_different_correlation_ids(self):
        """Two separate utterances should get different correlation IDs."""
        handler, stream = self._capture_logs()
        try:
            config = _make_config(inputMode="continuousDictation")

            # First utterance
            vad1 = FakeVAD(start_at=2, end_at=8)
            pipeline = Pipeline(
                config,
                _vad=vad1,
                _transcriber=FakeTranscriber("first utterance send it"),
                _wakeword=FakeWakeWord(detect_at=999),
            )
            events1 = _collect_events(pipeline, num_frames=12)

            # Second utterance (replace VAD/transcriber for fresh triggers)
            pipeline._vad = FakeVAD(start_at=2, end_at=8)
            pipeline._transcriber = FakeTranscriber("second utterance send it")
            events2 = _collect_events(pipeline, num_frames=12)

            log_entries = self._parse_log_lines(stream)
            entries_with_corr = [e for e in log_entries if "correlationId" in e]

            # Should have entries from two different utterances
            corr_ids = {e["correlationId"] for e in entries_with_corr}
            assert len(corr_ids) == 2, (
                f"Expected 2 unique correlation IDs for 2 utterances, got {corr_ids}"
            )

        finally:
            logging.getLogger().removeHandler(handler)

    def test_log_entries_are_valid_json(self):
        """All log output should be valid JSON lines."""
        handler, stream = self._capture_logs()
        try:
            config = _make_config(inputMode="wakeWord")
            pipeline = Pipeline(
                config,
                _vad=FakeVAD(start_at=2, end_at=10),
                _transcriber=FakeTranscriber("test send it"),
                _wakeword=FakeWakeWord(detect_at=3),
            )
            _collect_events(pipeline, num_frames=15)

            stream.seek(0)
            for line in stream:
                line = line.strip()
                if line:
                    entry = json.loads(line)
                    assert "timestamp" in entry
                    assert "level" in entry
                    assert "message" in entry
                    assert "module" in entry

        finally:
            logging.getLogger().removeHandler(handler)

    def test_no_correlation_id_outside_utterance(self):
        """Log entries outside an utterance should NOT have a correlation ID."""
        handler, stream = self._capture_logs()
        try:
            # Log something before any utterance processing
            logger = logging.getLogger("sidecar.pipeline")
            logger.info("Pipeline initialized (pre-utterance)")

            log_entries = self._parse_log_lines(stream)
            assert len(log_entries) > 0
            for entry in log_entries:
                assert "correlationId" not in entry, (
                    "Log entry outside utterance should not have correlationId"
                )

        finally:
            logging.getLogger().removeHandler(handler)

    def test_transcription_timing_logged(self):
        """Transcription should log timing information."""
        handler, stream = self._capture_logs()
        try:
            config = _make_config(inputMode="wakeWord")
            pipeline = Pipeline(
                config,
                _vad=FakeVAD(start_at=2, end_at=10),
                _transcriber=FakeTranscriber("test send it"),
                _wakeword=FakeWakeWord(detect_at=3),
            )
            _collect_events(pipeline, num_frames=15)

            log_entries = self._parse_log_lines(stream)
            # Look for transcription-related log entries
            transcription_logs = [
                e for e in log_entries
                if "transcri" in e.get("message", "").lower()
            ]
            assert len(transcription_logs) > 0, (
                "Expected at least one log entry about transcription"
            )

        finally:
            logging.getLogger().removeHandler(handler)
