# Claude Voice Constitution

## Core Principles

### I. Local-First Privacy
All audio processing — VAD, wake word detection, speech-to-text, TTS — runs locally. No audio or transcription data leaves the machine. No cloud services, no telemetry, no network calls for core functionality. Model downloads are the sole exception.

### II. FOSS Stack
Every runtime dependency must be fully open-source with a permissive license (MIT, Apache 2.0, BSD). No commercial SDKs with free tiers, no proprietary models, no vendor lock-in. This is non-negotiable and drives all technology choices.

### III. Sidecar Architecture
Audio processing lives in a Python sidecar process, cleanly separated from the TypeScript extension. Communication is via Unix domain socket with a well-defined JSON protocol. The extension is a thin orchestrator — it manages the sidecar lifecycle and bridges transcripts to Claude Code. The sidecar owns the audio pipeline.

### IV. Test-First
TDD for core logic. Integration tests exercise the real sidecar process with real audio (from fixtures), real socket communication, and real transcription. Stub processes for external tools follow the stub-process pattern — real child processes with real pipes, not mocks.

### V. Minimal Surface
Status bar + VS Code settings. No custom panels, webviews, or floating widgets. No audio cues. The extension should be invisible when idle and obvious when active. Complexity lives in the sidecar, not the UI.

### VI. Graceful Degradation
Missing dependencies produce clear, actionable error messages — not stack traces. The extension checks for prerequisites on activation and guides the user to fix issues. Auto-restart on crash with a circuit breaker (3 in 60s). Partial functionality is better than total failure — if TTS is missing, voice input still works.

### VII. Simplicity (YAGNI)
No plugin system, no remote connections, no multi-user support, no custom UI framework. Build the simplest thing that works for a single developer on Linux. macOS is a stretch goal, not a design constraint.

## Governance

This constitution defines the architectural boundaries for claude-voice. All implementation decisions should be evaluated against these principles. When in conflict, privacy (I) and FOSS (II) take precedence over all others.

**Version**: 1.0.0 | **Ratified**: 2026-03-25 | **Last Amended**: 2026-03-25
