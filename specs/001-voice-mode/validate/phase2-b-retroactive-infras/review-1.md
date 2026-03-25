# Phase phase2-b-retroactive-infras — Review #1: REVIEW-FIXES

**Date**: 2026-03-25T00:00:00Z
**Fixes applied**:
- `src/extension.ts:152-165`: Push-to-talk keybinding toggle was broken — `package.json` keybindings use `when: "claude-voice.pttActive"` / `when: "!claude-voice.pttActive"` to switch between pttStart and pttStop on the same key, but the context key was never set via `setContext`. Without it, `pttStop` could never fire and PTT would get stuck. Added `vscode.commands.executeCommand("setContext", "claude-voice.pttActive", true/false)` to both commands. Commit: 668a6ec.

**Deferred** (optional improvements, not bugs):
- `__main__.py:290-295`: `_start_listening()` registers dynamic shutdown hooks (`audio_stream_stop`, `pipeline_teardown`) on every call without deduplication — hooks accumulate if listening is toggled repeatedly. Not a crash risk (lambdas guard against None) but wasteful during shutdown. (Also noted in phase1 review.)
- `extension.ts:87-95`: Hardcoded 500ms `setTimeout` before connecting to the sidecar socket — fragile timing assumption, could be replaced with a retry/poll mechanism. (Also noted in phase1 review.)
- `sidecar-lifecycle.test.ts:1267`: Hardcoded NixOS-specific python path (`/run/current-system/sw/bin/python3`) — will break on non-NixOS CI runners.
- `connectWithRetry` in integration tests doesn't destroy failed socket attempts before retrying, which could leak file descriptors during long retry sequences. Test-only, not production risk.
