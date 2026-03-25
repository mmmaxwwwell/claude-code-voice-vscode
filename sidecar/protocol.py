"""NDJSON protocol messages for extension ↔ sidecar communication."""

from __future__ import annotations

import json
from dataclasses import dataclass, fields
from typing import Union


# --- Sidecar → Extension messages ---

@dataclass
class StatusMessage:
    state: str

    @property
    def type(self) -> str:
        return "status"


@dataclass
class TranscriptMessage:
    text: str
    action: str

    @property
    def type(self) -> str:
        return "transcript"


@dataclass
class ErrorMessage:
    code: str
    message: str

    @property
    def type(self) -> str:
        return "error"


# --- Extension → Sidecar messages ---

@dataclass
class ConfigMessage:
    inputMode: str
    whisperModel: str
    wakeWord: str
    submitWords: list[str]
    cancelWords: list[str]
    silenceTimeout: int
    maxUtteranceDuration: int
    micDevice: str

    @property
    def type(self) -> str:
        return "config"


@dataclass
class ControlMessage:
    action: str

    @property
    def type(self) -> str:
        return "control"


Message = Union[StatusMessage, TranscriptMessage, ErrorMessage, ConfigMessage, ControlMessage]

_TYPE_MAP: dict[str, type] = {
    "status": StatusMessage,
    "transcript": TranscriptMessage,
    "error": ErrorMessage,
    "config": ConfigMessage,
    "control": ControlMessage,
}


def serialize(msg: Message) -> str:
    """Serialize a message to an NDJSON line (JSON + newline)."""
    data = {"type": msg.type}
    for f in fields(msg):
        data[f.name] = getattr(msg, f.name)
    return json.dumps(data, separators=(",", ":")) + "\n"


def deserialize(line: str) -> Message:
    """Deserialize an NDJSON line to a typed message.

    Raises ValueError on malformed JSON, missing type, or unknown type.
    """
    line = line.strip()
    if not line:
        raise ValueError("empty message")
    try:
        data = json.loads(line)
    except json.JSONDecodeError as e:
        raise ValueError(f"malformed JSON: {e}") from e

    if not isinstance(data, dict) or "type" not in data:
        raise ValueError("missing 'type' field")

    msg_type = data.pop("type")
    cls = _TYPE_MAP.get(msg_type)
    if cls is None:
        raise ValueError(f"unknown message type: {msg_type!r}")

    try:
        return cls(**data)
    except TypeError as e:
        raise ValueError(f"invalid fields for {msg_type}: {e}") from e
