# Claude Voice — Development Guide

## Quick Start

```bash
# Enter dev environment (Node.js 22, Python 3.11, uv, portaudio)
nix develop

# Install extension dependencies
npm install

# Install sidecar dependencies
uv sync --dev

# Verify setup
npm run typecheck
```

**IMPORTANT — NixOS / Python native extensions**: numpy, onnxruntime, and other pip-installed C extensions need `libstdc++` and `libz`. Prefix all `uv run` / Python commands with:
```bash
LD_LIBRARY_PATH=/nix/store/ab3753m6i7isgvzphlar0a8xb84gl96i-gcc-15.2.0-lib/lib:/nix/store/2kdz3m7ic8w226pcvkz1dlg169v91p6a-zlib-1.3.2/lib
```
Do NOT use `find /nix/store`, `nix eval`, or `ldconfig` to locate libraries — the paths above are correct and stable.

## Scripts

### Extension (npm)

| Command | Description |
|---------|-------------|
| `npm run dev` | Build extension in watch mode |
| `npm run build` | Production build (`dist/extension.js`) |
| `npm run typecheck` | Type-check without emitting |
| `npm run test` | Run all tests (unit + integration) |
| `npm run test:unit` | Vitest — `tests/unit/ts/` |
| `npm run test:integration` | Vitest — `tests/integration/` |
| `npm run lint` | ESLint `src/` and `tests/` |
| `npm run lint:fix` | ESLint with auto-fix |
| `npm run clean` | Remove `dist/`, `out/`, `coverage/`, `*.vsix` |
| `npm run clean:all` | Remove all dev state (node_modules, .venv, models, etc.) |
| `npm run check` | lint + typecheck + all tests |
| `npm run package` | Build `.vsix` via `vsce package` |

### Sidecar (Python)

| Command | Description |
|---------|-------------|
| `uv run pytest tests/unit/python/` | Sidecar unit tests |
| `uv run pytest tests/integration/` | Sidecar integration tests |
| `uv run python -m sidecar --socket <path>` | Run sidecar manually |
| `uv run python -m sidecar --check --socket /dev/null` | Check sidecar dependencies |
| `uv run ruff check sidecar/` | Lint Python code |

## Architecture

```
┌─────────────────────┐         Unix Socket         ┌─────────────────────┐
│   VS Code Extension │◄───── NDJSON over ──────►│   Python Sidecar    │
│   (TypeScript)      │      domain socket          │   (Python 3.11+)    │
├─────────────────────┤                             ├─────────────────────┤
│ extension.ts        │  Config/Control ──────►     │ __main__.py         │
│ status-bar.ts       │                             │ server.py           │
│ socket-client.ts    │  ◄────── Status/Transcript/ │ pipeline.py         │
│ claude-bridge.ts    │          Error              │ audio.py            │
│ config.ts           │                             │ vad.py              │
│ model-manager.ts    │                             │ wakeword.py         │
│ commands.ts         │                             │ transcriber.py      │
│ logger.ts           │                             │ command_words.py    │
│ sidecar.ts          │                             │ protocol.py         │
│ protocol.ts         │                             │ errors.py           │
└─────────────────────┘                             │ logger.py           │
                                                    │ shutdown.py         │
                                                    │ config_validator.py │
                                                    └─────────────────────┘
```

### How it works

1. **Extension** spawns the sidecar as a child process, connects via Unix domain socket at `$XDG_RUNTIME_DIR/claude-voice-<pid>.sock` (fallback `/tmp`).
2. Communication is **NDJSON** (newline-delimited JSON): extension sends `config` and `control` messages, sidecar sends `status`, `transcript`, and `error` messages. Protocol contract: `specs/001-voice-mode/contracts/socket-protocol.md`.
3. **Sidecar pipeline**: Microphone → WebRTC VAD (reject silence) → Silero VAD via ONNX (confirm speech) → openWakeWord (gate in wake-word mode) → faster-whisper STT → command word detection → transcript delivered to extension.
4. **Extension bridge**: receives transcript → opens Claude Code sidebar → simulates typing → optionally auto-submits.

### Three input modes

- **Wake Word** — "hey claude [command] send it" triggers transcription
- **Push-to-Talk** — hold `Ctrl+Shift+Space` to speak, release to transcribe
- **Continuous Dictation** — all speech transcribed, command words ("send it", "never mind") delimit chunks

### Key modules

| Module | Role |
|--------|------|
| `src/extension.ts` | Entry point: registers commands, wires components, handles lifecycle |
| `src/sidecar.ts` | Spawns Python sidecar, auto-restart with circuit breaker (3 crashes/60s) |
| `src/socket-client.ts` | NDJSON client over Unix socket with reconnect backoff |
| `src/status-bar.ts` | State machine: Idle → Listening → Processing → Error |
| `src/claude-bridge.ts` | Delivers transcript to Claude Code via simulated typing |
| `src/model-manager.ts` | Downloads whisper models from Hugging Face with progress |
| `src/commands.ts` | "Check Dependencies" command, Claude Code extension detection |
| `src/config.ts` | VS Code settings → ConfigMessage, live config push on change |
| `src/logger.ts` | Structured logging to VS Code OutputChannel |
| `sidecar/pipeline.py` | Orchestrates audio → VAD → wake word → STT → command words |
| `sidecar/server.py` | Async Unix socket server, NDJSON protocol |
| `sidecar/audio.py` | Mic capture via sounddevice, 16kHz mono int16, 30ms frames |
| `sidecar/vad.py` | Two-stage VAD (WebRTC → Silero ONNX), pre-speech ring buffer |
| `sidecar/wakeword.py` | openWakeWord ONNX model loading and detection |
| `sidecar/transcriber.py` | faster-whisper model loading and transcription |
| `sidecar/command_words.py` | Submit/cancel word matching and stripping |
| `sidecar/logger.py` | Structured JSON logger with correlation ID (contextvars) |
| `sidecar/shutdown.py` | Shutdown hook registry, reverse-order cleanup with timeout |
| `sidecar/config_validator.py` | Validates config messages before pipeline creation |
| `sidecar/errors.py` | Error hierarchy with machine-readable codes and exit codes |

## Testing

Tests use TDD — write tests first, verify they fail, then implement.

### Test layout

| Directory | Framework | What it tests |
|-----------|-----------|---------------|
| `tests/unit/ts/` | Vitest | Protocol, config, status bar, socket client, bridge, sidecar manager, model manager, commands, logger, extension |
| `tests/unit/python/` | pytest | Errors, protocol, audio, VAD, wakeword, transcriber, command words, logger, shutdown, config validator, main |
| `tests/integration/` | Vitest + pytest | Real sidecar spawn with audio fixtures, socket communication, pipeline end-to-end, structured logging |
| `tests/fixtures/audio/` | — | WAV files (16kHz mono) for deterministic testing |

### Running tests

```bash
# All checks (lint + typecheck + all tests)
npm run check

# TypeScript unit tests only
npm run test:unit

# Python unit tests only
uv run pytest tests/unit/python/

# All integration tests (TypeScript + Python)
npm run test:integration
uv run pytest tests/integration/

# Single test file
npx vitest run tests/unit/ts/protocol.test.ts
uv run pytest tests/unit/python/test_protocol.py -v
```

### Test reporters

Custom structured test reporters output JSON to `test-logs/`:
- Vitest: `test-logs/unit-ts/<timestamp>/summary.json` + `failures/`
- pytest: `test-logs/unit-python/<timestamp>/summary.json` + `failures/`

### Audio fixtures

Located in `tests/fixtures/audio/`. Regenerate with:

```bash
uv run python tests/fixtures/generate-fixtures.py           # Synthetic (stdlib only)
uv run python tests/fixtures/generate-fixtures.py --tts      # TTS-generated (requires piper-tts)
```

Available fixtures: `command-only.wav`, `silence.wav`, `noise.wav`, `cancel.wav`, `wake-and-command.wav`, `wake-only.wav`, `multi-segment.wav`.

### Integration test notes

- Integration tests that exercise the full ML pipeline (wake word, PTT, continuous dictation) require native deps (webrtcvad, onnxruntime, faster-whisper). They auto-skip when deps are unavailable.
- The sidecar's `--audio-file <path>` flag overrides mic input with a WAV file for deterministic testing.
- Tests use `connectWithRetry` polling to wait for the sidecar socket file to appear.

## Configuration

All settings are under the `claude-voice.*` namespace in VS Code settings:

| Setting | Default | Description |
|---------|---------|-------------|
| `inputMode` | `wakeWord` | `wakeWord`, `pushToTalk`, or `continuousDictation` |
| `wakeWord` | `hey_claude` | openWakeWord model name |
| `submitWords` | `["send it", "go", "submit"]` | Words that trigger submission |
| `cancelWords` | `["never mind", "cancel"]` | Words that discard transcript |
| `deliveryMode` | `autoSubmit` | `autoSubmit` or `pasteAndReview` |
| `whisperModel` | `base` | Whisper model size: `tiny`, `base`, `small`, `medium` |
| `pushToTalkKey` | `ctrl+shift+space` | PTT keybinding |
| `silenceTimeout` | `1500` | Ms of silence before ending utterance (500–10000) |
| `maxUtteranceDuration` | `60000` | Max utterance length in ms (5000–300000) |
| `micDevice` | `""` | Mic device name (empty = system default) |
| `logLevel` | `info` | Log level: `debug`, `info`, `warn`, `error` |

## Key Paths

| Path | Description |
|------|-------------|
| `~/.cache/claude-voice/models/` | Downloaded whisper models |
| `$XDG_RUNTIME_DIR/claude-voice-<pid>.sock` | Sidecar Unix socket (fallback `/tmp`) |
| `dist/extension.js` | Bundled extension output |
| `specs/001-voice-mode/` | Spec docs, plan, contracts |
| `test-logs/` | Structured test output from custom reporters |

## Troubleshooting

### Sidecar won't start

1. **Check dependencies**: Run "Claude Voice: Check Dependencies" command in VS Code, or manually:
   ```bash
   uv run python -m sidecar --check --socket /dev/null
   ```
2. **Missing native libs**: The sidecar uses lazy imports for all native deps (sounddevice, webrtcvad, onnxruntime, openwakeword, faster-whisper, numpy). If one fails, you'll see a specific `DEPENDENCY_MISSING` error.
3. **No microphone**: `MIC_NOT_FOUND` or `MIC_PERMISSION_DENIED` error. Check `arecord -l` (Linux) or system sound settings.

### Sidecar crashes repeatedly

The extension auto-restarts the sidecar, but stops after 3 crashes within 60 seconds (circuit breaker). Check the "Claude Voice" output channel for error details.

### Model not found

Whisper models are downloaded to `~/.cache/claude-voice/models/<model>/`. Use "Claude Voice: Download Model" command to download, or the model will auto-download on first use.

### Config errors

If the sidecar rejects a config (e.g., invalid model size, missing wake word file), it sends a `CONFIG_INVALID` error but stays running. Fix the settings and the sidecar will accept the next valid config.

### Logs

- **Extension**: View → Output → "Claude Voice" channel
- **Sidecar**: Structured JSON logs to stderr (visible in extension output). Set `CLAUDE_VOICE_LOG_LEVEL=debug` env var for verbose sidecar logging, or change `claude-voice.logLevel` setting for extension-side logging.
- **Correlation IDs**: Each utterance gets a unique ID that appears in all log entries from speech_start through transcription, enabling end-to-end trace of a single voice command.

### Error codes

| Code | Meaning |
|------|---------|
| `MIC_NOT_FOUND` | No microphone detected |
| `MIC_PERMISSION_DENIED` | Microphone access denied |
| `MODEL_NOT_FOUND` | Whisper model not downloaded |
| `MODEL_LOAD_FAILED` | Whisper model file corrupted or incompatible |
| `DEPENDENCY_MISSING` | Required Python package not installed |
| `AUDIO_DEVICE_ERROR` | Audio device error during capture |
| `TRANSCRIPTION_FAILED` | Whisper transcription error |
| `CONFIG_INVALID` | Invalid configuration values |

### Exit codes

| Code | Meaning |
|------|---------|
| 0 | Clean exit |
| 1 | Generic/unhandled error |
| 2 | Audio error |
| 3 | Transcription error |
| 4 | Dependency error |
| 5 | Config error |

## CI/CD

GitHub Actions pipeline (`.github/workflows/ci.yml`) runs on push to main and PRs:
- **Lint**: ESLint + ruff
- **Typecheck**: `tsc --noEmit`
- **Build**: esbuild production bundle
- **Unit tests**: Vitest + pytest
- **Integration tests**: Full sidecar pipeline tests
- **Security scan**: Trivy (SCA), Semgrep (SAST), Gitleaks (secrets)

Pre-commit hook: Gitleaks secrets scanning (`.githooks/pre-commit`).

## Packaging

```bash
npm run package    # Produces claude-voice-<version>.vsix
```

The `.vscodeignore` excludes tests, fixtures, sidecar source, dev configs, and spec docs. The packaged `.vsix` contains only `package.json` and `dist/extension.js`.
