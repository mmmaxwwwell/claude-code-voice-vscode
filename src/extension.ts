import * as vscode from "vscode";
import * as os from "node:os";
import * as path from "node:path";
import { StatusBarController, VoiceState } from "./status-bar.js";
import { SidecarManager } from "./sidecar.js";
import { SocketClient } from "./socket-client.js";
import { ClaudeBridge, DeliveryMode } from "./claude-bridge.js";
import { buildConfigMessage, createConfigWatcher } from "./config.js";
import { createLogger } from "./logger.js";
import type { StatusMessage, TranscriptMessage, ErrorMessage } from "./protocol.js";

const logger = createLogger("extension");

let statusBar: StatusBarController | undefined;
let sidecar: SidecarManager | undefined;
let socketClient: SocketClient | undefined;
let bridge: ClaudeBridge | undefined;

function getSocketPath(): string {
  const runtimeDir = process.env.XDG_RUNTIME_DIR ?? os.tmpdir();
  return path.join(runtimeDir, `claude-voice-${process.pid}.sock`);
}

function getDeliveryMode(): DeliveryMode {
  const config = vscode.workspace.getConfiguration("claude-voice");
  const mode = config.get<string>("deliveryMode", "autoSubmit");
  return mode === "pasteAndReview"
    ? DeliveryMode.PasteAndReview
    : DeliveryMode.AutoSubmit;
}

function mapStatusToState(state: string): VoiceState | null {
  switch (state) {
    case "listening":
    case "speech_start":
    case "speech_end":
    case "wake_word_detected":
      return VoiceState.Listening;
    case "processing":
      return VoiceState.Processing;
    case "ready":
      return VoiceState.Idle;
    default:
      return null;
  }
}

export function activate(context: vscode.ExtensionContext): void {
  const socketPath = getSocketPath();

  // Create core components
  statusBar = new StatusBarController();
  sidecar = new SidecarManager(socketPath);
  socketClient = new SocketClient(socketPath, { reconnect: true });
  bridge = new ClaudeBridge();

  // Wire socket status events -> status bar
  socketClient.on("status", (msg: StatusMessage) => {
    const voiceState = mapStatusToState(msg.state);
    if (voiceState !== null) {
      statusBar?.setState(voiceState);
    }
  });

  // Wire socket transcript events -> claude bridge
  socketClient.on("transcript", (msg: TranscriptMessage) => {
    if (msg.action === "submit") {
      bridge?.deliver(msg.text, getDeliveryMode());
    }
    // action === "cancel" -> discard (do nothing)
    logger.info(
      `Transcript ${msg.action}: ${msg.action === "submit" ? msg.text.slice(0, 50) : "(discarded)"}`
    );
  });

  // Wire socket error events -> status bar error state + notification
  socketClient.on("error", (msg: ErrorMessage) => {
    statusBar?.setState(VoiceState.Error);
    vscode.window.showErrorMessage(`Claude Voice: ${msg.message}`);
    logger.error(`Sidecar error [${msg.code}]: ${msg.message}`);
  });

  // Wire sidecar lifecycle events
  sidecar.on("started", () => {
    logger.info("Sidecar started");
    // Give sidecar time to create socket, then connect
    setTimeout(async () => {
      try {
        await socketClient?.connect();
        socketClient?.send(buildConfigMessage());
        logger.info("Connected to sidecar socket");
      } catch (err) {
        logger.error(`Failed to connect to sidecar: ${err}`);
      }
    }, 500);
  });

  sidecar.on("stopped", (exitCode) => {
    logger.info(`Sidecar stopped with exit code ${exitCode}`);
    socketClient?.disconnect();
  });

  sidecar.on("error", (err) => {
    statusBar?.setState(VoiceState.Error);
    logger.error(`Sidecar error: ${err.message}`);
  });

  // Toggle listening command
  const toggleCmd = vscode.commands.registerCommand(
    "claude-voice.toggleListening",
    async () => {
      statusBar?.toggle();
      const newState = statusBar?.state;
      if (newState === VoiceState.Listening) {
        if (!sidecar?.running) {
          await sidecar?.start();
        } else if (socketClient?.connected) {
          socketClient.send({ type: "control", action: "start" });
        }
      } else if (newState === VoiceState.Idle) {
        if (socketClient?.connected) {
          socketClient.send({ type: "control", action: "stop" });
        }
      }
    }
  );

  // Download model command (stub -- full implementation in T032)
  const downloadCmd = vscode.commands.registerCommand(
    "claude-voice.downloadModel",
    () => {
      vscode.window.showInformationMessage(
        "Claude Voice: Model download not yet implemented."
      );
    }
  );

  // Check dependencies command (stub -- full implementation in T034)
  const checkDepsCmd = vscode.commands.registerCommand(
    "claude-voice.checkDependencies",
    () => {
      vscode.window.showInformationMessage(
        "Claude Voice: Dependency check not yet implemented."
      );
    }
  );

  // Push-to-talk commands
  const pttStartCmd = vscode.commands.registerCommand(
    "claude-voice.pttStart",
    () => {
      if (socketClient?.connected) {
        socketClient.send({ type: "control", action: "ptt_start" });
        statusBar?.setState(VoiceState.Listening);
      }
    }
  );

  const pttStopCmd = vscode.commands.registerCommand(
    "claude-voice.pttStop",
    () => {
      if (socketClient?.connected) {
        socketClient.send({ type: "control", action: "ptt_stop" });
      }
    }
  );

  // Config watcher -- push updated config to sidecar on settings change
  const configWatcher = createConfigWatcher((config) => {
    if (socketClient?.connected) {
      socketClient.send(config);
    }
  });

  // Register all disposables
  context.subscriptions.push(
    toggleCmd,
    downloadCmd,
    checkDepsCmd,
    pttStartCmd,
    pttStopCmd,
    configWatcher,
    { dispose: () => statusBar?.dispose() },
    { dispose: () => sidecar?.dispose() },
    { dispose: () => socketClient?.disconnect() },
    { dispose: () => bridge?.dispose() }
  );

  logger.info("Claude Voice extension activated");
}

export function deactivate(): void {
  socketClient?.disconnect();
  sidecar?.dispose();
  statusBar?.dispose();
  bridge?.dispose();

  socketClient = undefined;
  sidecar = undefined;
  statusBar = undefined;
  bridge = undefined;
}
