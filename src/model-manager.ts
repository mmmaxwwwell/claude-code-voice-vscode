import * as vscode from "vscode";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";

const MODELS_DIR = path.join(os.homedir(), ".cache", "claude-voice", "models");

const HF_REPO_PREFIX = "Systran/faster-whisper";

interface HfFileInfo {
  rfilename: string;
  size: number;
}

interface DownloadProgress {
  report(value: { message?: string; increment?: number }): void;
}

const MODEL_SIZES: Array<{ label: string; description: string }> = [
  { label: "tiny", description: "Tiny model (~75MB)" },
  { label: "base", description: "Base model (~150MB)" },
  { label: "small", description: "Small model (~500MB)" },
  { label: "medium", description: "Medium model (~1.5GB)" },
];

export class ModelManager {
  getModelPath(size: string): string {
    return path.join(MODELS_DIR, `faster-whisper-${size}`);
  }

  async modelExists(size: string): Promise<boolean> {
    const modelDir = this.getModelPath(size);
    try {
      await fs.access(modelDir);
      const entries = await fs.readdir(modelDir);
      return entries.length > 0;
    } catch {
      return false;
    }
  }

  async downloadModel(
    size: string,
    progress: DownloadProgress,
    token: vscode.CancellationToken
  ): Promise<void> {
    const modelDir = this.getModelPath(size);
    const repoId = `${HF_REPO_PREFIX}-${size}`;
    const tempDir = `${modelDir}.downloading`;

    try {
      // Get file list from Hugging Face API
      const apiUrl = `https://huggingface.co/api/models/${repoId}`;
      const listResp = await fetch(apiUrl);
      if (!listResp.ok) {
        throw new Error(
          `Failed to fetch model info from Hugging Face: ${listResp.status} ${listResp.statusText}`
        );
      }

      const modelInfo = (await listResp.json()) as { siblings?: HfFileInfo[] };
      const files: HfFileInfo[] = Array.isArray(modelInfo)
        ? modelInfo
        : modelInfo.siblings ?? [];

      if (files.length === 0) {
        throw new Error("No files found in model repository");
      }

      const totalSize = files.reduce((sum, f) => sum + f.size, 0);
      let downloadedSize = 0;

      // Create temp download directory
      await fs.mkdir(tempDir, { recursive: true } as never);

      progress.report({ message: `Downloading ${size} model...`, increment: 0 });

      // Download each file
      for (const file of files) {
        if (token.isCancellationRequested) {
          throw new Error("Download cancelled");
        }

        const fileUrl = `https://huggingface.co/${repoId}/resolve/main/${file.rfilename}`;
        const fileResp = await fetch(fileUrl);
        if (!fileResp.ok) {
          throw new Error(
            `Failed to download ${file.rfilename}: ${fileResp.status} ${fileResp.statusText}`
          );
        }

        const filePath = path.join(tempDir, file.rfilename);
        const fileDir = path.dirname(filePath);
        if (fileDir !== tempDir) {
          await fs.mkdir(fileDir, { recursive: true } as never);
        }

        // Stream download with progress
        const reader = fileResp.body?.getReader();
        if (!reader) {
          throw new Error(`No response body for ${file.rfilename}`);
        }

        const chunks: Uint8Array[] = [];
        try {
          while (true) {
            if (token.isCancellationRequested) {
              await reader.cancel();
              throw new Error("Download cancelled");
            }

            const { done, value } = await reader.read();
            if (done) break;

            chunks.push(value);
            downloadedSize += value.byteLength;

            const percent = Math.round((downloadedSize / totalSize) * 100);
            progress.report({
              message: `Downloading ${size} model... ${percent}%`,
              increment: (value.byteLength / totalSize) * 100,
            });
          }
        } catch (err) {
          await reader.cancel();
          throw err;
        }

        // Write file
        const fullData = Buffer.concat(chunks);
        await fs.writeFile(filePath, fullData);
      }

      // Move temp dir to final location (atomic-ish)
      try {
        await fs.rm(modelDir, { recursive: true, force: true } as never);
      } catch {
        // Directory may not exist
      }
      await fs.rename(tempDir, modelDir);
    } catch (err) {
      // Clean up partial download
      try {
        await fs.rm(tempDir, { recursive: true, force: true } as never);
      } catch {
        // Best effort cleanup
      }
      throw err;
    }
  }

  async downloadModelCommand(): Promise<void> {
    const selected = await vscode.window.showQuickPick(MODEL_SIZES, {
      placeHolder: "Select whisper model size to download",
    });

    if (!selected) {
      return;
    }

    const size = selected.label;

    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: "Claude Voice",
        cancellable: true,
      },
      async (progress, token) => {
        try {
          // Check if already downloaded
          if (await this.modelExists(size)) {
            vscode.window.showInformationMessage(
              `Claude Voice: Model "${size}" is already downloaded.`
            );
            return;
          }

          await this.downloadModel(size, progress, token);
          vscode.window.showInformationMessage(
            `Claude Voice: Model "${size}" downloaded successfully.`
          );
        } catch (err) {
          const message =
            err instanceof Error ? err.message : String(err);
          vscode.window.showErrorMessage(
            `Claude Voice: Failed to download model "${size}": ${message}`
          );
        }
      }
    );
  }
}
