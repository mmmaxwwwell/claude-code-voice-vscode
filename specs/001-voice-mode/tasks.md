# Tasks: Conversational Voice Mode

**Input**: Design documents from `/specs/001-voice-mode/`
**Prerequisites**: plan.md, spec.md, research.md, contracts/socket-protocol.md

**Approach**: TDD for core logic. Fix-validate loop per phase. No auth, no network hardening — local single-user tool.

## Format: `[ID] [P?] [Story?] Description`

- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to

---

## Phase 1: Setup

**Purpose**: Reproducible dev environment, project scaffold, test infrastructure, audio fixtures.

**Idempotency**: All tasks check-before-mutate. Skip if artifacts already exist.

- [x] T001 Create `flake.nix` with devShell providing nodejs_22, python311, uv, portaudio headers. Create `.envrc` with `use flake`. Create `.gitignore` covering: `.direnv/`, `node_modules/`, `dist/`, `out/`, `.vscode-test/`, `*.vsix`, `__pycache__/`, `*.pyc`, `.pytest_cache/`, `.mypy_cache/`, `.ruff_cache/`, `*.egg-info/`, `.uv/`, `*.onnx` (downloaded at runtime), `flake.lock`, `.env`, `coverage/`, `test-logs/`, `validate/`, `BLOCKED.md`. [FR-092]
- [x] T002 [P] Scaffold `package.json` with VS Code extension manifest: extension ID `claude-voice`, activation events (`onCommand:claude-voice.toggleListening`, `onCommand:claude-voice.downloadModel`, `onCommand:claude-voice.checkDependencies`), contributes (commands, configuration for all settings from spec, status bar item). Scripts: `dev`, `build`, `test`, `test:unit`, `test:integration`, `lint`, `lint:fix`, `typecheck`, `clean`, `check`. Dev deps: esbuild, vitest, typescript, @types/vscode. [FR-001]
- [x] T003 [P] Scaffold `pyproject.toml` for sidecar: deps (faster-whisper, onnxruntime, openwakeword, webrtcvad, sounddevice, numpy), dev deps (pytest, pytest-asyncio). [FR-040, FR-020, FR-030]
- [x] T004 [P] Create `tsconfig.json` (target ES2022, module node16) and esbuild build script bundling `src/extension.ts` → `dist/extension.js` with `vscode` as external.
- [x] T005 [P] Create audio test fixtures in `tests/fixtures/audio/` plus `tests/fixtures/generate-fixtures.py` for reproducible regeneration. Speech/command fixtures via piper-tts: `command-only.wav` ("refactor this function send it"), `silence.wav` (5s), `noise.wav` (ambient). Wake word fixtures via openWakeWord synthetic speech pipeline: `wake-and-command.wav` ("hey claude refactor this function send it"), `wake-only.wav` ("hey claude"), `cancel.wav` ("hey claude do something never mind"). All 16kHz mono WAV. [SC-001, SC-002, SC-007]
- [x] T006 [P] Create `.vscodeignore` excluding tests/, sidecar/, models/, fixtures, dev configs from packaged extension.
- [x] T007 Create `CLAUDE.md` with quick start (nix develop, npm install, uv sync), script inventory, architecture overview (extension ↔ sidecar over Unix socket), test guide.
- [x] T041 [P] Create `.github/workflows/ci.yml`: GitHub Actions pipeline with jobs for lint (ESLint + ruff), typecheck, build, unit tests (vitest + pytest), integration tests, security scan (Trivy SCA, Semgrep SAST, Gitleaks secrets). Nix devshell for reproducible CI. Runs on push to main and PRs. [FR-140, FR-141, FR-142]
- [x] T042 [P] Create Gitleaks pre-commit hook: add gitleaks to `flake.nix`, create `.pre-commit-config.yaml` or git hook script at `.githooks/pre-commit`. [FR-143]
- [ ] T043 [P] Create custom test reporters for structured output: Vitest custom reporter producing `test-logs/unit-ts/<timestamp>/summary.json` + `failures/<test-name>.log`. pytest plugin producing `test-logs/unit-python/<timestamp>/summary.json` + `failures/<test-name>.log`. Each failure log includes assertion details, stack trace, and context. [FR-150, FR-151, FR-152]
- [x] T044 [P] Create `.vscode/launch.json` with debug configurations: Extension Host debug, Vitest debug (current file), Python debugpy (attach to sidecar), pytest debug. [FR-160]
- [x] T045 [P] Add `clean:all` script to `package.json` that removes all dev state: `node_modules/`, `.venv/`, `dist/`, `out/`, `coverage/`, `test-logs/`, `.pytest_cache/`, `.mypy_cache/`, `.ruff_cache/`, downloaded models. [FR-161]

**Checkpoint**: `nix develop --command bash -c "npm install && npm run typecheck"` passes. Project structure in place.

---

## Phase 2: Sidecar Core — Protocol, Audio, VAD

**Purpose**: Python sidecar internals — everything up to the socket server. TDD: write tests first, then implement.

- [x] T008 [P] Implement `sidecar/errors.py`: `VoiceError` base class with `code` and `message` fields. Subclasses: `AudioError`, `TranscriptionError`, `DependencyError`. Each with machine-readable codes (`MIC_NOT_FOUND`, `MIC_PERMISSION_DENIED`, `MODEL_NOT_FOUND`, `MODEL_LOAD_FAILED`, `DEPENDENCY_MISSING`, `AUDIO_DEVICE_ERROR`, `TRANSCRIPTION_FAILED`). Unit tests in `tests/unit/python/test_errors.py`. [spec: Infrastructure Decisions]
- [x] T009 [P] Implement `sidecar/protocol.py`: dataclasses for all message types (StatusMessage, TranscriptMessage, ErrorMessage, ConfigMessage, ControlMessage) per `contracts/socket-protocol.md`. `serialize()` → JSON + newline, `deserialize(line)` → typed message. Unit tests: round-trip every message type, reject malformed JSON. `tests/unit/python/test_protocol.py`. [FR-011, FR-014, FR-015, FR-016]
- [x] T010 Implement `sidecar/audio.py`: `sounddevice` InputStream at 16kHz mono int16. Configurable device (empty = system default). Yields 30ms audio frames. Raises `AudioError` on no mic or permission denied. Unit tests mock sounddevice, verify frame size (480 samples at 16kHz × 30ms) and sample rate. `tests/unit/python/test_audio.py`. [FR-022]
- [x] T011 Implement `sidecar/vad.py`: two-stage VAD. Stage 1: `webrtcvad.Vad(mode=3)` rejects silence. Stage 2: Silero VAD via ONNX Runtime confirms speech. Pre-speech ring buffer (~300ms / 10 frames). Emits `speech_start` (with buffered audio) and `speech_end` events. Configurable silence timeout (default 1500ms). Unit tests with audio fixtures: silence → no events, speech → start/end with pre-buffer. `tests/unit/python/test_vad.py`. [FR-020, FR-021]
- [x] T012 Implement `sidecar/wakeword.py`: load openWakeWord TFLite model from configurable path. Process audio frames, emit detection event. Strip wake word audio from captured segment. Unit tests with wake word fixtures: detected when present, not detected when absent. `tests/unit/python/test_wakeword.py`. [FR-030, FR-031, FR-032, FR-033]
- [x] T013 [P] Implement `sidecar/command_words.py`: scan transcript suffix for submit/cancel words (case-insensitive). Strip matched words. Return `(cleaned_text, action)` where action is `submit`, `cancel`, or `none`. Unit tests: "refactor this send it" → ("refactor this", submit), "do something never mind" → ("", cancel), "no command word here" → ("no command word here", none). `tests/unit/python/test_command_words.py`. [FR-050, FR-051, FR-052, FR-053, FR-054]
- [x] T014 Implement `sidecar/transcriber.py`: load faster-whisper model by size (tiny/base/small/medium) from `~/.cache/claude-voice/models/`. Transcribe audio buffer → text. Raise `TranscriptionError` on model load failure, `DependencyError` if faster-whisper missing. Unit tests with audio fixture → expected text (fuzzy match). `tests/unit/python/test_transcriber.py`. [FR-040, FR-041]
- [ ] T046 [P] Implement `sidecar/logger.py`: structured JSON logger wrapping Python `logging` with custom formatter. Fields: `timestamp` (ISO 8601), `level`, `message`, `module`, `correlationId` (optional). `with_correlation_id(id)` context manager attaches ID to all log entries in scope. Level configurable via `CLAUDE_VOICE_LOG_LEVEL` env var (default INFO). Unit tests: verify JSON output format, correlation ID propagation, level filtering. `tests/unit/python/test_logger.py`. [FR-100, FR-101, FR-103]
- [ ] T047 [P] Implement `sidecar/shutdown.py`: shutdown hook registry. `register_hook(name, cleanup_fn)` for modules to register during init. `shutdown()` executes hooks in reverse registration order. Per-hook and overall timeout (default 5s). Logs each step at INFO via structured logger. Unit tests: registration order, reverse execution, timeout enforcement. `tests/unit/python/test_shutdown.py`. [FR-120, FR-121, FR-122]
- [ ] T048 [P] Implement `sidecar/config_validator.py`: validate config messages — model size is valid enum, wake word file exists (in wake word mode), submit/cancel word lists non-empty, silence timeout and max utterance duration are positive integers. Returns list of validation errors or clean config. Unit tests: valid config passes, each invalid field type caught, multiple errors returned together. `tests/unit/python/test_config_validator.py`. [FR-130, FR-131]

**Checkpoint**: `uv run pytest tests/unit/python/` — all sidecar unit tests pass including logger, shutdown, and config validator.

---

## Phase 2b: Retroactive Infrastructure Wiring

**Purpose**: Wire the new infrastructure modules (logger, shutdown, config validator, exit codes) into existing sidecar code that was implemented before these requirements were added.

**Dependencies**: T046 (logger), T047 (shutdown), T048 (config_validator) must be complete.

- [ ] T050 Update `sidecar/errors.py`: TDD — first write tests in `tests/unit/python/test_errors.py` for exit_code attribute on all error types and new ConfigError, verify they fail, then add `exit_code` class attribute to `VoiceError` base (default 1) and each subclass (`AudioError`=2, `TranscriptionError`=3, `DependencyError`=4). Add new `ConfigError` subclass with code `CONFIG_INVALID` and exit_code=5. [FR-110]
- [ ] T051 Update `sidecar/__main__.py`: TDD — first write tests for `--check` flag behavior and shutdown hook execution order, verify they fail, then implement: (1) Replace `logging.basicConfig()` with `configure_logging()` from `sidecar.logger`. (2) Wire `ShutdownRegistry` — register cleanup hooks for: audio stream stop, pipeline teardown, socket server stop, socket file cleanup, log flush. Call `registry.shutdown()` in `_request_shutdown()`. (3) Add `--check` flag that initializes pipeline components (verifies audio device availability, dependency imports, model file existence — does NOT load the full whisper model into memory), reports status via structured log, exits 0 on success / error's exit_code on failure. (4) Register global unhandled exception handler via `sys.excepthook` and `asyncio` exception handler: log FATAL with stack trace, trigger shutdown, exit with code 1. [FR-111, FR-120, FR-121, FR-122, FR-123]
- [ ] T052 Update `sidecar/__main__.py` config handling: TDD — first write tests for invalid config → error message and valid config → pipeline created, verify they fail, then implement: after receiving a `ConfigMessage`, run `validate_config()` from `sidecar.config_validator`. If validation fails, send `ErrorMessage(code="CONFIG_INVALID", message=...)` listing all errors. If no prior valid config exists, refuse to start listening (sidecar stays running, waits for valid config). If a prior valid config exists, keep using it. [FR-130, FR-131]
- [ ] T053 Wire structured logger into existing sidecar modules: TDD — first write an integration test that verifies structured JSON log output with correlation IDs for a full utterance lifecycle, verify it fails, then wire: (1) `pipeline.py` — assign a correlation ID via `with_correlation_id()` at speech_start, use it through transcription and command word detection, clear at speech_end/cancel. (2) `server.py` — log with module name, use structured logger. (3) `audio.py`, `vad.py`, `wakeword.py`, `transcriber.py` — add `logger = logging.getLogger(__name__)` where missing, add key diagnostic log statements (model loaded, VAD state changes, transcription timing). All log statements use existing structured JSON format via the configured logger. [FR-100, FR-101, SC-009]

**Checkpoint**: `uv run pytest tests/unit/python/ tests/integration/` — all tests pass. Sidecar outputs structured JSON logs with correlation IDs. `python -m sidecar --check --socket /dev/null` exits 0 when deps are available.

---

## Phase 3: Sidecar Integration — Pipeline & Socket Server

**Purpose**: Wire the components together into a working pipeline with socket communication.

- [x] T015 Implement `sidecar/pipeline.py`: orchestrates audio → VAD → wake word gate → transcriber → command word detection. Three modes: `wakeWord` (gate on, ignore speech without wake word), `pushToTalk` (gate off, start/stop controlled externally via ptt_start/ptt_stop), `continuousDictation` (gate off, command words delimit chunks, VAD segments append to accumulation buffer). Emits status events and transcript events. Max utterance duration enforcement. Integration tests: feed audio fixtures through pipeline, verify correct status events and transcripts. `tests/integration/test_pipeline.py`. [FR-060, FR-062, FR-063]
- [x] T016 Implement `sidecar/server.py`: Unix domain socket server at `$XDG_RUNTIME_DIR/claude-voice-<pid>.sock` (fallback `/tmp`). Accept single client connection. Read NDJSON config/control messages, write NDJSON status/transcript/error messages. Clean up socket file on shutdown. Integration test: connect, send config + control:start, verify status messages. `tests/integration/test_server.py`. [FR-010, FR-012, FR-013]
- [x] T017 Implement `sidecar/__main__.py`: parse `--socket <path>` from args, create socket server, init pipeline from config, wire pipeline events → socket messages. Signal handling (SIGTERM, SIGINT) for clean shutdown. Logging to stderr at INFO level.

**Checkpoint**: `uv run pytest tests/unit/python/ tests/integration/` — all sidecar tests pass. Sidecar starts, accepts socket connection, responds to config/control messages.

---

## Phase 4: Extension — Protocol & Socket Client

**Purpose**: TypeScript extension internals — types, socket client, config adapter.

- [x] T018 [P] Implement `src/protocol.ts`: TypeScript interfaces for all message types matching `contracts/socket-protocol.md` (ConfigMessage, ControlMessage, StatusMessage, TranscriptMessage, ErrorMessage). Type guards (`isStatusMessage`, `isTranscriptMessage`, etc.). Serialize/deserialize functions. Unit tests: round-trip all types, reject malformed JSON, type guards. `tests/unit/ts/protocol.test.ts`. [FR-011]
- [ ] T019 Implement `src/socket-client.ts`: connect to Unix domain socket via `net.createConnection`. NDJSON line-buffered reader (handle partial lines). Send typed messages, receive via EventEmitter (`on('status', ...)`, `on('transcript', ...)`, `on('error', ...)`). Auto-reconnect on disconnect with backoff (for sidecar restart). Unit tests: mock socket, verify message framing and event emission. `tests/unit/ts/socket-client.test.ts`. [FR-010]
- [x] T020 [P] Implement `src/config.ts`: read VS Code workspace settings → build ConfigMessage. Listen for `vscode.workspace.onDidChangeConfiguration` → push updated config to sidecar via socket. Unit tests: settings object → correct ConfigMessage fields. `tests/unit/ts/config.test.ts`. [FR-012]
- [ ] T049 [P] Implement `src/logger.ts`: structured logger wrapping VS Code OutputChannel "Claude Voice". Entries include timestamp, level, module, message, correlationId. Log level filtering from `claude-voice.logLevel` setting. Unit tests: verify formatted output, level filtering, correlation ID inclusion. `tests/unit/ts/logger.test.ts`. [FR-102]

**Checkpoint**: `npm run test:unit` — protocol and socket client tests pass.

---

## Phase 5: User Story 1 & 4 — Wake Word + Status Bar (P1)

**Goal**: Core interaction loop — user clicks status bar to start, says "hey claude [command] send it", transcript appears in Claude Code input.

**Independent Test**: Feed wake-and-command.wav to sidecar, verify transcript delivered to Claude Code bridge.

- [ ] T021 Implement `src/status-bar.ts`: state machine (Idle → Listening → Processing → Error) with status bar item. Icon and tooltip per state. Click handler toggles Idle ↔ Listening. Unit tests: all state transitions, correct icon/tooltip per state, click toggles. `tests/unit/ts/status-bar.test.ts`. [FR-001, Story 1, Story 4]
- [ ] T022 Implement `src/sidecar.ts`: spawn `python -m sidecar --socket <path>`. Monitor process exit. Auto-restart with circuit breaker (3 crashes in 60s window → stop, show error notification). Determine Python path (check python3, python in PATH). Clean up socket file on stop. Unit tests: mock child_process, verify restart logic, circuit breaker timing. `tests/unit/ts/sidecar.test.ts`. [FR-002, FR-003, FR-004, FR-005, Story 4]
- [ ] T023 Implement `src/claude-bridge.ts`: open sidebar via `vscode.commands.executeCommand('claude-vscode.sidebar.open')`, focus input via `claude-vscode.focus`, simulate typing via `vscode.commands.executeCommand('type', {text})`. Auto-submit: simulate Enter after typing. Paste-and-review: type text, leave cursor. Sequential delivery queue (no overlapping typing). Unit tests: mock VS Code API, verify command sequence for both delivery modes. `tests/unit/ts/claude-bridge.test.ts`. [FR-070, FR-071, FR-072, FR-073, FR-074, FR-075, Story 1]
- [ ] T024 Implement `src/extension.ts`: register commands (toggleListening, downloadModel, checkDependencies), create status bar, sidecar manager, socket client, bridge. Wire: socket status events → status bar state, socket transcript events → claude bridge (submit action → deliver, cancel action → discard). Handle push-to-talk keybinding registration. Dispose everything on deactivate. [Story 1, Story 2, Story 4]
- [ ] T025 Integration test: wake word → transcript end-to-end. Spawn real sidecar with audio fixture input (override mic with file). Feed `wake-and-command.wav`. Verify status messages (speech_start, wake_word_detected, processing), transcript with correct text, wake word and "send it" stripped. `tests/integration/sidecar-wake.test.ts`. [SC-001]
- [ ] T026 Integration test: sidecar lifecycle. Spawn real sidecar, verify socket connection. Kill sidecar, verify auto-restart. Kill 3× in <60s, verify circuit breaker stops. `tests/integration/sidecar-lifecycle.test.ts`. [SC-004]

**Checkpoint**: Wake word activation works end-to-end. Status bar reflects state correctly. Sidecar auto-restarts. `npm run test:unit && npm run test:integration` pass.

---

## Phase 6: User Story 2 — Push-to-Talk (P1)

**Goal**: Hold keybinding → speak → release → transcript delivered.

**Independent Test**: Send ptt_start, feed audio, send ptt_stop, verify transcript.

- [ ] T027 Integration test: push-to-talk → transcript. Spawn real sidecar, send `ptt_start` control, feed `command-only.wav`, send `ptt_stop`. Verify transcript delivered with correct text. `tests/integration/sidecar-ptt.test.ts`. [SC-002, Story 2]
- [ ] T028 Integration test: push-to-talk cancel. Send `ptt_start`, feed audio containing "cancel", send `ptt_stop`. Verify transcript action is `cancel` and text is discarded. `tests/integration/sidecar-ptt-cancel.test.ts`. [Story 2]

**Checkpoint**: Push-to-talk works. Command words work post-transcription in PTT mode.

---

## Phase 7: User Story 3 — Continuous Dictation (P2)

**Goal**: All speech transcribed without wake word. Command words delimit chunks.

**Independent Test**: Feed multiple utterances with submit/cancel words, verify correct delivery/discard per chunk.

- [ ] T029 Integration test: continuous dictation submit. Configure sidecar in `continuousDictation` mode. Feed audio with "refactor the auth module send it". Verify transcript "refactor the auth module" delivered. `tests/integration/sidecar-continuous.test.ts`. [Story 3]
- [ ] T030 Integration test: continuous dictation cancel. Feed audio with "do something never mind". Verify transcript discarded. [Story 3]
- [ ] T031 Integration test: continuous dictation multi-segment accumulation. Feed multiple VAD speech segments without command words, then a segment with "send it". Verify all segments accumulated into one transcript. [FR-063, Story 3]

**Checkpoint**: Continuous dictation works with command word chunking and multi-segment accumulation.

---

## Phase 8: User Story 5 — Model Management (P2)

**Goal**: Auto-download whisper models on first use, manual download command.

- [ ] T032 Implement `src/model-manager.ts`: check model existence at `~/.cache/claude-voice/models/<model>/` [FR-090]. Download from Hugging Face (faster-whisper model repos) with progress via `vscode.window.withProgress`. Clean up partial downloads on failure/cancel. "Download Model" command: quick-pick model size, trigger download. Unit tests: mock fetch, verify progress, partial cleanup. `tests/unit/ts/model-manager.test.ts`. [FR-042, FR-043, FR-044, FR-090, FR-091, Story 5]
- [ ] T033 Integration test: model download. Mock HTTP server serving fake model file. Trigger download, verify progress, file at correct path. Interrupt download, verify partial cleaned up. `tests/integration/model-download.test.ts`. [SC-005]

**Checkpoint**: Model auto-download works. Manual download command works.

---

## Phase 9: Error Handling & Dependencies

**Purpose**: Dependency checker, error paths, edge cases.

- [ ] T034 Implement `src/commands.ts`: "Check Dependencies" command — run `python -c "import faster_whisper; import openwakeword; ..."` to verify each dep. Report results as VS Code notification. Check Claude Code extension via `vscode.extensions.getExtension('anthropics.claude-code')`. On activation: check Claude Code, warn if missing. Unit tests: mock exec, verify notification content. `tests/unit/ts/commands.test.ts`. [FR-006, FR-092, SC-008]
- [ ] T035 Integration test: error handling. Start sidecar with no mic → verify `MIC_NOT_FOUND` error. Start with missing model → verify `MODEL_NOT_FOUND`. Verify extension surfaces errors as notifications. `tests/integration/sidecar-errors.test.ts`. [SC-008]
- [ ] T036 Integration test: edge cases. Empty transcription (VAD triggers, whisper returns empty) → silently discarded. Max utterance duration exceeded → truncated. Rapid sequential transcriptions → queued, delivered in order. Settings change while listening → new config pushed to sidecar. Cancel word in wake word mode ("hey claude never mind") → discarded. `tests/integration/edge-cases.test.ts`. [SC-003, SC-007]

**Checkpoint**: All error paths tested. Edge cases covered. `npm run check` (lint + typecheck + all tests) passes.

---

## Phase 10: Polish & Packaging

**Purpose**: Wake word model, error message polish, packaging, final docs.

- [ ] T037 [P] Create pre-trained "hey claude" openWakeWord model via Colab notebook with synthetic speech. Validate detection accuracy against test fixtures. Commit to `models/hey_claude.tflite`.
- [ ] T038 [P] Polish error messages: review all error paths across sidecar and extension. Ensure every error surfaced to user has an actionable message (what went wrong + how to fix). Test: missing Python, missing each pip dep, no mic, corrupt model, Claude Code not installed.
- [ ] T039 Package extension: `vsce package` → `.vsix`. Verify `.vscodeignore` excludes dev files. Test: install in clean VS Code, run "Check Dependencies".
- [ ] T040 Update `CLAUDE.md` with final development guide, architecture overview, test guide, troubleshooting.
- [ ] REVIEW Code review: check all implementation against spec FRs, constitution principles, research.md decisions. Auto-fix issues found. Write `REVIEW-TODO.md` for anything requiring human judgment.

**Checkpoint**: Extension packages cleanly. All tests pass. Manual smoke test: install, activate, speak a command, verify it reaches Claude Code.

---

## Dependencies & Execution Order

### Phase Dependencies

```
Phase 1 (Setup) ──▶ Phase 2 (Sidecar Core) ──▶ Phase 2b (Retro Wiring) ──▶ Phase 3 (Sidecar Integration)*
Phase 1 ──▶ Phase 4 (Extension Protocol)
Phase 3 + Phase 4 ──▶ Phase 5 (Wake Word + Status Bar)
Phase 5 ──▶ Phase 6 (Push-to-Talk)
Phase 5 ──▶ Phase 7 (Continuous Dictation)
Phase 5 ──▶ Phase 8 (Model Management)
Phase 6 + Phase 7 + Phase 8 ──▶ Phase 9 (Error Handling)
Phase 9 ──▶ Phase 10 (Polish)

* Phase 3 is already complete but Phase 2b modifies files from Phase 3 (server.py, __main__.py).
  Phase 2b must run before Phase 4+ to ensure the wiring is in place.
```

### Parallel Opportunities

- **Phase 1**: T002, T003, T004, T005, T006, T041, T042, T043, T044, T045 can all run in parallel
- **Phase 2**: T046, T047, T048 can run in parallel (no shared deps). T010→T011→T012→T014 are sequential (each builds on audio pipeline)
- **Phase 2b**: T050 can run in parallel with T051. T052 depends on T048. T053 depends on T046. T051 depends on T046+T047.
- **Phase 4**: T018, T020 can run in parallel
- **Phase 6, 7, 8**: Can run in parallel after Phase 5 (independent user stories)
- **Phase 10**: T037, T038 can run in parallel

### Optimal Multi-Agent Strategy

```
Agent A: Phase 1 → Phase 2 → Phase 2b → Phase 5 → Phase 6 → Phase 9 → Phase 10
Agent B: (wait for Phase 1) → Phase 4 → (wait for Phase 2b) → Phase 7
Agent C: (wait for Phase 5) → Phase 8
```

Sync points: after Phase 1 (scaffold ready), after Phase 2b+4 (both sides ready), after Phase 5 (core loop works), after Phase 9 (all tests pass).
Note: Phase 3 is already complete. Phase 2b retroactively updates Phase 3 files.

---

## Notes

- Tests are written FIRST (TDD). Verify they fail before implementing.
- Commit after each task.
- Audio fixture tests require the sidecar's mic input to be overridable with a file source — implement this in T010 as a constructor parameter.
- The `models/hey_claude.tflite` file (T037) is a blocker for real wake word integration tests. Until it exists, wake word tests can use one of openWakeWord's built-in models (e.g., `hey_jarvis`) as a stand-in.
- `SidecarError` and `IntegrationError` (extension-side TypeScript errors) are created in T024 as part of the extension entry point, not in the Python sidecar.
