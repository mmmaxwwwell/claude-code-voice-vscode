import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "node:events";
import { SocketClient } from "../../../src/socket-client.js";
import type {
  ConfigMessage,
  ControlMessage,
  StatusMessage,
  TranscriptMessage,
  ErrorMessage,
} from "../../../src/protocol.js";

// --- Mock net.Socket ---

class MockSocket extends EventEmitter {
  destroyed = false;
  written: string[] = [];

  write(data: string | Buffer): boolean {
    this.written.push(typeof data === "string" ? data : data.toString());
    return true;
  }

  destroy(): void {
    this.destroyed = true;
    this.emit("close", false);
  }

  connect(): this {
    // simulate async connect
    queueMicrotask(() => this.emit("connect"));
    return this;
  }
}

// Helper: create a SocketClient with a mock socket factory
function createClient(
  mockSocket: MockSocket,
  options?: { reconnect?: boolean; reconnectDelay?: number; maxReconnectDelay?: number },
): SocketClient {
  return new SocketClient("/tmp/test.sock", {
    reconnect: options?.reconnect ?? false,
    reconnectDelay: options?.reconnectDelay ?? 100,
    maxReconnectDelay: options?.maxReconnectDelay ?? 1000,
    _createSocket: () => mockSocket,
  });
}

// --- Tests ---

describe("SocketClient", () => {
  let mockSocket: MockSocket;

  beforeEach(() => {
    mockSocket = new MockSocket();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // --- Connection ---

  describe("connection", () => {
    it("connects to the socket path", async () => {
      const client = createClient(mockSocket);
      const connectPromise = client.connect();
      await vi.runAllTimersAsync();
      await connectPromise;
      expect(client.connected).toBe(true);
    });

    it("emits 'connected' event on connect", async () => {
      const client = createClient(mockSocket);
      const connected = vi.fn();
      client.on("connected", connected);
      const connectPromise = client.connect();
      await vi.runAllTimersAsync();
      await connectPromise;
      expect(connected).toHaveBeenCalledOnce();
    });

    it("emits 'disconnected' event on socket close", async () => {
      const client = createClient(mockSocket);
      const disconnected = vi.fn();
      client.on("disconnected", disconnected);
      const connectPromise = client.connect();
      await vi.runAllTimersAsync();
      await connectPromise;

      mockSocket.emit("close", false);
      expect(disconnected).toHaveBeenCalledOnce();
    });
  });

  // --- Sending messages ---

  describe("send", () => {
    it("serializes and writes a ConfigMessage", async () => {
      const client = createClient(mockSocket);
      const connectPromise = client.connect();
      await vi.runAllTimersAsync();
      await connectPromise;

      const msg: ConfigMessage = {
        type: "config",
        inputMode: "wakeWord",
        whisperModel: "base",
        wakeWord: "hey_claude",
        submitWords: ["send it"],
        cancelWords: ["never mind"],
        silenceTimeout: 1500,
        maxUtteranceDuration: 60000,
        micDevice: "",
      };
      client.send(msg);

      expect(mockSocket.written).toHaveLength(1);
      expect(mockSocket.written[0]).toBe(JSON.stringify(msg) + "\n");
    });

    it("serializes and writes a ControlMessage", async () => {
      const client = createClient(mockSocket);
      const connectPromise = client.connect();
      await vi.runAllTimersAsync();
      await connectPromise;

      const msg: ControlMessage = { type: "control", action: "start" };
      client.send(msg);

      expect(mockSocket.written).toHaveLength(1);
      expect(mockSocket.written[0]).toBe(JSON.stringify(msg) + "\n");
    });
  });

  // --- NDJSON line-buffered reading ---

  describe("NDJSON parsing", () => {
    it("emits status event for StatusMessage", async () => {
      const client = createClient(mockSocket);
      const statusHandler = vi.fn();
      client.on("status", statusHandler);

      const connectPromise = client.connect();
      await vi.runAllTimersAsync();
      await connectPromise;

      const msg: StatusMessage = { type: "status", state: "listening" };
      mockSocket.emit("data", Buffer.from(JSON.stringify(msg) + "\n"));

      expect(statusHandler).toHaveBeenCalledWith(msg);
    });

    it("emits transcript event for TranscriptMessage", async () => {
      const client = createClient(mockSocket);
      const handler = vi.fn();
      client.on("transcript", handler);

      const connectPromise = client.connect();
      await vi.runAllTimersAsync();
      await connectPromise;

      const msg: TranscriptMessage = {
        type: "transcript",
        text: "refactor this function",
        action: "submit",
      };
      mockSocket.emit("data", Buffer.from(JSON.stringify(msg) + "\n"));

      expect(handler).toHaveBeenCalledWith(msg);
    });

    it("emits error event for ErrorMessage", async () => {
      const client = createClient(mockSocket);
      const handler = vi.fn();
      client.on("error", handler);

      const connectPromise = client.connect();
      await vi.runAllTimersAsync();
      await connectPromise;

      const msg: ErrorMessage = {
        type: "error",
        code: "MIC_NOT_FOUND",
        message: "No microphone",
      };
      mockSocket.emit("data", Buffer.from(JSON.stringify(msg) + "\n"));

      expect(handler).toHaveBeenCalledWith(msg);
    });

    it("handles multiple messages in a single data chunk", async () => {
      const client = createClient(mockSocket);
      const statusHandler = vi.fn();
      client.on("status", statusHandler);

      const connectPromise = client.connect();
      await vi.runAllTimersAsync();
      await connectPromise;

      const msg1: StatusMessage = { type: "status", state: "speech_start" };
      const msg2: StatusMessage = { type: "status", state: "speech_end" };
      const chunk = JSON.stringify(msg1) + "\n" + JSON.stringify(msg2) + "\n";
      mockSocket.emit("data", Buffer.from(chunk));

      expect(statusHandler).toHaveBeenCalledTimes(2);
      expect(statusHandler).toHaveBeenNthCalledWith(1, msg1);
      expect(statusHandler).toHaveBeenNthCalledWith(2, msg2);
    });

    it("handles partial lines across data chunks", async () => {
      const client = createClient(mockSocket);
      const statusHandler = vi.fn();
      client.on("status", statusHandler);

      const connectPromise = client.connect();
      await vi.runAllTimersAsync();
      await connectPromise;

      const msg: StatusMessage = { type: "status", state: "processing" };
      const fullLine = JSON.stringify(msg);
      const part1 = fullLine.slice(0, 10);
      const part2 = fullLine.slice(10) + "\n";

      mockSocket.emit("data", Buffer.from(part1));
      expect(statusHandler).not.toHaveBeenCalled();

      mockSocket.emit("data", Buffer.from(part2));
      expect(statusHandler).toHaveBeenCalledWith(msg);
    });

    it("handles message split across three chunks", async () => {
      const client = createClient(mockSocket);
      const handler = vi.fn();
      client.on("transcript", handler);

      const connectPromise = client.connect();
      await vi.runAllTimersAsync();
      await connectPromise;

      const msg: TranscriptMessage = {
        type: "transcript",
        text: "hello world",
        action: "submit",
      };
      const fullLine = JSON.stringify(msg);
      const p1 = fullLine.slice(0, 5);
      const p2 = fullLine.slice(5, 20);
      const p3 = fullLine.slice(20) + "\n";

      mockSocket.emit("data", Buffer.from(p1));
      mockSocket.emit("data", Buffer.from(p2));
      expect(handler).not.toHaveBeenCalled();

      mockSocket.emit("data", Buffer.from(p3));
      expect(handler).toHaveBeenCalledWith(msg);
    });

    it("ignores empty lines", async () => {
      const client = createClient(mockSocket);
      const statusHandler = vi.fn();
      client.on("status", statusHandler);

      const connectPromise = client.connect();
      await vi.runAllTimersAsync();
      await connectPromise;

      mockSocket.emit("data", Buffer.from("\n\n"));
      expect(statusHandler).not.toHaveBeenCalled();
    });

    it("emits parse-error for malformed JSON lines", async () => {
      const client = createClient(mockSocket);
      const parseErrorHandler = vi.fn();
      client.on("parse-error", parseErrorHandler);

      const connectPromise = client.connect();
      await vi.runAllTimersAsync();
      await connectPromise;

      mockSocket.emit("data", Buffer.from("{bad json}\n"));
      expect(parseErrorHandler).toHaveBeenCalledOnce();
      expect(parseErrorHandler.mock.calls[0][0]).toBeInstanceOf(Error);
    });
  });

  // --- Auto-reconnect ---

  describe("auto-reconnect", () => {
    it("reconnects after disconnect when reconnect is enabled", async () => {
      let socketIndex = 0;
      const sockets = [new MockSocket(), new MockSocket()];
      const client = new SocketClient("/tmp/test.sock", {
        reconnect: true,
        reconnectDelay: 100,
        maxReconnectDelay: 1000,
        _createSocket: () => sockets[socketIndex++],
      });

      const connectedHandler = vi.fn();
      client.on("connected", connectedHandler);

      const connectPromise = client.connect();
      await vi.runAllTimersAsync();
      await connectPromise;
      expect(connectedHandler).toHaveBeenCalledOnce();

      // Simulate disconnect
      sockets[0].emit("close", false);

      // Advance past reconnect delay
      await vi.advanceTimersByTimeAsync(100);
      // Let the microtask (connect event) fire
      await vi.runAllTimersAsync();

      expect(connectedHandler).toHaveBeenCalledTimes(2);
    });

    it("does not reconnect when reconnect is disabled", async () => {
      const client = createClient(mockSocket, { reconnect: false });
      const connectedHandler = vi.fn();
      client.on("connected", connectedHandler);

      const connectPromise = client.connect();
      await vi.runAllTimersAsync();
      await connectPromise;

      mockSocket.emit("close", false);
      await vi.advanceTimersByTimeAsync(5000);

      expect(connectedHandler).toHaveBeenCalledOnce();
    });

    it("does not reconnect after explicit disconnect()", async () => {
      let socketIndex = 0;
      const sockets = [new MockSocket(), new MockSocket()];
      const client = new SocketClient("/tmp/test.sock", {
        reconnect: true,
        reconnectDelay: 100,
        maxReconnectDelay: 1000,
        _createSocket: () => sockets[socketIndex++],
      });
      const connectedHandler = vi.fn();
      client.on("connected", connectedHandler);

      const connectPromise = client.connect();
      await vi.runAllTimersAsync();
      await connectPromise;

      client.disconnect();
      await vi.advanceTimersByTimeAsync(5000);

      expect(connectedHandler).toHaveBeenCalledOnce();
    });

    it("uses exponential backoff on reconnect", async () => {
      let socketIndex = 0;
      const sockets: MockSocket[] = [];
      for (let i = 0; i < 5; i++) sockets.push(new MockSocket());

      const client = new SocketClient("/tmp/test.sock", {
        reconnect: true,
        reconnectDelay: 100,
        maxReconnectDelay: 1600,
        _createSocket: () => {
          const s = sockets[socketIndex++];
          // Make connections after the first fail
          if (socketIndex > 1 && socketIndex < 4) {
            // Override connect to emit error instead
            s.connect = function () {
              queueMicrotask(() => s.emit("error", new Error("ECONNREFUSED")));
              return s;
            } as typeof s.connect;
          }
          return s;
        },
      });

      const connectPromise = client.connect();
      await vi.runAllTimersAsync();
      await connectPromise;

      // First disconnect - should try reconnect after 100ms
      sockets[0].emit("close", false);
      await vi.advanceTimersByTimeAsync(99);
      expect(socketIndex).toBe(1); // not yet

      // Advance to 100ms — fires reconnect timer, flush microtask (connect error)
      await vi.advanceTimersByTimeAsync(1);
      await vi.advanceTimersByTimeAsync(0);
      expect(socketIndex).toBe(2); // reconnect attempt 1 (fails)

      // Second attempt after 200ms (doubled)
      await vi.advanceTimersByTimeAsync(199);
      expect(socketIndex).toBe(2);
      await vi.advanceTimersByTimeAsync(1);
      await vi.advanceTimersByTimeAsync(0);
      expect(socketIndex).toBe(3); // reconnect attempt 2 (fails)

      // Third attempt after 400ms (doubled again)
      await vi.advanceTimersByTimeAsync(399);
      expect(socketIndex).toBe(3);
      await vi.advanceTimersByTimeAsync(1);
      await vi.advanceTimersByTimeAsync(0);
      expect(socketIndex).toBe(4); // reconnect attempt 3 (succeeds)
    });
  });

  // --- Dispose ---

  describe("dispose", () => {
    it("destroys the socket on disconnect", async () => {
      const client = createClient(mockSocket);
      const connectPromise = client.connect();
      await vi.runAllTimersAsync();
      await connectPromise;

      client.disconnect();
      expect(mockSocket.destroyed).toBe(true);
    });

    it("is safe to call disconnect when not connected", () => {
      const client = createClient(mockSocket);
      expect(() => client.disconnect()).not.toThrow();
    });
  });
});
