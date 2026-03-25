import * as vscode from "vscode";

export enum DeliveryMode {
  AutoSubmit = "autoSubmit",
  PasteAndReview = "pasteAndReview",
}

/**
 * Bridge to Claude Code extension — opens sidebar, focuses input,
 * simulates typing, and optionally submits. Uses a sequential delivery
 * queue to prevent overlapping typing simulations.
 */
export class ClaudeBridge {
  private _queue: Promise<void> = Promise.resolve();

  /**
   * Deliver a transcript to the Claude Code input.
   * Queued for sequential execution — concurrent calls will not overlap.
   */
  deliver(text: string, mode: DeliveryMode): Promise<void> {
    const task = this._queue.then(() => this._deliverNow(text, mode));
    this._queue = task.catch(() => {});
    return task;
  }

  dispose(): void {
    // Nothing to clean up — queue will drain naturally
  }

  private async _deliverNow(text: string, mode: DeliveryMode): Promise<void> {
    if (!text.trim()) {
      return;
    }

    await vscode.commands.executeCommand("claude-vscode.sidebar.open");
    await vscode.commands.executeCommand("claude-vscode.focus");
    await vscode.commands.executeCommand("type", { text });

    if (mode === DeliveryMode.AutoSubmit) {
      await vscode.commands.executeCommand("type", { text: "\n" });
    }
  }
}
