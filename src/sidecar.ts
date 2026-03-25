// Sidecar process lifecycle manager: spawn, monitor, auto-restart with circuit breaker.

import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, unlinkSync } from "node:fs";
import { EventEmitter } from "node:events";
import * as vscode from "vscode";

const CIRCUIT_BREAKER_WINDOW_MS = 60_000;
const CIRCUIT_BREAKER_MAX_CRASHES = 3;
const RESTART_DELAY_MS = 1000;

export interface SidecarManagerOptions {
  /** Override python executable path. If not set, defaults to "python3". */
  _pythonPath?: string;
}

export interface SidecarManagerEvents {
  started: [];
  stopped: [exitCode: number | null];
  error: [error: Error];
}

export class SidecarManager extends EventEmitter<SidecarManagerEvents> {
  private readonly _socketPath: string;
  private readonly _pythonPath: string;
  private _process: ChildProcess | null = null;
  private _intentionalStop = false;
  private _crashTimestamps: number[] = [];
  private _restartTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(socketPath: string, options: SidecarManagerOptions = {}) {
    super();
    this._socketPath = socketPath;
    this._pythonPath = options._pythonPath ?? "python3";
  }

  get socketPath(): string {
    return this._socketPath;
  }

  get running(): boolean {
    return this._process !== null && !this._process.killed;
  }

  async start(): Promise<void> {
    if (this.running) {
      return;
    }

    this._intentionalStop = false;
    this._spawnProcess();
  }

  stop(): void {
    this._intentionalStop = true;
    this._clearRestartTimer();
    this._killProcess();
    this._cleanupSocket();
  }

  dispose(): void {
    this.stop();
    this.removeAllListeners();
  }

  private _spawnProcess(): void {
    this._process = spawn(
      this._pythonPath,
      ["-m", "sidecar", "--socket", this._socketPath],
      { stdio: ["ignore", "pipe", "pipe"] }
    );

    this._process.on("error", (err) => {
      this._process = null;
      this.emit("error", err);
    });

    this._process.on("close", (code, signal) => {
      this._process = null;
      this.emit("stopped", code);
      this._handleExit(code, signal);
    });

    this.emit("started");
  }

  private _handleExit(code: number | null, _signal: string | null): void {
    if (this._intentionalStop) {
      return;
    }

    // Normal exit — don't restart
    if (code === 0) {
      return;
    }

    // Record crash timestamp and prune old ones
    const now = Date.now();
    this._crashTimestamps.push(now);
    this._crashTimestamps = this._crashTimestamps.filter(
      (t) => now - t < CIRCUIT_BREAKER_WINDOW_MS
    );

    // Circuit breaker: too many crashes in window
    if (this._crashTimestamps.length >= CIRCUIT_BREAKER_MAX_CRASHES) {
      const err = new Error(
        "Claude Voice sidecar circuit breaker tripped: process crashed repeatedly"
      );
      this.emit("error", err);
      vscode.window.showErrorMessage(
        "Claude Voice sidecar crashed repeatedly. Please check the output for errors."
      );
      this._crashTimestamps = [];
      return;
    }

    // Schedule restart
    this._restartTimer = setTimeout(() => {
      this._restartTimer = null;
      if (!this._intentionalStop) {
        this._spawnProcess();
      }
    }, RESTART_DELAY_MS);
  }

  private _killProcess(): void {
    if (this._process && !this._process.killed) {
      this._process.kill();
      this._process = null;
    }
  }

  private _cleanupSocket(): void {
    if (existsSync(this._socketPath)) {
      unlinkSync(this._socketPath);
    }
  }

  private _clearRestartTimer(): void {
    if (this._restartTimer !== null) {
      clearTimeout(this._restartTimer);
      this._restartTimer = null;
    }
  }
}
