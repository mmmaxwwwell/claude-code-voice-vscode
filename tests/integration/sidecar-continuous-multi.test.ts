/**
 * Integration test: continuous dictation multi-segment accumulation.
 *
 * Spawns a real sidecar in continuousDictation mode with a multi-segment
 * audio fixture (3 speech segments separated by >1.5s silence gaps).
 * The first two segments contain no command words (accumulated), and the
 * third segment contains "send it" (triggers submit with all accumulated text).
 *
 * Requires native ML dependencies (faster-whisper, webrtcvad, onnxruntime, numpy).
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
  isTranscriptMessage,
  isErrorMessage,
} from "../../src/protocol";

const PROJECT_ROOT = join(__dirname, "..", "..");
const FIXTURE_DIR = join(PROJECT_ROOT, "tests", "fixtures", "audio");
const MULTI_SEGMENT_WAV = join(FIXTURE_DIR, "multi-segment.wav");

/** Check if native ML dependencies are available. */
let nativeDepsAvailable = false;
beforeAll(() => {
  try {
    execSync(
      'python -c "import numpy; import webrtcvad; import openwakeword; import faster_whisper"',
      { cwd: PROJECT_ROOT, timeout: 10_000, stdio: "pipe" },
    );
    nativeDepsAvailable = true;
  } catch {
    nativeDepsAvailable = false;
  }
});

const TEST_TIMEOUT_MS = 60_000;
const SOCKET_WAIT_MS = 10_000;
const MESSAGE_COLLECT_MS = 45_000;

function tmpSocketPath(): string {
  const id = randomBytes(8).toString("hex");
  return join(tmpdir(), `claude-voice-test-multi-${id}.sock`);
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
        reject(new Error("Condition not met within timeout"));
        return;
      }
      setTimeout(check, 50);
    }

    check();
  });
}

describe("sidecar continuous dictation multi-segment accumulation", () => {
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
    "accumulates multiple speech segments and delivers combined transcript on submit command word",
    async ({ skip }) => {
      if (!nativeDepsAvailable) {
        skip();
        return;
      }
      socketPath = tmpSocketPath();

      // Spawn sidecar with multi-segment audio fixture
      sidecar = spawn(
        "python",
        [
          "-m",
          "sidecar",
          "--socket",
          socketPath,
          "--audio-file",
          MULTI_SEGMENT_WAV,
        ],
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

      // Collect messages
      const messages: Message[] = [];
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

      // Wait for "ready"
      await waitForCondition(
        messages,
        (msgs) => msgs.some((m) => isStatusMessage(m) && m.state === "ready"),
        5000,
      );

      // Send config (continuousDictation mode)
      const config: ConfigMessage = {
        type: "config",
        inputMode: "continuousDictation",
        whisperModel: "base",
        wakeWord: "hey_claude",
        submitWords: ["send it", "go", "submit"],
        cancelWords: ["never mind", "cancel"],
        silenceTimeout: 1500,
        maxUtteranceDuration: 60000,
        micDevice: "",
      };
      sock.write(serialize(config));

      await new Promise((r) => setTimeout(r, 200));

      // Verify no config errors
      const configErrors = messages.filter(
        (m) => isErrorMessage(m) && m.code === "CONFIG_INVALID",
      );
      expect(configErrors).toHaveLength(0);

      // Send control:start to initialize audio capture and pipeline
      const controlStart: ControlMessage = {
        type: "control",
        action: "start",
      };
      sock.write(serialize(controlStart));

      // The multi-segment.wav has 3 speech segments separated by >1.5s silence.
      // In continuous dictation mode:
      //   - Segment 1: no command word → accumulated
      //   - Segment 2: no command word → accumulated
      //   - Segment 3: contains "send it" → submit with all accumulated text
      // Wait for a transcript with action "submit"

      await waitForCondition(
        messages,
        (msgs) =>
          msgs.some((m) => isTranscriptMessage(m) && m.action === "submit"),
        MESSAGE_COLLECT_MS,
      ).catch(() => {
        // Timeout — check what we have
      });

      // -- Assertions --

      // 1. Should have received "ready"
      const readyMsgs = messages.filter(
        (m) => isStatusMessage(m) && m.state === "ready",
      );
      expect(readyMsgs.length).toBeGreaterThanOrEqual(1);

      // 2. Should have received "listening"
      const listeningMsgs = messages.filter(
        (m) => isStatusMessage(m) && m.state === "listening",
      );
      expect(listeningMsgs.length).toBeGreaterThanOrEqual(1);

      // 3. VAD should have detected multiple speech segments (multiple speech_start events)
      const speechStartMsgs = messages.filter(
        (m) => isStatusMessage(m) && m.state === "speech_start",
      );
      expect(speechStartMsgs.length).toBeGreaterThanOrEqual(2);

      // 4. Multiple speech_end events (one per VAD segment)
      const speechEndMsgs = messages.filter(
        (m) => isStatusMessage(m) && m.state === "speech_end",
      );
      expect(speechEndMsgs.length).toBeGreaterThanOrEqual(2);

      // 5. Processing events (transcription for each segment)
      const processingMsgs = messages.filter(
        (m) => isStatusMessage(m) && m.state === "processing",
      );
      expect(processingMsgs.length).toBeGreaterThanOrEqual(2);

      // 6. Final transcript: accumulated text from all segments, delivered with "submit"
      const submitTranscripts = messages.filter(
        (m) => isTranscriptMessage(m) && m.action === "submit",
      );
      expect(submitTranscripts.length).toBeGreaterThanOrEqual(1);

      const transcript = submitTranscripts[0]!;
      if (isTranscriptMessage(transcript)) {
        // The combined transcript should contain text (accumulated from all segments)
        expect(transcript.text.trim().length).toBeGreaterThan(0);
        // "send it" command word should be stripped
        expect(transcript.text.toLowerCase()).not.toContain("send it");
      }

      // 7. No unexpected errors
      const errors = messages.filter(
        (m) => isErrorMessage(m) && m.code !== "CONFIG_INVALID",
      );
      expect(errors).toHaveLength(0);
    },
    TEST_TIMEOUT_MS,
  );
});
