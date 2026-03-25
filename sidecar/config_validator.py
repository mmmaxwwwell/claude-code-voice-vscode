"""Validate ConfigMessage fields before use in the pipeline."""

from __future__ import annotations

import os
from typing import List

from sidecar.protocol import ConfigMessage

VALID_WHISPER_MODELS = {"tiny", "base", "small", "medium"}
VALID_INPUT_MODES = {"wakeWord", "pushToTalk", "continuousDictation"}


def validate_config(config: ConfigMessage) -> List[str]:
    """Validate a ConfigMessage and return a list of error strings.

    Returns an empty list if the config is valid.
    """
    errors: List[str] = []

    if config.inputMode not in VALID_INPUT_MODES:
        errors.append(
            f"inputMode must be one of {sorted(VALID_INPUT_MODES)}, "
            f"got {config.inputMode!r}"
        )

    if config.whisperModel not in VALID_WHISPER_MODELS:
        errors.append(
            f"whisperModel must be one of {sorted(VALID_WHISPER_MODELS)}, "
            f"got {config.whisperModel!r}"
        )

    if config.inputMode == "wakeWord" and not os.path.isfile(config.wakeWord):
        errors.append(
            f"wakeWord file does not exist: {config.wakeWord!r}"
        )

    if not config.submitWords:
        errors.append("submitWords must be a non-empty list")

    if not config.cancelWords:
        errors.append("cancelWords must be a non-empty list")

    if not isinstance(config.silenceTimeout, int) or config.silenceTimeout <= 0:
        errors.append(
            f"silenceTimeout must be a positive integer, "
            f"got {config.silenceTimeout!r}"
        )

    if not isinstance(config.maxUtteranceDuration, int) or config.maxUtteranceDuration <= 0:
        errors.append(
            f"maxUtteranceDuration must be a positive integer, "
            f"got {config.maxUtteranceDuration!r}"
        )

    return errors
