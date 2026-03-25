// Message types for the Claude Voice socket protocol (NDJSON over Unix domain socket)
// See: specs/001-voice-mode/contracts/socket-protocol.md

// --- Extension → Sidecar ---

export type InputMode = "wakeWord" | "pushToTalk" | "continuousDictation";
export type WhisperModel = "tiny" | "base" | "small" | "medium";
export type ControlAction = "start" | "stop" | "ptt_start" | "ptt_stop";

export interface ConfigMessage {
  type: "config";
  inputMode: InputMode;
  whisperModel: WhisperModel;
  wakeWord: string;
  submitWords: string[];
  cancelWords: string[];
  silenceTimeout: number;
  maxUtteranceDuration: number;
  micDevice: string;
}

export interface ControlMessage {
  type: "control";
  action: ControlAction;
}

// --- Sidecar → Extension ---

export type PipelineState =
  | "listening"
  | "speech_start"
  | "speech_end"
  | "wake_word_detected"
  | "processing"
  | "ready";

export type TranscriptAction = "submit" | "cancel";

export interface StatusMessage {
  type: "status";
  state: PipelineState;
}

export interface TranscriptMessage {
  type: "transcript";
  text: string;
  action: TranscriptAction;
}

export interface ErrorMessage {
  type: "error";
  code: string;
  message: string;
}

// Union types
export type OutgoingMessage = ConfigMessage | ControlMessage;
export type IncomingMessage = StatusMessage | TranscriptMessage | ErrorMessage;
export type Message = OutgoingMessage | IncomingMessage;

// Type guards
export function isConfigMessage(msg: Message): msg is ConfigMessage {
  return msg.type === "config";
}

export function isControlMessage(msg: Message): msg is ControlMessage {
  return msg.type === "control";
}

export function isStatusMessage(msg: Message): msg is StatusMessage {
  return msg.type === "status";
}

export function isTranscriptMessage(msg: Message): msg is TranscriptMessage {
  return msg.type === "transcript";
}

export function isErrorMessage(msg: Message): msg is ErrorMessage {
  return msg.type === "error";
}

// Serialization
export function serialize(msg: Message): string {
  return JSON.stringify(msg) + "\n";
}

const VALID_TYPES = new Set(["config", "control", "status", "transcript", "error"]);

export function deserialize(line: string): Message {
  const trimmed = line.trim();
  if (!trimmed) {
    throw new Error("Empty message");
  }
  const obj = JSON.parse(trimmed);
  if (!obj || typeof obj !== "object" || typeof obj.type !== "string") {
    throw new Error("Invalid message: missing type field");
  }
  if (!VALID_TYPES.has(obj.type)) {
    throw new Error(`Unknown message type: ${obj.type}`);
  }
  validateMessage(obj);
  return obj as Message;
}

function validateMessage(obj: Record<string, unknown>): void {
  switch (obj.type) {
    case "config":
      requireFields(obj, ["inputMode", "whisperModel", "wakeWord", "submitWords", "cancelWords", "silenceTimeout", "maxUtteranceDuration", "micDevice"]);
      break;
    case "control":
      requireFields(obj, ["action"]);
      break;
    case "status":
      requireFields(obj, ["state"]);
      break;
    case "transcript":
      requireFields(obj, ["text", "action"]);
      break;
    case "error":
      requireFields(obj, ["code", "message"]);
      break;
  }
}

function requireFields(obj: Record<string, unknown>, fields: string[]): void {
  for (const field of fields) {
    if (!(field in obj)) {
      throw new Error(`Invalid ${obj.type} message: missing required field '${field}'`);
    }
  }
}
