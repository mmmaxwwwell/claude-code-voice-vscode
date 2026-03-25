"""Structured JSON logger for the Claude Voice sidecar.

Wraps Python's ``logging`` module with a custom formatter that outputs
JSON lines with fields: timestamp, level, message, module, and an
optional correlationId.

Usage::

    from sidecar.logger import configure_logging, get_logger, with_correlation_id

    configure_logging()  # call once at startup
    logger = get_logger(__name__)
    logger.info("ready")

    with with_correlation_id("req-abc"):
        logger.info("processing")  # includes correlationId
"""

from __future__ import annotations

import contextvars
import json
import logging
import os
import sys
from contextlib import contextmanager
from datetime import datetime, timezone
from typing import Iterator

# Context variable holding the current correlation ID (or None).
_correlation_id: contextvars.ContextVar[str | None] = contextvars.ContextVar(
    "correlation_id", default=None
)


class _JsonFormatter(logging.Formatter):
    """Formats log records as single-line JSON objects."""

    def format(self, record: logging.LogRecord) -> str:
        entry: dict[str, str] = {
            "timestamp": datetime.fromtimestamp(
                record.created, tz=timezone.utc
            ).isoformat(),
            "level": record.levelname,
            "message": record.getMessage(),
            "module": record.name,
        }
        corr_id = _correlation_id.get()
        if corr_id is not None:
            entry["correlationId"] = corr_id
        return json.dumps(entry)


def configure_logging(*, level: str | None = None) -> None:
    """Configure the root logger with the JSON formatter.

    Parameters
    ----------
    level:
        Explicit log level name (e.g. ``"DEBUG"``). When *None*, the
        level is read from the ``CLAUDE_VOICE_LOG_LEVEL`` environment
        variable, falling back to ``"INFO"``.
    """
    if level is None:
        level = os.environ.get("CLAUDE_VOICE_LOG_LEVEL", "INFO")

    numeric_level = getattr(logging, level.upper(), logging.INFO)

    root = logging.getLogger()
    # Remove pre-existing handlers to avoid duplicates on re-configure.
    for handler in root.handlers[:]:
        root.removeHandler(handler)

    handler = logging.StreamHandler(sys.stderr)
    handler.setFormatter(_JsonFormatter())
    root.addHandler(handler)
    root.setLevel(numeric_level)


def get_logger(name: str) -> logging.Logger:
    """Return a named logger.  Call :func:`configure_logging` first."""
    return logging.getLogger(name)


@contextmanager
def with_correlation_id(cid: str) -> Iterator[None]:
    """Attach *cid* to every log entry emitted within this context."""
    token = _correlation_id.set(cid)
    try:
        yield
    finally:
        _correlation_id.reset(token)
