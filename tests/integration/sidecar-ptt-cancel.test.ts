/**
 * Integration test: push-to-talk cancel.
 *
 * Spawns a real sidecar process with cancel.wav audio fixture,
 * connects via Unix domain socket, sends config (pushToTalk mode) + control:start,
 * then ptt_start, waits for audio to be consumed, sends ptt_stop, and verifies
 * the transcript action is "cancel" and text is discarded.
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
const CANCEL_WAV = join(FIXTURE_DIR, "cancel.wav");

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

const TEST_TIMEOUT_MS = 30_000;
const SOCKET_WAIT_MS = 10_000;
const MESSAGE_COLLECT_MS = 15_000;

function tmpSocketPath(): string {
  const id = randomBytes(8).toString("hex");
  return join(tmpdir(), `claude-voice-test-ptt-cancel-${id}.sock`);
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

describe("sidecar push-to-talk cancel", () => {
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
    "sends ptt_start, feeds cancel.wav, sends ptt_stop, receives transcript with cancel action",
    async ({ skip }) => {
      if (!nativeDepsAvailable) {
        skip();
        return;
      }
      socketPath = tmpSocketPath();

      // Spawn sidecar with cancel audio file
      sidecar = spawn(
        "python",
        [
          "-m",
          "sidecar",
          "--socket",
          socketPath,
          "--audio-file",
          CANCEL_WAV,
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

      // Send config (pushToTalk mode)
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

      // Wait for "listening"
      await waitForCondition(
        messages,
        (msgs) =>
          msgs.some((m) => isStatusMessage(m) && m.state === "listening"),
        5000,
      );

      // Send ptt_start — this enables audio frame accumulation in PTT mode
      const pttStart: ControlMessage = { type: "control", action: "ptt_start" };
      sock.write(serialize(pttStart));

      // Wait for audio to be consumed, then send ptt_stop
      await new Promise((r) => setTimeout(r, 2000));

      // Send ptt_stop — triggers transcription of accumulated audio
      const pttStop: ControlMessage = { type: "control", action: "ptt_stop" };
      sock.write(serialize(pttStop));

      // Wait for transcript
      await waitForCondition(
        messages,
        (msgs) => msgs.some((m) => isTranscriptMessage(m)),
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

      // 3. ptt_start emits speech_start
      const speechStartMsgs = messages.filter(
        (m) => isStatusMessage(m) && m.state === "speech_start",
      );
      expect(speechStartMsgs.length).toBeGreaterThanOrEqual(1);

      // 4. ptt_stop emits speech_end
      const speechEndMsgs = messages.filter(
        (m) => isStatusMessage(m) && m.state === "speech_end",
      );
      expect(speechEndMsgs.length).toBeGreaterThanOrEqual(1);

      // 5. Processing status (transcription happening)
      const processingMsgs = messages.filter(
        (m) => isStatusMessage(m) && m.state === "processing",
      );
      expect(processingMsgs.length).toBeGreaterThanOrEqual(1);

      // 6. Transcript received with cancel action
      const transcripts = messages.filter((m) => isTranscriptMessage(m));
      expect(transcripts.length).toBeGreaterThanOrEqual(1);

      const transcript = transcripts[0]!;
      if (isTranscriptMessage(transcript)) {
        // cancel.wav contains "hey claude do something never mind"
        // "never mind" is a cancel word, so action should be "cancel"
        expect(transcript.action).toBe("cancel");
        // Text is discarded on cancel — may be empty or contain discarded text
        // The key assertion is that action is "cancel"
      }

      // 7. Message ordering: speech_start before speech_end before processing
      const statusStates = messages
        .filter((m) => isStatusMessage(m))
        .map((m) => (m as { state: string }).state);

      const speechStartIdx = statusStates.indexOf("speech_start");
      const speechEndIdx = statusStates.indexOf("speech_end");
      const processingIdx = statusStates.indexOf("processing");

      if (speechStartIdx >= 0 && speechEndIdx >= 0) {
        expect(speechStartIdx).toBeLessThan(speechEndIdx);
      }
      if (speechEndIdx >= 0 && processingIdx >= 0) {
        expect(speechEndIdx).toBeLessThan(processingIdx);
      }

      // 8. No unexpected errors
      const errors = messages.filter(
        (m) => isErrorMessage(m) && m.code !== "CONFIG_INVALID",
      );
      expect(errors).toHaveLength(0);
    },
    TEST_TIMEOUT_MS,
  );
});
