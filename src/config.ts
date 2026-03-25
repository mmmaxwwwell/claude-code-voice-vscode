import * as vscode from "vscode";
import type { ConfigMessage, InputMode, WhisperModel } from "./protocol.js";

/**
 * Read VS Code workspace settings and build a ConfigMessage for the sidecar.
 */
export function buildConfigMessage(): ConfigMessage {
  const config = vscode.workspace.getConfiguration("claude-voice");
  return {
    type: "config",
    inputMode: config.get<InputMode>("inputMode", "wakeWord"),
    whisperModel: config.get<WhisperModel>("whisperModel", "base"),
    wakeWord: config.get<string>("wakeWord", "hey_claude"),
    submitWords: config.get<string[]>("submitWords", ["send it", "go", "submit"]),
    cancelWords: config.get<string[]>("cancelWords", ["never mind", "cancel"]),
    silenceTimeout: config.get<number>("silenceTimeout", 1500),
    maxUtteranceDuration: config.get<number>("maxUtteranceDuration", 60000),
    micDevice: config.get<string>("micDevice", ""),
  };
}

/**
 * Watch for VS Code configuration changes affecting claude-voice settings.
 * Calls the callback with an updated ConfigMessage when settings change.
 */
export function createConfigWatcher(
  callback: (config: ConfigMessage) => void
): vscode.Disposable {
  return vscode.workspace.onDidChangeConfiguration((e) => {
    if (e.affectsConfiguration("claude-voice")) {
      callback(buildConfigMessage());
    }
  });
}
