# Phase phase2-b-retroactive-infras — Review #2: REVIEW-FIXES

**Date**: 2026-03-25T00:00:00Z
**Fixes applied**:
- `src/sidecar.ts:73-74`: Spawned child process with `stdio: ["ignore", "pipe", "pipe"]` but never consumed stdout/stderr streams. Once the OS pipe buffer fills (~64KB), the Python sidecar would block on stderr writes (structured JSON logging) and deadlock. Added `this._process.stdout?.resume()` and `this._process.stderr?.resume()` to drain both streams. Commit: 96fd1d2.

**Deferred** (optional improvements, not bugs):
- `__main__.py:290-295`: `_start_listening()` registers dynamic shutdown hooks on every call without deduplication — hooks accumulate if listening is toggled repeatedly. (Carried from review-1.)
- `extension.ts:87-95`: Hardcoded 500ms `setTimeout` before connecting to the sidecar socket — fragile timing assumption. (Carried from review-1.)
- `sidecar-lifecycle.test.ts:57`: Hardcoded NixOS-specific python path (`/run/current-system/sw/bin/python3`) — will break on non-NixOS CI runners. (Carried from review-1.)
