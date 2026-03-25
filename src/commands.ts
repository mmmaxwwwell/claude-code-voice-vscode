import * as vscode from "vscode";
import { exec } from "node:child_process";
import { createLogger } from "./logger.js";

const logger = createLogger("commands");

/** Map of Python import name to pip install name. */
const PYTHON_DEPENDENCIES: Array<{ importName: string; pipName: string }> = [
  { importName: "faster_whisper", pipName: "faster-whisper" },
  { importName: "openwakeword", pipName: "openwakeword" },
  { importName: "webrtcvad", pipName: "webrtcvad" },
  { importName: "sounddevice", pipName: "sounddevice" },
  { importName: "onnxruntime", pipName: "onnxruntime" },
  { importName: "numpy", pipName: "numpy" },
];

function checkPythonAvailable(): Promise<boolean> {
  return new Promise((resolve) => {
    exec("python3 --version", (err) => {
      resolve(!err);
    });
  });
}

function checkPythonDep(importName: string, pipName: string): Promise<{ pipName: string; ok: boolean }> {
  return new Promise((resolve) => {
    exec(
      `python3 -c "import ${importName}"`,
      (err) => {
        resolve({ pipName, ok: !err });
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
  const ext = vscode.extensions.getExtension("anthropic.claude-code");
  if (!ext) {
    vscode.window.showWarningMessage(
      "Claude Voice: Claude Code extension is not installed. Search for 'Claude Code' in the Extensions view (Ctrl+Shift+X) to install it."
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
  // Check Python availability first
  const pythonOk = await checkPythonAvailable();
  if (!pythonOk) {
    vscode.window.showErrorMessage(
      "Claude Voice: Python 3 is not installed or not in PATH. Install Python 3.11+ from https://python.org and ensure 'python3' is available in your terminal."
    );
    logger.error("Python 3 not found in PATH");
    // Still check Claude Code even if Python is missing
    checkClaudeCodeExtension();
    return;
  }

  // Check Python dependencies
  const results = await Promise.all(
    PYTHON_DEPENDENCIES.map((d) => checkPythonDep(d.importName, d.pipName))
  );
  const missing = results.filter((r) => !r.ok).map((r) => r.pipName);

  if (missing.length > 0) {
    vscode.window.showErrorMessage(
      `Claude Voice: Missing Python packages: ${missing.join(", ")}. ` +
      `Install with: pip install ${missing.join(" ")}`
    );
    logger.warn(`Missing Python packages: ${missing.join(", ")}`);
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
