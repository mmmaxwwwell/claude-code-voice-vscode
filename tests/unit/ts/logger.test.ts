import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock vscode module
const mockAppendLine = vi.fn();
const mockConfigValues: Record<string, unknown> = {
  "claude-voice.logLevel": "info",
};

vi.mock("vscode", () => {
  return {
    window: {
      createOutputChannel: vi.fn(() => ({
        appendLine: mockAppendLine,
        dispose: vi.fn(),
      })),
    },
    workspace: {
      getConfiguration: vi.fn((_section: string) => ({
        get: vi.fn((key: string, defaultValue?: unknown) => {
          const fullKey = `claude-voice.${key}`;
          return fullKey in mockConfigValues
            ? mockConfigValues[fullKey]
            : defaultValue;
        }),
      })),
    },
  };
});

import { createLogger, LogLevel, type Logger } from "../../../src/logger.js";

describe("Logger", () => {
  let logger: Logger;

  beforeEach(() => {
    vi.clearAllMocks();
    mockConfigValues["claude-voice.logLevel"] = "info";
    logger = createLogger("test-module");
  });

  describe("formatted output", () => {
    it("includes timestamp, level, module, and message", () => {
      logger.info("hello world");

      expect(mockAppendLine).toHaveBeenCalledTimes(1);
      const output = mockAppendLine.mock.calls[0][0] as string;
      const parsed = JSON.parse(output);

      expect(parsed.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
      expect(parsed.level).toBe("INFO");
      expect(parsed.module).toBe("test-module");
      expect(parsed.message).toBe("hello world");
    });

    it("includes correlationId when provided", () => {
      logger.info("with correlation", { correlationId: "abc-123" });

      const output = mockAppendLine.mock.calls[0][0] as string;
      const parsed = JSON.parse(output);

      expect(parsed.correlationId).toBe("abc-123");
    });

    it("omits correlationId when not provided", () => {
      logger.info("no correlation");

      const output = mockAppendLine.mock.calls[0][0] as string;
      const parsed = JSON.parse(output);

      expect(parsed.correlationId).toBeUndefined();
    });
  });

  describe("log levels", () => {
    it("logs debug level", () => {
      mockConfigValues["claude-voice.logLevel"] = "debug";
      logger = createLogger("test-module");

      logger.debug("debug msg");
      expect(mockAppendLine).toHaveBeenCalledTimes(1);
      const parsed = JSON.parse(mockAppendLine.mock.calls[0][0]);
      expect(parsed.level).toBe("DEBUG");
    });

    it("logs warn level", () => {
      logger.warn("warn msg");
      expect(mockAppendLine).toHaveBeenCalledTimes(1);
      const parsed = JSON.parse(mockAppendLine.mock.calls[0][0]);
      expect(parsed.level).toBe("WARN");
    });

    it("logs error level", () => {
      logger.error("error msg");
      expect(mockAppendLine).toHaveBeenCalledTimes(1);
      const parsed = JSON.parse(mockAppendLine.mock.calls[0][0]);
      expect(parsed.level).toBe("ERROR");
    });
  });

  describe("level filtering", () => {
    it("filters out debug when logLevel is info", () => {
      mockConfigValues["claude-voice.logLevel"] = "info";
      logger = createLogger("test-module");

      logger.debug("should not appear");
      expect(mockAppendLine).not.toHaveBeenCalled();
    });

    it("allows info when logLevel is info", () => {
      mockConfigValues["claude-voice.logLevel"] = "info";
      logger = createLogger("test-module");

      logger.info("should appear");
      expect(mockAppendLine).toHaveBeenCalledTimes(1);
    });

    it("filters out info when logLevel is warn", () => {
      mockConfigValues["claude-voice.logLevel"] = "warn";
      logger = createLogger("test-module");

      logger.info("should not appear");
      expect(mockAppendLine).not.toHaveBeenCalled();
    });

    it("filters out warn when logLevel is error", () => {
      mockConfigValues["claude-voice.logLevel"] = "error";
      logger = createLogger("test-module");

      logger.warn("should not appear");
      expect(mockAppendLine).not.toHaveBeenCalled();
    });

    it("allows error when logLevel is error", () => {
      mockConfigValues["claude-voice.logLevel"] = "error";
      logger = createLogger("test-module");

      logger.error("should appear");
      expect(mockAppendLine).toHaveBeenCalledTimes(1);
    });

    it("allows everything when logLevel is debug", () => {
      mockConfigValues["claude-voice.logLevel"] = "debug";
      logger = createLogger("test-module");

      logger.debug("d");
      logger.info("i");
      logger.warn("w");
      logger.error("e");
      expect(mockAppendLine).toHaveBeenCalledTimes(4);
    });
  });

  describe("LogLevel enum", () => {
    it("has correct ordering", () => {
      expect(LogLevel.DEBUG).toBeLessThan(LogLevel.INFO);
      expect(LogLevel.INFO).toBeLessThan(LogLevel.WARN);
      expect(LogLevel.WARN).toBeLessThan(LogLevel.ERROR);
    });
  });

  describe("correlation ID inclusion", () => {
    it("includes correlationId in all log levels", () => {
      mockConfigValues["claude-voice.logLevel"] = "debug";
      logger = createLogger("test-module");

      const opts = { correlationId: "corr-1" };
      logger.debug("d", opts);
      logger.info("i", opts);
      logger.warn("w", opts);
      logger.error("e", opts);

      for (let i = 0; i < 4; i++) {
        const parsed = JSON.parse(mockAppendLine.mock.calls[i][0]);
        expect(parsed.correlationId).toBe("corr-1");
      }
    });
  });

  describe("dispose", () => {
    it("disposes the output channel", () => {
      const { dispose } = createLogger("test-module");
      dispose();
      // createOutputChannel was called, and its dispose should be callable
    });
  });
});
