import * as vscode from "vscode";

export enum LogLevel {
  DEBUG = 0,
  INFO = 1,
  WARN = 2,
  ERROR = 3,
}

const LOG_LEVEL_MAP: Record<string, LogLevel> = {
  debug: LogLevel.DEBUG,
  info: LogLevel.INFO,
  warn: LogLevel.WARN,
  error: LogLevel.ERROR,
};

export interface LogOptions {
  correlationId?: string;
}

export interface Logger {
  debug(message: string, opts?: LogOptions): void;
  info(message: string, opts?: LogOptions): void;
  warn(message: string, opts?: LogOptions): void;
  error(message: string, opts?: LogOptions): void;
  dispose(): void;
}

let sharedChannel: vscode.OutputChannel | undefined;

function getOutputChannel(): vscode.OutputChannel {
  if (!sharedChannel) {
    sharedChannel = vscode.window.createOutputChannel("Claude Voice");
  }
  return sharedChannel;
}

function getConfiguredLevel(): LogLevel {
  const config = vscode.workspace.getConfiguration("claude-voice");
  const levelStr = config.get<string>("logLevel", "info").toLowerCase();
  return LOG_LEVEL_MAP[levelStr] ?? LogLevel.INFO;
}

function formatEntry(
  level: string,
  module: string,
  message: string,
  opts?: LogOptions
): string {
  const entry: Record<string, string> = {
    timestamp: new Date().toISOString(),
    level,
    module,
    message,
  };
  if (opts?.correlationId) {
    entry.correlationId = opts.correlationId;
  }
  return JSON.stringify(entry);
}

export function createLogger(module: string): Logger {
  const channel = getOutputChannel();

  function log(level: LogLevel, levelName: string, message: string, opts?: LogOptions): void {
    if (level < getConfiguredLevel()) {
      return;
    }
    channel.appendLine(formatEntry(levelName, module, message, opts));
  }

  return {
    debug: (message: string, opts?: LogOptions) => log(LogLevel.DEBUG, "DEBUG", message, opts),
    info: (message: string, opts?: LogOptions) => log(LogLevel.INFO, "INFO", message, opts),
    warn: (message: string, opts?: LogOptions) => log(LogLevel.WARN, "WARN", message, opts),
    error: (message: string, opts?: LogOptions) => log(LogLevel.ERROR, "ERROR", message, opts),
    dispose: () => channel.dispose(),
  };
}

export function resetSharedChannel(): void {
  sharedChannel = undefined;
}
