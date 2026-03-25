"""Pipeline orchestrator: audio -> VAD -> wake word gate -> transcriber -> command words.

Three modes:
- wakeWord: gate on, ignore speech without wake word
- pushToTalk: gate off, start/stop controlled externally via ptt_start/ptt_stop
- continuousDictation: gate off, command words delimit chunks, VAD segments accumulate
"""

from __future__ import annotations

import logging
from dataclasses import dataclass
from typing import Union

import numpy as np

from sidecar.audio import FRAME_DURATION_MS, FRAME_SAMPLES
from sidecar.command_words import Action, detect_command
from sidecar.protocol import ConfigMessage
from sidecar.vad import SpeechEnd, SpeechStart, VoiceActivityDetector
from sidecar.wakeword import WakeWordDetector

logger = logging.getLogger(__name__)


@dataclass
class StatusEvent:
    """Pipeline status change event."""
    state: str


@dataclass
class TranscriptEvent:
    """Final transcript event."""
    text: str
    action: str  # "submit" or "cancel"


PipelineEvent = Union[StatusEvent, TranscriptEvent]


class Pipeline:
    """Orchestrates audio -> VAD -> wake word gate -> transcriber -> command words.

    Args:
        config: Configuration message with mode, model, wake word, etc.
        _vad: Injected VAD instance (for testing).
        _transcriber: Injected transcriber instance (for testing).
        _wakeword: Injected wake word detector instance (for testing).
    """

    def __init__(
        self,
        config: ConfigMessage,
        *,
        _vad: VoiceActivityDetector | object | None = None,
        _transcriber: object | None = None,
        _wakeword: WakeWordDetector | object | None = None,
    ) -> None:
        self._config = config
        self._vad = _vad or VoiceActivityDetector(
            silence_timeout_ms=config.silenceTimeout,
        )
        self._transcriber = _transcriber
        self._wakeword = _wakeword or WakeWordDetector(
            model_name=config.wakeWord,
        )

        # Pipeline state
        self._in_speech = False
        self._wake_word_detected = False
        self._speech_frames: list[np.ndarray] = []
        self._speech_frame_count = 0
        self._max_frames = config.maxUtteranceDuration // FRAME_DURATION_MS

        # Push-to-talk state
        self._ptt_active = False
        self._ptt_audio: list[np.ndarray] = []

        # Continuous dictation accumulation buffer
        self._accumulated_text: list[str] = []

    def process_frame(self, frame: np.ndarray) -> list[PipelineEvent]:
        """Process a single 30ms audio frame through the pipeline.

        Returns list of events (status changes and/or transcripts).
        """
        mode = self._config.inputMode
        events: list[PipelineEvent] = []

        if mode == "pushToTalk":
            return self._process_ptt_frame(frame)

        # For wakeWord and continuousDictation modes, run through VAD
        vad_events = self._vad.process_frame(frame)
        speech_ended_by_vad = False

        for vad_event in vad_events:
            if isinstance(vad_event, SpeechStart):
                self._in_speech = True
                self._speech_frames = list(vad_event.buffered_audio)
                self._speech_frame_count = len(self._speech_frames)
                self._wake_word_detected = False
                events.append(StatusEvent(state="speech_start"))

            elif isinstance(vad_event, SpeechEnd):
                self._in_speech = False
                speech_ended_by_vad = True
                # Use the VAD's accumulated audio (includes all speech frames)
                self._speech_frames = vad_event.audio
                events.append(StatusEvent(state="speech_end"))
                events.extend(self._process_speech_end())

        # During speech (if VAD didn't just end it), accumulate and check
        if self._in_speech and not speech_ended_by_vad:
            self._speech_frames.append(frame.copy())
            self._speech_frame_count += 1

            # Feed wake word detector in wakeWord mode
            if mode == "wakeWord" and not self._wake_word_detected:
                ww_events = self._wakeword.process_frame(frame)
                if ww_events:
                    self._wake_word_detected = True
                    events.append(StatusEvent(state="wake_word_detected"))

            # Check max utterance duration
            if self._speech_frame_count >= self._max_frames:
                self._in_speech = False
                events.append(StatusEvent(state="speech_end"))
                events.extend(self._process_speech_end())

        return events

    def _process_ptt_frame(self, frame: np.ndarray) -> list[PipelineEvent]:
        """Process a frame in push-to-talk mode."""
        if not self._ptt_active:
            return []

        # In PTT mode, just accumulate audio — VAD still used for speech detection
        vad_events = self._vad.process_frame(frame)

        events: list[PipelineEvent] = []
        for vad_event in vad_events:
            if isinstance(vad_event, SpeechStart):
                self._in_speech = True
                self._speech_frames = list(vad_event.buffered_audio)
                events.append(StatusEvent(state="speech_start"))
            elif isinstance(vad_event, SpeechEnd):
                self._speech_frames = vad_event.audio
                # Don't process yet — wait for ptt_stop

        if self._in_speech:
            self._ptt_audio.append(frame.copy())

        return events

    def ptt_start(self) -> list[PipelineEvent]:
        """Called when push-to-talk key is pressed."""
        self._ptt_active = True
        self._ptt_audio = []
        self._speech_frames = []
        self._in_speech = False
        self._vad.reset()
        return [StatusEvent(state="speech_start")]

    def ptt_stop(self) -> list[PipelineEvent]:
        """Called when push-to-talk key is released."""
        self._ptt_active = False
        events: list[PipelineEvent] = []
        events.append(StatusEvent(state="speech_end"))

        # Use VAD-captured speech frames if available, otherwise use raw PTT audio
        audio_frames = self._speech_frames if self._speech_frames else self._ptt_audio
        if not audio_frames:
            self._in_speech = False
            return events

        events.append(StatusEvent(state="processing"))

        audio = np.concatenate(audio_frames)
        transcript_text = self._transcriber.transcribe(audio)

        if not transcript_text.strip():
            events.append(StatusEvent(state="listening"))
            self._in_speech = False
            return events

        cleaned, action = detect_command(
            transcript_text,
            submit_words=self._config.submitWords,
            cancel_words=self._config.cancelWords,
        )

        if action == Action.CANCEL:
            events.append(TranscriptEvent(text="", action="cancel"))
        elif action == Action.SUBMIT:
            events.append(TranscriptEvent(text=cleaned, action="submit"))
        else:
            # No command word in PTT — treat as submit
            events.append(TranscriptEvent(text=transcript_text, action="submit"))

        events.append(StatusEvent(state="listening"))
        self._in_speech = False
        return events

    def _process_speech_end(self) -> list[PipelineEvent]:
        """Process accumulated speech after VAD speech_end or max duration."""
        events: list[PipelineEvent] = []
        mode = self._config.inputMode

        if not self._speech_frames:
            events.append(StatusEvent(state="listening"))
            return events

        # In wakeWord mode, check if wake word was detected
        if mode == "wakeWord" and not self._wake_word_detected:
            logger.debug("No wake word detected, discarding speech")
            self._reset_speech_state()
            events.append(StatusEvent(state="listening"))
            return events

        events.append(StatusEvent(state="processing"))

        # Strip wake word audio in wakeWord mode
        audio_frames = self._speech_frames
        if mode == "wakeWord":
            audio_frames = self._wakeword.strip_wakeword_audio(audio_frames)

        if not audio_frames:
            self._reset_speech_state()
            events.append(StatusEvent(state="listening"))
            return events

        audio = np.concatenate(audio_frames)
        transcript_text = self._transcriber.transcribe(audio)

        if not transcript_text.strip():
            logger.debug("Empty transcription, discarding")
            self._reset_speech_state()
            events.append(StatusEvent(state="listening"))
            return events

        cleaned, action = detect_command(
            transcript_text,
            submit_words=self._config.submitWords,
            cancel_words=self._config.cancelWords,
        )

        if mode == "continuousDictation":
            events.extend(self._handle_continuous_dictation(cleaned, action, transcript_text))
        else:
            # wakeWord mode
            if action == Action.CANCEL:
                events.append(TranscriptEvent(text="", action="cancel"))
            elif action == Action.SUBMIT:
                events.append(TranscriptEvent(text=cleaned, action="submit"))
            else:
                # No command word in wake word mode — still deliver
                events.append(TranscriptEvent(text=transcript_text, action="submit"))
            events.append(StatusEvent(state="listening"))

        self._reset_speech_state()
        return events

    def _handle_continuous_dictation(
        self, cleaned: str, action: Action, raw_text: str
    ) -> list[PipelineEvent]:
        """Handle transcript in continuous dictation mode."""
        events: list[PipelineEvent] = []

        if action == Action.CANCEL:
            self._accumulated_text = []
            events.append(TranscriptEvent(text="", action="cancel"))
            events.append(StatusEvent(state="listening"))
        elif action == Action.SUBMIT:
            # Add this segment's cleaned text to accumulated
            if cleaned:
                self._accumulated_text.append(cleaned)
            full_text = " ".join(self._accumulated_text)
            self._accumulated_text = []
            events.append(TranscriptEvent(text=full_text, action="submit"))
            events.append(StatusEvent(state="listening"))
        else:
            # No command word — accumulate
            self._accumulated_text.append(raw_text)
            events.append(StatusEvent(state="listening"))

        return events

    def _reset_speech_state(self) -> None:
        """Reset speech-related state after processing.

        Does NOT reset VAD or wakeword — the VAD is already in a clean
        state after emitting SpeechEnd, and resetting would cause false
        re-triggers on subsequent silence frames.
        """
        self._speech_frames = []
        self._speech_frame_count = 0
        self._wake_word_detected = False
        self._in_speech = False
