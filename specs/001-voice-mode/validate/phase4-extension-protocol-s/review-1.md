# Phase phase4-extension-protocol-s — Review #1: REVIEW-FIXES

**Date**: 2026-03-25T00:00:00Z
**Fixes applied**:
- `src/socket-client.ts`: After successful connection, the initial `error` handler was removed (line 88) but no replacement was attached. Node.js `net.Socket` emits `error` before `close` for network issues (ECONNRESET, EPIPE, etc.), and without a listener this throws an uncaught exception that crashes the VS Code extension host. Added a no-op `error` handler after connection setup. Commit: d82c72e

**Deferred** (optional improvements, not bugs):
- `src/logger.ts`: The `dispose()` method on each logger disposes the shared OutputChannel, which means any logger disposing kills logging for all modules. Not a current bug since `dispose()` is never called in practice, but a latent footgun if future code calls it.
- `src/extension.ts:87-95`: The 500ms `setTimeout` before connecting to the sidecar socket is a heuristic race; relying on the socket client's reconnect logic mitigates this, but a readiness signal from the sidecar would be more robust.
