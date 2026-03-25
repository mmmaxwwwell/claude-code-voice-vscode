# Phase phase4-extension-protocol-s — Review #2: REVIEW-FIXES

**Date**: 2026-03-25T00:00:00Z
**Fixes applied**:
- `src/sidecar.ts`: The spawned `ChildProcess` in `_spawnProcess()` had no `error` event handler. If `python3` is not on PATH (or any other spawn failure), Node.js emits an `error` event (ENOENT) on the ChildProcess, and without a listener this throws an uncaught exception that crashes the VS Code extension host. Added an `error` handler that clears the process reference and emits the error through the SidecarManager event system. Commit: 7a602ee

**Deferred** (optional improvements, not bugs):
- `src/logger.ts`: The `dispose()` method on each logger disposes the shared OutputChannel (carried over from review-1, still present).
- `src/extension.ts:87-95`: The 500ms `setTimeout` before connecting to the sidecar socket is a heuristic race (carried over from review-1, still present).
