# Socket Protocol Contract

**Transport**: Unix domain socket
**Path**: `$XDG_RUNTIME_DIR/claude-voice-<pid>.sock` (fallback: `/tmp/claude-voice-<pid>.sock`)
**Framing**: Newline-delimited JSON (NDJSON) — one JSON object per line, terminated by `\n`
**Encoding**: UTF-8
**Connection**: Single client (extension) ↔ single server (sidecar)

## Connection Lifecycle

1. Extension spawns sidecar process with `--socket <path>` argument
2. Sidecar creates Unix socket and listens for one connection
3. Extension connects to the socket
4. Extension sends `config` message with current settings
5. Extension sends `control` message to start/stop listening
6. Sidecar pushes `status`, `transcript`, and `error` messages asynchronously
7. On shutdown: extension sends `control:stop`, sidecar closes socket, cleans up socket file

## Message Types

### Extension → Sidecar

#### `config` — Push settings to sidecar

Sent on connection and whenever VS Code settings change.

```json
{
  "type": "config",
  "inputMode": "wakeWord",
  "whisperModel": "base",
  "wakeWord": "hey_claude",
  "submitWords": ["send it", "go", "submit"],
  "cancelWords": ["never mind", "cancel"],
  "silenceTimeout": 1500,
  "maxUtteranceDuration": 60000,
  "micDevice": ""
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `type` | `"config"` | yes | Message type discriminator |
| `inputMode` | `"wakeWord" \| "pushToTalk" \| "continuousDictation"` | yes | Active voice input mode |
| `whisperModel` | `"tiny" \| "base" \| "small" \| "medium"` | yes | Whisper model size |
| `wakeWord` | `string` | yes | openWakeWord model name |
| `submitWords` | `string[]` | yes | Words that trigger transcript submission |
| `cancelWords` | `string[]` | yes | Words that discard current transcript |
| `silenceTimeout` | `number` | yes | Milliseconds of silence to end utterance (push-to-talk) |
| `maxUtteranceDuration` | `number` | yes | Maximum utterance duration in ms |
| `micDevice` | `string` | yes | Microphone device name (empty = system default) |

#### `control` — Start/stop listening

```json
{
  "type": "control",
  "action": "start"
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `type` | `"control"` | yes | Message type discriminator |
| `action` | `"start" \| "stop" \| "ptt_start" \| "ptt_stop"` | yes | Control action |

**Actions**:
- `start` — Begin listening (mic capture + VAD active)
- `stop` — Stop listening (pause mic capture)
- `ptt_start` — Push-to-talk key pressed: begin capturing for transcription (skip wake word)
- `ptt_stop` — Push-to-talk key released: end capture, transcribe accumulated audio

---

### Sidecar → Extension

#### `status` — Pipeline state changes

```json
{
  "type": "status",
  "state": "listening"
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `type` | `"status"` | yes | Message type discriminator |
| `state` | `string` | yes | Current pipeline state |

**States**:
| State | Meaning | Status bar maps to |
|-------|---------|--------------------|
| `listening` | Mic active, waiting for speech/wake word | Listening |
| `speech_start` | VAD detected speech | Listening (pulsing) |
| `speech_end` | VAD detected silence after speech | Listening |
| `wake_word_detected` | Wake word matched | Listening |
| `processing` | Whisper transcription in progress | Processing |
| `ready` | Sidecar initialized, waiting for start command | Idle |

#### `transcript` — Final transcription result

```json
{
  "type": "transcript",
  "text": "refactor this function to use async await",
  "action": "submit"
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `type` | `"transcript"` | yes | Message type discriminator |
| `text` | `string` | yes | Transcribed text (wake word and command words already stripped) |
| `action` | `"submit" \| "cancel"` | yes | What the command word indicated |

**Notes**:
- `action: "submit"` → extension delivers text to Claude Code
- `action: "cancel"` → extension discards (text field may be empty or contain the discarded text for logging)
- Wake word is always stripped before this message is sent
- Command words are always stripped before this message is sent

#### `error` — Error from sidecar

```json
{
  "type": "error",
  "code": "MIC_NOT_FOUND",
  "message": "No microphone device found. Check your audio settings."
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `type` | `"error"` | yes | Message type discriminator |
| `code` | `string` | yes | Machine-readable error code |
| `message` | `string` | yes | Human-readable description (safe to show in notification) |

**Error codes**:
| Code | Meaning | Recoverable? |
|------|---------|-------------|
| `MIC_NOT_FOUND` | No microphone device available | No — user must connect mic |
| `MIC_PERMISSION_DENIED` | OS denied mic access | No — user must grant permission |
| `MODEL_NOT_FOUND` | Whisper model file missing | Yes — trigger download |
| `MODEL_LOAD_FAILED` | Whisper model file corrupted or incompatible | Yes — re-download |
| `WAKE_MODEL_NOT_FOUND` | openWakeWord model file missing | No — ship with extension |
| `DEPENDENCY_MISSING` | Required Python package not installed | No — user runs dependency check |
| `AUDIO_DEVICE_ERROR` | Audio device error during capture | Maybe — auto-retry once |
| `TRANSCRIPTION_FAILED` | Whisper inference failed | Maybe — retry with next utterance |

---

## Message Flow Examples

### Wake word → submit

```
Extension → Sidecar:  {"type":"config","inputMode":"wakeWord",...}
Extension → Sidecar:  {"type":"control","action":"start"}
Sidecar → Extension:  {"type":"status","state":"listening"}
                       [user says "hey claude refactor this function send it"]
Sidecar → Extension:  {"type":"status","state":"speech_start"}
Sidecar → Extension:  {"type":"status","state":"wake_word_detected"}
Sidecar → Extension:  {"type":"status","state":"speech_end"}
Sidecar → Extension:  {"type":"status","state":"processing"}
Sidecar → Extension:  {"type":"transcript","text":"refactor this function","action":"submit"}
Sidecar → Extension:  {"type":"status","state":"listening"}
```

### Push-to-talk

```
Extension → Sidecar:  {"type":"control","action":"ptt_start"}
Sidecar → Extension:  {"type":"status","state":"speech_start"}
                       [user speaks while holding key]
Extension → Sidecar:  {"type":"control","action":"ptt_stop"}
Sidecar → Extension:  {"type":"status","state":"speech_end"}
Sidecar → Extension:  {"type":"status","state":"processing"}
Sidecar → Extension:  {"type":"transcript","text":"explain this code","action":"submit"}
Sidecar → Extension:  {"type":"status","state":"listening"}
```

### Cancel

```
Sidecar → Extension:  {"type":"status","state":"speech_start"}
Sidecar → Extension:  {"type":"status","state":"wake_word_detected"}
Sidecar → Extension:  {"type":"status","state":"speech_end"}
Sidecar → Extension:  {"type":"status","state":"processing"}
Sidecar → Extension:  {"type":"transcript","text":"","action":"cancel"}
Sidecar → Extension:  {"type":"status","state":"listening"}
```

### Error

```
Extension → Sidecar:  {"type":"control","action":"start"}
Sidecar → Extension:  {"type":"error","code":"MIC_NOT_FOUND","message":"No microphone device found."}
```
