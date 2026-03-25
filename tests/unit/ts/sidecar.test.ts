import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";

// Mock vscode
vi.mock("vscode", () => ({
  window: {
    showErrorMessage: vi.fn(),
  },
  workspace: {
    getConfiguration: vi.fn(() => ({
      get: vi.fn((key: string, defaultValue: unknown) => defaultValue),
    })),
  },
}));

// Mock child_process
vi.mock("node:child_process", () => ({
  spawn: vi.fn(),
}));

// Mock node:fs for socket cleanup
vi.mock("node:fs", () => ({
  existsSync: vi.fn(() => false),
  unlinkSync: vi.fn(),
}));

// Mock node:fs/promises for python detection
vi.mock("node:fs/promises", () => ({
  access: vi.fn(),
}));

import { SidecarManager } from "../../../src/sidecar.js";
import { spawn } from "node:child_process";
import { existsSync, unlinkSync } from "node:fs";

function createMockProcess(): ChildProcess & EventEmitter {
  const proc = new EventEmitter() as ChildProcess & EventEmitter;
  (proc as Record<string, unknown>).pid = 12345;
  (proc as Record<string, unknown>).killed = false;
  (proc as Record<string, unknown>).stdin = null;
  const mockStdout = new EventEmitter();
  (mockStdout as Record<string, unknown>).resume = vi.fn();
  (proc as Record<string, unknown>).stdout = mockStdout;
  const mockStderr = new EventEmitter();
  (mockStderr as Record<string, unknown>).resume = vi.fn();
  (proc as Record<string, unknown>).stderr = mockStderr;
  (proc as Record<string, unknown>).kill = vi.fn(() => {
    (proc as Record<string, unknown>).killed = true;
    proc.emit("close", 0, null);
    return true;
  });
  return proc;
}

describe("SidecarManager", () => {
  let manager: SidecarManager;
  let mockProc: ChildProcess & EventEmitter;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    mockProc = createMockProcess();
    vi.mocked(spawn).mockReturnValue(mockProc);
    vi.mocked(existsSync).mockReturnValue(false);
    manager = new SidecarManager("/tmp/test.sock", {
      _pythonPath: "python3",
    });
  });

  afterEach(() => {
    manager.dispose();
    vi.useRealTimers();
  });

  describe("start", () => {
    it("spawns python with correct arguments", async () => {
      await manager.start();
      expect(spawn).toHaveBeenCalledWith(
        "python3",
        ["-m", "sidecar", "--socket", "/tmp/test.sock"],
        expect.objectContaining({ stdio: ["ignore", "pipe", "pipe"] })
      );
    });

    it("reports running state after start", async () => {
      await manager.start();
      expect(manager.running).toBe(true);
    });

    it("does not spawn twice if already running", async () => {
      await manager.start();
      await manager.start();
      expect(spawn).toHaveBeenCalledTimes(1);
    });
  });

  describe("stop", () => {
    it("kills the process", async () => {
      await manager.start();
      manager.stop();
      expect(mockProc.kill).toHaveBeenCalled();
      expect(manager.running).toBe(false);
    });

    it("cleans up socket file if it exists", async () => {
      vi.mocked(existsSync).mockReturnValue(true);
      await manager.start();
      manager.stop();
      expect(unlinkSync).toHaveBeenCalledWith("/tmp/test.sock");
    });

    it("does not throw if not running", () => {
      expect(() => manager.stop()).not.toThrow();
    });
  });

  describe("auto-restart", () => {
    it("restarts when process exits unexpectedly", async () => {
      await manager.start();
      const newMockProc = createMockProcess();
      vi.mocked(spawn).mockReturnValue(newMockProc);

      // Simulate unexpected exit
      mockProc.emit("close", 1, null);
      await vi.advanceTimersByTimeAsync(1000);

      expect(spawn).toHaveBeenCalledTimes(2);
    });

    it("does not restart after intentional stop", async () => {
      await manager.start();
      manager.stop();

      await vi.advanceTimersByTimeAsync(5000);
      // Only the initial spawn
      expect(spawn).toHaveBeenCalledTimes(1);
    });

    it("does not restart on exit code 0", async () => {
      await manager.start();

      // Exit code 0 = normal shutdown
      mockProc.emit("close", 0, null);
      await vi.advanceTimersByTimeAsync(5000);

      expect(spawn).toHaveBeenCalledTimes(1);
    });
  });

  describe("circuit breaker", () => {
    it("stops restarting after 3 crashes in 60s window", async () => {
      const vscode = await import("vscode");
      // Must listen for 'error' to prevent EventEmitter from throwing
      manager.on("error", () => {});

      await manager.start();

      // Crash 1
      const proc2 = createMockProcess();
      vi.mocked(spawn).mockReturnValue(proc2);
      mockProc.emit("close", 1, null);
      await vi.advanceTimersByTimeAsync(1000);
      expect(spawn).toHaveBeenCalledTimes(2);

      // Crash 2
      const proc3 = createMockProcess();
      vi.mocked(spawn).mockReturnValue(proc3);
      proc2.emit("close", 1, null);
      await vi.advanceTimersByTimeAsync(1000);
      expect(spawn).toHaveBeenCalledTimes(3);

      // Crash 3 — circuit breaker should trip
      const proc4 = createMockProcess();
      vi.mocked(spawn).mockReturnValue(proc4);
      proc3.emit("close", 1, null);
      await vi.advanceTimersByTimeAsync(1000);

      // Should NOT have spawned a 4th time
      expect(spawn).toHaveBeenCalledTimes(3);
      expect(manager.running).toBe(false);
      expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
        expect.stringContaining("crashed repeatedly")
      );
    });

    it("resets crash count after 60s window", async () => {
      await manager.start();

      // Crash 1
      const proc2 = createMockProcess();
      vi.mocked(spawn).mockReturnValue(proc2);
      mockProc.emit("close", 1, null);
      await vi.advanceTimersByTimeAsync(1000);

      // Crash 2
      const proc3 = createMockProcess();
      vi.mocked(spawn).mockReturnValue(proc3);
      proc2.emit("close", 1, null);
      await vi.advanceTimersByTimeAsync(1000);

      // Wait 60 seconds to reset window
      await vi.advanceTimersByTimeAsync(60000);

      // Crash 3 — should NOT trip circuit breaker because window reset
      const proc4 = createMockProcess();
      vi.mocked(spawn).mockReturnValue(proc4);
      proc3.emit("close", 1, null);
      await vi.advanceTimersByTimeAsync(1000);
      expect(spawn).toHaveBeenCalledTimes(4); // Still restarting

      // Crash 4 — still within new window
      const proc5 = createMockProcess();
      vi.mocked(spawn).mockReturnValue(proc5);
      proc4.emit("close", 1, null);
      await vi.advanceTimersByTimeAsync(1000);
      expect(spawn).toHaveBeenCalledTimes(5);
    });
  });

  describe("socket path", () => {
    it("exposes the socket path", () => {
      expect(manager.socketPath).toBe("/tmp/test.sock");
    });
  });

  describe("dispose", () => {
    it("stops the process and cleans up", async () => {
      vi.mocked(existsSync).mockReturnValue(true);
      await manager.start();
      manager.dispose();
      expect(mockProc.kill).toHaveBeenCalled();
      expect(unlinkSync).toHaveBeenCalledWith("/tmp/test.sock");
    });
  });

  describe("python path resolution", () => {
    it("uses configured python path", async () => {
      const mgr = new SidecarManager("/tmp/test.sock", {
        _pythonPath: "/usr/bin/python3.11",
      });
      const proc = createMockProcess();
      vi.mocked(spawn).mockReturnValue(proc);

      await mgr.start();
      expect(spawn).toHaveBeenCalledWith(
        "/usr/bin/python3.11",
        expect.any(Array),
        expect.any(Object)
      );
      mgr.dispose();
    });
  });

  describe("events", () => {
    it("emits 'started' when process spawns", async () => {
      const listener = vi.fn();
      manager.on("started", listener);
      await manager.start();
      expect(listener).toHaveBeenCalled();
    });

    it("emits 'stopped' when process exits", async () => {
      const listener = vi.fn();
      manager.on("stopped", listener);
      await manager.start();
      mockProc.emit("close", 0, null);
      expect(listener).toHaveBeenCalledWith(0);
    });

    it("emits 'error' when circuit breaker trips", async () => {
      const errorListener = vi.fn();
      manager.on("error", errorListener);

      await manager.start();

      // Crash 3 times
      for (let i = 0; i < 2; i++) {
        const nextProc = createMockProcess();
        vi.mocked(spawn).mockReturnValue(nextProc);
        mockProc.emit("close", 1, null);
        await vi.advanceTimersByTimeAsync(1000);
        mockProc = nextProc;
      }
      mockProc.emit("close", 1, null);
      await vi.advanceTimersByTimeAsync(1000);

      expect(errorListener).toHaveBeenCalledWith(
        expect.objectContaining({ message: expect.stringContaining("circuit breaker") })
      );
    });
  });
});
