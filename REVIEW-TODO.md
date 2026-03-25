# Code Review: Implementation vs Spec/Constitution/Research

**Date**: 2026-03-25
**Reviewer**: Automated (REVIEW task)
**Scope**: All implementation files against spec FRs, constitution principles, research.md decisions, and socket-protocol contract.

## Status: PASS with notes

The implementation is well-aligned with the spec, constitution, and research decisions. No critical violations found. Items below require human judgment.

---

## Items Requiring Human Judgment

### 1. T037 (Hey Claude model) and T038 (Error message polish) are incomplete

**Status**: T037 and T038 are still unchecked in tasks.md.
- T037: Pre-trained "hey claude" openWakeWord model not yet created. FR-031 requires extension to ship with this model.
- T038: Error message polish pass not yet done.
- The `WAKE_MODEL_NOT_FOUND` error code exists in the protocol contract but has no implementation in code yet — blocked on T037.

**Decision needed**: Are T037/T038 blockers for release, or can the extension ship using openWakeWord's built-in models (e.g., `hey_jarvis`) as a fallback?

### 2. PTT keybinding is hardcoded despite `pushToTalkKey` setting

**Context**: The `pushToTalkKey` setting exists in package.json configuration (default: `ctrl+shift+space`), but the actual keybinding in `package.json` `contributes.keybindings` is hardcoded to `ctrl+shift+space`. VS Code keybindings in the manifest cannot be dynamically changed at runtime — they are static.

**Impact**: The `pushToTalkKey` setting has no effect. Users who want a different keybinding must use VS Code's keyboard shortcuts editor (`Preferences: Open Keyboard Shortcuts`).

**Decision needed**: Should `pushToTalkKey` be removed from settings to avoid confusion, or documented as "default keybinding, customize via VS Code Keyboard Shortcuts editor"?

### 3. Model download uses Hugging Face API (network call)

**Context**: Constitution Principle I (Local-First Privacy) says "Model downloads are the sole exception" to no-network-calls. The implementation downloads from `huggingface.co/api/models/Systran/faster-whisper-*`. This is within the stated exception.

**Decision needed**: Should the model download URL be configurable for users behind corporate proxies or air-gapped environments? Currently hardcoded.

### 4. No `SidecarError` or `IntegrationError` TypeScript classes

**Context**: The spec's error hierarchy (spec.md line 264-271) lists `SidecarError` and `IntegrationError` as extension-side error types. The tasks.md note (line 229) says "created in T024 as part of the extension entry point." However, the implementation uses plain `Error` objects and VS Code notifications instead of a typed error hierarchy. This is functionally equivalent and simpler (per Constitution Principle VII: Simplicity).

**Decision needed**: Is the simpler approach acceptable, or should typed error classes be added for consistency with the spec?

### 5. Socket connection timing is racy (extension.ts:89-101)

**Context**: After sidecar starts, extension waits a fixed 500ms before connecting to the socket. If the sidecar takes longer to create the socket file, the connection fails silently. Integration tests use a `connectWithRetry` polling pattern, but the production code does not.

**Impact**: On slow machines or cold starts, the extension may fail to connect to the sidecar, requiring the user to toggle listening off and on.

**Decision needed**: Replace `setTimeout(500)` with a retry/polling pattern? Low risk currently but affects reliability.

### 6. Silent error suppression in claude-bridge.ts delivery queue

**Context**: The promise-chain queue uses `.catch(() => {})` to prevent unhandled rejection crashes. If `vscode.commands.executeCommand("type", { text })` or `claude-vscode.sidebar.open` fails, the error is silently swallowed and the transcript is lost.

**Impact**: If Claude Code is installed but unresponsive, the user gets no feedback that their voice command was lost.

**Decision needed**: Add try-catch logging and optionally a notification on delivery failure? Or is silent failure acceptable since it's rare?

### 7. Model download rename race (model-manager.ts:134-140)

**Context**: After successful download, the code does `fs.rm(modelDir)` then `fs.rename(tempDir, modelDir)`. If `rename` fails after `rm`, the model is lost (neither in temp nor final location).

**Impact**: Extremely unlikely race condition. Would only happen on filesystem errors during the rename step.

**Decision needed**: Reverse the order (rename first, then cleanup)? Or accept the risk as negligible?

### 9. FR-130 partial: wake word model file existence not validated at config time

**Context**: FR-130 says "wake word model file exists (in wake word mode)". The `config_validator.py` only checks that `wakeWord` is non-empty. Actual model file resolution happens inside openWakeWord during Pipeline construction, not during config validation.

**Impact**: If the wake word model file is missing, the user gets a pipeline creation error instead of a clear `CONFIG_INVALID` error at config time. The `WAKE_MODEL_NOT_FOUND` error code from the protocol contract is never emitted.

**Decision needed**: Should `config_validator.py` probe for the wake word model file? This is complicated because openWakeWord resolves model names to files via its own internal logic (built-in models vs custom .tflite files). A file existence check would need to replicate that logic.

### 10. `np.ndarray` type annotations with lazy numpy imports

**Context**: Several sidecar modules (`pipeline.py`, `vad.py`, `wakeword.py`, `audio.py`, `transcriber.py`) use `np.ndarray` in type hints while numpy is lazy-imported. This works at runtime due to `from __future__ import annotations` (PEP 563 deferred evaluation), but would break if someone adds runtime type checking (e.g., `beartype`).

**Impact**: None currently. Would only matter if runtime type checking is added later.

**Decision needed**: No action needed unless runtime type checking is planned.

---

## Auto-Fixed Issues

### 1. Socket protocol contract missing error codes

**Fixed**: Added `CONFIG_INVALID`, `PROTOCOL_ERROR`, and `CONNECTION_REJECTED` error codes to `specs/001-voice-mode/contracts/socket-protocol.md`. These were implemented in code but missing from the contract documentation.

### 2. Config validator missing bounds checking for silenceTimeout and maxUtteranceDuration

**Fixed**: Updated `sidecar/config_validator.py` to validate bounds per package.json configuration:
- `silenceTimeout`: must be 500-10000 (was: any positive integer)
- `maxUtteranceDuration`: must be 5000-300000 (was: any positive integer)

Added 8 new boundary tests to `tests/unit/python/test_config_validator.py`. All 26 tests pass.

---

## Compliance Summary

### Functional Requirements

| FR | Status | Notes |
|----|--------|-------|
| FR-001 | PASS | Status bar with Idle/Listening/Processing/Error |
| FR-002/003 | PASS | Start/stop sidecar on status bar click |
| FR-004 | PASS | Auto-restart with circuit breaker (3/60s) |
| FR-005 | PASS | Notification on crash |
| FR-006 | PASS | Claude Code extension check on activation |
| FR-010 | PASS | Unix domain socket + NDJSON |
| FR-011 | PASS | All 5 message types |
| FR-012 | PASS | Config sent on startup + settings change |
| FR-013 | PASS | Control messages (start/stop/ptt_start/ptt_stop) |
| FR-014 | PASS | All status states emitted |
| FR-015 | PASS | Transcript messages with text |
| FR-016 | PASS | Error messages with code + description |
| FR-020/021 | PASS | Two-stage VAD with ~300ms ring buffer |
| FR-022 | PASS | 16kHz mono audio capture |
| FR-030 | PASS | Wake word via openWakeWord |
| FR-031 | BLOCKED | T037 — custom "hey claude" model not yet trained |
| FR-032 | PASS | Wake word configurable |
| FR-033 | PASS | Wake word stripped via `strip_wakeword_audio()` |
| FR-040/041 | PASS | faster-whisper with tiny/base/small/medium |
| FR-042-044 | PASS | Model download with progress + manual command |
| FR-050-054 | PASS | Submit/cancel command words, stripped, configurable |
| FR-060-063 | PASS | All three input modes implemented |
| FR-070-075 | PASS | Claude bridge: open, focus, type, auto-submit, queue |
| FR-090/091 | PASS | ~/.cache/claude-voice/models/, partial cleanup |
| FR-092 | PASS | Check Dependencies command |
| FR-100-103 | PASS | Structured JSON logging with correlation IDs |
| FR-110 | PASS | Exit codes: 1/2/3/4/5 |
| FR-111 | PASS | Global exception handler (sys.excepthook + asyncio) |
| FR-120-122 | PASS | Shutdown registry, reverse order, timeout |
| FR-123 | PASS | --check flag |
| FR-130/131 | PARTIAL | Config validation passes except wake word file existence check (see item 9). Bounds now enforced for silenceTimeout/maxUtteranceDuration. |
| FR-140-142 | PASS | CI pipeline with lint/test/security |
| FR-143 | PASS | Gitleaks pre-commit hook |
| FR-150-152 | PASS | Custom test reporters |
| FR-160 | PASS | launch.json debug configs |
| FR-161 | PASS | clean:all script |

### Constitution Principles

| Principle | Status | Notes |
|-----------|--------|-------|
| I. Local-First Privacy | PASS | No cloud calls except model downloads |
| II. FOSS Stack | PASS | All deps are open-source (MIT/Apache/BSD) |
| III. Sidecar Architecture | PASS | Clean TS extension + Python sidecar separation |
| IV. Test-First | PASS | TDD approach, comprehensive test coverage |
| V. Minimal Surface | PASS | Status bar + settings only, no webviews |
| VI. Graceful Degradation | PASS | Actionable error messages, circuit breaker |
| VII. Simplicity | PASS | No over-engineering, YAGNI followed |

### Research Decisions

| Decision | Status | Notes |
|----------|--------|-------|
| TypeScript + esbuild + npm | PASS | |
| uv + pyproject.toml | PASS | |
| Unix domain socket + NDJSON | PASS | |
| Two-stage VAD | PASS | |
| openWakeWord | PASS | |
| faster-whisper | PASS | |
| Vitest + pytest | PASS | |
| Socket path ($XDG_RUNTIME_DIR) | PASS | |
