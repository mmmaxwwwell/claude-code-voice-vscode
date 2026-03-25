# Research: Conversational Voice Mode

**Date**: 2026-03-25

## Technology Decisions

### Extension Language & Tooling

**Decision**: TypeScript + esbuild + npm

**Rationale**: VS Code extensions must be TypeScript/JavaScript. esbuild is VS Code's recommended bundler (fast, zero-config). npm is the ecosystem default — no benefit from pnpm/yarn for a single-package extension.

**Alternatives rejected**:
- JavaScript (no types): Would make protocol serialization and settings typing error-prone
- webpack: Slower than esbuild, more config overhead, no benefit for an extension

### Python Sidecar Package Management

**Decision**: uv + pyproject.toml

**Rationale**: uv is fast, already available via Nix, handles virtualenvs and dependency resolution. pyproject.toml is the modern Python standard.

**Alternatives rejected**:
- pip + requirements.txt: Slower, no lockfile, less reproducible
- poetry: Heavier than needed for a sidecar with ~5 dependencies
- conda: Overkill, not needed for this dependency set

### Communication Protocol

**Decision**: Unix domain socket with newline-delimited JSON (NDJSON)

**Rationale**: User chose socket over stdin/stdout for bidirectional async messaging — sidecar pushes VAD state changes and partial status updates without being polled. NDJSON is simple to parse, debug (just `socat`), and test with stub scripts. Socket path: `$XDG_RUNTIME_DIR/claude-voice-<pid>.sock` with `/tmp` fallback — PID suffix avoids collisions across VS Code windows, XDG_RUNTIME_DIR is the Linux-correct location for per-user runtime files.

**Alternatives rejected**:
- stdin/stdout: Can't push events from sidecar to extension without polling. User explicitly chose socket.
- WebSocket: Adds a dependency (ws library) for no benefit over Unix socket — no cross-machine requirement.
- HTTP/REST: Higher overhead per message, poor fit for streaming status updates.
- gRPC: Massive dependency for a simple protocol with ~6 message types.

### Voice Activity Detection

**Decision**: Two-stage VAD — WebRTC VAD (stage 1) → Silero VAD via ONNX Runtime (stage 2)

**Rationale**: User chose two-stage. WebRTC VAD is extremely cheap (~microseconds per frame) and rejects obvious silence before invoking the neural model. Silero via ONNX avoids pulling in PyTorch (~2GB). Research confirmed this is the dominant pattern (used by RealtimeSTT).

**Alternatives rejected**:
- Silero-only: Works but wastes CPU running neural inference on silence. Two-stage adds negligible complexity.
- Energy-based VAD: Research showed this fails in noisy environments (VoxPilot's weakness).
- WebRTC-only: Not accurate enough — false positives on keyboard typing, fan noise.

### Wake Word Engine

**Decision**: openWakeWord (Apache 2.0)

**Rationale**: User requires fully FOSS stack. openWakeWord is Apache 2.0, runs on CPU with ONNX Runtime (switched from TFLite due to numpy 2.x incompatibility), supports custom wake word training via Google Colab notebook (synthetic speech, ~1 hour). Ships with 6 pre-trained models but not "hey claude" — we train a custom ONNX model.

**Alternatives rejected**:
- Porcupine (Picovoice): Better DX for custom wake words, but commercial licensing with free tier limits. User's FOSS requirement is non-negotiable.
- Snowboy: Abandoned/unmaintained.
- Mycroft Precise: Less active than openWakeWord, smaller community.

### Speech-to-Text

**Decision**: faster-whisper (MIT license) via CTranslate2

**Rationale**: Local-only STT, good accuracy, GPU acceleration available, lower memory than original Whisper. CTranslate2 backend is optimized for inference. Model sizes from tiny (~75MB) to medium (~1.5GB) give users a speed/accuracy tradeoff.

**Alternatives rejected**:
- whisper.cpp: C++ binary — would need to manage a second native binary alongside the Python sidecar. faster-whisper keeps everything in one Python process.
- Moonshine ASR: Smaller models but less accurate, newer/less proven. VoxPilot uses it but it's optimized for different tradeoffs.
- Cloud STT (OpenAI Whisper API, Google, AWS): Non-negotiable privacy constraint — no cloud services.
- VS Code Speech extension: Cloud-based, can't be used as a library.

### Test Strategy

**Decision**: Vitest (TypeScript) + pytest (Python), integration tests with real sidecar process

**Rationale**: Local preset — unit tests for core logic, integration tests for sidecar communication. No custom test reporter (local preset allows built-in reporters). Audio fixture files (WAV) for reproducible testing.

**Alternatives rejected**:
- Jest: Slower than Vitest, less ESM-friendly.
- Mocha: Less batteries-included than Vitest.
- @vscode/test-electron for all tests: Slow (boots Electron). Reserve for tests that genuinely need VS Code API.

### Project Structure

**Decision**: `src/` for TypeScript extension, `sidecar/` for Python, `tests/` at root with subdirs per type

**Rationale**: Clean separation between the two language ecosystems. Tests colocated by type (unit/integration) rather than by language — integration tests span both languages (TS test spawns Python sidecar).

### Socket Path

**Decision**: `$XDG_RUNTIME_DIR/claude-voice-<pid>.sock` with `/tmp` fallback

**Rationale**: XDG_RUNTIME_DIR is the Linux-standard location for per-user runtime sockets (typically `/run/user/<uid>/`). PID suffix prevents collisions when multiple VS Code windows each run their own sidecar. Falls back to `/tmp` if XDG_RUNTIME_DIR is unset (macOS stretch goal).

### Build & Package

**Decision**: esbuild bundles extension to single JS file, Python sidecar shipped as source (not bundled)

**Rationale**: VS Code extensions are typically bundled to a single file for performance. The Python sidecar runs in its own process with its own venv — no need to bundle. Users install Python deps via the extension's "Check Dependencies" command or Nix flake.

## User Preferences & Constraints (from interview)

- **Privacy**: Non-negotiable. Everything local. No cloud services.
- **FOSS**: Non-negotiable. All runtime dependencies must be open-source with permissive licenses.
- **No Docker**: Not explicitly rejected, but Nix is available and preferred.
- **No custom UI**: Status bar + settings only. No webviews, panels, or floating widgets.
- **Linux primary**: macOS is a stretch goal, not a design constraint.
- **Command words over silence**: User explicitly chose command words for chunk termination because silence-based termination causes premature submission during thinking pauses.
