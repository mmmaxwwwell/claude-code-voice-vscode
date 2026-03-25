"""Command word detection for voice transcripts.

Scans transcript suffix for submit/cancel command words (case-insensitive),
strips matched words, and returns the cleaned text with the detected action.
"""

from __future__ import annotations

import enum
import re

DEFAULT_SUBMIT_WORDS: list[str] = ["send it", "go", "submit"]
DEFAULT_CANCEL_WORDS: list[str] = ["never mind", "cancel"]


class Action(enum.Enum):
    SUBMIT = "submit"
    CANCEL = "cancel"
    NONE = "none"


def detect_command(
    transcript: str,
    *,
    submit_words: list[str] | None = None,
    cancel_words: list[str] | None = None,
) -> tuple[str, Action]:
    """Scan transcript suffix for command words.

    Returns (cleaned_text, action) where action is submit, cancel, or none.
    Cancel action discards all text (returns empty string).
    """
    text = transcript.strip()
    if not text:
        return ("", Action.NONE)

    effective_submit = submit_words if submit_words is not None else DEFAULT_SUBMIT_WORDS
    effective_cancel = cancel_words if cancel_words is not None else DEFAULT_CANCEL_WORDS

    # Check cancel words first (longer phrases checked before shorter ones)
    for word in sorted(effective_cancel, key=len, reverse=True):
        pattern = re.compile(r"\s+" + re.escape(word) + r"\s*$", re.IGNORECASE)
        if pattern.search(text):
            return ("", Action.CANCEL)
        # Also match if the entire text is just the command word
        if text.lower().strip() == word.lower():
            return ("", Action.CANCEL)

    # Check submit words
    for word in sorted(effective_submit, key=len, reverse=True):
        pattern = re.compile(r"\s+" + re.escape(word) + r"\s*$", re.IGNORECASE)
        match = pattern.search(text)
        if match:
            cleaned = text[: match.start()].strip()
            return (cleaned, Action.SUBMIT)
        # Entire text is just the command word
        if text.lower().strip() == word.lower():
            return ("", Action.SUBMIT)

    return (text, Action.NONE)
