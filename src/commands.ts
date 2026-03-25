import * as vscode from "vscode";
import { exec } from "node:child_process";
import { createLogger } from "./logger.js";

const logger = createLogger("commands");

const PYTHON_DEPENDENCIES = [
  "faster_whisper",
  "openwakeword",
  "webrtcvad",
  "sounddevice",
  "onnxruntime",
  "numpy",
];

function checkPythonDep(dep: string): Promise<{ dep: string; ok: boolean }> {
  return new Promise((resolve) => {
    exec(
      `python3 -c "import ${dep}"`,
      (err) => {
        resolve({ dep, ok: !err });
      }
    );
  });
}

/**
 * Check if the Claude Code extension is installed.
 * Shows a warning notification if not found.
 * Returns true if installed, false otherwise.
 */
export function checkClaudeCodeExtension(): boolean {
  const ext = vscode.extensions.getExtension("anthropics.claude-code");
  if (!ext) {
    vscode.window.showWarningMessage(
      "Claude Voice: Claude Code extension is not installed. Install it for voice commands to work."
    );
    return false;
  }
  return true;
}

/**
 * Run the full dependency check: Python deps + Claude Code extension.
 * Reports results via VS Code notifications.
 */
export async function checkDependencies(): Promise<void> {
  // Check Python dependencies
  const results = await Promise.all(
    PYTHON_DEPENDENCIES.map((dep) => checkPythonDep(dep))
  );
  const missing = results.filter((r) => !r.ok).map((r) => r.dep);

  if (missing.length > 0) {
    vscode.window.showErrorMessage(
      `Claude Voice: Missing Python dependencies: ${missing.join(", ")}. Install them with: pip install ${missing.join(" ")}`
    );
    logger.warn(`Missing Python dependencies: ${missing.join(", ")}`);
  }

  // Check Claude Code extension
  const claudeCodeOk = checkClaudeCodeExtension();

  // If everything is OK, show success
  if (missing.length === 0 && claudeCodeOk) {
    vscode.window.showInformationMessage(
      "Claude Voice: All dependencies are installed."
    );
    logger.info("All dependencies verified successfully");
  }
}
