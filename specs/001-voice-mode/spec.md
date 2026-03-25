# Feature Specification: Conversational Voice Mode

**Feature Branch**: `001-voice-mode`
**Created**: 2026-03-25
**Status**: Draft
**Preset**: local

## Overview

Always-listening voice input for the Claude Code VS Code extension. A Python sidecar process captures microphone audio, detects speech via two-stage VAD, recognizes wake words, transcribes speech locally via faster-whisper, and sends transcriptions to the extension over a Unix domain socket. The extension bridges to Claude Code by simulating keystrokes into its input field.

All audio processing runs locally — no cloud STT services.

## User Scenarios & Testing

### User Story 1 — Wake Word Activation (Priority: P1)

The user says "hey claude, refactor this function to use async/await". The sidecar detects the wake word, captures speech until a submit command word ("send it", "go", "submit"), strips the wake word and command word, transcribes the speech, and delivers the transcript to the Claude Code input.

**Why this priority**: This is the core interaction loop. Without it, nothing else matters.

**Independent Test**: Can be tested end-to-end with a pre-recorded audio file containing "hey claude [utterance] send it" fed to the sidecar. Validates wake word detection → STT → transcript delivery → command word stripping.

**Acceptance Scenarios**:

1. **Given** the extension is active and listening, **When** the user says "hey claude, add error handling to this function, send it", **Then** the wake word and command word are stripped, "add error handling to this function" is transcribed and delivered to Claude Code's input, and (if auto-submit is enabled) the message is submitted.
2. **Given** the extension is active and listening, **When** the user speaks without the wake word, **Then** the speech is ignored and no transcription is produced.
3. **Given** the extension is active and listening, **When** the user says "hey claude, actually never mind", **Then** the pending transcription is cancelled and nothing is sent to Claude Code.

---

### User Story 2 — Push-to-Talk (Priority: P1)

The user holds a keybinding (`Ctrl+Shift+Space` default), speaks their command, and releases. No wake word needed — everything captured while the key is held is transcribed and delivered.

**Why this priority**: Equal priority to wake word — some users prefer explicit control, and it's simpler (no wake word model needed). Essential fallback for noisy environments.

**Independent Test**: Simulate keydown → feed audio → keyup → verify transcript delivered.

**Acceptance Scenarios**:

1. **Given** push-to-talk mode is active, **When** the user holds the keybinding and speaks "explain this code", **Then** speech is captured from keydown to keyup, transcribed, and delivered to Claude Code's input.
2. **Given** push-to-talk mode is active, **When** the user taps the keybinding without speaking, **Then** no transcription is produced and no action is taken.
3. **Given** push-to-talk mode is active, **When** the user holds the key, says "cancel", and releases, **Then** the transcription is discarded post-transcription (command words are detected after key release, not in real-time during speech).

---

### User Story 3 — Continuous Dictation (Priority: P2)

The user activates continuous dictation mode (via command or setting). All detected speech is transcribed without requiring a wake word. Chunks are delimited by command words — submit words send the accumulated text, cancel words discard it.

**Why this priority**: Power-user feature for extended dictation sessions. Requires wake word and push-to-talk to work first.

**Independent Test**: Feed continuous audio with multiple utterances separated by silence and command words. Verify each chunk is delivered or cancelled correctly.

**Acceptance Scenarios**:

1. **Given** continuous dictation is active, **When** the user speaks "refactor the auth module... send it", **Then** "refactor the auth module" is transcribed and delivered.
2. **Given** continuous dictation is active, **When** the user speaks "no wait... never mind", **Then** the accumulated text is discarded.
3. **Given** continuous dictation is active, **When** the user is silent for an extended period, **Then** the system remains listening without producing empty transcriptions.

---

### User Story 4 — Status Bar Control (Priority: P1)

The user clicks a status bar button to start/stop listening. The status bar shows the current state: Idle, Listening, Processing, Error.

**Why this priority**: Primary UI control surface — users need to see what's happening and toggle listening.

**Independent Test**: Activate extension, verify status bar transitions through Idle → Listening → Processing → Idle on a voice command cycle.

**Acceptance Scenarios**:

1. **Given** the extension is idle, **When** the user clicks the status bar button, **Then** the sidecar starts, mic capture begins, and status changes to Listening.
2. **Given** the extension is listening, **When** the user clicks the status bar button, **Then** mic capture stops, sidecar is sent a `control:stop` message, and status changes to Idle.
3. **Given** the sidecar crashes, **When** the crash is detected, **Then** status changes to Error, a notification is shown, and auto-restart is attempted (up to 3 times in 60 seconds).

---

### User Story 5 — Model Management (Priority: P2)

The user selects a whisper model size in settings (tiny, base, small, medium). On first use, the model is automatically downloaded to `~/.cache/claude-voice/models/`. A manual download command is also available.

**Why this priority**: Required for STT to function, but the download/management UX is secondary to the core voice pipeline.

**Independent Test**: Set model size to "tiny", trigger first activation, verify download progress notification appears, model file is saved to correct path, and subsequent activations skip download.

**Acceptance Scenarios**:

1. **Given** no model is downloaded, **When** the user activates listening for the first time, **Then** a VS Code progress notification shows download progress, the model is saved to `~/.cache/claude-voice/models/`, and listening begins after download completes.
2. **Given** a model is already downloaded, **When** the user activates listening, **Then** the sidecar starts immediately without downloading.
3. **Given** the user runs the "Download Model" command, **When** a model size is selected, **Then** the model is downloaded (or confirmed already present) with progress shown.

---

### Edge Cases & Failure Modes

**Sidecar lifecycle:**
- **Sidecar crash mid-transcription**: Pending audio is lost. Extension detects socket disconnect, shows Error status, auto-restarts sidecar. No partial transcript is delivered.
- **Sidecar fails to start** (Python not found, missing dependencies): Extension shows error notification with actionable message ("Python sidecar failed to start: missing faster-whisper. Run `pip install faster-whisper`"). Status stays Error.
- **3+ crashes in 60 seconds**: Auto-restart stops. Error notification tells user to check logs. Manual restart via status bar click or command.

**Audio & transcription:**
- **No microphone available**: Sidecar reports error on startup. Extension shows notification: "No microphone found". Status stays Error.
- **Mic permission denied**: Same as above with "Microphone permission denied" message.
- **Empty transcription** (VAD triggered but whisper produces empty/whitespace result): Silently discarded, no action taken.
- **Very long utterance** (user speaks for minutes): Sidecar buffers and transcribes in chunks to avoid memory exhaustion. Max single transcription duration configurable (default 60s).
- **Background noise triggers VAD but not wake word**: No action — wake word gate prevents spurious transcriptions.
- **Wake word false positive** (TV says "hey claude"): Transcription of non-command speech is delivered. Acceptable in local preset — user can cancel or use push-to-talk in noisy environments.

**Claude Code integration:**
- **Claude Code sidebar not open**: Extension calls `claude-vscode.sidebar.open` before typing.
- **Claude Code input not focused**: Extension calls `claude-vscode.focus` before typing.
- **Claude Code extension not installed**: Extension checks on activation. Shows notification: "Claude Code extension required." Deactivates voice features.
- **Rapid sequential transcriptions**: Queue transcriptions and deliver in order. Don't overlap typing simulations.
- **Transcription contains special characters**: Text is delivered as-is. No escaping needed since we simulate typing character by character.

**Model management:**
- **Download interrupted** (network failure, user cancels): Partial file is deleted. Next activation retries download.
- **Disk full during download**: Error notification with clear message. Partial file cleaned up.
- **Model file corrupted**: Sidecar fails to load model, reports error. Extension shows notification suggesting re-download. User runs "Download Model" command to fix.
- **Model size changed in settings while listening**: Current session continues with old model. New model used on next sidecar restart.

**Resource exhaustion:**
- **High CPU from continuous STT**: Two-stage VAD minimizes unnecessary Whisper invocations. Whisper only runs on confirmed speech segments.
- **Memory growth in long sessions**: Sidecar should not accumulate audio buffers beyond the current utterance. Processed audio is discarded immediately.

---

## Requirements

### Functional Requirements

#### Extension Core
- **FR-001**: Extension MUST provide a status bar item showing current state: Idle, Listening, Processing, Error
- **FR-002**: Extension MUST start the Python sidecar process when the user clicks the status bar button to begin listening
- **FR-003**: Extension MUST stop the sidecar when the user clicks the status bar button to stop listening
- **FR-004**: Extension MUST auto-restart the sidecar on crash, up to 3 times within 60 seconds
- **FR-005**: Extension MUST show a VS Code notification on sidecar crash with error details
- **FR-006**: Extension MUST verify Claude Code extension is installed on activation and show a notification if missing

#### Communication Protocol
- **FR-010**: Extension and sidecar MUST communicate via a Unix domain socket with newline-delimited JSON messages
- **FR-011**: Protocol MUST support message types: `status`, `transcript`, `config`, `control`, `error`
- **FR-012**: Extension MUST send `config` messages to sidecar on startup with current settings (mode, model, wake word, command words)
- **FR-013**: Extension MUST send `control` messages for start/stop listening and push-to-talk start/stop
- **FR-014**: Sidecar MUST send `status` messages for pipeline state changes: `ready`, `listening`, `speech_start`, `speech_end`, `wake_word_detected`, `processing`
- **FR-015**: Sidecar MUST send `transcript` messages with final transcription text
- **FR-016**: Sidecar MUST send `error` messages with error code and human-readable description

#### Voice Activity Detection
- **FR-020**: Sidecar MUST implement two-stage VAD: WebRTC VAD for fast rejection, Silero VAD (ONNX) for neural confirmation
- **FR-021**: Sidecar MUST maintain a pre-speech audio buffer (~300ms) to avoid clipping initial phonemes
- **FR-022**: Sidecar MUST capture audio at 16kHz mono

#### Wake Word Detection
- **FR-030**: Sidecar MUST support wake word detection via openWakeWord
- **FR-031**: Extension MUST ship with a pre-trained "hey claude" openWakeWord model
- **FR-032**: Wake word MUST be configurable in extension settings
- **FR-033**: Wake word MUST be stripped from the final transcript

#### Speech-to-Text
- **FR-040**: Sidecar MUST transcribe speech locally using faster-whisper
- **FR-041**: User MUST be able to select whisper model size in settings: tiny, base, small, medium
- **FR-042**: Extension MUST auto-download the selected model on first use to `~/.cache/claude-voice/models/`
- **FR-043**: Extension MUST show download progress via VS Code progress notification
- **FR-044**: Extension MUST provide a "Download Model" command for manual pre-download

#### Command Words
- **FR-050**: Sidecar MUST support configurable submit command words (defaults: "send it", "go", "submit")
- **FR-051**: Sidecar MUST support configurable cancel command words (defaults: "never mind", "cancel")
- **FR-052**: Command words MUST be stripped from the final transcript
- **FR-053**: Submit command words MUST trigger transcript delivery to the extension
- **FR-054**: Cancel command words MUST discard the accumulated transcription

#### Input Modes
- **FR-060**: Extension MUST support three input modes: wake word, push-to-talk, continuous dictation
- **FR-061**: Push-to-talk MUST use a configurable keybinding (default: `Ctrl+Shift+Space`), hold-to-talk (release ends recording)
- **FR-062**: In wake word mode, speech without the wake word MUST be ignored
- **FR-063**: In continuous dictation mode, all detected speech MUST be transcribed and accumulated until a command word. Each VAD speech segment appends to the accumulation buffer. If no command word is spoken, the buffer accumulates indefinitely (bounded only by `maxUtteranceDuration` per individual segment).

#### Claude Code Integration
- **FR-070**: Extension MUST deliver transcriptions to Claude Code by simulating typing into the focused input
- **FR-071**: Extension MUST open the Claude Code sidebar (`claude-vscode.sidebar.open`) if not visible before delivering text
- **FR-072**: Extension MUST focus the Claude Code input (`claude-vscode.focus`) before typing
- **FR-073**: Extension MUST support two delivery modes: auto-submit (simulate Enter after typing) and paste-and-review (type text, leave cursor in input)
- **FR-074**: Delivery mode MUST be configurable in extension settings
- **FR-075**: Transcriptions MUST be queued and delivered sequentially — no overlapping typing simulations

#### Model & Dependency Management
- **FR-090**: Extension MUST store downloaded models in `~/.cache/claude-voice/models/`
- **FR-091**: Partial/interrupted downloads MUST be cleaned up (no partial files left on disk)
- **FR-092**: Extension MUST provide a "Check Dependencies" command that verifies Python, faster-whisper, silero-vad, openwakeword are available

### Key Entities

- **Sidecar Process**: Long-running Python process managing audio capture, VAD, wake word, and STT
- **Voice Session**: Period between user activating and deactivating listening — encompasses multiple utterances
- **Utterance**: Single speech segment from speech_start to command word, bounded by VAD
- **Transcript**: Final text output from an utterance, with wake word and command words stripped
- **Command Word**: Configurable trigger words for submit ("send it") or cancel ("never mind") actions

### Extension Settings

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `claude-voice.inputMode` | enum | `wakeWord` | Active input mode: `wakeWord`, `pushToTalk`, `continuousDictation` |
| `claude-voice.wakeWord` | string | `hey_claude` | openWakeWord model name |
| `claude-voice.submitWords` | string[] | `["send it", "go", "submit"]` | Words that trigger transcript submission |
| `claude-voice.cancelWords` | string[] | `["never mind", "cancel"]` | Words that discard current transcript |
| `claude-voice.deliveryMode` | enum | `autoSubmit` | `autoSubmit` or `pasteAndReview` |
| `claude-voice.whisperModel` | enum | `base` | Model size: `tiny`, `base`, `small`, `medium` |
| `claude-voice.pushToTalkKey` | string | `ctrl+shift+space` | Keybinding for push-to-talk |
| `claude-voice.silenceTimeout` | number | `1500` | Milliseconds of silence before ending an utterance (applies to VAD speech-end detection across all modes) |
| `claude-voice.maxUtteranceDuration` | number | `60000` | Maximum single utterance duration in ms |
| `claude-voice.micDevice` | string | `""` | Microphone device name (empty = system default) |

---

## Infrastructure Decisions (local preset)

**Logging**: Python `logging` module at INFO level, stderr output. Extension side uses VS Code `OutputChannel` named "Claude Voice". No correlation IDs.

**Error handling**: Simple hierarchy:
```
VoiceError (base)
├── SidecarError        — sidecar process failures (crash, start failure)
├── AudioError          — microphone/audio capture issues
├── TranscriptionError  — STT model failures
├── DependencyError     — missing Python packages or tools
└── IntegrationError    — Claude Code extension communication failures
```
Extension-side errors surface as VS Code notifications. Sidecar-side errors are sent via `error` socket messages.

**Configuration**: VS Code settings for extension config. Sidecar receives config via socket `config` message on startup — no separate config file.

**CI/CD**: None initially.

**Branching**: Direct-to-main.

---

## Success Criteria

- **SC-001**: User can activate listening via status bar, say "hey claude [command] send it", and see the transcribed command appear in Claude Code's input — validates FR-001, FR-002, FR-010, FR-020, FR-030, FR-033, FR-040, FR-050, FR-052, FR-070, FR-071, FR-072
- **SC-002**: Push-to-talk works end-to-end: hold key, speak, release, transcript delivered — validates FR-060, FR-061, FR-070
- **SC-003**: Cancel command words ("never mind") discard pending transcription — validates FR-051, FR-054
- **SC-004**: Sidecar auto-restarts on crash with notification, stops after 3 crashes in 60s — validates FR-004, FR-005
- **SC-005**: Model auto-downloads on first use with progress indicator — validates FR-042, FR-043
- **SC-006**: Status bar correctly reflects Idle/Listening/Processing/Error states — validates FR-001
- **SC-007**: Two-stage VAD prevents whisper from running on silence/noise — validates FR-020
- **SC-008**: Extension degrades gracefully when Claude Code extension is not installed — validates FR-006

## Assumptions

- User has Python 3.11+ available on PATH (required for sidecar dependencies)
- User has a working microphone accessible to the OS
- User has the Claude Code VS Code extension installed (soft requirement — degrades gracefully if missing)
- Linux is the primary platform; macOS support is a stretch goal
- The Claude Code extension does not expose a public API — integration is via simulated typing (fragile but only available option)
- `claude-vscode.sidebar.open`, `claude-vscode.focus`, `claude-vscode.blur`, `claude-vscode.newConversation` commands remain available and stable
