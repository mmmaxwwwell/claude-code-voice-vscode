import { describe, it, expect } from "vitest";
import {
  type ConfigMessage,
  type ControlMessage,
  type StatusMessage,
  type TranscriptMessage,
  type ErrorMessage,
  isConfigMessage,
  isControlMessage,
  isStatusMessage,
  isTranscriptMessage,
  isErrorMessage,
  serialize,
  deserialize,
} from "../../../src/protocol.js";

// --- Sample messages ---

const sampleConfig: ConfigMessage = {
  type: "config",
  inputMode: "wakeWord",
  whisperModel: "base",
  wakeWord: "hey_claude",
  submitWords: ["send it", "go", "submit"],
  cancelWords: ["never mind", "cancel"],
  silenceTimeout: 1500,
  maxUtteranceDuration: 60000,
  micDevice: "",
};

const sampleControl: ControlMessage = {
  type: "control",
  action: "start",
};

const sampleStatus: StatusMessage = {
  type: "status",
  state: "listening",
};

const sampleTranscript: TranscriptMessage = {
  type: "transcript",
  text: "refactor this function to use async await",
  action: "submit",
};

const sampleError: ErrorMessage = {
  type: "error",
  code: "MIC_NOT_FOUND",
  message: "No microphone device found. Check your audio settings.",
};

// --- Round-trip tests ---

describe("protocol serialize/deserialize", () => {
  it("round-trips ConfigMessage", () => {
    const line = serialize(sampleConfig);
    expect(line.endsWith("\n")).toBe(true);
    const parsed = deserialize(line);
    expect(parsed).toEqual(sampleConfig);
  });

  it("round-trips ControlMessage", () => {
    const line = serialize(sampleControl);
    const parsed = deserialize(line);
    expect(parsed).toEqual(sampleControl);
  });

  it("round-trips StatusMessage", () => {
    const line = serialize(sampleStatus);
    const parsed = deserialize(line);
    expect(parsed).toEqual(sampleStatus);
  });

  it("round-trips TranscriptMessage", () => {
    const line = serialize(sampleTranscript);
    const parsed = deserialize(line);
    expect(parsed).toEqual(sampleTranscript);
  });

  it("round-trips ErrorMessage", () => {
    const line = serialize(sampleError);
    const parsed = deserialize(line);
    expect(parsed).toEqual(sampleError);
  });

  it("round-trips ControlMessage with ptt_start action", () => {
    const msg: ControlMessage = { type: "control", action: "ptt_start" };
    expect(deserialize(serialize(msg))).toEqual(msg);
  });

  it("round-trips TranscriptMessage with cancel action", () => {
    const msg: TranscriptMessage = { type: "transcript", text: "", action: "cancel" };
    expect(deserialize(serialize(msg))).toEqual(msg);
  });

  it("serialize produces compact JSON with trailing newline", () => {
    const line = serialize(sampleStatus);
    expect(line).toBe('{"type":"status","state":"listening"}\n');
  });
});

// --- Malformed JSON rejection ---

describe("deserialize rejects malformed input", () => {
  it("throws on empty string", () => {
    expect(() => deserialize("")).toThrow();
  });

  it("throws on whitespace-only string", () => {
    expect(() => deserialize("   \n")).toThrow();
  });

  it("throws on invalid JSON", () => {
    expect(() => deserialize("{not json}")).toThrow();
  });

  it("throws on JSON without type field", () => {
    expect(() => deserialize('{"foo":"bar"}\n')).toThrow(/type/);
  });

  it("throws on unknown type", () => {
    expect(() => deserialize('{"type":"unknown"}\n')).toThrow(/unknown/i);
  });

  it("throws on JSON array", () => {
    expect(() => deserialize("[1,2,3]\n")).toThrow();
  });

  it("throws on config message missing required fields", () => {
    expect(() => deserialize('{"type":"config","inputMode":"wakeWord"}\n')).toThrow();
  });

  it("throws on status message with extra fields only (missing state)", () => {
    expect(() => deserialize('{"type":"status","foo":"bar"}\n')).toThrow();
  });
});

// --- Type guard tests ---

describe("type guards", () => {
  it("isConfigMessage returns true for config", () => {
    expect(isConfigMessage(sampleConfig)).toBe(true);
  });

  it("isConfigMessage returns false for non-config", () => {
    expect(isConfigMessage(sampleStatus)).toBe(false);
  });

  it("isControlMessage returns true for control", () => {
    expect(isControlMessage(sampleControl)).toBe(true);
  });

  it("isControlMessage returns false for non-control", () => {
    expect(isControlMessage(sampleConfig)).toBe(false);
  });

  it("isStatusMessage returns true for status", () => {
    expect(isStatusMessage(sampleStatus)).toBe(true);
  });

  it("isStatusMessage returns false for non-status", () => {
    expect(isStatusMessage(sampleTranscript)).toBe(false);
  });

  it("isTranscriptMessage returns true for transcript", () => {
    expect(isTranscriptMessage(sampleTranscript)).toBe(true);
  });

  it("isTranscriptMessage returns false for non-transcript", () => {
    expect(isTranscriptMessage(sampleError)).toBe(false);
  });

  it("isErrorMessage returns true for error", () => {
    expect(isErrorMessage(sampleError)).toBe(true);
  });

  it("isErrorMessage returns false for non-error", () => {
    expect(isErrorMessage(sampleControl)).toBe(false);
  });
});
