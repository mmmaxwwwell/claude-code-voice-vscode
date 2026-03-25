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
| `npm run check` | lint + typecheck + all tests |

### Sidecar (Python)

| Command | Description |
|---------|-------------|
| `uv run pytest tests/unit/python/` | Sidecar unit tests |
| `uv run pytest tests/integration/` | Sidecar integration tests |
| `uv run python -m sidecar --socket <path>` | Run sidecar manually |

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
│ protocol.ts         │                             │ command_words.py    │
└─────────────────────┘                             │ protocol.py         │
                                                    │ errors.py           │
                                                    └─────────────────────┘
```

**Extension** → spawns sidecar as a child process, connects via Unix domain socket at `$XDG_RUNTIME_DIR/claude-voice-<pid>.sock`. Communication is NDJSON (newline-delimited JSON): extension sends `config` and `control` messages, sidecar sends `status`, `transcript`, and `error` messages. Protocol contract: `specs/001-voice-mode/contracts/socket-protocol.md`.

**Sidecar pipeline**: Microphone → WebRTC VAD (reject silence) → Silero VAD via ONNX (confirm speech) → openWakeWord (gate in wake-word mode) → faster-whisper STT → command word detection → transcript delivered to extension.

**Three input modes**:
- **Wake Word** — "hey claude [command] send it" triggers transcription
- **Push-to-Talk** — hold keybinding to speak, release to transcribe
- **Continuous Dictation** — all speech transcribed, command words delimit chunks

## Testing

Tests use TDD — write tests first, verify they fail, then implement.

- **TypeScript unit tests**: Vitest in `tests/unit/ts/` — protocol, config, status bar, socket client
- **Python unit tests**: pytest in `tests/unit/python/` — VAD, command words, transcriber, protocol
- **Integration tests**: `tests/integration/` — real sidecar spawned with audio fixtures
- **Audio fixtures**: `tests/fixtures/audio/` — WAV files (16kHz mono) for deterministic testing

### Running tests

```bash
# All tests
npm run check

# TypeScript only
npm run test:unit

# Python only
uv run pytest tests/unit/python/

# Integration
npm run test:integration
```

## Key Paths

- Models cache: `~/.cache/claude-voice/models/`
- Socket: `$XDG_RUNTIME_DIR/claude-voice-<pid>.sock` (fallback `/tmp`)
- Extension bundle: `dist/extension.js`
- Spec docs: `specs/001-voice-mode/`
