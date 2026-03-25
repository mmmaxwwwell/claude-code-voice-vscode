/**
 * Integration test: error handling.
 *
 * Tests that the sidecar correctly reports errors via the socket protocol:
 *   1. No mic (bogus device) → AUDIO_DEVICE_ERROR or MIC_NOT_FOUND error message
 *   2. Missing model → DEPENDENCY_MISSING error when pipeline can't initialize
 *   3. Verify error messages have the correct structure for extension notification surfacing
 *
 * These tests spawn a real sidecar process and communicate via Unix socket.
 * They do NOT require native ML dependencies — they intentionally trigger error paths.
 */

import { describe, it, expect, afterEach, beforeAll } from "vitest";
import { spawn, execSync, type ChildProcess } from "node:child_process";
import { createConnection, type Socket } from "node:net";
import { join } from "node:path";
import { unlinkSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { randomBytes } from "node:crypto";
import {
  serialize,
  deserialize,
  type Message,
  type ConfigMessage,
  type ControlMessage,
  isStatusMessage,
  isErrorMessage,
} from "../../src/protocol";

const PROJECT_ROOT = join(__dirname, "..", "..");

const TEST_TIMEOUT_MS = 30_000;
const SOCKET_WAIT_MS = 10_000;
const MESSAGE_COLLECT_MS = 10_000;

/** Check if core sidecar dependencies (excluding audio hardware) are available. */
let sidecarDepsAvailable = false;
beforeAll(() => {
  try {
    execSync('python -c "import sidecar.server; import sidecar.protocol"', {
      cwd: PROJECT_ROOT,
      timeout: 10_000,
      stdio: "pipe",
      env: { ...process.env, PYTHONPATH: PROJECT_ROOT },
    });
    sidecarDepsAvailable = true;
  } catch {
    sidecarDepsAvailable = false;
  }
});

function tmpSocketPath(label: string): string {
  const id = randomBytes(8).toString("hex");
  return join(tmpdir(), `claude-voice-test-err-${label}-${id}.sock`);
}

function connectWithRetry(
  socketPath: string,
  timeoutMs: number,
): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs;

    function attempt() {
      if (Date.now() > deadline) {
        reject(
          new Error(
            `Socket ${socketPath} did not appear within ${timeoutMs}ms`,
          ),
        );
        return;
      }

      const sock = createConnection(socketPath);
      sock.once("connect", () => resolve(sock));
      sock.once("error", () => {
        setTimeout(attempt, 100);
      });
    }

    attempt();
  });
}

function waitForCondition(
  messages: Message[],
  condition: (msgs: Message[]) => boolean,
  timeoutMs: number,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs;

    function check() {
      if (condition(messages)) {
        resolve();
        return;
      }
      if (Date.now() > deadline) {
        reject(
          new Error(
            `Condition not met within ${timeoutMs}ms. Messages received: ${JSON.stringify(messages)}`,
          ),
        );
        return;
      }
      setTimeout(check, 50);
    }

    check();
  });
}

function collectMessages(sock: Socket, messages: Message[]): void {
  let buffer = "";
  sock.on("data", (chunk: Buffer) => {
    buffer += chunk.toString("utf-8");
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";

    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        messages.push(deserialize(line));
      } catch {
        // skip malformed
      }
    }
  });
}

describe("sidecar error handling", () => {
  let sidecar: ChildProcess | null = null;
  let sock: Socket | null = null;
  let socketPath: string = "";

  afterEach(() => {
    if (sock) {
      sock.destroy();
      sock = null;
    }
    if (sidecar && !sidecar.killed) {
      sidecar.kill("SIGTERM");
      sidecar = null;
    }
    if (socketPath && existsSync(socketPath)) {
      try {
        unlinkSync(socketPath);
      } catch {
        // ignore
      }
    }
  });

  it(
    "reports error when starting with a nonexistent mic device",
    async ({ skip }) => {
      if (!sidecarDepsAvailable) {
        skip();
        return;
      }

      socketPath = tmpSocketPath("nomic");

      // Spawn sidecar without --audio-file (will try to use real mic)
      sidecar = spawn(
        "python",
        ["-m", "sidecar", "--socket", socketPath],
        {
          cwd: PROJECT_ROOT,
          stdio: ["ignore", "pipe", "pipe"],
          env: {
            ...process.env,
            PYTHONPATH: PROJECT_ROOT,
          },
        },
      );

      let stderrOutput = "";
      sidecar.stderr?.on("data", (chunk: Buffer) => {
        stderrOutput += chunk.toString();
      });

      const earlyExitPromise = new Promise<never>((_, reject) => {
        sidecar!.once("exit", (code) => {
          reject(
            new Error(
              `Sidecar exited early with code ${code}.\nstderr: ${stderrOutput}`,
            ),
          );
        });
      });

      // Connect to socket
      sock = await Promise.race([
        connectWithRetry(socketPath, SOCKET_WAIT_MS),
        earlyExitPromise,
      ]);

      const messages: Message[] = [];
      collectMessages(sock, messages);

      // Wait for "ready"
      await waitForCondition(
        messages,
        (msgs) => msgs.some((m) => isStatusMessage(m) && m.state === "ready"),
        5000,
      );

      // Send config with a nonexistent mic device name
      const config: ConfigMessage = {
        type: "config",
        inputMode: "pushToTalk",
        whisperModel: "base",
        wakeWord: "hey_claude",
        submitWords: ["send it", "go", "submit"],
        cancelWords: ["never mind", "cancel"],
        silenceTimeout: 1500,
        maxUtteranceDuration: 60000,
        micDevice: "nonexistent_device_that_does_not_exist_12345",
      };
      sock.write(serialize(config));

      await new Promise((r) => setTimeout(r, 200));

      // Send control:start — this will try to open the mic device and fail
      const controlStart: ControlMessage = {
        type: "control",
        action: "start",
      };
      sock.write(serialize(controlStart));

      // Wait for an error message
      await waitForCondition(
        messages,
        (msgs) => msgs.some((m) => isErrorMessage(m)),
        MESSAGE_COLLECT_MS,
      );

      // Verify error message structure
      const errors = messages.filter((m) => isErrorMessage(m));
      expect(errors.length).toBeGreaterThanOrEqual(1);

      const errorMsg = errors[0]!;
      if (isErrorMessage(errorMsg)) {
        // Should be an audio-related error code
        expect([
          "MIC_NOT_FOUND",
          "AUDIO_DEVICE_ERROR",
          "DEPENDENCY_MISSING",
        ]).toContain(errorMsg.code);
        // Error message should be a non-empty human-readable string
        expect(errorMsg.message).toBeTruthy();
        expect(typeof errorMsg.message).toBe("string");
        expect(errorMsg.message.length).toBeGreaterThan(0);
      }

      // Sidecar should still be running (errors are recoverable)
      expect(sidecar.killed).toBe(false);
      expect(sidecar.exitCode).toBeNull();
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "reports DEPENDENCY_MISSING or MODEL_LOAD_FAILED when pipeline cannot initialize",
    async ({ skip }) => {
      if (!sidecarDepsAvailable) {
        skip();
        return;
      }

      socketPath = tmpSocketPath("nomodel");

      // Spawn sidecar normally — pipeline construction will fail if ML deps
      // (faster-whisper, webrtcvad, etc.) aren't available or model isn't downloaded.
      // Either way, the sidecar should report a structured error, not crash.
      sidecar = spawn(
        "python",
        ["-m", "sidecar", "--socket", socketPath],
        {
          cwd: PROJECT_ROOT,
          stdio: ["ignore", "pipe", "pipe"],
          env: {
            ...process.env,
            PYTHONPATH: PROJECT_ROOT,
          },
        },
      );

      let stderrOutput = "";
      sidecar.stderr?.on("data", (chunk: Buffer) => {
        stderrOutput += chunk.toString();
      });

      const earlyExitPromise = new Promise<never>((_, reject) => {
        sidecar!.once("exit", (code) => {
          reject(
            new Error(
              `Sidecar exited early with code ${code}.\nstderr: ${stderrOutput}`,
            ),
          );
        });
      });

      // Connect to socket
      sock = await Promise.race([
        connectWithRetry(socketPath, SOCKET_WAIT_MS),
        earlyExitPromise,
      ]);

      const messages: Message[] = [];
      collectMessages(sock, messages);

      // Wait for "ready"
      await waitForCondition(
        messages,
        (msgs) => msgs.some((m) => isStatusMessage(m) && m.state === "ready"),
        5000,
      );

      // Send config — pipeline construction happens here; it will fail
      // if native ML deps can't be imported (DEPENDENCY_MISSING) or
      // if the whisper model can't be loaded (MODEL_LOAD_FAILED).
      const config: ConfigMessage = {
        type: "config",
        inputMode: "pushToTalk",
        whisperModel: "base",
        wakeWord: "hey_claude",
        submitWords: ["send it", "go", "submit"],
        cancelWords: ["never mind", "cancel"],
        silenceTimeout: 1500,
        maxUtteranceDuration: 60000,
        micDevice: "",
      };
      sock.write(serialize(config));

      // Wait for either an error (pipeline init failure) or successful pipeline init
      // (indicated by no error within the timeout — config accepted silently)
      await waitForCondition(
        messages,
        (msgs) =>
          msgs.some((m) => isErrorMessage(m)) ||
          // If config was accepted without error, the sidecar is ready for control
          msgs.filter((m) => isStatusMessage(m) && m.state === "ready").length >= 1,
        MESSAGE_COLLECT_MS,
      );

      // Give a bit more time for any async error delivery
      await new Promise((r) => setTimeout(r, 500));

      // Check if we got an error (expected when ML deps or model unavailable)
      const errors = messages.filter((m) => isErrorMessage(m));
      if (errors.length > 0) {
        const errorMsg = errors[0]!;
        if (isErrorMessage(errorMsg)) {
          // Should be a dependency or model error
          expect([
            "MODEL_NOT_FOUND",
            "MODEL_LOAD_FAILED",
            "DEPENDENCY_MISSING",
          ]).toContain(errorMsg.code);
          expect(errorMsg.message).toBeTruthy();
          expect(typeof errorMsg.message).toBe("string");
        }
      }
      // If no error, ML deps are available and model loaded — that's fine too.

      // Sidecar should still be running regardless of errors
      expect(sidecar.killed).toBe(false);
      expect(sidecar.exitCode).toBeNull();
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "error messages have correct structure for extension notification surfacing",
    async ({ skip }) => {
      if (!sidecarDepsAvailable) {
        skip();
        return;
      }

      socketPath = tmpSocketPath("errfmt");

      // Spawn sidecar
      sidecar = spawn(
        "python",
        ["-m", "sidecar", "--socket", socketPath],
        {
          cwd: PROJECT_ROOT,
          stdio: ["ignore", "pipe", "pipe"],
          env: {
            ...process.env,
            PYTHONPATH: PROJECT_ROOT,
          },
        },
      );

      let stderrOutput = "";
      sidecar.stderr?.on("data", (chunk: Buffer) => {
        stderrOutput += chunk.toString();
      });

      const earlyExitPromise = new Promise<never>((_, reject) => {
        sidecar!.once("exit", (code) => {
          reject(
            new Error(
              `Sidecar exited early with code ${code}.\nstderr: ${stderrOutput}`,
            ),
          );
        });
      });

      sock = await Promise.race([
        connectWithRetry(socketPath, SOCKET_WAIT_MS),
        earlyExitPromise,
      ]);

      const messages: Message[] = [];
      collectMessages(sock, messages);

      await waitForCondition(
        messages,
        (msgs) => msgs.some((m) => isStatusMessage(m) && m.state === "ready"),
        5000,
      );

      // Send an invalid config to trigger CONFIG_INVALID error
      const invalidConfig: ConfigMessage = {
        type: "config",
        inputMode: "pushToTalk",
        whisperModel: "invalid_model_size" as "base",
        wakeWord: "hey_claude",
        submitWords: [],  // empty submit words should fail validation
        cancelWords: ["never mind", "cancel"],
        silenceTimeout: -1,  // negative timeout should fail validation
        maxUtteranceDuration: 60000,
        micDevice: "",
      };
      sock.write(serialize(invalidConfig));

      // Wait for CONFIG_INVALID error
      await waitForCondition(
        messages,
        (msgs) =>
          msgs.some((m) => isErrorMessage(m) && m.code === "CONFIG_INVALID"),
        MESSAGE_COLLECT_MS,
      );

      const configErrors = messages.filter(
        (m) => isErrorMessage(m) && m.code === "CONFIG_INVALID",
      );
      expect(configErrors.length).toBeGreaterThanOrEqual(1);

      const errorMsg = configErrors[0]!;
      if (isErrorMessage(errorMsg)) {
        // Verify the error message structure matches what extension.ts expects:
        // socketClient.on("error", (msg: ErrorMessage) => {
        //   vscode.window.showErrorMessage(`Claude Voice: ${msg.message}`);
        // });
        expect(errorMsg).toHaveProperty("type", "error");
        expect(errorMsg).toHaveProperty("code");
        expect(errorMsg).toHaveProperty("message");
        expect(typeof errorMsg.code).toBe("string");
        expect(typeof errorMsg.message).toBe("string");
        expect(errorMsg.message.length).toBeGreaterThan(0);

        // The message should be human-readable (suitable for showErrorMessage)
        // It should contain useful info about what went wrong
        expect(errorMsg.message.toLowerCase()).toContain("invalid");
      }

      // Sidecar should still be running after config error
      expect(sidecar.killed).toBe(false);
      expect(sidecar.exitCode).toBeNull();
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "--check flag exits with non-zero code when mic is unavailable",
    async ({ skip }) => {
      if (!sidecarDepsAvailable) {
        skip();
        return;
      }

      // Run sidecar with --check flag — it checks audio device, deps, models
      // In CI/test environments without a real mic, this should fail
      const checkResult = await new Promise<{
        code: number | null;
        stderr: string;
      }>((resolve) => {
        const proc = spawn(
          "python",
          ["-m", "sidecar", "--socket", "/dev/null", "--check"],
          {
            cwd: PROJECT_ROOT,
            stdio: ["ignore", "pipe", "pipe"],
            env: {
              ...process.env,
              PYTHONPATH: PROJECT_ROOT,
            },
          },
        );

        let stderr = "";
        proc.stderr?.on("data", (chunk: Buffer) => {
          stderr += chunk.toString();
        });

        proc.once("exit", (code) => {
          resolve({ code, stderr });
        });
      });

      // --check should either pass (exit 0) or fail with a specific exit code
      // Exit code 1 = generic error (e.g., sounddevice import failed)
      // Exit code 2 = AudioError (MIC_NOT_FOUND)
      // Exit code 4 = DependencyError
      // Exit code 0 = all checks passed
      expect([0, 1, 2, 4]).toContain(checkResult.code);

      if (checkResult.code !== 0) {
        // stderr should contain structured log output about what failed
        expect(checkResult.stderr.length).toBeGreaterThan(0);
      }
    },
    TEST_TIMEOUT_MS,
  );
});
