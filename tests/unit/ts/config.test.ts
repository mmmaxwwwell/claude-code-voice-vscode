import { describe, it, expect, vi, beforeEach } from "vitest";
import { buildConfigMessage, createConfigWatcher } from "../../../src/config.js";

// Mock vscode module
vi.mock("vscode", () => {
  const configValues: Record<string, unknown> = {
    "claude-voice.inputMode": "wakeWord",
    "claude-voice.whisperModel": "base",
    "claude-voice.wakeWord": "hey_claude",
    "claude-voice.submitWords": ["send it", "go", "submit"],
    "claude-voice.cancelWords": ["never mind", "cancel"],
    "claude-voice.silenceTimeout": 1500,
    "claude-voice.maxUtteranceDuration": 60000,
    "claude-voice.micDevice": "",
  };

  const mockConfig = {
    get: vi.fn((key: string) => {
      const fullKey = `claude-voice.${key}`;
      return configValues[fullKey];
    }),
  };

  const onDidChangeConfigurationListeners: Array<
    (e: { affectsConfiguration: (section: string) => boolean }) => void
  > = [];

  return {
    workspace: {
      getConfiguration: vi.fn((_section: string) => mockConfig),
      onDidChangeConfiguration: vi.fn(
        (
          listener: (e: {
            affectsConfiguration: (section: string) => boolean;
          }) => void
        ) => {
          onDidChangeConfigurationListeners.push(listener);
          return { dispose: vi.fn() };
        }
      ),
    },
    _mockConfig: mockConfig,
    _configValues: configValues,
    _onDidChangeConfigurationListeners: onDidChangeConfigurationListeners,
    _fireConfigChange: (section: string) => {
      const event = {
        affectsConfiguration: (s: string) => s === section,
      };
      for (const listener of onDidChangeConfigurationListeners) {
        listener(event);
      }
    },
  };
});

describe("buildConfigMessage", () => {
  it("reads default VS Code settings and builds a ConfigMessage", () => {
    const msg = buildConfigMessage();

    expect(msg.type).toBe("config");
    expect(msg.inputMode).toBe("wakeWord");
    expect(msg.whisperModel).toBe("base");
    expect(msg.wakeWord).toBe("hey_claude");
    expect(msg.submitWords).toEqual(["send it", "go", "submit"]);
    expect(msg.cancelWords).toEqual(["never mind", "cancel"]);
    expect(msg.silenceTimeout).toBe(1500);
    expect(msg.maxUtteranceDuration).toBe(60000);
    expect(msg.micDevice).toBe("");
  });

  it("reads custom settings values", async () => {
    const vscode = await import("vscode");
    const configValues =
      (vscode as unknown as Record<string, Record<string, unknown>>)
        ._configValues;
    configValues["claude-voice.inputMode"] = "pushToTalk";
    configValues["claude-voice.whisperModel"] = "small";
    configValues["claude-voice.wakeWord"] = "hey_jarvis";
    configValues["claude-voice.submitWords"] = ["do it"];
    configValues["claude-voice.cancelWords"] = ["stop"];
    configValues["claude-voice.silenceTimeout"] = 2000;
    configValues["claude-voice.maxUtteranceDuration"] = 30000;
    configValues["claude-voice.micDevice"] = "USB Mic";

    const msg = buildConfigMessage();

    expect(msg.type).toBe("config");
    expect(msg.inputMode).toBe("pushToTalk");
    expect(msg.whisperModel).toBe("small");
    expect(msg.wakeWord).toBe("hey_jarvis");
    expect(msg.submitWords).toEqual(["do it"]);
    expect(msg.cancelWords).toEqual(["stop"]);
    expect(msg.silenceTimeout).toBe(2000);
    expect(msg.maxUtteranceDuration).toBe(30000);
    expect(msg.micDevice).toBe("USB Mic");
  });

  it("returns all required ConfigMessage fields", () => {
    const msg = buildConfigMessage();
    const keys = Object.keys(msg).sort();
    expect(keys).toEqual([
      "cancelWords",
      "inputMode",
      "maxUtteranceDuration",
      "micDevice",
      "silenceTimeout",
      "submitWords",
      "type",
      "wakeWord",
      "whisperModel",
    ]);
  });
});

describe("createConfigWatcher", () => {
  let vscodeModule: Record<string, unknown>;

  beforeEach(async () => {
    vscodeModule = (await import("vscode")) as unknown as Record<
      string,
      unknown
    >;
    const listeners = vscodeModule._onDidChangeConfigurationListeners as Array<
      (e: { affectsConfiguration: (section: string) => boolean }) => void
    >;
    listeners.length = 0;
  });

  it("registers a configuration change listener", () => {
    const callback = vi.fn();
    createConfigWatcher(callback);

    const ws = (
      vscodeModule as unknown as {
        workspace: { onDidChangeConfiguration: ReturnType<typeof vi.fn> };
      }
    ).workspace;
    expect(ws.onDidChangeConfiguration).toHaveBeenCalled();
  });

  it("calls callback with new ConfigMessage when claude-voice settings change", () => {
    const callback = vi.fn();
    createConfigWatcher(callback);

    const fireConfigChange = vscodeModule._fireConfigChange as (
      section: string
    ) => void;
    fireConfigChange("claude-voice");

    expect(callback).toHaveBeenCalledTimes(1);
    const msg = callback.mock.calls[0][0];
    expect(msg.type).toBe("config");
  });

  it("does not call callback when unrelated settings change", () => {
    const callback = vi.fn();
    createConfigWatcher(callback);

    const fireConfigChange = vscodeModule._fireConfigChange as (
      section: string
    ) => void;
    fireConfigChange("editor.fontSize");

    expect(callback).not.toHaveBeenCalled();
  });

  it("returns a disposable", () => {
    const callback = vi.fn();
    const disposable = createConfigWatcher(callback);

    expect(disposable).toBeDefined();
    expect(typeof disposable.dispose).toBe("function");
  });
});
