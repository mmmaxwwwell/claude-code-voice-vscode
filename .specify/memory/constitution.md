<!-- Sync Impact Report
  Version change: 0.0.0 → 1.0.0 (initial ratification)
  Added principles: I–V (all new)
  Added sections: Technical Constraints, Development Workflow
  Templates requiring updates: ✅ None (initial constitution, templates are generic)
  Follow-up TODOs: None
-->

# Claude Voice Constitution

## Core Principles

### I. Sidecar Architecture

The extension MUST be a thin TypeScript orchestrator that delegates all audio and ML work to a Python sidecar process. The extension handles VS Code lifecycle, UI (status bar), settings, and IPC. The sidecar handles mic capture, VAD, wake word detection, and speech-to-text. Communication between extension and sidecar MUST use a well-defined JSON protocol over stdin/stdout. Neither side may assume implementation details of the other beyond the protocol contract.

### II. Local-Only Processing

All audio processing — voice activity detection, wake word detection, and speech-to-text — MUST run locally. No audio data leaves the machine. No cloud STT services. This is a privacy constraint, not a cost optimization. Dependencies (silero-vad, openwakeword/porcupine, faster-whisper) are chosen specifically because they run locally.

### III. Minimal Surface Area

The extension adds voice as an input method to Claude Code — nothing more. No custom webviews, no chat UI, no attempt to replicate or replace Claude Code functionality. The only UI elements are a status bar indicator and VS Code settings. Integration with Claude Code is via its existing commands and simulated keystrokes into its input field.

### IV. Test-First for Protocol and Pipeline

TDD is mandatory for the IPC protocol (JSON message serialization/deserialization, message routing) and the audio pipeline stages (VAD state machine, wake word → STT handoff, transcription delivery). Tests for the extension use VS Code's test infrastructure. Tests for the sidecar use pytest. Integration tests verify the extension ↔ sidecar protocol by spawning a real sidecar process with a stub audio source.

### V. Simplicity Over Configurability

Start with the simplest working pipeline: one wake word ("hey claude"), one STT model (faster-whisper base), one mic (system default). Add configurability only when the simple version works end-to-end. Every setting added must justify its existence — if a reasonable default covers 90% of users, hardcode it and move on.

## Technical Constraints

- **Extension**: TypeScript, VS Code Extension API, no native Node modules (audio goes through sidecar)
- **Sidecar**: Python 3.11+, minimal pip dependencies (silero-vad, faster-whisper, openwakeword)
- **IPC**: JSON-over-stdin/stdout between extension and sidecar — one JSON object per line (newline-delimited JSON)
- **Primary platform**: Linux (X11/Wayland). macOS support is a stretch goal, not a launch requirement.
- **No native audio in the extension**: The VS Code extension process MUST NOT capture audio directly. All audio capture happens in the sidecar via PyAudio or sounddevice.

## Development Workflow

- Direct-to-main development — single developer, no feature branches or PRs required
- Nix flake for reproducible dev environment (Python + Node.js + system audio libs)
- `npm run test` for extension tests, `pytest` for sidecar tests
- Lint with ESLint (extension) and ruff (sidecar)
- The sidecar is developed and tested independently of the extension — it must work as a standalone CLI that reads audio and prints transcriptions

## Governance

This constitution defines the architectural boundaries for claude-voice. All implementation decisions must comply with these principles. Amendments require updating this document with rationale and incrementing the version.

**Version**: 1.0.0 | **Ratified**: 2026-03-25 | **Last Amended**: 2026-03-25
