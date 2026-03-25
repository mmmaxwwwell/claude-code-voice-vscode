# Feature Specification: Conversational Voice Mode

**Feature Branch**: `001-voice-mode`
**Created**: 2026-03-25
**Status**: Draft
**Input**: User description: "Always-listening voice input that detects when I'm talking to Claude, transcribes my speech, and sends it to the Claude Code VS Code extension."

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Push-to-Talk Voice Input (Priority: P1)

As a developer using Claude Code in VS Code, I want to hold a keybinding to speak a prompt and have it transcribed and sent to Claude, so I can interact with Claude hands-free without typing.

I click the "Start Listening" button in the status bar. The status bar changes to "Listening." I press and hold my push-to-talk keybinding, speak my prompt ("refactor this function to use async/await"), and release. The status bar shows "Processing" while the speech is transcribed. The transcribed text appears in the Claude Code input field. Depending on my settings, it either auto-submits or waits for me to review and press Enter.

**Why this priority**: This is the minimal viable voice input path — it works without wake word detection, requires the fewest pipeline components (just VAD + STT), and gives the user full control over when the system listens.

**Independent Test**: Can be tested by starting the extension, clicking the status bar to begin listening, pressing the push-to-talk key, speaking a phrase, and verifying the transcribed text appears in the Claude Code input field.

**Acceptance Scenarios**:

1. **Given** the extension is installed and the sidecar is available, **When** the user clicks the status bar icon, **Then** the sidecar starts and the status bar changes to "Listening"
2. **Given** the status bar shows "Listening", **When** the user holds the push-to-talk key and speaks, **Then** the status bar changes to "Processing" after the key is released
3. **Given** the user has spoken and released the push-to-talk key, **When** transcription completes, **Then** the transcribed text is inserted into the Claude Code input field
4. **Given** auto-submit is enabled, **When** transcription completes, **Then** the text is submitted to Claude automatically
5. **Given** auto-submit is disabled, **When** transcription completes, **Then** the text is inserted but not submitted, allowing the user to review and edit

---

### User Story 2 - Wake Word Activation (Priority: P2)

As a developer, I want to say "hey claude" followed by my prompt, so I can interact with Claude without pressing any keys at all.

While listening mode is active, I say "hey claude, explain this error message." The system detects the wake word, begins recording my speech, detects when I stop talking (via voice activity detection), transcribes the utterance, and sends it to Claude Code.

**Why this priority**: This is the flagship experience — fully hands-free. It depends on the same STT pipeline as P1 but adds wake word detection and VAD-based utterance boundary detection, which are additional complexity.

**Independent Test**: Can be tested by activating listening mode, saying "hey claude" followed by a phrase, and verifying the transcribed text (minus the wake word) appears in the Claude Code input.

**Acceptance Scenarios**:

1. **Given** listening mode is active with wake word mode enabled, **When** the user says the configured wake word, **Then** the status bar changes to "Processing" and the system begins recording the utterance
2. **Given** the wake word was detected and the user is speaking, **When** the user stops speaking (silence detected by VAD), **Then** the system stops recording and begins transcription
3. **Given** transcription is complete after wake word activation, **When** the text is ready, **Then** the wake word phrase is stripped and only the command text is sent to Claude Code
4. **Given** ambient speech is occurring without the wake word, **When** people talk near the mic, **Then** the system remains in "Listening" state and does not trigger transcription

---

### User Story 3 - Continuous Dictation Mode (Priority: P3)

As a developer, I want a mode where everything I say is transcribed and sent to Claude, without needing a wake word or push-to-talk key for each utterance.

I activate continuous dictation mode. Everything I say is transcribed and sent to Claude Code. Silence gaps between utterances are used to segment individual messages. I deactivate the mode by clicking the status bar or using a keybinding.

**Why this priority**: This is useful for extended voice sessions but risks accidental input from ambient speech. It's a convenience mode built on top of the same pipeline.

**Independent Test**: Can be tested by activating continuous dictation, speaking multiple phrases with pauses between them, and verifying each phrase is individually transcribed and sent.

**Acceptance Scenarios**:

1. **Given** continuous dictation mode is active, **When** the user speaks, **Then** each utterance (delimited by VAD silence detection) is independently transcribed and sent to Claude Code
2. **Given** continuous dictation mode is active, **When** the user clicks the status bar or presses the stop keybinding, **Then** the mode deactivates and returns to Idle
3. **Given** continuous dictation mode is active, **When** the user pauses for longer than the configurable silence threshold, **Then** the current utterance is finalized and transcribed as a complete message

---

### User Story 4 - Sidecar Lifecycle and Error Recovery (Priority: P1)

As a developer, I want the voice sidecar to start reliably when I activate listening and recover automatically if it crashes, so I don't have to manually manage processes.

When I click "Start Listening," the extension spawns the Python sidecar process. If the sidecar crashes or becomes unresponsive, the extension detects this, shows a notification ("Voice sidecar restarted"), and automatically restarts it. The status bar reflects the current state accurately.

**Why this priority**: Without reliable sidecar management, none of the voice features work. This is foundational infrastructure.

**Independent Test**: Can be tested by starting listening mode, killing the sidecar process externally, and verifying the extension detects the crash, shows a notification, and restarts the sidecar within a few seconds.

**Acceptance Scenarios**:

1. **Given** the user clicks "Start Listening", **When** the sidecar is not running, **Then** the extension spawns the sidecar process and waits for its ready signal before changing status to "Listening"
2. **Given** the sidecar is running, **When** the sidecar process exits unexpectedly, **Then** the extension shows a notification "Voice sidecar restarted" and spawns a new sidecar within 5 seconds
3. **Given** the sidecar crashed, **When** auto-restart succeeds, **Then** the extension resumes the previous listening mode (wake word, push-to-talk, or continuous)
4. **Given** the sidecar crashes repeatedly (3+ times in 60 seconds), **When** the restart limit is hit, **Then** the extension shows an error notification and sets the status bar to "Error" without further restart attempts
5. **Given** the status bar shows "Error", **When** the user clicks it, **Then** the extension attempts a fresh sidecar start

---

### User Story 5 - STT Model Selection and Download (Priority: P2)

As a developer, I want to choose which speech-to-text model to use and have it downloaded automatically, so I can balance accuracy vs. speed for my hardware.

In VS Code settings, I select a faster-whisper model size (tiny, base, small, medium, large). If the model isn't already downloaded, the extension triggers a download with a progress notification. The model is cached locally for future use.

**Why this priority**: Model selection directly affects transcription quality and latency. Users on weaker hardware need smaller models; users with GPUs want larger ones.

**Independent Test**: Can be tested by selecting a model in settings, verifying the download starts (or is skipped if cached), and verifying the sidecar uses the selected model for transcription.

**Acceptance Scenarios**:

1. **Given** the user selects a model size in settings, **When** the model is not cached locally, **Then** the extension shows a download progress notification and the sidecar downloads the model
2. **Given** a model download is in progress, **When** the download completes, **Then** the notification updates to "Model ready" and the sidecar begins using the new model
3. **Given** the user selects a model that is already cached, **When** the sidecar starts, **Then** it loads the cached model without downloading
4. **Given** a model download fails (network error, disk full), **When** the failure occurs, **Then** the extension shows an error notification with the reason and falls back to the previously working model (if any)

---

### Edge Cases & Failure Modes

**Sidecar lifecycle**:
- What happens when the Python runtime is not found? → Extension shows an error notification with instructions to install Python and configure the path in settings. Status bar shows "Error."
- What happens when the sidecar starts but fails to initialize (e.g., missing pip dependencies)? → Sidecar sends an error message over the IPC protocol with details. Extension shows the error to the user.
- What happens when the sidecar becomes unresponsive (no crash, just hangs)? → Extension uses a heartbeat mechanism. If no heartbeat response within 10 seconds, the sidecar is killed and restarted.

**Audio pipeline**:
- What happens when no microphone is available? → Sidecar reports "no audio device" over IPC. Extension shows notification and sets status to "Error."
- What happens when the microphone is grabbed by another application? → Sidecar detects the audio stream failure, reports it over IPC. Extension shows notification.
- What happens when the user speaks but the wake word detector gives a false positive? → The utterance is transcribed and sent. Users can undo via Claude Code's normal interaction (this is an acceptable trade-off for local wake word detection).
- What happens when the wake word detector misses a real wake word? → The utterance is ignored. The user can repeat or switch to push-to-talk. No system action needed.

**Transcription delivery**:
- What happens when Claude Code's input field is not visible/focused? → The extension runs `claude-vscode.focus` command before inserting text. If the command fails, the text is copied to clipboard and a notification says "Transcription copied to clipboard — Claude Code input not available."
- What happens when two transcriptions complete in quick succession? → They are queued and delivered sequentially, each waiting for the previous submission to complete before inserting the next.

**Model management**:
- What happens when disk space is insufficient for model download? → Download fails, extension shows error with required space. Falls back to previously cached model.
- What happens when the user changes the model while a transcription is in progress? → The current transcription completes with the old model. The new model is loaded for the next transcription.

**Concurrent access**:
- What happens when multiple VS Code windows are open? → Only one instance should own the microphone at a time. The first window to activate listening claims the mic. Other windows attempting to activate get a notification "Mic in use by another window."

## Requirements *(mandatory)*

### Functional Requirements

**Sidecar Management**:
- **FR-001**: Extension MUST spawn a Python sidecar process when the user activates listening mode [Story 4]
- **FR-002**: Extension MUST communicate with the sidecar via newline-delimited JSON over stdin/stdout [Story 4]
- **FR-003**: Extension MUST detect sidecar crashes (process exit) and auto-restart within 5 seconds [Story 4]
- **FR-004**: Extension MUST implement a heartbeat mechanism to detect unresponsive sidecars (10-second timeout) [Story 4]
- **FR-005**: Extension MUST stop auto-restart attempts after 3 crashes within 60 seconds and show an error [Story 4]
- **FR-006**: Extension MUST show a notification on each auto-restart with the message "Voice sidecar restarted" [Story 4]

**Voice Input Modes**:
- **FR-007**: Extension MUST support push-to-talk mode where audio is captured only while a configurable keybinding is held [Story 1]
- **FR-008**: Extension MUST support wake word mode where a configurable wake phrase (default: "hey claude") triggers recording [Story 2]
- **FR-009**: Extension MUST support continuous dictation mode where all speech is transcribed until the user deactivates [Story 3]
- **FR-010**: User MUST be able to select the active voice input mode via VS Code settings [Stories 1, 2, 3]
- **FR-011**: Wake word mode MUST strip the wake word phrase from the transcribed text before delivery [Story 2]
- **FR-012**: Continuous dictation mode MUST segment utterances using VAD silence detection with a configurable silence threshold [Story 3]

**Audio Pipeline (Sidecar)**:
- **FR-013**: Sidecar MUST capture audio from the system microphone using the OS audio API [Stories 1, 2, 3]
- **FR-014**: Sidecar MUST perform voice activity detection to identify speech start and end [Stories 2, 3]
- **FR-015**: Sidecar MUST perform wake word detection when in wake word mode [Story 2]
- **FR-016**: Sidecar MUST transcribe speech to text using a local STT model (no cloud services) [Stories 1, 2, 3]
- **FR-017**: Sidecar MUST report audio device errors (no mic, mic grabbed) to the extension via IPC [Story 4]

**Transcription Delivery**:
- **FR-018**: Extension MUST focus the Claude Code input field (via `claude-vscode.focus` command) before inserting transcribed text [Stories 1, 2, 3]
- **FR-019**: Extension MUST insert transcribed text into the Claude Code input field via simulated keystrokes [Stories 1, 2, 3]
- **FR-020**: Extension MUST support configurable auto-submit behavior (auto-submit on, off) [Stories 1, 2, 3]
- **FR-021**: Extension MUST queue multiple transcriptions and deliver them sequentially [Stories 2, 3]
- **FR-022**: Extension MUST fall back to clipboard copy with notification if the Claude Code input is unavailable [Stories 1, 2, 3]

**Model Management**:
- **FR-023**: Extension MUST allow the user to select a STT model size via VS Code settings (tiny, base, small, medium, large) [Story 5]
- **FR-024**: Extension MUST trigger automatic model download when a selected model is not cached locally [Story 5]
- **FR-025**: Extension MUST show download progress via VS Code notification [Story 5]
- **FR-026**: Extension MUST cache downloaded models locally and reuse them across sessions [Story 5]
- **FR-027**: Extension MUST fall back to the previously cached model if a download fails [Story 5]

**Status Bar**:
- **FR-028**: Extension MUST display a status bar item showing the current state: Idle, Listening, Processing, Error [Stories 1, 2, 3, 4]
- **FR-029**: Status bar item MUST be clickable to toggle between Idle and Listening states [Story 4]
- **FR-030**: Status bar item in Error state MUST be clickable to retry sidecar startup [Story 4]

**Multi-Window**:
- **FR-031**: Only one VS Code window MUST own the microphone at a time; other windows attempting to activate listening MUST receive a notification [Edge Cases]

### Key Entities

- **Sidecar Process**: The Python process that handles audio capture, VAD, wake word detection, and STT. Lifecycle states: NotStarted → Starting → Ready → Error → Restarting
- **Voice Session**: An active listening session from activation to deactivation. Tracks the current input mode and queued transcriptions.
- **Transcription**: A single speech-to-text result. Contains the recognized text and metadata (duration, confidence if available).
- **IPC Message**: A JSON message exchanged between extension and sidecar. Types include: ready, heartbeat, heartbeat-ack, audio-config, start-listening, stop-listening, vad-event, wake-word-detected, transcription-result, error, download-progress, model-loaded.

## Testing

### Unit Tests
- IPC message serialization/deserialization (both TypeScript and Python sides)
- Status bar state machine transitions
- Transcription queue ordering and delivery logic
- Crash counter and restart throttling logic
- Configuration validation (model size, wake word, silence threshold)

### Integration Tests
- Extension ↔ sidecar IPC: spawn a real sidecar process with a stub audio source, send messages, verify responses
- Sidecar crash detection and auto-restart: spawn sidecar, kill it, verify restart
- Heartbeat timeout: spawn sidecar that stops responding, verify timeout detection
- Model download: verify the sidecar correctly downloads and loads a model (use the tiny model for test speed)
- Transcription delivery: verify text insertion into a mock VS Code input via command execution

### Stub Process
- A test stub sidecar (`tests/fixtures/stub-sidecar.py`) that implements the IPC protocol without real audio/ML dependencies. Accepts the same startup flags, responds to heartbeats, and sends fake transcription results on command.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: User can speak a prompt and see the transcribed text in the Claude Code input within 5 seconds of finishing speaking (using the base model) [FR-016, FR-019]
- **SC-002**: Wake word detection triggers on the configured phrase at least 90% of the time in a quiet environment [FR-015]
- **SC-003**: Wake word false positive rate is below 5% during 10 minutes of ambient office conversation [FR-015]
- **SC-004**: Sidecar auto-restarts after a crash within 5 seconds, and the user can resume voice input without manually restarting [FR-003, FR-006]
- **SC-005**: Status bar accurately reflects the system state at all times (no stale states after transitions) [FR-028]
- **SC-006**: All three voice input modes (push-to-talk, wake word, continuous dictation) work end-to-end [FR-007, FR-008, FR-009]
- **SC-007**: Model download completes and the model is usable without manual file management [FR-024, FR-026]

## Assumptions

- User has Python 3.11+ installed and accessible from the VS Code terminal environment
- User has a working microphone connected and accessible to the OS audio subsystem
- User has the Claude Code VS Code extension installed and functional
- Linux is the primary platform; macOS support is a stretch goal, not a launch requirement
- The faster-whisper models are downloaded from Hugging Face (default model hub)
- The sidecar's pip dependencies (faster-whisper, silero-vad, openwakeword, sounddevice/pyaudio) are installed in a virtualenv managed by the extension or pre-installed by the user
- Simulated keystrokes into the Claude Code input field work via VS Code's `type` command or similar mechanism — if Claude Code changes its input handling, this integration may break
