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

## Infrastructure Decisions (local preset defaults)

- **Logging**: Language-default structured logger at INFO level, stderr output. No correlation IDs.
- **Error handling**: Simple error hierarchy (AppError → ValidationError, NotFoundError, InternalError). No HTTP status mapping.
- **Configuration**: VS Code settings for extension config, config file for sidecar. No secret management.
- **CI/CD**: None initially
- **Branching**: Direct-to-main

## User Preferences / Pushbacks

- No cloud STT — everything runs locally (privacy constraint, non-negotiable)
- No custom UI beyond status bar and settings
- Linux primary, macOS stretch goal
- Keep dependencies minimal
