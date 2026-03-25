import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { CancellationToken } from "vscode";

// Track fs mock state
let mockDirs: Set<string>;
let mockFiles: Map<string, Buffer>;

// Mock node:fs/promises
vi.mock("node:fs/promises", () => {
  return {
    access: vi.fn(async (p: string) => {
      if (!mockDirs.has(p) && !mockFiles.has(p)) {
        const err = new Error(`ENOENT: no such file or directory, access '${p}'`) as NodeJS.ErrnoException;
        err.code = "ENOENT";
        throw err;
      }
    }),
    mkdir: vi.fn(async (p: string) => {
      mockDirs.add(p);
    }),
    readdir: vi.fn(async (p: string) => {
      if (!mockDirs.has(p)) {
        const err = new Error(`ENOENT`) as NodeJS.ErrnoException;
        err.code = "ENOENT";
        throw err;
      }
      const entries: string[] = [];
      for (const key of mockFiles.keys()) {
        if (key.startsWith(p + "/")) {
          const relative = key.slice(p.length + 1);
          if (!relative.includes("/")) {
            entries.push(relative);
          }
        }
      }
      return entries;
    }),
    rm: vi.fn(async (p: string) => {
      // Remove dir and all files under it
      mockDirs.delete(p);
      for (const key of mockFiles.keys()) {
        if (key.startsWith(p)) {
          mockFiles.delete(key);
        }
      }
    }),
    writeFile: vi.fn(async (p: string, data: Buffer) => {
      mockFiles.set(p, data);
    }),
    rename: vi.fn(async (oldPath: string, newPath: string) => {
      // Move all files from old to new path prefix
      for (const [key, value] of mockFiles.entries()) {
        if (key.startsWith(oldPath)) {
          const newKey = newPath + key.slice(oldPath.length);
          mockFiles.set(newKey, value);
          mockFiles.delete(key);
        }
      }
      if (mockDirs.has(oldPath)) {
        mockDirs.delete(oldPath);
        mockDirs.add(newPath);
      }
    }),
  };
});

// Mock node:os
vi.mock("node:os", () => ({
  homedir: vi.fn(() => "/home/testuser"),
}));

// Mock vscode
const mockWithProgress = vi.fn();
const mockShowQuickPick = vi.fn();
const mockShowErrorMessage = vi.fn();
const mockShowInformationMessage = vi.fn();

vi.mock("vscode", () => {
  return {
    window: {
      withProgress: mockWithProgress,
      showQuickPick: mockShowQuickPick,
      showErrorMessage: mockShowErrorMessage,
      showInformationMessage: mockShowInformationMessage,
    },
    ProgressLocation: {
      Notification: 15,
    },
  };
});

// We need to mock global fetch
const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

describe("ModelManager", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDirs = new Set<string>();
    mockFiles = new Map<string, Buffer>();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("modelExists", () => {
    it("returns true when model directory exists and contains files", async () => {
      const { ModelManager } = await import("../../../src/model-manager.js");
      const mgr = new ModelManager();

      const modelDir = "/home/testuser/.cache/claude-voice/models/faster-whisper-base";
      mockDirs.add(modelDir);
      mockFiles.set(`${modelDir}/model.bin`, Buffer.from("data"));

      const exists = await mgr.modelExists("base");
      expect(exists).toBe(true);
    });

    it("returns false when model directory does not exist", async () => {
      const { ModelManager } = await import("../../../src/model-manager.js");
      const mgr = new ModelManager();

      const exists = await mgr.modelExists("base");
      expect(exists).toBe(false);
    });

    it("returns false when model directory exists but is empty", async () => {
      const { ModelManager } = await import("../../../src/model-manager.js");
      const mgr = new ModelManager();

      const modelDir = "/home/testuser/.cache/claude-voice/models/faster-whisper-base";
      mockDirs.add(modelDir);

      const exists = await mgr.modelExists("base");
      expect(exists).toBe(false);
    });

    it("checks the correct path for each model size", async () => {
      const { ModelManager } = await import("../../../src/model-manager.js");
      const mgr = new ModelManager();

      for (const size of ["tiny", "base", "small", "medium"]) {
        const modelDir = `/home/testuser/.cache/claude-voice/models/faster-whisper-${size}`;
        mockDirs.add(modelDir);
        mockFiles.set(`${modelDir}/model.bin`, Buffer.from("data"));

        const exists = await mgr.modelExists(size);
        expect(exists).toBe(true);
      }
    });
  });

  describe("getModelPath", () => {
    it("returns the correct path for a model size", async () => {
      const { ModelManager } = await import("../../../src/model-manager.js");
      const mgr = new ModelManager();

      expect(mgr.getModelPath("base")).toBe(
        "/home/testuser/.cache/claude-voice/models/faster-whisper-base"
      );
    });
  });

  describe("downloadModel", () => {
    it("downloads model files from Hugging Face with progress", async () => {
      const { ModelManager } = await import("../../../src/model-manager.js");
      const mgr = new ModelManager();

      // Mock the file list API response
      const fileList = [
        { rfilename: "config.json", size: 100 },
        { rfilename: "model.bin", size: 200 },
      ];

      // First fetch: file list
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => fileList,
      });

      // Second fetch: config.json content
      mockFetch.mockResolvedValueOnce({
        ok: true,
        headers: new Map([["content-length", "100"]]),
        body: {
          getReader: () => {
            let done = false;
            return {
              read: async () => {
                if (!done) {
                  done = true;
                  return { done: false, value: new Uint8Array(100) };
                }
                return { done: true, value: undefined };
              },
              cancel: vi.fn(),
            };
          },
        },
      });

      // Third fetch: model.bin content
      mockFetch.mockResolvedValueOnce({
        ok: true,
        headers: new Map([["content-length", "200"]]),
        body: {
          getReader: () => {
            let done = false;
            return {
              read: async () => {
                if (!done) {
                  done = true;
                  return { done: false, value: new Uint8Array(200) };
                }
                return { done: true, value: undefined };
              },
              cancel: vi.fn(),
            };
          },
        },
      });

      const progressReports: Array<{ message?: string; increment?: number }> = [];
      const mockProgress = {
        report: (value: { message?: string; increment?: number }) => {
          progressReports.push(value);
        },
      };

      const mockToken: CancellationToken = {
        isCancellationRequested: false,
        onCancellationRequested: vi.fn(),
      };

      await mgr.downloadModel("base", mockProgress, mockToken);

      // Should have fetched file list + 2 file downloads
      expect(mockFetch).toHaveBeenCalledTimes(3);

      // First call should be to the HF API for file list
      expect(mockFetch.mock.calls[0][0]).toContain("huggingface.co/api/models");
      expect(mockFetch.mock.calls[0][0]).toContain("faster-whisper-base");

      // Should have reported progress
      expect(progressReports.length).toBeGreaterThan(0);
    });

    it("cleans up partial downloads on fetch failure", async () => {
      const { ModelManager } = await import("../../../src/model-manager.js");
      const fs = await import("node:fs/promises");
      const mgr = new ModelManager();

      // Mock file list success, then file download failure
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => [{ rfilename: "model.bin", size: 1000 }],
      });

      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 500,
        statusText: "Internal Server Error",
      });

      const mockProgress = { report: vi.fn() };
      const mockToken: CancellationToken = {
        isCancellationRequested: false,
        onCancellationRequested: vi.fn(),
      };

      await expect(
        mgr.downloadModel("base", mockProgress, mockToken)
      ).rejects.toThrow();

      // Should have cleaned up the partial download directory
      expect(fs.rm).toHaveBeenCalled();
    });

    it("cleans up partial downloads on cancellation", async () => {
      const { ModelManager } = await import("../../../src/model-manager.js");
      const fs = await import("node:fs/promises");
      const mgr = new ModelManager();

      // Mock file list
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => [{ rfilename: "model.bin", size: 1000 }],
      });

      // Mock a download that will be "cancelled"
      let cancelled = false;
      const cancellationListeners: Array<() => void> = [];
      const mockToken: CancellationToken = {
        get isCancellationRequested() { return cancelled; },
        onCancellationRequested: vi.fn((listener: () => void) => {
          cancellationListeners.push(listener);
          return { dispose: vi.fn() };
        }),
      };

      mockFetch.mockResolvedValueOnce({
        ok: true,
        headers: new Map([["content-length", "1000"]]),
        body: {
          getReader: () => ({
            read: async () => {
              // Simulate cancellation mid-download
              cancelled = true;
              for (const listener of cancellationListeners) listener();
              return { done: false, value: new Uint8Array(100) };
            },
            cancel: vi.fn(),
          }),
        },
      });

      const mockProgress = { report: vi.fn() };

      await expect(
        mgr.downloadModel("base", mockProgress, mockToken)
      ).rejects.toThrow(/cancel/i);

      // Should clean up
      expect(fs.rm).toHaveBeenCalled();
    });

    it("throws if file list API returns error", async () => {
      const { ModelManager } = await import("../../../src/model-manager.js");
      const mgr = new ModelManager();

      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 404,
        statusText: "Not Found",
      });

      const mockProgress = { report: vi.fn() };
      const mockToken: CancellationToken = {
        isCancellationRequested: false,
        onCancellationRequested: vi.fn(),
      };

      await expect(
        mgr.downloadModel("base", mockProgress, mockToken)
      ).rejects.toThrow();
    });
  });

  describe("downloadModelCommand", () => {
    it("shows a quick pick with model sizes and triggers download", async () => {
      const { ModelManager } = await import("../../../src/model-manager.js");
      const mgr = new ModelManager();

      mockShowQuickPick.mockResolvedValueOnce({
        label: "base",
        description: "Base model (~150MB)",
      });

      // Mock withProgress to run the callback
      mockWithProgress.mockImplementationOnce(
        async (
          _opts: unknown,
          task: (
            progress: { report: (v: unknown) => void },
            token: CancellationToken
          ) => Promise<void>
        ) => {
          // Mock successful model already exists
          const modelDir = "/home/testuser/.cache/claude-voice/models/faster-whisper-base";
          mockDirs.add(modelDir);
          mockFiles.set(`${modelDir}/model.bin`, Buffer.from("data"));

          await task(
            { report: vi.fn() },
            {
              isCancellationRequested: false,
              onCancellationRequested: vi.fn(),
            }
          );
        }
      );

      await mgr.downloadModelCommand();

      expect(mockShowQuickPick).toHaveBeenCalledTimes(1);
      // Verify quick pick items include model sizes
      const items = mockShowQuickPick.mock.calls[0][0];
      expect(items).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ label: "tiny" }),
          expect.objectContaining({ label: "base" }),
          expect.objectContaining({ label: "small" }),
          expect.objectContaining({ label: "medium" }),
        ])
      );
    });

    it("does nothing if quick pick is cancelled", async () => {
      const { ModelManager } = await import("../../../src/model-manager.js");
      const mgr = new ModelManager();

      mockShowQuickPick.mockResolvedValueOnce(undefined);

      await mgr.downloadModelCommand();

      expect(mockWithProgress).not.toHaveBeenCalled();
    });

    it("shows success message when download completes", async () => {
      const { ModelManager } = await import("../../../src/model-manager.js");
      const mgr = new ModelManager();

      mockShowQuickPick.mockResolvedValueOnce({
        label: "tiny",
        description: "Tiny model (~75MB)",
      });

      mockWithProgress.mockImplementationOnce(
        async (
          _opts: unknown,
          task: (
            progress: { report: (v: unknown) => void },
            token: CancellationToken
          ) => Promise<void>
        ) => {
          await task(
            { report: vi.fn() },
            {
              isCancellationRequested: false,
              onCancellationRequested: vi.fn(),
            }
          );
        }
      );

      // Mock the download itself to succeed (model already exists)
      const modelDir = "/home/testuser/.cache/claude-voice/models/faster-whisper-tiny";
      mockDirs.add(modelDir);
      mockFiles.set(`${modelDir}/model.bin`, Buffer.from("data"));

      await mgr.downloadModelCommand();

      expect(mockShowInformationMessage).toHaveBeenCalledWith(
        expect.stringContaining("tiny")
      );
    });

    it("shows error message on download failure", async () => {
      const { ModelManager } = await import("../../../src/model-manager.js");
      const mgr = new ModelManager();

      mockShowQuickPick.mockResolvedValueOnce({
        label: "base",
        description: "Base model (~150MB)",
      });

      mockWithProgress.mockImplementationOnce(
        async (
          _opts: unknown,
          task: (
            progress: { report: (v: unknown) => void },
            token: CancellationToken
          ) => Promise<void>
        ) => {
          // Simulate download failure
          mockFetch.mockResolvedValueOnce({
            ok: false,
            status: 500,
            statusText: "Server Error",
          });

          await task(
            { report: vi.fn() },
            {
              isCancellationRequested: false,
              onCancellationRequested: vi.fn(),
            }
          );
        }
      );

      await mgr.downloadModelCommand();

      expect(mockShowErrorMessage).toHaveBeenCalledWith(
        expect.stringContaining("Failed")
      );
    });
  });
});
