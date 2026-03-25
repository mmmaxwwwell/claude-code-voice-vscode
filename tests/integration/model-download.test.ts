import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import * as http from "node:http";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import type { CancellationToken } from "vscode";

// ---- Mock HTTP server ----

interface ServerState {
  server: http.Server;
  port: number;
  baseUrl: string;
}

const FAKE_MODEL_CONTENT = Buffer.alloc(4096, 0xab);
const FAKE_CONFIG_CONTENT = Buffer.from('{"model_type": "whisper"}');

function createMockHfServer(opts?: {
  /** Delay in ms per chunk for slow streaming (for cancellation test) */
  streamDelay?: number;
}): Promise<ServerState> {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const url = req.url ?? "";

      // File list API endpoint
      if (url.includes("/api/models/")) {
        const files = [
          { rfilename: "config.json", size: FAKE_CONFIG_CONTENT.length },
          { rfilename: "model.bin", size: FAKE_MODEL_CONTENT.length },
        ];
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ siblings: files }));
        return;
      }

      // File download endpoint
      if (url.includes("/resolve/main/")) {
        const filename = url.split("/resolve/main/")[1];
        const content = filename === "config.json" ? FAKE_CONFIG_CONTENT : FAKE_MODEL_CONTENT;

        res.writeHead(200, {
          "Content-Type": "application/octet-stream",
          "Content-Length": String(content.length),
        });

        if (opts?.streamDelay) {
          // Send in small chunks with delay for cancellation testing
          const chunkSize = 256;
          let offset = 0;
          const sendChunk = () => {
            if (offset >= content.length || res.destroyed) {
              if (!res.destroyed) res.end();
              return;
            }
            const chunk = content.subarray(offset, offset + chunkSize);
            offset += chunkSize;
            res.write(chunk);
            setTimeout(sendChunk, opts.streamDelay!);
          };
          sendChunk();
        } else {
          res.end(content);
        }
        return;
      }

      res.writeHead(404);
      res.end("Not found");
    });

    server.listen(0, "127.0.0.1", () => {
      const addr = server.address() as { port: number };
      resolve({
        server,
        port: addr.port,
        baseUrl: `http://127.0.0.1:${addr.port}`,
      });
    });
  });
}

// ---- Temp dir for model downloads ----

let tmpDir: string;
let serverState: ServerState;

// Override os.homedir so ModelManager writes to our temp dir
vi.mock("node:os", async () => {
  const actual = await vi.importActual<typeof import("node:os")>("node:os");
  return {
    ...actual,
    homedir: () => tmpDir,
  };
});

// Mock vscode (not available in integration tests)
vi.mock("vscode", () => ({
  window: {
    withProgress: vi.fn(),
    showQuickPick: vi.fn(),
    showErrorMessage: vi.fn(),
    showInformationMessage: vi.fn(),
  },
  ProgressLocation: { Notification: 15 },
}));

describe("model-download integration", () => {
  beforeAll(async () => {
    serverState = await createMockHfServer();
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => serverState.server.close(() => resolve()));
  });

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "claude-voice-test-"));
  });

  afterEach(async () => {
    try {
      await fs.rm(tmpDir, { recursive: true, force: true });
    } catch {
      // best effort
    }
  });

  it("downloads model files to the correct path with progress", async () => {
    const { ModelManager } = await import("../../src/model-manager.js");
    const mgr = new ModelManager();

    // Intercept fetch to redirect HF URLs to local mock server
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (input: string | URL | Request, init?: RequestInit) => {
      let url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      url = url.replace("https://huggingface.co", serverState.baseUrl);
      return originalFetch(url, init);
    };

    const progressReports: Array<{ message?: string; increment?: number }> = [];
    const progress = {
      report: (value: { message?: string; increment?: number }) => {
        progressReports.push(value);
      },
    };

    const token: CancellationToken = {
      isCancellationRequested: false,
      onCancellationRequested: vi.fn(),
    };

    try {
      await mgr.downloadModel("tiny", progress, token);
    } finally {
      globalThis.fetch = originalFetch;
    }

    // Verify model directory exists
    const modelDir = mgr.getModelPath("tiny");
    const stat = await fs.stat(modelDir);
    expect(stat.isDirectory()).toBe(true);

    // Verify files were written
    const entries = await fs.readdir(modelDir);
    expect(entries.sort()).toEqual(["config.json", "model.bin"]);

    // Verify file contents are correct
    const configData = await fs.readFile(path.join(modelDir, "config.json"));
    expect(configData).toEqual(FAKE_CONFIG_CONTENT);

    const modelData = await fs.readFile(path.join(modelDir, "model.bin"));
    expect(modelData).toEqual(FAKE_MODEL_CONTENT);

    // Verify progress was reported
    expect(progressReports.length).toBeGreaterThan(0);
    expect(progressReports[0].message).toContain("tiny");

    // Verify modelExists returns true
    const exists = await mgr.modelExists("tiny");
    expect(exists).toBe(true);

    // Verify no .downloading temp dir remains
    const parentDir = path.dirname(modelDir);
    const parentEntries = await fs.readdir(parentDir);
    expect(parentEntries.some((e) => e.endsWith(".downloading"))).toBe(false);
  });

  it("cleans up partial download on cancellation", async () => {
    // Create a slow server for this test
    const slowServer = await createMockHfServer({ streamDelay: 50 });

    const { ModelManager } = await import("../../src/model-manager.js");
    const mgr = new ModelManager();

    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (input: string | URL | Request, init?: RequestInit) => {
      let url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      url = url.replace("https://huggingface.co", slowServer.baseUrl);
      return originalFetch(url, init);
    };

    let cancelled = false;
    const token: CancellationToken = {
      get isCancellationRequested() {
        return cancelled;
      },
      onCancellationRequested: vi.fn(),
    };

    const progress = { report: vi.fn() };

    // Cancel after a short delay (let it start downloading)
    const cancelTimer = setTimeout(() => {
      cancelled = true;
    }, 150);

    try {
      await expect(mgr.downloadModel("tiny", progress, token)).rejects.toThrow(/cancel/i);
    } finally {
      clearTimeout(cancelTimer);
      globalThis.fetch = originalFetch;
      await new Promise<void>((resolve) => slowServer.server.close(() => resolve()));
    }

    // Verify no .downloading temp dir remains
    const modelsDir = path.join(tmpDir, ".cache", "claude-voice", "models");
    try {
      const entries = await fs.readdir(modelsDir);
      expect(entries.some((e) => e.endsWith(".downloading"))).toBe(false);
    } catch {
      // models dir may not exist at all, which is fine
    }

    // Verify model directory does NOT exist (download was incomplete)
    const modelDir = mgr.getModelPath("tiny");
    await expect(fs.access(modelDir)).rejects.toThrow();
  });
});
