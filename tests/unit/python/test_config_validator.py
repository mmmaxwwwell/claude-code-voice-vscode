"""Tests for sidecar.config_validator — config message validation."""

import os
import tempfile

import pytest

from sidecar.config_validator import validate_config
from sidecar.protocol import ConfigMessage


def _valid_config(**overrides) -> ConfigMessage:
    """Return a valid ConfigMessage, with optional field overrides."""
    defaults = dict(
        inputMode="wakeWord",
        whisperModel="base",
        wakeWord="hey_claude",
        submitWords=["send it", "go"],
        cancelWords=["never mind", "cancel"],
        silenceTimeout=1500,
        maxUtteranceDuration=60000,
        micDevice="",
    )
    defaults.update(overrides)
    return ConfigMessage(**defaults)


class TestValidConfigPasses:
    def test_valid_wake_word_config(self, tmp_path):
        model_file = tmp_path / "hey_claude.tflite"
        model_file.touch()
        cfg = _valid_config(wakeWord=str(model_file))
        errors = validate_config(cfg)
        assert errors == []

    def test_valid_push_to_talk_config(self):
        cfg = _valid_config(inputMode="pushToTalk")
        errors = validate_config(cfg)
        assert errors == []

    def test_valid_continuous_dictation_config(self):
        cfg = _valid_config(inputMode="continuousDictation")
        errors = validate_config(cfg)
        assert errors == []

    def test_all_whisper_model_sizes(self):
        for size in ("tiny", "base", "small", "medium"):
            cfg = _valid_config(inputMode="pushToTalk", whisperModel=size)
            errors = validate_config(cfg)
            assert errors == [], f"model size {size!r} should be valid"


class TestInvalidModelSize:
    def test_invalid_whisper_model(self):
        cfg = _valid_config(inputMode="pushToTalk", whisperModel="xlarge")
        errors = validate_config(cfg)
        assert len(errors) == 1
        assert "whisperModel" in errors[0]

    def test_empty_whisper_model(self):
        cfg = _valid_config(inputMode="pushToTalk", whisperModel="")
        errors = validate_config(cfg)
        assert len(errors) == 1
        assert "whisperModel" in errors[0]


class TestInvalidInputMode:
    def test_invalid_input_mode(self):
        cfg = _valid_config(inputMode="voiceActivated")
        errors = validate_config(cfg)
        assert len(errors) >= 1
        assert any("inputMode" in e for e in errors)


class TestWakeWordFileValidation:
    def test_wake_word_file_missing_in_wake_word_mode(self):
        cfg = _valid_config(
            inputMode="wakeWord",
            wakeWord="/nonexistent/path/model.tflite",
        )
        errors = validate_config(cfg)
        assert len(errors) == 1
        assert "wakeWord" in errors[0]

    def test_wake_word_file_not_checked_in_push_to_talk(self):
        cfg = _valid_config(
            inputMode="pushToTalk",
            wakeWord="/nonexistent/path/model.tflite",
        )
        errors = validate_config(cfg)
        assert errors == []

    def test_wake_word_file_not_checked_in_continuous(self):
        cfg = _valid_config(
            inputMode="continuousDictation",
            wakeWord="/nonexistent/path/model.tflite",
        )
        errors = validate_config(cfg)
        assert errors == []


class TestSubmitCancelWords:
    def test_empty_submit_words(self):
        cfg = _valid_config(inputMode="pushToTalk", submitWords=[])
        errors = validate_config(cfg)
        assert len(errors) == 1
        assert "submitWords" in errors[0]

    def test_empty_cancel_words(self):
        cfg = _valid_config(inputMode="pushToTalk", cancelWords=[])
        errors = validate_config(cfg)
        assert len(errors) == 1
        assert "cancelWords" in errors[0]


class TestSilenceTimeout:
    def test_zero_silence_timeout(self):
        cfg = _valid_config(inputMode="pushToTalk", silenceTimeout=0)
        errors = validate_config(cfg)
        assert len(errors) == 1
        assert "silenceTimeout" in errors[0]

    def test_negative_silence_timeout(self):
        cfg = _valid_config(inputMode="pushToTalk", silenceTimeout=-100)
        errors = validate_config(cfg)
        assert len(errors) == 1
        assert "silenceTimeout" in errors[0]


class TestMaxUtteranceDuration:
    def test_zero_max_utterance_duration(self):
        cfg = _valid_config(inputMode="pushToTalk", maxUtteranceDuration=0)
        errors = validate_config(cfg)
        assert len(errors) == 1
        assert "maxUtteranceDuration" in errors[0]

    def test_negative_max_utterance_duration(self):
        cfg = _valid_config(inputMode="pushToTalk", maxUtteranceDuration=-5000)
        errors = validate_config(cfg)
        assert len(errors) == 1
        assert "maxUtteranceDuration" in errors[0]


class TestMultipleErrors:
    def test_multiple_errors_returned_together(self):
        cfg = _valid_config(
            inputMode="invalid_mode",
            whisperModel="huge",
            submitWords=[],
            cancelWords=[],
            silenceTimeout=-1,
            maxUtteranceDuration=0,
        )
        errors = validate_config(cfg)
        assert len(errors) >= 5
        error_text = " ".join(errors)
        assert "inputMode" in error_text
        assert "whisperModel" in error_text
        assert "submitWords" in error_text
        assert "cancelWords" in error_text
        assert "silenceTimeout" in error_text
        assert "maxUtteranceDuration" in error_text
