"""Unit tests for command word detection."""

import pytest

from sidecar.command_words import detect_command, Action


class TestDetectCommand:
    """Test command word detection and stripping."""

    # --- Submit words ---

    def test_send_it_suffix(self):
        text, action = detect_command("refactor this send it")
        assert text == "refactor this"
        assert action == Action.SUBMIT

    def test_go_suffix(self):
        text, action = detect_command("explain this code go")
        assert text == "explain this code"
        assert action == Action.SUBMIT

    def test_submit_suffix(self):
        text, action = detect_command("fix the bug submit")
        assert text == "fix the bug"
        assert action == Action.SUBMIT

    # --- Cancel words ---

    def test_never_mind_suffix(self):
        text, action = detect_command("do something never mind")
        assert text == ""
        assert action == Action.CANCEL

    def test_cancel_suffix(self):
        text, action = detect_command("undo that cancel")
        assert text == ""
        assert action == Action.CANCEL

    # --- No command word ---

    def test_no_command_word(self):
        text, action = detect_command("no command word here")
        assert text == "no command word here"
        assert action == Action.NONE

    # --- Case insensitivity ---

    def test_case_insensitive_send_it(self):
        text, action = detect_command("refactor this Send It")
        assert text == "refactor this"
        assert action == Action.SUBMIT

    def test_case_insensitive_never_mind(self):
        text, action = detect_command("do something NEVER MIND")
        assert text == ""
        assert action == Action.CANCEL

    # --- Edge cases ---

    def test_empty_string(self):
        text, action = detect_command("")
        assert text == ""
        assert action == Action.NONE

    def test_only_command_word(self):
        text, action = detect_command("send it")
        assert text == ""
        assert action == Action.SUBMIT

    def test_only_cancel_word(self):
        text, action = detect_command("never mind")
        assert text == ""
        assert action == Action.CANCEL

    def test_command_word_not_at_end(self):
        """Command words only match at the suffix, not in the middle."""
        text, action = detect_command("send it to the server please")
        assert text == "send it to the server please"
        assert action == Action.NONE

    def test_whitespace_stripping(self):
        text, action = detect_command("  refactor this   send it  ")
        assert text == "refactor this"
        assert action == Action.SUBMIT

    def test_cancel_discards_text(self):
        """Cancel action returns empty string regardless of preceding text."""
        text, action = detect_command("write a long function that does many things never mind")
        assert text == ""
        assert action == Action.CANCEL


class TestCustomCommandWords:
    """Test with custom command word lists."""

    def test_custom_submit_words(self):
        text, action = detect_command(
            "do the thing execute",
            submit_words=["execute", "run"],
        )
        assert text == "do the thing"
        assert action == Action.SUBMIT

    def test_custom_cancel_words(self):
        text, action = detect_command(
            "do the thing abort",
            cancel_words=["abort", "stop"],
        )
        assert text == ""
        assert action == Action.CANCEL

    def test_custom_words_override_defaults(self):
        """When custom words are provided, defaults are not used."""
        text, action = detect_command(
            "do the thing send it",
            submit_words=["execute"],
        )
        assert text == "do the thing send it"
        assert action == Action.NONE
