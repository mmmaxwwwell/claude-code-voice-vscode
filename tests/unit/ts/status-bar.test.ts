import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  StatusBarController,
  VoiceState,
} from "../../../src/status-bar.js";

// Mock vscode module
vi.mock("vscode", () => {
  const StatusBarAlignment = { Left: 1, Right: 2 };

  const createMockStatusBarItem = () => ({
    text: "",
    tooltip: "",
    command: "",
    show: vi.fn(),
    hide: vi.fn(),
    dispose: vi.fn(),
    alignment: StatusBarAlignment.Left,
    priority: 0,
  });

  return {
    StatusBarAlignment,
    window: {
      createStatusBarItem: vi.fn(() => createMockStatusBarItem()),
    },
  };
});

describe("StatusBarController", () => {
  let controller: StatusBarController;

  beforeEach(() => {
    vi.clearAllMocks();
    controller = new StatusBarController();
  });

  describe("initial state", () => {
    it("starts in Idle state", () => {
      expect(controller.state).toBe(VoiceState.Idle);
    });

    it("creates a status bar item", async () => {
      const vscode = await import("vscode");
      expect(vscode.window.createStatusBarItem).toHaveBeenCalled();
    });

    it("shows the status bar item", () => {
      expect(controller.statusBarItem.show).toHaveBeenCalled();
    });

    it("sets correct icon for Idle state", () => {
      expect(controller.statusBarItem.text).toContain("mic-mute");
    });

    it("sets correct tooltip for Idle state", () => {
      expect(controller.statusBarItem.tooltip).toBe(
        "Claude Voice: Click to start listening"
      );
    });

    it("sets click command to toggleListening", () => {
      expect(controller.statusBarItem.command).toBe(
        "claude-voice.toggleListening"
      );
    });
  });

  describe("state transitions", () => {
    it("transitions from Idle to Listening", () => {
      controller.setState(VoiceState.Listening);
      expect(controller.state).toBe(VoiceState.Listening);
    });

    it("transitions from Listening to Processing", () => {
      controller.setState(VoiceState.Listening);
      controller.setState(VoiceState.Processing);
      expect(controller.state).toBe(VoiceState.Processing);
    });

    it("transitions from Processing to Idle", () => {
      controller.setState(VoiceState.Listening);
      controller.setState(VoiceState.Processing);
      controller.setState(VoiceState.Idle);
      expect(controller.state).toBe(VoiceState.Idle);
    });

    it("transitions from any state to Error", () => {
      controller.setState(VoiceState.Error);
      expect(controller.state).toBe(VoiceState.Error);

      controller.setState(VoiceState.Listening);
      controller.setState(VoiceState.Error);
      expect(controller.state).toBe(VoiceState.Error);

      controller.setState(VoiceState.Processing);
      controller.setState(VoiceState.Error);
      expect(controller.state).toBe(VoiceState.Error);
    });

    it("transitions from Error to Idle", () => {
      controller.setState(VoiceState.Error);
      controller.setState(VoiceState.Idle);
      expect(controller.state).toBe(VoiceState.Idle);
    });

    it("transitions from Error to Listening", () => {
      controller.setState(VoiceState.Error);
      controller.setState(VoiceState.Listening);
      expect(controller.state).toBe(VoiceState.Listening);
    });
  });

  describe("icon per state", () => {
    it("shows mic-mute icon when Idle", () => {
      controller.setState(VoiceState.Idle);
      expect(controller.statusBarItem.text).toContain("mic-mute");
    });

    it("shows mic icon when Listening", () => {
      controller.setState(VoiceState.Listening);
      expect(controller.statusBarItem.text).toContain("$(mic)");
    });

    it("shows loading/sync icon when Processing", () => {
      controller.setState(VoiceState.Listening);
      controller.setState(VoiceState.Processing);
      expect(controller.statusBarItem.text).toContain("sync~spin");
    });

    it("shows error icon when Error", () => {
      controller.setState(VoiceState.Error);
      expect(controller.statusBarItem.text).toContain("error");
    });
  });

  describe("tooltip per state", () => {
    it("shows start listening tooltip when Idle", () => {
      controller.setState(VoiceState.Idle);
      expect(controller.statusBarItem.tooltip).toBe(
        "Claude Voice: Click to start listening"
      );
    });

    it("shows listening tooltip when Listening", () => {
      controller.setState(VoiceState.Listening);
      expect(controller.statusBarItem.tooltip).toBe(
        "Claude Voice: Listening... Click to stop"
      );
    });

    it("shows processing tooltip when Processing", () => {
      controller.setState(VoiceState.Listening);
      controller.setState(VoiceState.Processing);
      expect(controller.statusBarItem.tooltip).toBe(
        "Claude Voice: Processing speech..."
      );
    });

    it("shows error tooltip when Error", () => {
      controller.setState(VoiceState.Error);
      expect(controller.statusBarItem.tooltip).toBe(
        "Claude Voice: Error — Click to retry"
      );
    });
  });

  describe("click handler (toggle)", () => {
    it("toggles from Idle to Listening", () => {
      controller.toggle();
      expect(controller.state).toBe(VoiceState.Listening);
    });

    it("toggles from Listening to Idle", () => {
      controller.setState(VoiceState.Listening);
      controller.toggle();
      expect(controller.state).toBe(VoiceState.Idle);
    });

    it("toggles from Error to Listening (retry)", () => {
      controller.setState(VoiceState.Error);
      controller.toggle();
      expect(controller.state).toBe(VoiceState.Listening);
    });

    it("does not toggle while Processing", () => {
      controller.setState(VoiceState.Listening);
      controller.setState(VoiceState.Processing);
      controller.toggle();
      expect(controller.state).toBe(VoiceState.Processing);
    });

    it("emits onToggle event with new state", () => {
      const listener = vi.fn();
      controller.onToggle(listener);
      controller.toggle();
      expect(listener).toHaveBeenCalledWith(VoiceState.Listening);
    });

    it("emits onToggle with Idle when toggling off", () => {
      controller.setState(VoiceState.Listening);
      const listener = vi.fn();
      controller.onToggle(listener);
      controller.toggle();
      expect(listener).toHaveBeenCalledWith(VoiceState.Idle);
    });

    it("does not emit onToggle when Processing (no-op)", () => {
      controller.setState(VoiceState.Listening);
      controller.setState(VoiceState.Processing);
      const listener = vi.fn();
      controller.onToggle(listener);
      controller.toggle();
      expect(listener).not.toHaveBeenCalled();
    });
  });

  describe("dispose", () => {
    it("disposes the status bar item", () => {
      controller.dispose();
      expect(controller.statusBarItem.dispose).toHaveBeenCalled();
    });
  });
});
