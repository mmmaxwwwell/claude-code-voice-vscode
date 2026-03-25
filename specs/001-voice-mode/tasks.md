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

- [x] T001 Create `flake.nix` with devShell providing nodejs_22, python311, uv, portaudio headers. Create `.envrc` with `use flake`. Create `.gitignore` covering: `.direnv/`, `node_modules/`, `dist/`, `out/`, `.vscode-test/`, `*.vsix`, `__pycache__/`, `*.pyc`, `.pytest_cache/`, `.mypy_cache/`, `.ruff_cache/`, `*.egg-info/`, `.uv/`, `*.onnx` (downloaded at runtime), `flake.lock`, `.env`, `coverage/`. [FR-092]
- [x] T002 [P] Scaffold `package.json` with VS Code extension manifest: extension ID `claude-voice`, activation events (`onCommand:claude-voice.toggleListening`, `onCommand:claude-voice.downloadModel`, `onCommand:claude-voice.checkDependencies`), contributes (commands, configuration for all settings from spec, status bar item). Scripts: `dev`, `build`, `test`, `test:unit`, `test:integration`, `lint`, `lint:fix`, `typecheck`, `clean`, `check`. Dev deps: esbuild, vitest, typescript, @types/vscode. [FR-001]
- [x] T003 [P] Scaffold `pyproject.toml` for sidecar: deps (faster-whisper, onnxruntime, openwakeword, webrtcvad, sounddevice, numpy), dev deps (pytest, pytest-asyncio). [FR-040, FR-020, FR-030]
- [x] T004 [P] Create `tsconfig.json` (target ES2022, module node16) and esbuild build script bundling `src/extension.ts` → `dist/extension.js` with `vscode` as external.
- [x] T005 [P] Create audio test fixtures in `tests/fixtures/audio/` plus `tests/fixtures/generate-fixtures.py` for reproducible regeneration. Speech/command fixtures via piper-tts: `command-only.wav` ("refactor this function send it"), `silence.wav` (5s), `noise.wav` (ambient). Wake word fixtures via openWakeWord synthetic speech pipeline: `wake-and-command.wav` ("hey claude refactor this function send it"), `wake-only.wav` ("hey claude"), `cancel.wav` ("hey claude do something never mind"). All 16kHz mono WAV. [SC-001, SC-002, SC-007]
- [x] T006 [P] Create `.vscodeignore` excluding tests/, sidecar/, models/, fixtures, dev configs from packaged extension.
- [x] T007 Create `CLAUDE.md` with quick start (nix develop, npm install, uv sync), script inventory, architecture overview (extension ↔ sidecar over Unix socket), test guide.

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

**Checkpoint**: `uv run pytest tests/unit/python/` — all sidecar unit tests pass.

---

## Phase 3: Sidecar Integration — Pipeline & Socket Server

**Purpose**: Wire the components together into a working pipeline with socket communication.

- [ ] T015 Implement `sidecar/pipeline.py`: orchestrates audio → VAD → wake word gate → transcriber → command word detection. Three modes: `wakeWord` (gate on, ignore speech without wake word), `pushToTalk` (gate off, start/stop controlled externally via ptt_start/ptt_stop), `continuousDictation` (gate off, command words delimit chunks, VAD segments append to accumulation buffer). Emits status events and transcript events. Max utterance duration enforcement. Integration tests: feed audio fixtures through pipeline, verify correct status events and transcripts. `tests/integration/test_pipeline.py`. [FR-060, FR-062, FR-063]
- [ ] T016 Implement `sidecar/server.py`: Unix domain socket server at `$XDG_RUNTIME_DIR/claude-voice-<pid>.sock` (fallback `/tmp`). Accept single client connection. Read NDJSON config/control messages, write NDJSON status/transcript/error messages. Clean up socket file on shutdown. Integration test: connect, send config + control:start, verify status messages. `tests/integration/test_server.py`. [FR-010, FR-012, FR-013]
- [ ] T017 Implement `sidecar/__main__.py`: parse `--socket <path>` from args, create socket server, init pipeline from config, wire pipeline events → socket messages. Signal handling (SIGTERM, SIGINT) for clean shutdown. Logging to stderr at INFO level.

**Checkpoint**: `uv run pytest tests/unit/python/ tests/integration/` — all sidecar tests pass. Sidecar starts, accepts socket connection, responds to config/control messages.

---

## Phase 4: Extension — Protocol & Socket Client

**Purpose**: TypeScript extension internals — types, socket client, config adapter.

- [ ] T018 [P] Implement `src/protocol.ts`: TypeScript interfaces for all message types matching `contracts/socket-protocol.md` (ConfigMessage, ControlMessage, StatusMessage, TranscriptMessage, ErrorMessage). Type guards (`isStatusMessage`, `isTranscriptMessage`, etc.). Serialize/deserialize functions. Unit tests: round-trip all types, reject malformed JSON, type guards. `tests/unit/ts/protocol.test.ts`. [FR-011]
- [ ] T019 Implement `src/socket-client.ts`: connect to Unix domain socket via `net.createConnection`. NDJSON line-buffered reader (handle partial lines). Send typed messages, receive via EventEmitter (`on('status', ...)`, `on('transcript', ...)`, `on('error', ...)`). Auto-reconnect on disconnect with backoff (for sidecar restart). Unit tests: mock socket, verify message framing and event emission. `tests/unit/ts/socket-client.test.ts`. [FR-010]
- [ ] T020 [P] Implement `src/config.ts`: read VS Code workspace settings → build ConfigMessage. Listen for `vscode.workspace.onDidChangeConfiguration` → push updated config to sidecar via socket. Unit tests: settings object → correct ConfigMessage fields. `tests/unit/ts/config.test.ts`. [FR-012]

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

- [ ] T032 Implement `src/model-manager.ts`: check model existence at `~/.cache/claude-voice/models/<model>/`. Download from Hugging Face (faster-whisper model repos) with progress via `vscode.window.withProgress`. Clean up partial downloads on failure/cancel. "Download Model" command: quick-pick model size, trigger download. Unit tests: mock fetch, verify progress, partial cleanup. `tests/unit/ts/model-manager.test.ts`. [FR-042, FR-043, FR-044, FR-090, FR-091, Story 5]
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
Phase 1 (Setup) ──▶ Phase 2 (Sidecar Core) ──▶ Phase 3 (Sidecar Integration)
Phase 1 ──▶ Phase 4 (Extension Protocol)
Phase 3 + Phase 4 ──▶ Phase 5 (Wake Word + Status Bar)
Phase 5 ──▶ Phase 6 (Push-to-Talk)
Phase 5 ──▶ Phase 7 (Continuous Dictation)
Phase 5 ──▶ Phase 8 (Model Management)
Phase 6 + Phase 7 + Phase 8 ──▶ Phase 9 (Error Handling)
Phase 9 ──▶ Phase 10 (Polish)
```

### Parallel Opportunities

- **Phase 1**: T002, T003, T004, T005, T006 can all run in parallel
- **Phase 2**: T008, T009, T013 can run in parallel (no shared deps). T010→T011→T012→T014 are sequential (each builds on audio pipeline)
- **Phase 4**: T018, T020 can run in parallel
- **Phase 6, 7, 8**: Can run in parallel after Phase 5 (independent user stories)
- **Phase 10**: T037, T038 can run in parallel

### Optimal Multi-Agent Strategy

```
Agent A: Phase 1 → Phase 2 → Phase 3 → Phase 5 → Phase 6 → Phase 9 → Phase 10
Agent B: (wait for Phase 1) → Phase 4 → (wait for Phase 3) → Phase 7
Agent C: (wait for Phase 5) → Phase 8
```

Sync points: after Phase 1 (scaffold ready), after Phase 3+4 (both sides ready), after Phase 5 (core loop works), after Phase 9 (all tests pass).

---

## Notes

- Tests are written FIRST (TDD). Verify they fail before implementing.
- Commit after each task.
- Audio fixture tests require the sidecar's mic input to be overridable with a file source — implement this in T010 as a constructor parameter.
- The `models/hey_claude.tflite` file (T037) is a blocker for real wake word integration tests. Until it exists, wake word tests can use one of openWakeWord's built-in models (e.g., `hey_jarvis`) as a stand-in.
- `SidecarError` and `IntegrationError` (extension-side TypeScript errors) are created in T024 as part of the extension entry point, not in the Python sidecar.
