"""Tests for sidecar.logger — structured JSON logging with correlation IDs."""

import json
import logging
import os
from unittest.mock import patch

import pytest

from sidecar.logger import configure_logging, get_logger, with_correlation_id


class TestJsonFormat:
    """Verify log output is valid JSON with required fields."""

    def setup_method(self):
        """Set up a fresh logger and capture handler for each test."""
        # Remove all existing handlers to start clean
        root = logging.getLogger()
        for h in root.handlers[:]:
            root.removeHandler(h)

        configure_logging(level="DEBUG")
        self.logger = get_logger("test_module")

        # Capture output via a handler writing to a list
        self.records: list[str] = []
        self._handler = logging.StreamHandler(self._make_stream())
        # Use the same formatter as configure_logging installs
        root = logging.getLogger()
        if root.handlers:
            self._handler.setFormatter(root.handlers[0].formatter)
        root.addHandler(self._handler)

    def _make_stream(self):
        """Create a fake stream that captures write calls."""

        class FakeStream:
            def __init__(self, records):
                self._records = records

            def write(self, msg):
                stripped = msg.strip()
                if stripped:
                    self._records.append(stripped)

            def flush(self):
                pass

        return FakeStream(self.records)

    def teardown_method(self):
        root = logging.getLogger()
        if self._handler in root.handlers:
            root.removeHandler(self._handler)

    def test_output_is_valid_json(self):
        self.logger.info("hello world")
        assert len(self.records) >= 1
        entry = json.loads(self.records[-1])
        assert isinstance(entry, dict)

    def test_required_fields_present(self):
        self.logger.info("test message")
        entry = json.loads(self.records[-1])
        assert "timestamp" in entry
        assert "level" in entry
        assert "message" in entry
        assert "module" in entry

    def test_timestamp_is_iso8601(self):
        self.logger.info("ts check")
        entry = json.loads(self.records[-1])
        ts = entry["timestamp"]
        # ISO 8601 should contain T separator and timezone info or Z
        assert "T" in ts

    def test_level_matches(self):
        self.logger.warning("warn msg")
        entry = json.loads(self.records[-1])
        assert entry["level"] == "WARNING"

    def test_message_matches(self):
        self.logger.info("specific message text")
        entry = json.loads(self.records[-1])
        assert entry["message"] == "specific message text"

    def test_module_matches(self):
        self.logger.info("module check")
        entry = json.loads(self.records[-1])
        assert entry["module"] == "test_module"

    def test_no_correlation_id_by_default(self):
        self.logger.info("no corr id")
        entry = json.loads(self.records[-1])
        assert "correlationId" not in entry


class TestCorrelationId:
    """Verify with_correlation_id context manager."""

    def setup_method(self):
        root = logging.getLogger()
        for h in root.handlers[:]:
            root.removeHandler(h)

        configure_logging(level="DEBUG")
        self.logger = get_logger("corr_module")

        self.records: list[str] = []
        self._handler = logging.StreamHandler(self._make_stream())
        root = logging.getLogger()
        if root.handlers:
            self._handler.setFormatter(root.handlers[0].formatter)
        root.addHandler(self._handler)

    def _make_stream(self):
        class FakeStream:
            def __init__(self, records):
                self._records = records

            def write(self, msg):
                stripped = msg.strip()
                if stripped:
                    self._records.append(stripped)

            def flush(self):
                pass

        return FakeStream(self.records)

    def teardown_method(self):
        root = logging.getLogger()
        if self._handler in root.handlers:
            root.removeHandler(self._handler)

    def test_correlation_id_attached_inside_context(self):
        with with_correlation_id("req-123"):
            self.logger.info("inside context")
        entry = json.loads(self.records[-1])
        assert entry["correlationId"] == "req-123"

    def test_correlation_id_cleared_outside_context(self):
        with with_correlation_id("req-456"):
            self.logger.info("inside")
        self.logger.info("outside")
        outside_entry = json.loads(self.records[-1])
        assert "correlationId" not in outside_entry

    def test_nested_correlation_id(self):
        with with_correlation_id("outer"):
            self.logger.info("outer log")
            with with_correlation_id("inner"):
                self.logger.info("inner log")
            self.logger.info("back to outer")

        entries = [json.loads(r) for r in self.records]
        assert entries[0]["correlationId"] == "outer"
        assert entries[1]["correlationId"] == "inner"
        assert entries[2]["correlationId"] == "outer"

    def test_correlation_id_cleared_on_exception(self):
        try:
            with with_correlation_id("exc-id"):
                self.logger.info("before error")
                raise ValueError("boom")
        except ValueError:
            pass
        self.logger.info("after exception")
        after_entry = json.loads(self.records[-1])
        assert "correlationId" not in after_entry


class TestLevelFiltering:
    """Verify log level filtering via env var and configure_logging."""

    def setup_method(self):
        root = logging.getLogger()
        for h in root.handlers[:]:
            root.removeHandler(h)

    def _setup_capture(self):
        self.records: list[str] = []

        class FakeStream:
            def __init__(self, records):
                self._records = records

            def write(self, msg):
                stripped = msg.strip()
                if stripped:
                    self._records.append(stripped)

            def flush(self):
                pass

        handler = logging.StreamHandler(FakeStream(self.records))
        root = logging.getLogger()
        if root.handlers:
            handler.setFormatter(root.handlers[0].formatter)
        root.addHandler(handler)
        return handler

    def test_default_level_is_info(self):
        with patch.dict(os.environ, {}, clear=False):
            os.environ.pop("CLAUDE_VOICE_LOG_LEVEL", None)
            configure_logging()
        handler = self._setup_capture()
        logger = get_logger("lvl_test")
        logger.debug("should be filtered")
        logger.info("should appear")
        assert len(self.records) == 1
        entry = json.loads(self.records[0])
        assert entry["message"] == "should appear"
        logging.getLogger().removeHandler(handler)

    def test_env_var_sets_level(self):
        with patch.dict(os.environ, {"CLAUDE_VOICE_LOG_LEVEL": "WARNING"}):
            configure_logging()
        handler = self._setup_capture()
        logger = get_logger("lvl_test2")
        logger.info("filtered out")
        logger.warning("visible")
        assert len(self.records) == 1
        entry = json.loads(self.records[0])
        assert entry["message"] == "visible"
        logging.getLogger().removeHandler(handler)

    def test_explicit_level_overrides_env(self):
        with patch.dict(os.environ, {"CLAUDE_VOICE_LOG_LEVEL": "ERROR"}):
            configure_logging(level="DEBUG")
        handler = self._setup_capture()
        logger = get_logger("lvl_test3")
        logger.debug("should appear with explicit override")
        assert len(self.records) == 1
        logging.getLogger().removeHandler(handler)

    def test_case_insensitive_env_var(self):
        with patch.dict(os.environ, {"CLAUDE_VOICE_LOG_LEVEL": "debug"}):
            configure_logging()
        handler = self._setup_capture()
        logger = get_logger("lvl_test4")
        logger.debug("debug visible")
        assert len(self.records) == 1
        logging.getLogger().removeHandler(handler)
