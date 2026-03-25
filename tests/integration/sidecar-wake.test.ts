/**
 * Integration test: wake word → transcript end-to-end.
 *
 * Spawns a real sidecar process with audio fixture input (--audio-file),
 * connects via Unix domain socket, sends config + control:start, and
 * verifies the expected message flow:
 *   ready → listening → speech_start → wake_word_detected → speech_end → processing → transcript
 *
 * NOTE: Full end-to-end verification (wake word detection + transcription) requires:
 *   - TTS-generated audio fixtures (regenerate with `python tests/fixtures/generate-fixtures.py --tts`)
 *   - Native dependencies available (faster-whisper, openwakeword, webrtcvad, onnxruntime)
 *   - A wake word model (models/hey_claude.tflite or openWakeWord built-in model)
 *
 * With synthetic audio fixtures, VAD should trigger but wake word detection and
 * transcription may not produce meaningful results.
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
const WAKE_AND_COMMAND_WAV = join(FIXTURE_DIR, "wake-and-command.wav");

/**
 * Check if native ML dependencies required for end-to-end pipeline are available.
 * The sidecar needs numpy, webrtcvad, onnxruntime, openwakeword, and faster-whisper.
 */
let nativeDepsAvailable = false;
beforeAll(() => {
  try {
    execSync(
      "python -c \"import numpy; import webrtcvad; import openwakeword; import faster_whisper\"",
      { cwd: PROJECT_ROOT, timeout: 10_000, stdio: "pipe" },
    );
    nativeDepsAvailable = true;
  } catch {
    nativeDepsAvailable = false;
  }
});

/** Timeout for the entire test (sidecar startup + audio processing). */
const TEST_TIMEOUT_MS = 30_000;

/** Timeout for waiting for the socket file to appear. */
const SOCKET_WAIT_MS = 10_000;

/** Timeout for collecting messages after control:start. */
const MESSAGE_COLLECT_MS = 15_000;

function tmpSocketPath(): string {
  const id = randomBytes(8).toString("hex");
  return join(tmpdir(), `claude-voice-test-${id}.sock`);
}

/**
 * Connect to a Unix domain socket, retrying until it exists or timeout.
 */
function connectWithRetry(
  socketPath: string,
  timeoutMs: number,
): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs;

    function attempt() {
      if (Date.now() > deadline) {
        reject(new Error(`Socket ${socketPath} did not appear within ${timeoutMs}ms`));
        return;
      }

      const sock = createConnection(socketPath);
      sock.once("connect", () => resolve(sock));
      sock.once("error", () => {
        // Socket not ready yet — retry after short delay
        setTimeout(attempt, 100);
      });
    }

    attempt();
  });
}

/**
 * Read NDJSON messages from a socket until timeout or socket closes.
 */
function collectMessages(
  sock: Socket,
  timeoutMs: number,
): Promise<Message[]> {
  return new Promise((resolve) => {
    const messages: Message[] = [];
    let buffer = "";
    let resolved = false;

    function finish() {
      if (!resolved) {
        resolved = true;
        resolve(messages);
      }
    }

    const timer = setTimeout(finish, timeoutMs);

    sock.on("data", (chunk: Buffer) => {
      buffer += chunk.toString("utf-8");
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";

      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          messages.push(deserialize(line));
        } catch {
          // Skip malformed lines
        }
      }
    });

    sock.on("close", () => {
      clearTimeout(timer);
      finish();
    });

    sock.on("error", () => {
      clearTimeout(timer);
      finish();
    });
  });
}

/**
 * Wait until a specific condition is met among collected messages, or timeout.
 */
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

describe("sidecar wake word end-to-end", () => {
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
    "spawns sidecar, feeds wake-and-command.wav, and receives expected message flow",
    // Skip when native ML deps (numpy, webrtcvad, openwakeword, faster-whisper) are unavailable
    async ({ skip }) => {
      if (!nativeDepsAvailable) {
        skip();
        return;
      }
      socketPath = tmpSocketPath();

      // Spawn sidecar with audio file override
      sidecar = spawn(
        "python",
        [
          "-m",
          "sidecar",
          "--socket",
          socketPath,
          "--audio-file",
          WAKE_AND_COMMAND_WAV,
        ],
        {
          cwd: PROJECT_ROOT,
          stdio: ["ignore", "pipe", "pipe"],
          env: {
            ...process.env,
            // Ensure Python can find the sidecar package
            PYTHONPATH: PROJECT_ROOT,
          },
        },
      );

      // Collect stderr for diagnostics on failure
      let stderrOutput = "";
      sidecar.stderr?.on("data", (chunk: Buffer) => {
        stderrOutput += chunk.toString();
      });

      // Wait for sidecar to exit unexpectedly (fail fast) or proceed
      const earlyExitPromise = new Promise<never>((_, reject) => {
        sidecar!.once("exit", (code) => {
          reject(
            new Error(
              `Sidecar exited early with code ${code}.\nstderr: ${stderrOutput}`,
            ),
          );
        });
      });

      // Connect to socket (retry until socket file appears)
      sock = await Promise.race([
        connectWithRetry(socketPath, SOCKET_WAIT_MS),
        earlyExitPromise,
      ]);

      // Start collecting messages in the background
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
            // skip
          }
        }
      });

      // Wait for "ready" status
      await waitForCondition(
        messages,
        (msgs) => msgs.some((m) => isStatusMessage(m) && m.state === "ready"),
        5000,
      );

      // Send config message (wakeWord mode)
      const config: ConfigMessage = {
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
      sock.write(serialize(config));

      // Small delay for config processing
      await new Promise((r) => setTimeout(r, 200));

      // Verify no CONFIG_INVALID error
      const configErrors = messages.filter(
        (m) => isErrorMessage(m) && m.code === "CONFIG_INVALID",
      );
      expect(configErrors).toHaveLength(0);

      // Send control:start
      const control: ControlMessage = { type: "control", action: "start" };
      sock.write(serialize(control));

      // Wait for "listening" status
      await waitForCondition(
        messages,
        (msgs) =>
          msgs.some((m) => isStatusMessage(m) && m.state === "listening"),
        5000,
      );

      // Now wait for audio processing to complete.
      // File-based audio is finite — the sidecar will process all frames and
      // then the audio stream ends. We wait for either:
      //   - A transcript message (full pipeline worked)
      //   - The sidecar to finish processing (socket closes or timeout)
      //   - At minimum: speech_start from VAD detecting the tone bursts
      await waitForCondition(
        messages,
        (msgs) => {
          // Done if we got a transcript
          if (msgs.some((m) => isTranscriptMessage(m))) return true;
          // Done if we got speech_start + processing (pipeline ran)
          const hasProcessing = msgs.some(
            (m) => isStatusMessage(m) && m.state === "processing",
          );
          if (hasProcessing) return true;
          // Done if audio finished (back to listening after speech)
          const statusMsgs = msgs.filter((m) => isStatusMessage(m));
          const listeningCount = statusMsgs.filter(
            (m) => isStatusMessage(m) && m.state === "listening",
          ).length;
          // If we see listening after having seen speech_start, audio is done
          const hasSpeechStart = msgs.some(
            (m) => isStatusMessage(m) && m.state === "speech_start",
          );
          if (hasSpeechStart && listeningCount >= 2) return true;
          return false;
        },
        MESSAGE_COLLECT_MS,
      ).catch(() => {
        // Timeout is acceptable — collect what we have
      });

      // -- Assertions --

      // 1. Should have received "ready" on connect
      const readyMsgs = messages.filter(
        (m) => isStatusMessage(m) && m.state === "ready",
      );
      expect(readyMsgs.length).toBeGreaterThanOrEqual(1);

      // 2. Should have received "listening" after control:start
      const listeningMsgs = messages.filter(
        (m) => isStatusMessage(m) && m.state === "listening",
      );
      expect(listeningMsgs.length).toBeGreaterThanOrEqual(1);

      // 3. Verify speech_start (VAD should trigger on tone bursts in fixture)
      const speechStartMsgs = messages.filter(
        (m) => isStatusMessage(m) && m.state === "speech_start",
      );
      expect(speechStartMsgs.length).toBeGreaterThanOrEqual(1);

      // 4. Verify wake_word_detected
      const wakeWordMsgs = messages.filter(
        (m) => isStatusMessage(m) && m.state === "wake_word_detected",
      );
      expect(wakeWordMsgs.length).toBeGreaterThanOrEqual(1);

      // 5. Verify processing status
      const processingMsgs = messages.filter(
        (m) => isStatusMessage(m) && m.state === "processing",
      );
      expect(processingMsgs.length).toBeGreaterThanOrEqual(1);

      // 6. Verify transcript received with correct structure
      const transcripts = messages.filter((m) => isTranscriptMessage(m));
      expect(transcripts.length).toBeGreaterThanOrEqual(1);

      const transcript = transcripts[0]!;
      if (isTranscriptMessage(transcript)) {
        expect(transcript.action).toBe("submit");
        // Text should have wake word ("hey claude") and submit word ("send it") stripped
        expect(transcript.text).toBeDefined();
        expect(transcript.text.toLowerCase()).not.toContain("hey claude");
        expect(transcript.text.toLowerCase()).not.toContain("send it");
        expect(transcript.text.trim().length).toBeGreaterThan(0);
      }

      // 7. Verify message ordering: speech_start before wake_word_detected before processing
      const statusStates = messages
        .filter((m) => isStatusMessage(m))
        .map((m) => (m as { state: string }).state);

      const speechStartIdx = statusStates.indexOf("speech_start");
      const wakeWordIdx = statusStates.indexOf("wake_word_detected");
      const processingIdx = statusStates.indexOf("processing");

      if (speechStartIdx >= 0 && wakeWordIdx >= 0) {
        expect(speechStartIdx).toBeLessThan(wakeWordIdx);
      }
      if (wakeWordIdx >= 0 && processingIdx >= 0) {
        expect(wakeWordIdx).toBeLessThan(processingIdx);
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
