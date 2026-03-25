# Interview Notes: Conversational Voice Mode

**Date**: 2026-03-25
**Preset**: local
**Nix available**: yes

## Key Decisions

1. **Activation model**: User clicks a status bar button to start listening (not auto-start on extension activation)
2. **Voice input modes**: All three modes configurable — push-to-talk, wake word ("hey claude"), and continuous dictation
3. **Transcription delivery**: Configurable — auto-submit or paste-and-review
4. **Audio feedback**: Status bar indicator only — no audio cues (beeps/chimes)
5. **STT model management**: User selects model size in settings, auto-download on first use
6. **Status bar states**: Idle, Listening, Processing, Error
7. **Error recovery**: Auto-restart sidecar on crash with notification; stop after 3 crashes in 60s
8. **Communication protocol**: Unix domain socket with newline-delimited JSON — chosen over stdin/stdout for bidirectional async messaging (sidecar pushes VAD state updates in real-time)
9. **VAD strategy**: Two-stage — WebRTC VAD for fast silence rejection, Silero VAD (ONNX) for neural confirmation. Avoids full PyTorch dependency.
10. **Wake word engine**: openWakeWord (Apache 2.0, fully FOSS) — chosen over Porcupine due to licensing constraint. Ship pre-trained "hey claude" model generated via openWakeWord's Colab training notebook.
11. **Chunk termination**: Configurable command words, not silence-based. Submit words ("send it", "go", "submit") deliver the transcript. Cancel words ("never mind", "cancel") discard it. All command words stripped from transcript.
12. **Wake word stripping**: Yes — wake word is always removed from the final transcript.

## Alternatives Considered and Rejected

| Decision | Rejected alternative | Reason |
|----------|---------------------|--------|
| Unix socket | stdin/stdout | Needed bidirectional async for real-time VAD status pushes |
| openWakeWord | Porcupine | User requires fully FOSS stack; Porcupine has commercial licensing |
| Command words for chunk end | Silence timeout | Silence-only causes premature submission on long pauses mid-thought |
| Two-stage VAD | Silero-only | WebRTC pre-filter is cheap and reduces unnecessary Silero invocations |
| Two-stage VAD | Energy-based VAD | Research showed energy-based VAD fails in noisy environments |
| Local STT (faster-whisper) | Cloud STT services | Non-negotiable privacy constraint from user |

## User Priorities

1. **Privacy** — Everything runs locally. No cloud STT. Non-negotiable.
2. **FOSS** — Entire dependency stack must be fully open-source. This drove the openWakeWord choice over Porcupine.
3. **Minimal dependencies** — Keep the stack lean. ONNX for Silero (not full PyTorch).
4. **Linux primary** — macOS is a stretch goal, not a launch requirement.
5. **Simple UI** — Status bar + settings only. No custom panels or webviews.

## Surprising / Non-obvious Requirements

- **Command words instead of silence for chunk termination** — Most similar projects use silence timeout. User explicitly wanted explicit command words because silence-based termination causes premature submission during thinking pauses.
- **Cancel words** — Not just submit words, but also explicit cancel/discard words ("never mind", "cancel"). These discard accumulated audio, acting as a verbal undo.
- **Pre-speech buffer** — Research revealed that not buffering ~300ms of pre-speech audio causes clipped word beginnings. This is a subtle requirement that's easy to miss.

## Infrastructure Decisions Summary (local preset defaults)

| Topic | Decision | Status |
|-------|----------|--------|
| Logging | Structured JSON to stderr (sidecar), VS Code OutputChannel (extension). Correlation IDs per utterance. Level via `CLAUDE_VOICE_LOG_LEVEL` env var. | Updated per local preset |
| Error handling | VoiceError hierarchy (Sidecar, Audio, Transcription, Config, Dependency, Integration) with exit codes per category. Global unhandled exception handler. | Updated per local preset |
| Configuration | VS Code settings → socket config message to sidecar. Fail-fast validation on receipt. | Updated per local preset |
| Graceful shutdown | Shutdown hook registry, reverse-order cleanup, 5s timeout. SIGTERM/SIGINT handling. | Added per local preset |
| Config validation | Sidecar validates config on receipt — model enum, file existence, non-empty word lists, numeric ranges | Added per local preset |
| CI/CD | GitHub Actions: lint, typecheck, build, tests, Tier 1 security (Trivy, Semgrep, Gitleaks). Gitleaks pre-commit hook. | Updated per local preset |
| Structured test output | Custom Vitest + pytest reporters producing `test-logs/` with `summary.json` + failure logs | Added per local preset |
| DX tooling | VS Code `launch.json` debug configs, `clean:all` script | Added per local preset |
| Health check | `--check` flag on sidecar to verify pipeline can initialize | Added per local preset |
| Branching | Direct-to-main | Accepted (default) |
| Auth | N/A (local tool) | Skipped per preset |
| Security | N/A (local tool, no network) | Skipped per preset |
| Observability | Logging only | Accepted (default) |

## Research Findings (Prior Art)

Key projects researched:
- **RealtimeSTT** — Best reference architecture for mic→VAD→STT pipeline. Two-stage VAD (WebRTC→Silero), pre-speech buffer, faster-whisper backend.
- **voice-mode (PyPI)** — Python package wrapping Claude Code with local Whisper + Kokoro TTS. Most relevant prior art.
- **VoxPilot** — VS Code extension using Moonshine ASR. Energy-based VAD proved fragile in noisy environments.
- **Claude Code native voice** — Push-to-talk only, cloud-based transcription. Deliberately chose PTT over always-on for privacy.
- **openWakeWord** — 6 built-in models (alexa, hey_mycroft, hey_jarvis, hey_rhasspy, timer, weather). Custom "hey claude" model trainable via Colab notebook in ~1 hour using synthetic speech.

## Project Description

VS Code extension that adds conversational voice input to the Claude Code extension, using a fully local and FOSS audio pipeline (faster-whisper, openWakeWord, Silero VAD) running in a Python sidecar process.
