// Socket client for communicating with the Python sidecar over a Unix domain socket.
// Uses NDJSON framing with line-buffered reading and auto-reconnect with exponential backoff.

import { EventEmitter } from "node:events";
import * as net from "node:net";
import {
  type OutgoingMessage,
  type StatusMessage,
  type TranscriptMessage,
  type ErrorMessage,
  serialize,
  deserialize,
} from "./protocol.js";

export interface SocketClientOptions {
  reconnect?: boolean;
  reconnectDelay?: number;
  maxReconnectDelay?: number;
  /** @internal For testing: override socket creation */
  _createSocket?: () => net.Socket;
}

export interface SocketClientEvents {
  connected: [];
  disconnected: [];
  status: [message: StatusMessage];
  transcript: [message: TranscriptMessage];
  error: [message: ErrorMessage];
  "parse-error": [error: Error];
}

export class SocketClient extends EventEmitter<SocketClientEvents> {
  private readonly socketPath: string;
  private readonly shouldReconnect: boolean;
  private readonly baseDelay: number;
  private readonly maxDelay: number;
  private readonly createSocket: () => net.Socket;

  private socket: net.Socket | null = null;
  private buffer = "";
  private currentDelay: number;
  private intentionalDisconnect = false;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(socketPath: string, options: SocketClientOptions = {}) {
    super();
    this.socketPath = socketPath;
    this.shouldReconnect = options.reconnect ?? false;
    this.baseDelay = options.reconnectDelay ?? 1000;
    this.maxDelay = options.maxReconnectDelay ?? 30000;
    this.currentDelay = this.baseDelay;
    this.createSocket = options._createSocket ?? (() => new net.Socket());
  }

  get connected(): boolean {
    return this.socket !== null && !this.socket.destroyed;
  }

  connect(): Promise<void> {
    return this.connectInternal();
  }

  send(msg: OutgoingMessage): void {
    if (this.socket && !this.socket.destroyed) {
      this.socket.write(serialize(msg));
    }
  }

  disconnect(): void {
    this.intentionalDisconnect = true;
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.socket) {
      this.socket.destroy();
      this.socket = null;
    }
  }

  private connectInternal(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      this.intentionalDisconnect = false;
      this.socket = this.createSocket();
      this.buffer = "";

      const onConnect = (): void => {
        this.socket?.removeListener("error", onError);
        this.currentDelay = this.baseDelay;
        this.setupDataHandler();
        this.setupCloseHandler();
        this.emit("connected");
        resolve();
      };

      const onError = (err: Error): void => {
        this.socket?.removeListener("connect", onConnect);
        reject(err);
      };

      this.socket.once("connect", onConnect);
      this.socket.once("error", onError);
      this.socket.connect(this.socketPath);
    });
  }

  private setupDataHandler(): void {
    this.socket?.on("data", (chunk: Buffer) => {
      this.buffer += chunk.toString("utf-8");
      this.processBuffer();
    });

    // Prevent unhandled 'error' events from crashing the extension host.
    // Socket errors (ECONNRESET, EPIPE, etc.) emit 'error' before 'close';
    // the close handler already triggers reconnect logic.
    this.socket?.on("error", () => {});
  }

  private processBuffer(): void {
    let newlineIndex: number;
    while ((newlineIndex = this.buffer.indexOf("\n")) !== -1) {
      const line = this.buffer.slice(0, newlineIndex);
      this.buffer = this.buffer.slice(newlineIndex + 1);

      if (line.trim() === "") continue;

      try {
        const msg = deserialize(line);
        switch (msg.type) {
          case "status":
            this.emit("status", msg as StatusMessage);
            break;
          case "transcript":
            this.emit("transcript", msg as TranscriptMessage);
            break;
          case "error":
            this.emit("error", msg as ErrorMessage);
            break;
        }
      } catch (err) {
        this.emit("parse-error", err instanceof Error ? err : new Error(String(err)));
      }
    }
  }

  private setupCloseHandler(): void {
    this.socket?.once("close", () => {
      this.emit("disconnected");
      if (this.shouldReconnect && !this.intentionalDisconnect) {
        this.scheduleReconnect();
      }
    });
  }

  private scheduleReconnect(): void {
    const delay = this.currentDelay;
    this.currentDelay = Math.min(this.currentDelay * 2, this.maxDelay);

    this.reconnectTimer = setTimeout(async () => {
      this.reconnectTimer = null;
      try {
        await this.connectInternal();
      } catch {
        // Connection failed — schedule next attempt with backoff
        if (this.shouldReconnect && !this.intentionalDisconnect) {
          this.scheduleReconnect();
        }
      }
    }, delay);
  }
}
