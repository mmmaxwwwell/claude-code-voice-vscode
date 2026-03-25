import { describe, it, expect, vi, beforeEach } from "vitest";

// Track all executeCommand calls in order
const commandCalls: Array<{ command: string; args?: unknown }> = [];

vi.mock("vscode", () => {
  return {
    commands: {
      executeCommand: vi.fn(async (command: string, ...args: unknown[]) => {
        commandCalls.push({ command, args: args[0] });
      }),
    },
    workspace: {
      getConfiguration: vi.fn(() => ({
        get: vi.fn((key: string) => {
          if (key === "deliveryMode") return "autoSubmit";
          return undefined;
        }),
      })),
    },
  };
});

import { ClaudeBridge, DeliveryMode } from "../../../src/claude-bridge.js";

describe("ClaudeBridge", () => {
  let bridge: ClaudeBridge;

  beforeEach(() => {
    commandCalls.length = 0;
    vi.clearAllMocks();
    bridge = new ClaudeBridge();
  });

  describe("deliver (auto-submit mode)", () => {
    it("opens sidebar, focuses input, types text, and presses Enter", async () => {
      await bridge.deliver("hello world", DeliveryMode.AutoSubmit);

      expect(commandCalls).toEqual([
        { command: "claude-vscode.sidebar.open", args: undefined },
        { command: "claude-vscode.focus", args: undefined },
        { command: "type", args: { text: "hello world" } },
        { command: "type", args: { text: "\n" } },
      ]);
    });

    it("includes Enter keypress for auto-submit", async () => {
      await bridge.deliver("test", DeliveryMode.AutoSubmit);

      const lastCall = commandCalls[commandCalls.length - 1];
      expect(lastCall.command).toBe("type");
      expect(lastCall.args).toEqual({ text: "\n" });
    });
  });

  describe("deliver (paste-and-review mode)", () => {
    it("opens sidebar, focuses input, types text, but does NOT press Enter", async () => {
      await bridge.deliver("review this", DeliveryMode.PasteAndReview);

      expect(commandCalls).toEqual([
        { command: "claude-vscode.sidebar.open", args: undefined },
        { command: "claude-vscode.focus", args: undefined },
        { command: "type", args: { text: "review this" } },
      ]);
    });

    it("does not simulate Enter", async () => {
      await bridge.deliver("review this", DeliveryMode.PasteAndReview);

      const enterCalls = commandCalls.filter(
        (c) =>
          c.command === "type" &&
          (c.args as { text: string })?.text === "\n"
      );
      expect(enterCalls).toHaveLength(0);
    });
  });

  describe("sequential delivery queue", () => {
    it("delivers multiple transcripts sequentially without overlapping", async () => {
      // Start two deliveries concurrently
      const p1 = bridge.deliver("first", DeliveryMode.AutoSubmit);
      const p2 = bridge.deliver("second", DeliveryMode.AutoSubmit);

      await Promise.all([p1, p2]);

      // First delivery commands, then second delivery commands
      // Each delivery: open sidebar, focus, type text, type enter
      expect(commandCalls).toEqual([
        { command: "claude-vscode.sidebar.open", args: undefined },
        { command: "claude-vscode.focus", args: undefined },
        { command: "type", args: { text: "first" } },
        { command: "type", args: { text: "\n" } },
        { command: "claude-vscode.sidebar.open", args: undefined },
        { command: "claude-vscode.focus", args: undefined },
        { command: "type", args: { text: "second" } },
        { command: "type", args: { text: "\n" } },
      ]);
    });

    it("queues deliveries and processes them in order", async () => {
      const deliveries = [
        bridge.deliver("one", DeliveryMode.AutoSubmit),
        bridge.deliver("two", DeliveryMode.PasteAndReview),
        bridge.deliver("three", DeliveryMode.AutoSubmit),
      ];

      await Promise.all(deliveries);

      // Extract just the typed text (excluding sidebar/focus commands)
      const typedTexts = commandCalls
        .filter((c) => c.command === "type")
        .map((c) => (c.args as { text: string }).text);

      expect(typedTexts).toEqual(["one", "\n", "two", "three", "\n"]);
    });
  });

  describe("empty text handling", () => {
    it("does nothing for empty string", async () => {
      await bridge.deliver("", DeliveryMode.AutoSubmit);

      expect(commandCalls).toHaveLength(0);
    });

    it("does nothing for whitespace-only string", async () => {
      await bridge.deliver("   ", DeliveryMode.AutoSubmit);

      expect(commandCalls).toHaveLength(0);
    });
  });

  describe("dispose", () => {
    it("can be disposed without error", () => {
      expect(() => bridge.dispose()).not.toThrow();
    });
  });
});
