import * as vscode from "vscode";

export enum VoiceState {
  Idle = "idle",
  Listening = "listening",
  Processing = "processing",
  Error = "error",
}

interface StateConfig {
  icon: string;
  tooltip: string;
}

const STATE_CONFIG: Record<VoiceState, StateConfig> = {
  [VoiceState.Idle]: {
    icon: "$(mic-mute)",
    tooltip: "Claude Voice: Click to start listening",
  },
  [VoiceState.Listening]: {
    icon: "$(mic)",
    tooltip: "Claude Voice: Listening... Click to stop",
  },
  [VoiceState.Processing]: {
    icon: "$(sync~spin)",
    tooltip: "Claude Voice: Processing speech...",
  },
  [VoiceState.Error]: {
    icon: "$(error)",
    tooltip: "Claude Voice: Error — Click to retry",
  },
};

type ToggleListener = (newState: VoiceState) => void;

export class StatusBarController {
  private _state: VoiceState = VoiceState.Idle;
  private readonly _statusBarItem: vscode.StatusBarItem;
  private readonly _toggleListeners: ToggleListener[] = [];

  constructor() {
    this._statusBarItem = vscode.window.createStatusBarItem(
      vscode.StatusBarAlignment.Left
    );
    this._statusBarItem.command = "claude-voice.toggleListening";
    this._applyState();
    this._statusBarItem.show();
  }

  get state(): VoiceState {
    return this._state;
  }

  get statusBarItem(): vscode.StatusBarItem {
    return this._statusBarItem;
  }

  setState(newState: VoiceState): void {
    this._state = newState;
    this._applyState();
  }

  toggle(): void {
    let newState: VoiceState | null = null;

    switch (this._state) {
      case VoiceState.Idle:
        newState = VoiceState.Listening;
        break;
      case VoiceState.Listening:
        newState = VoiceState.Idle;
        break;
      case VoiceState.Error:
        newState = VoiceState.Listening;
        break;
      case VoiceState.Processing:
        // No-op while processing
        return;
    }

    this._state = newState;
    this._applyState();
    for (const listener of this._toggleListeners) {
      listener(newState);
    }
  }

  onToggle(listener: ToggleListener): void {
    this._toggleListeners.push(listener);
  }

  dispose(): void {
    this._statusBarItem.dispose();
    this._toggleListeners.length = 0;
  }

  private _applyState(): void {
    const config = STATE_CONFIG[this._state];
    this._statusBarItem.text = config.icon;
    this._statusBarItem.tooltip = config.tooltip;
  }
}
