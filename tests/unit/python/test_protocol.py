"""Tests for sidecar.protocol — message types, serialization, deserialization."""

import json
import pytest

from sidecar.protocol import (
    ConfigMessage,
    ControlMessage,
    ErrorMessage,
    StatusMessage,
    TranscriptMessage,
    deserialize,
    serialize,
)


# --- StatusMessage ---

class TestStatusMessage:
    def test_round_trip_listening(self):
        msg = StatusMessage(state="listening")
        line = serialize(msg)
        assert line.endswith("\n")
        restored = deserialize(line)
        assert isinstance(restored, StatusMessage)
        assert restored.state == "listening"

    def test_round_trip_all_states(self):
        for state in ("listening", "speech_start", "speech_end",
                      "wake_word_detected", "processing", "ready"):
            msg = StatusMessage(state=state)
            restored = deserialize(serialize(msg))
            assert isinstance(restored, StatusMessage)
            assert restored.state == state

    def test_serialized_json_structure(self):
        msg = StatusMessage(state="processing")
        data = json.loads(serialize(msg))
        assert data == {"type": "status", "state": "processing"}


# --- TranscriptMessage ---

class TestTranscriptMessage:
    def test_round_trip_submit(self):
        msg = TranscriptMessage(text="refactor this function", action="submit")
        restored = deserialize(serialize(msg))
        assert isinstance(restored, TranscriptMessage)
        assert restored.text == "refactor this function"
        assert restored.action == "submit"

    def test_round_trip_cancel(self):
        msg = TranscriptMessage(text="", action="cancel")
        restored = deserialize(serialize(msg))
        assert isinstance(restored, TranscriptMessage)
        assert restored.text == ""
        assert restored.action == "cancel"

    def test_serialized_json_structure(self):
        msg = TranscriptMessage(text="hello", action="submit")
        data = json.loads(serialize(msg))
        assert data == {"type": "transcript", "text": "hello", "action": "submit"}


# --- ErrorMessage ---

class TestErrorMessage:
    def test_round_trip(self):
        msg = ErrorMessage(code="MIC_NOT_FOUND", message="No microphone device found.")
        restored = deserialize(serialize(msg))
        assert isinstance(restored, ErrorMessage)
        assert restored.code == "MIC_NOT_FOUND"
        assert restored.message == "No microphone device found."

    def test_serialized_json_structure(self):
        msg = ErrorMessage(code="MODEL_LOAD_FAILED", message="Corrupt model file.")
        data = json.loads(serialize(msg))
        assert data == {
            "type": "error",
            "code": "MODEL_LOAD_FAILED",
            "message": "Corrupt model file.",
        }


# --- ConfigMessage ---

class TestConfigMessage:
    def test_round_trip(self):
        msg = ConfigMessage(
            inputMode="wakeWord",
            whisperModel="base",
            wakeWord="hey_claude",
            submitWords=["send it", "go", "submit"],
            cancelWords=["never mind", "cancel"],
            silenceTimeout=1500,
            maxUtteranceDuration=60000,
            micDevice="",
        )
        restored = deserialize(serialize(msg))
        assert isinstance(restored, ConfigMessage)
        assert restored.inputMode == "wakeWord"
        assert restored.whisperModel == "base"
        assert restored.wakeWord == "hey_claude"
        assert restored.submitWords == ["send it", "go", "submit"]
        assert restored.cancelWords == ["never mind", "cancel"]
        assert restored.silenceTimeout == 1500
        assert restored.maxUtteranceDuration == 60000
        assert restored.micDevice == ""

    def test_serialized_json_structure(self):
        msg = ConfigMessage(
            inputMode="pushToTalk",
            whisperModel="tiny",
            wakeWord="hey_claude",
            submitWords=["send it"],
            cancelWords=["cancel"],
            silenceTimeout=2000,
            maxUtteranceDuration=30000,
            micDevice="USB Mic",
        )
        data = json.loads(serialize(msg))
        assert data["type"] == "config"
        assert data["inputMode"] == "pushToTalk"
        assert data["whisperModel"] == "tiny"
        assert data["micDevice"] == "USB Mic"


# --- ControlMessage ---

class TestControlMessage:
    def test_round_trip_all_actions(self):
        for action in ("start", "stop", "ptt_start", "ptt_stop"):
            msg = ControlMessage(action=action)
            restored = deserialize(serialize(msg))
            assert isinstance(restored, ControlMessage)
            assert restored.action == action

    def test_serialized_json_structure(self):
        msg = ControlMessage(action="ptt_start")
        data = json.loads(serialize(msg))
        assert data == {"type": "control", "action": "ptt_start"}


# --- Deserialization error handling ---

class TestDeserializeErrors:
    def test_reject_malformed_json(self):
        with pytest.raises(ValueError, match="malformed"):
            deserialize("not valid json\n")

    def test_reject_missing_type(self):
        with pytest.raises(ValueError, match="type"):
            deserialize('{"state": "listening"}\n')

    def test_reject_unknown_type(self):
        with pytest.raises(ValueError, match="unknown.*type"):
            deserialize('{"type": "unknown_msg"}\n')

    def test_reject_missing_required_field(self):
        with pytest.raises((ValueError, TypeError)):
            deserialize('{"type": "status"}\n')

    def test_handles_trailing_newline(self):
        msg = StatusMessage(state="ready")
        line = serialize(msg)
        assert line.endswith("\n")
        # Should work with or without trailing newline
        restored = deserialize(line.rstrip("\n"))
        assert isinstance(restored, StatusMessage)

    def test_reject_empty_string(self):
        with pytest.raises(ValueError):
            deserialize("")

    def test_reject_whitespace_only(self):
        with pytest.raises(ValueError):
            deserialize("   \n")
