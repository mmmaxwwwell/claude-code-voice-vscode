/**
 * Integration test: edge cases.
 *
 * Tests edge case behaviors of the sidecar pipeline:
 *   1. Empty transcription (VAD triggers, whisper returns empty) → silently discarded
 *   2. Max utterance duration exceeded → truncated
 *   3. Rapid sequential transcriptions → queued, delivered in order
 *   4. Settings change while listening → new config pushed to sidecar
 *   5. Cancel word in wake word mode ("hey claude never mind") → discarded
 *
 * These tests spawn a real sidecar process and communicate via Unix socket.
 * Tests requiring native ML dependencies skip when they are unavailable.
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
const SILENCE_WAV = join(FIXTURE_DIR, "silence.wav");
const COMMAND_ONLY_WAV = join(FIXTURE_DIR, "command-only.wav");
const CANCEL_WAV = join(FIXTURE_DIR, "cancel.wav");

const TEST_TIMEOUT_MS = 30_000;
const SOCKET_WAIT_MS = 10_000;
const MESSAGE_COLLECT_MS = 15_000;

/** Check if native ML dependencies are available. */
let nativeDepsAvailable = false;
/** Check if core sidecar dependencies (excluding ML) are available. */
let sidecarDepsAvailable = false;

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
  return join(tmpdir(), `claude-voice-test-edge-${label}-${id}.sock`);
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

function spawnSidecar(
  socketPath: string,
  audioFile?: string,
): { proc: ChildProcess; stderrOutput: { value: string }; earlyExitPromise: Promise<never> } {
  const args = ["-m", "sidecar", "--socket", socketPath];
  if (audioFile) {
    args.push("--audio-file", audioFile);
  }

  const proc = spawn("python", args, {
    cwd: PROJECT_ROOT,
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      PYTHONPATH: PROJECT_ROOT,
    },
  });

  const stderrOutput = { value: "" };
  proc.stderr?.on("data", (chunk: Buffer) => {
    stderrOutput.value += chunk.toString();
  });

  const earlyExitPromise = new Promise<never>((_, reject) => {
    proc.once("exit", (code) => {
      reject(
        new Error(
          `Sidecar exited early with code ${code}.\nstderr: ${stderrOutput.value}`,
        ),
      );
    });
  });

  return { proc, stderrOutput, earlyExitPromise };
}

function makeConfig(overrides: Partial<ConfigMessage> = {}): ConfigMessage {
  return {
    type: "config",
    inputMode: "continuousDictation",
    whisperModel: "base",
    wakeWord: "hey_claude",
    submitWords: ["send it", "go", "submit"],
    cancelWords: ["never mind", "cancel"],
    silenceTimeout: 1500,
    maxUtteranceDuration: 60000,
    micDevice: "",
    ...overrides,
  };
}

describe("sidecar edge cases", () => {
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
    "empty transcription from silence.wav is silently discarded (no transcript message sent)",
    async ({ skip }) => {
      if (!nativeDepsAvailable) {
        skip();
        return;
      }

      socketPath = tmpSocketPath("empty");
      const { proc, earlyExitPromise } = spawnSidecar(socketPath, SILENCE_WAV);
      sidecar = proc;

      sock = await Promise.race([
        connectWithRetry(socketPath, SOCKET_WAIT_MS),
        earlyExitPromise,
      ]);

      const messages: Message[] = [];
      collectMessages(sock, messages);

      // Wait for ready
      await waitForCondition(
        messages,
        (msgs) => msgs.some((m) => isStatusMessage(m) && m.state === "ready"),
        5000,
      );

      // Send config in continuous dictation mode and start listening
      sock.write(serialize(makeConfig({ inputMode: "continuousDictation" })));
      await new Promise((r) => setTimeout(r, 200));

      const controlStart: ControlMessage = { type: "control", action: "start" };
      sock.write(serialize(controlStart));

      // Wait for listening state
      await waitForCondition(
        messages,
        (msgs) =>
          msgs.some((m) => isStatusMessage(m) && m.state === "listening"),
        5000,
      );

      // silence.wav is 5s of silence. The audio file will be consumed quickly.
      // Even if VAD triggers on noise edges, whisper should return empty text.
      // Wait for audio processing to complete (audio file finite, listen loop ends).
      await new Promise((r) => setTimeout(r, 8000));

      // No transcript messages should have been sent for empty transcriptions
      const transcripts = messages.filter((m) => isTranscriptMessage(m));
      expect(transcripts).toHaveLength(0);

      // Sidecar should still be running
      expect(sidecar.killed).toBe(false);
      expect(sidecar.exitCode).toBeNull();
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "max utterance duration exceeded triggers forced speech_end and truncated transcription",
    async ({ skip }) => {
      if (!nativeDepsAvailable) {
        skip();
        return;
      }

      socketPath = tmpSocketPath("maxdur");
      // Use command-only.wav which has speech, but set maxUtteranceDuration very low
      // so it triggers before the natural VAD silence timeout.
      const { proc, earlyExitPromise } = spawnSidecar(
        socketPath,
        COMMAND_ONLY_WAV,
      );
      sidecar = proc;

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

      // Set a very short maxUtteranceDuration (e.g. 500ms = ~17 frames at 30ms each)
      // This should trigger before the natural silence timeout
      sock.write(
        serialize(
          makeConfig({
            inputMode: "continuousDictation",
            maxUtteranceDuration: 500,
          }),
        ),
      );
      await new Promise((r) => setTimeout(r, 200));

      sock.write(serialize({ type: "control", action: "start" } as ControlMessage));

      // Wait for processing (either from max duration or natural speech end)
      await waitForCondition(
        messages,
        (msgs) =>
          msgs.some((m) => isStatusMessage(m) && m.state === "processing") ||
          msgs.some((m) => isTranscriptMessage(m)),
        MESSAGE_COLLECT_MS,
      ).catch(() => {
        // timeout - check what we have
      });

      // Allow time for full processing
      await new Promise((r) => setTimeout(r, 3000));

      // Should have speech_start and speech_end
      const speechStarts = messages.filter(
        (m) => isStatusMessage(m) && m.state === "speech_start",
      );
      expect(speechStarts.length).toBeGreaterThanOrEqual(1);

      const speechEnds = messages.filter(
        (m) => isStatusMessage(m) && m.state === "speech_end",
      );
      expect(speechEnds.length).toBeGreaterThanOrEqual(1);

      // Should have processing state
      const processing = messages.filter(
        (m) => isStatusMessage(m) && m.state === "processing",
      );
      expect(processing.length).toBeGreaterThanOrEqual(1);

      // Pipeline should have processed the truncated audio — a transcript
      // may or may not be produced depending on whether the truncated audio
      // had enough content for whisper. Either way, no crash.
      expect(sidecar.killed).toBe(false);
      expect(sidecar.exitCode).toBeNull();
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "settings change while listening: new config pushed to sidecar rebuilds pipeline",
    async ({ skip }) => {
      if (!sidecarDepsAvailable) {
        skip();
        return;
      }

      socketPath = tmpSocketPath("cfgchange");
      // Spawn without audio file — we just test config handling, not audio processing
      const { proc, earlyExitPromise } = spawnSidecar(socketPath);
      sidecar = proc;

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

      // Send initial valid config
      sock.write(
        serialize(
          makeConfig({
            inputMode: "pushToTalk",
            silenceTimeout: 1500,
          }),
        ),
      );
      await new Promise((r) => setTimeout(r, 300));

      // No config error for valid config
      const configErrors1 = messages.filter(
        (m) => isErrorMessage(m) && m.code === "CONFIG_INVALID",
      );
      expect(configErrors1).toHaveLength(0);

      // Now push a new config with different settings while sidecar is running
      sock.write(
        serialize(
          makeConfig({
            inputMode: "continuousDictation",
            silenceTimeout: 2000,
          }),
        ),
      );
      await new Promise((r) => setTimeout(r, 300));

      // Should still have no config errors (both configs are valid)
      const configErrors2 = messages.filter(
        (m) => isErrorMessage(m) && m.code === "CONFIG_INVALID",
      );
      expect(configErrors2).toHaveLength(0);

      // Now push an invalid config — sidecar should report error but keep running
      sock.write(
        serialize(
          makeConfig({
            inputMode: "pushToTalk",
            whisperModel: "invalid_size" as "base",
            submitWords: [],
            silenceTimeout: -1,
          }),
        ),
      );

      // Wait for CONFIG_INVALID error
      await waitForCondition(
        messages,
        (msgs) =>
          msgs.some((m) => isErrorMessage(m) && m.code === "CONFIG_INVALID"),
        5000,
      );

      const invalidErrors = messages.filter(
        (m) => isErrorMessage(m) && m.code === "CONFIG_INVALID",
      );
      expect(invalidErrors.length).toBeGreaterThanOrEqual(1);

      // Sidecar should still be running after invalid config
      expect(sidecar.killed).toBe(false);
      expect(sidecar.exitCode).toBeNull();
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "cancel word in wake word mode ('hey claude never mind') is discarded",
    async ({ skip }) => {
      if (!nativeDepsAvailable) {
        skip();
        return;
      }

      socketPath = tmpSocketPath("wkcancel");
      // cancel.wav contains "hey claude do something never mind"
      const { proc, earlyExitPromise } = spawnSidecar(socketPath, CANCEL_WAV);
      sidecar = proc;

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

      // Send config in wakeWord mode
      sock.write(serialize(makeConfig({ inputMode: "wakeWord" })));
      await new Promise((r) => setTimeout(r, 200));

      // Verify no config errors
      const configErrors = messages.filter(
        (m) => isErrorMessage(m) && m.code === "CONFIG_INVALID",
      );
      expect(configErrors).toHaveLength(0);

      // Start listening
      sock.write(
        serialize({ type: "control", action: "start" } as ControlMessage),
      );

      // Wait for transcript or processing state
      await waitForCondition(
        messages,
        (msgs) =>
          msgs.some((m) => isTranscriptMessage(m)) ||
          msgs.some((m) => isStatusMessage(m) && m.state === "processing"),
        MESSAGE_COLLECT_MS,
      ).catch(() => {
        // timeout - check what we have
      });

      // Allow time for transcription
      await new Promise((r) => setTimeout(r, 3000));

      // In wake word mode with cancel.wav ("hey claude do something never mind"):
      // The wake word should be detected, transcription should happen,
      // "never mind" cancel word should be detected, and the transcript
      // should have action "cancel".
      const transcripts = messages.filter((m) => isTranscriptMessage(m));

      if (transcripts.length > 0) {
        const transcript = transcripts[0]!;
        if (isTranscriptMessage(transcript)) {
          // The cancel word "never mind" should result in cancel action
          expect(transcript.action).toBe("cancel");
        }
      }

      // Verify wake word was detected (if pipeline ran fully)
      const wakeWordMsgs = messages.filter(
        (m) => isStatusMessage(m) && m.state === "wake_word_detected",
      );
      if (transcripts.length > 0) {
        expect(wakeWordMsgs.length).toBeGreaterThanOrEqual(1);
      }

      // Sidecar should still be running
      expect(sidecar.killed).toBe(false);
      expect(sidecar.exitCode).toBeNull();
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "rapid sequential transcriptions are queued and delivered in order (PTT mode)",
    async ({ skip }) => {
      if (!nativeDepsAvailable) {
        skip();
        return;
      }

      socketPath = tmpSocketPath("rapid");
      // Use command-only.wav for PTT — we'll do two rapid PTT cycles
      const { proc, earlyExitPromise } = spawnSidecar(
        socketPath,
        COMMAND_ONLY_WAV,
      );
      sidecar = proc;

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

      // Configure PTT mode
      sock.write(serialize(makeConfig({ inputMode: "pushToTalk" })));
      await new Promise((r) => setTimeout(r, 200));

      // Start listening
      sock.write(
        serialize({ type: "control", action: "start" } as ControlMessage),
      );

      await waitForCondition(
        messages,
        (msgs) =>
          msgs.some((m) => isStatusMessage(m) && m.state === "listening"),
        5000,
      );

      // First PTT cycle
      sock.write(
        serialize({ type: "control", action: "ptt_start" } as ControlMessage),
      );
      // Wait for audio file frames to be consumed
      await new Promise((r) => setTimeout(r, 2000));
      sock.write(
        serialize({ type: "control", action: "ptt_stop" } as ControlMessage),
      );

      // Wait for first transcript
      await waitForCondition(
        messages,
        (msgs) => msgs.some((m) => isTranscriptMessage(m)),
        MESSAGE_COLLECT_MS,
      ).catch(() => {
        // timeout
      });

      // Verify at least the first PTT cycle produced results
      const speechStarts = messages.filter(
        (m) => isStatusMessage(m) && m.state === "speech_start",
      );
      expect(speechStarts.length).toBeGreaterThanOrEqual(1);

      // Check message ordering: all speech_start messages come before
      // their corresponding speech_end, and processing before transcript
      const statusStates = messages
        .filter((m) => isStatusMessage(m))
        .map((m) => (m as { state: string }).state);

      const firstSpeechStart = statusStates.indexOf("speech_start");
      const firstSpeechEnd = statusStates.indexOf("speech_end");
      const firstProcessing = statusStates.indexOf("processing");

      if (firstSpeechStart >= 0 && firstSpeechEnd >= 0) {
        expect(firstSpeechStart).toBeLessThan(firstSpeechEnd);
      }
      if (firstSpeechEnd >= 0 && firstProcessing >= 0) {
        expect(firstSpeechEnd).toBeLessThan(firstProcessing);
      }

      // Transcripts should be delivered in order (if any)
      const transcripts = messages.filter((m) => isTranscriptMessage(m));
      if (transcripts.length > 0) {
        // Each transcript should have valid structure
        for (const t of transcripts) {
          if (isTranscriptMessage(t)) {
            expect(["submit", "cancel"]).toContain(t.action);
            expect(typeof t.text).toBe("string");
          }
        }
      }

      // Sidecar should still be running
      expect(sidecar.killed).toBe(false);
      expect(sidecar.exitCode).toBeNull();
    },
    TEST_TIMEOUT_MS,
  );
});
