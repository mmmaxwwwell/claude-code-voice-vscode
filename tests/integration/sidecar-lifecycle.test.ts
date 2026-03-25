/**
 * Integration test: sidecar lifecycle.
 *
 * Tests SidecarManager with real child processes:
 *   1. Spawn sidecar, verify it starts and socket connection works
 *   2. Kill sidecar, verify auto-restart
 *   3. Kill 3x in <60s, verify circuit breaker stops
 *
 * Uses lightweight Python stub scripts instead of the full sidecar
 * to avoid native dependency requirements while testing lifecycle logic.
 *
 * Strategy: Override SidecarManager's private _spawnProcess method at the
 * prototype level so it spawns our stub script instead of `python -m sidecar`.
 */

import { describe, it, expect, afterEach, vi, beforeEach } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { createConnection, type Socket } from "node:net";
import { join } from "node:path";
import {
  existsSync,
  unlinkSync,
  writeFileSync,
  mkdtempSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { randomBytes } from "node:crypto";

// Mock vscode before importing SidecarManager
vi.mock("vscode", () => ({
  window: {
    showErrorMessage: vi.fn(),
  },
  workspace: {
    getConfiguration: vi.fn(() => ({
      get: vi.fn((_key: string, defaultValue: unknown) => defaultValue),
    })),
  },
}));

import { SidecarManager } from "../../src/sidecar.js";

/** Timeout for individual test cases. */
const TEST_TIMEOUT_MS = 30_000;

/** Max wait for a socket to appear and accept connections. */
const SOCKET_WAIT_MS = 8_000;

/** Path to python3 — resolved once. */
const PYTHON3 = "/run/current-system/sw/bin/python3";

/**
 * Minimal Python stub sidecar that:
 * - Parses --socket from argv (ignores -m sidecar)
 * - Creates a Unix socket server
 * - Sends {"type":"status","state":"ready"} on client connect
 * - Waits for SIGTERM to shut down
 */
const STUB_SIDECAR_SCRIPT = `
import asyncio, os, signal, sys, json

async def main():
    socket_path = None
    args = sys.argv[1:]
    i = 0
    while i < len(args):
        if args[i] == "--socket" and i + 1 < len(args):
            socket_path = args[i + 1]
            break
        i += 1

    if not socket_path:
        print("Missing --socket argument", file=sys.stderr, flush=True)
        sys.exit(1)

    shutdown = asyncio.Event()
    loop = asyncio.get_running_loop()
    for sig in (signal.SIGTERM, signal.SIGINT):
        loop.add_signal_handler(sig, shutdown.set)

    async def handle_client(reader, writer):
        msg = json.dumps({"type": "status", "state": "ready"}) + "\\n"
        writer.write(msg.encode())
        await writer.drain()
        try:
            while not shutdown.is_set():
                await asyncio.sleep(0.5)
        except Exception:
            pass
        writer.close()

    server = await asyncio.start_unix_server(handle_client, path=socket_path)
    async with server:
        await shutdown.wait()
    if os.path.exists(socket_path):
        os.unlink(socket_path)

asyncio.run(main())
`;

function tmpSocketPath(): string {
  const id = randomBytes(8).toString("hex");
  return join(tmpdir(), `claude-voice-lifecycle-${id}.sock`);
}

/**
 * Try to connect to a Unix socket, retrying until success or timeout.
 */
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

/**
 * Wait for a condition to become true, polling every intervalMs.
 */
function waitFor(
  condition: () => boolean,
  timeoutMs: number,
  intervalMs = 50,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs;

    function check() {
      if (condition()) {
        resolve();
        return;
      }
      if (Date.now() > deadline) {
        reject(new Error("waitFor timed out"));
        return;
      }
      setTimeout(check, intervalMs);
    }

    check();
  });
}

/**
 * Patch SidecarManager._spawnProcess to spawn a specific Python script
 * instead of `python3 -m sidecar`. The patch persists across restarts.
 */
function patchSpawn(manager: SidecarManager, pythonScript: string): void {
  const self = manager as unknown as Record<string, unknown>;

  self._spawnProcess = function (this: typeof self) {
    const proc = spawn(PYTHON3, [pythonScript, "--socket", this._socketPath as string], {
      stdio: ["ignore", "pipe", "pipe"],
    });

    this._process = proc;

    proc.on("close", (code: number | null, signal: string | null) => {
      this._process = null;
      (manager as unknown as { emit: (event: string, ...args: unknown[]) => void }).emit("stopped", code);
      (this as Record<string, unknown>)._handleExit(code, signal);
    });

    (manager as unknown as { emit: (event: string, ...args: unknown[]) => void }).emit("started");
  };
}

describe("sidecar lifecycle", () => {
  let manager: SidecarManager;
  let socketPath: string;
  let tmpDir: string;
  let sockets: Socket[] = [];

  beforeEach(() => {
    vi.clearAllMocks();
    socketPath = tmpSocketPath();
    tmpDir = mkdtempSync(join(tmpdir(), "sidecar-lifecycle-"));
    sockets = [];
  });

  afterEach(async () => {
    for (const sock of sockets) {
      sock.destroy();
    }
    sockets = [];

    if (manager) {
      manager.dispose();
    }

    await new Promise((r) => setTimeout(r, 300));

    if (socketPath && existsSync(socketPath)) {
      try {
        unlinkSync(socketPath);
      } catch {
        // ignore
      }
    }

    try {
      rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  it(
    "spawns sidecar and accepts socket connection",
    async () => {
      const stubPath = join(tmpDir, "stub_sidecar.py");
      writeFileSync(stubPath, STUB_SIDECAR_SCRIPT);

      manager = new SidecarManager(socketPath);
      manager.on("error", () => {});
      patchSpawn(manager, stubPath);

      const startedPromise = new Promise<void>((resolve) =>
        manager.once("started", resolve),
      );

      await manager.start();
      await startedPromise;
      expect(manager.running).toBe(true);

      // Connect to the socket
      const sock = await connectWithRetry(socketPath, SOCKET_WAIT_MS);
      sockets.push(sock);

      // Read the "ready" status message
      const data = await new Promise<string>((resolve) => {
        sock.once("data", (chunk: Buffer) => resolve(chunk.toString("utf-8")));
      });

      const msg = JSON.parse(data.trim());
      expect(msg.type).toBe("status");
      expect(msg.state).toBe("ready");
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "auto-restarts sidecar after unexpected exit",
    async () => {
      const stubPath = join(tmpDir, "stub_sidecar.py");
      writeFileSync(stubPath, STUB_SIDECAR_SCRIPT);

      manager = new SidecarManager(socketPath);
      manager.on("error", () => {});
      patchSpawn(manager, stubPath);

      let startCount = 0;
      manager.on("started", () => {
        startCount++;
      });

      await manager.start();
      expect(manager.running).toBe(true);

      // Verify initial process is connectable
      let sock = await connectWithRetry(socketPath, SOCKET_WAIT_MS);
      sockets.push(sock);
      sock.destroy();

      // Kill the sidecar process with SIGKILL to simulate a crash
      const stoppedPromise = new Promise<void>((resolve) =>
        manager.once("stopped", resolve),
      );

      const proc = (
        manager as unknown as { _process: ChildProcess }
      )._process;
      proc.kill("SIGKILL");

      await stoppedPromise;

      // Wait for the auto-restart (RESTART_DELAY_MS = 1000ms + socket startup)
      await waitFor(() => startCount >= 2, 5000, 100);

      expect(startCount).toBe(2);
      expect(manager.running).toBe(true);

      // Wait for the new socket to be ready
      await new Promise((r) => setTimeout(r, 500));

      // Verify the restarted sidecar accepts connections
      sock = await connectWithRetry(socketPath, SOCKET_WAIT_MS);
      sockets.push(sock);

      const data = await new Promise<string>((resolve) => {
        sock.once("data", (chunk: Buffer) => resolve(chunk.toString("utf-8")));
      });

      const msg = JSON.parse(data.trim());
      expect(msg.type).toBe("status");
      expect(msg.state).toBe("ready");
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "circuit breaker stops restarts after 3 crashes in <60s",
    async () => {
      // Script that exits immediately with code 1 (simulates crash)
      const crashScript = join(tmpDir, "crash_sidecar.py");
      writeFileSync(crashScript, "import sys; sys.exit(1)\n");

      manager = new SidecarManager(socketPath);
      patchSpawn(manager, crashScript);

      const errors: Error[] = [];
      manager.on("error", (err) => {
        errors.push(err);
      });

      let startCount = 0;
      manager.on("started", () => {
        startCount++;
      });

      let stopCount = 0;
      manager.on("stopped", () => {
        stopCount++;
      });

      await manager.start();

      // The crash script exits immediately with code 1.
      // SidecarManager will:
      //   crash 1 → record timestamp, wait 1s → restart (start #2)
      //   crash 2 → record timestamp, wait 1s → restart (start #3)
      //   crash 3 → 3 crashes in window → circuit breaker trips, no restart

      await waitFor(() => errors.length >= 1, 10_000, 100);

      expect(errors.length).toBe(1);
      expect(errors[0]!.message).toContain("circuit breaker");

      // Initial start + 2 restarts = 3 starts total
      expect(startCount).toBe(3);

      // 3 crash exits
      expect(stopCount).toBe(3);

      expect(manager.running).toBe(false);

      // vscode.window.showErrorMessage should have been called
      const vscode = await import("vscode");
      expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
        expect.stringContaining("crashed repeatedly"),
      );
    },
    TEST_TIMEOUT_MS,
  );
});
