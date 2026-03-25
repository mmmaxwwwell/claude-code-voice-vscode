import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock vscode module
const mockShowInformationMessage = vi.fn();
const mockShowWarningMessage = vi.fn();
const mockShowErrorMessage = vi.fn();
const mockGetExtension = vi.fn();

vi.mock("vscode", () => ({
  window: {
    showInformationMessage: (...args: unknown[]) =>
      mockShowInformationMessage(...args),
    showWarningMessage: (...args: unknown[]) =>
      mockShowWarningMessage(...args),
    showErrorMessage: (...args: unknown[]) => mockShowErrorMessage(...args),
    createOutputChannel: vi.fn(() => ({
      appendLine: vi.fn(),
      dispose: vi.fn(),
    })),
  },
  extensions: {
    getExtension: (...args: unknown[]) => mockGetExtension(...args),
  },
  workspace: {
    getConfiguration: vi.fn(() => ({
      get: vi.fn((_key: string, def: unknown) => def),
    })),
  },
}));

// Mock node:child_process exec
const mockExec = vi.fn();
vi.mock("node:child_process", () => ({
  exec: (...args: unknown[]) => mockExec(...args),
}));

import { checkDependencies, checkClaudeCodeExtension } from "../../../src/commands.js";

describe("commands", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("checkDependencies", () => {
    it("should report all dependencies OK when all imports succeed", async () => {
      // exec succeeds (callback with no error)
      mockExec.mockImplementation(
        (_cmd: string, callback: (err: Error | null, stdout: string, stderr: string) => void) => {
          callback(null, "", "");
        }
      );
      mockGetExtension.mockReturnValue({ id: "anthropics.claude-code" });

      await checkDependencies();

      expect(mockShowInformationMessage).toHaveBeenCalledWith(
        expect.stringContaining("All dependencies are installed")
      );
      expect(mockShowErrorMessage).not.toHaveBeenCalled();
      expect(mockShowWarningMessage).not.toHaveBeenCalled();
    });

    it("should report missing Python dependencies when imports fail", async () => {
      // exec fails (callback with error)
      mockExec.mockImplementation(
        (_cmd: string, callback: (err: Error | null, stdout: string, stderr: string) => void) => {
          const err = new Error("ModuleNotFoundError: No module named 'faster_whisper'");
          callback(err, "", "ModuleNotFoundError: No module named 'faster_whisper'");
        }
      );
      mockGetExtension.mockReturnValue({ id: "anthropics.claude-code" });

      await checkDependencies();

      expect(mockShowErrorMessage).toHaveBeenCalledWith(
        expect.stringContaining("Missing Python dependencies")
      );
    });

    it("should report missing Claude Code extension", async () => {
      mockExec.mockImplementation(
        (_cmd: string, callback: (err: Error | null, stdout: string, stderr: string) => void) => {
          callback(null, "", "");
        }
      );
      mockGetExtension.mockReturnValue(undefined);

      await checkDependencies();

      // Should warn about Claude Code, but Python deps are OK
      expect(mockShowWarningMessage).toHaveBeenCalledWith(
        expect.stringContaining("Claude Code extension is not installed")
      );
    });

    it("should report both Python deps and Claude Code missing", async () => {
      mockExec.mockImplementation(
        (_cmd: string, callback: (err: Error | null, stdout: string, stderr: string) => void) => {
          const err = new Error("failed");
          callback(err, "", "No module named 'openwakeword'");
        }
      );
      mockGetExtension.mockReturnValue(undefined);

      await checkDependencies();

      expect(mockShowErrorMessage).toHaveBeenCalledWith(
        expect.stringContaining("Missing Python dependencies")
      );
      expect(mockShowWarningMessage).toHaveBeenCalledWith(
        expect.stringContaining("Claude Code extension is not installed")
      );
    });

    it("should check each required Python dependency individually", async () => {
      const calledCommands: string[] = [];
      mockExec.mockImplementation(
        (cmd: string, callback: (err: Error | null, stdout: string, stderr: string) => void) => {
          calledCommands.push(cmd);
          callback(null, "", "");
        }
      );
      mockGetExtension.mockReturnValue({ id: "anthropics.claude-code" });

      await checkDependencies();

      // Should check for each dependency
      const allCmds = calledCommands.join(" ");
      expect(allCmds).toContain("faster_whisper");
      expect(allCmds).toContain("openwakeword");
      expect(allCmds).toContain("webrtcvad");
      expect(allCmds).toContain("sounddevice");
    });

    it("should identify specific missing dependencies", async () => {
      // First calls succeed, one fails
      let callCount = 0;
      mockExec.mockImplementation(
        (cmd: string, callback: (err: Error | null, stdout: string, stderr: string) => void) => {
          callCount++;
          if (cmd.includes("openwakeword")) {
            callback(new Error("missing"), "", "No module named 'openwakeword'");
          } else {
            callback(null, "", "");
          }
        }
      );
      mockGetExtension.mockReturnValue({ id: "anthropics.claude-code" });

      await checkDependencies();

      expect(mockShowErrorMessage).toHaveBeenCalledWith(
        expect.stringContaining("openwakeword")
      );
    });
  });

  describe("checkClaudeCodeExtension", () => {
    it("should return true when Claude Code is installed", () => {
      mockGetExtension.mockReturnValue({ id: "anthropics.claude-code" });

      const result = checkClaudeCodeExtension();

      expect(result).toBe(true);
      expect(mockGetExtension).toHaveBeenCalledWith("anthropics.claude-code");
    });

    it("should return false and show warning when Claude Code is not installed", () => {
      mockGetExtension.mockReturnValue(undefined);

      const result = checkClaudeCodeExtension();

      expect(result).toBe(false);
      expect(mockShowWarningMessage).toHaveBeenCalledWith(
        expect.stringContaining("Claude Code extension is not installed")
      );
    });
  });
});
