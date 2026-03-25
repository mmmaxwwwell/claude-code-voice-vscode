#!/usr/bin/env python3
"""Generate audio test fixtures for claude-voice tests.

All fixtures are 16kHz mono WAV (int16).

Two generation modes:
  1. Synthetic (default): stdlib-only, no external deps. Produces tone bursts
     and noise that satisfy VAD/wakeword tests structurally.
  2. TTS (--tts): uses piper-tts for speech and numpy for resampling.
     Produces realistic audio. Requires: numpy, piper-tts CLI.

Usage:
    python tests/fixtures/generate-fixtures.py           # synthetic (no deps)
    python tests/fixtures/generate-fixtures.py --tts     # requires piper-tts + numpy
    python tests/fixtures/generate-fixtures.py --verify   # check existing fixtures
"""

from __future__ import annotations

import argparse
import math
import os
import random
import struct
import sys
import wave
from pathlib import Path

SAMPLE_RATE = 16000
MAX_INT16 = 32767
OUTPUT_DIR = Path(__file__).parent / "audio"


def write_wav(path: Path, samples: list[int]) -> None:
    """Write int16 mono samples to a WAV file at 16kHz."""
    clamped = [max(-MAX_INT16, min(MAX_INT16, int(s))) for s in samples]
    with wave.open(str(path), "wb") as wf:
        wf.setnchannels(1)
        wf.setsampwidth(2)
        wf.setframerate(SAMPLE_RATE)
        wf.writeframes(struct.pack(f"<{len(clamped)}h", *clamped))
    print(f"  wrote {path.name} ({len(clamped) / SAMPLE_RATE:.2f}s, {path.stat().st_size} bytes)")


# ---------------------------------------------------------------------------
# Synthetic generators (stdlib only)
# ---------------------------------------------------------------------------

def make_silence(duration_s: float = 5.0) -> list[int]:
    """Pure digital silence."""
    return [0] * int(SAMPLE_RATE * duration_s)


def make_noise(duration_s: float = 5.0, amplitude: float = 0.05) -> list[int]:
    """Ambient background noise (uniform random, low amplitude)."""
    rng = random.Random(42)
    n = int(SAMPLE_RATE * duration_s)
    return [int(rng.uniform(-1.0, 1.0) * amplitude * MAX_INT16) for _ in range(n)]


def make_speech_tone(text_hint: str, duration_s: float = 2.0) -> list[int]:
    """Synthetic speech-like signal: modulated tone burst with noise floor.

    Not real speech, but activates VAD (energy + spectral variation).
    Different text_hint seeds produce different patterns.
    """
    rng = random.Random(hash(text_hint) % (2**31))
    n_samples = int(SAMPLE_RATE * duration_s)

    f0 = rng.uniform(120, 250)
    harmonic_amps = {h: rng.uniform(0.05, 0.2) for h in [2, 3, 5]}
    samples: list[int] = []

    for i in range(n_samples):
        t = i / SAMPLE_RATE

        # Fundamental with vibrato
        vibrato = 5.0 * math.sin(2 * math.pi * 5.0 * t)
        signal = 0.6 * math.sin(2 * math.pi * (f0 + vibrato) * t)

        # Harmonics
        for harmonic, amp in harmonic_amps.items():
            signal += amp * math.sin(2 * math.pi * f0 * harmonic * t)

        # Amplitude envelope
        fade_n = int(SAMPLE_RATE * 0.05)
        if i < fade_n:
            env = i / fade_n
        elif i > n_samples - fade_n:
            env = (n_samples - i) / fade_n
        else:
            env = 1.0

        # Syllable-like modulation (4 Hz)
        mod = 0.7 + 0.3 * abs(math.sin(2 * math.pi * 4.0 * t))
        env *= mod

        signal *= env

        # Noise floor
        signal += rng.gauss(0, 0.02)

        samples.append(int(signal * MAX_INT16))

    return samples


def pad_with_silence(samples: list[int], pre_s: float = 0.3, post_s: float = 0.5) -> list[int]:
    """Pad audio with silence before and after."""
    pre = [0] * int(SAMPLE_RATE * pre_s)
    post = [0] * int(SAMPLE_RATE * post_s)
    return pre + samples + post


def silence_gap(duration_s: float) -> list[int]:
    """Short silence gap between segments."""
    return [0] * int(SAMPLE_RATE * duration_s)


# ---------------------------------------------------------------------------
# Fixture definitions
# ---------------------------------------------------------------------------

FIXTURES = {
    "command-only.wav": {
        "text": "refactor this function send it",
        "description": "Speech command without wake word",
    },
    "silence.wav": {
        "text": None,
        "description": "Pure silence (5 seconds)",
    },
    "noise.wav": {
        "text": None,
        "description": "Ambient background noise",
    },
    "wake-and-command.wav": {
        "text": "hey claude refactor this function send it",
        "description": "Wake word followed by command with submit",
    },
    "wake-only.wav": {
        "text": "hey claude",
        "description": "Wake word only, no command",
    },
    "cancel.wav": {
        "text": "hey claude do something never mind",
        "description": "Wake word + command + cancel",
    },
    "multi-segment.wav": {
        "text": None,  # composite — handled specially in generators
        "description": "Three speech segments separated by long silence for multi-segment accumulation test",
        "segments": [
            {"text": "refactor this function", "duration": 2.0},
            {"text": "and fix the tests", "duration": 2.0},
            {"text": "then deploy it send it", "duration": 2.5},
        ],
        "gap_duration": 2.0,
    },
}


def generate_synthetic(output_dir: Path) -> None:
    """Generate all fixtures using synthetic audio (no external deps)."""
    print("Generating synthetic fixtures (stdlib only)...")

    write_wav(output_dir / "silence.wav", make_silence(5.0))
    write_wav(output_dir / "noise.wav", make_noise(5.0))

    write_wav(
        output_dir / "command-only.wav",
        pad_with_silence(make_speech_tone("refactor this function send it", 2.5)),
    )

    write_wav(
        output_dir / "wake-and-command.wav",
        pad_with_silence(
            make_speech_tone("hey claude", 0.8)
            + silence_gap(0.2)
            + make_speech_tone("refactor this function send it", 2.5)
        ),
    )

    write_wav(
        output_dir / "wake-only.wav",
        pad_with_silence(make_speech_tone("hey claude", 1.2)),
    )

    write_wav(
        output_dir / "cancel.wav",
        pad_with_silence(
            make_speech_tone("hey claude", 0.8)
            + silence_gap(0.15)
            + make_speech_tone("do something", 1.2)
            + silence_gap(0.15)
            + make_speech_tone("never mind", 0.8)
        ),
    )

    # Multi-segment fixture: 3 speech segments separated by long silence gaps
    # (>1.5s to trigger VAD speech_end between segments)
    spec = FIXTURES["multi-segment.wav"]
    segments_audio: list[int] = []
    for i, seg in enumerate(spec["segments"]):
        if i > 0:
            segments_audio += silence_gap(spec["gap_duration"])
        segments_audio += make_speech_tone(seg["text"], seg["duration"])
    write_wav(
        output_dir / "multi-segment.wav",
        pad_with_silence(segments_audio, pre_s=0.3, post_s=2.0),
    )


def generate_tts(output_dir: Path) -> None:
    """Generate all fixtures using piper-tts for realistic speech.

    Requires: piper-tts CLI, numpy.
    """
    import subprocess
    import tempfile

    import numpy as np

    print("Generating TTS fixtures (piper-tts)...")

    write_wav(output_dir / "silence.wav", make_silence(5.0))
    write_wav(output_dir / "noise.wav", make_noise(5.0))

    for name, spec in FIXTURES.items():
        if spec["text"] is None:
            continue

        with tempfile.NamedTemporaryFile(suffix=".wav", delete=True) as tmp:
            result = subprocess.run(
                ["piper", "--model", "en_US-lessac-medium", "--output_file", tmp.name],
                input=spec["text"].encode(),
                capture_output=True,
            )
            if result.returncode != 0:
                raise RuntimeError(f"piper-tts failed for {name}: {result.stderr.decode()}")

            with wave.open(tmp.name, "rb") as wf:
                orig_rate = wf.getframerate()
                n_channels = wf.getnchannels()
                raw = wf.readframes(wf.getnframes())

            samples = np.frombuffer(raw, dtype=np.int16).astype(np.float64)
            if n_channels > 1:
                samples = samples[::n_channels]

            # Resample to 16kHz if needed
            if orig_rate != SAMPLE_RATE:
                n_out = int(len(samples) * SAMPLE_RATE / orig_rate)
                indices = np.linspace(0, len(samples) - 1, n_out)
                samples = np.interp(indices, np.arange(len(samples)), samples)

            int_samples = [int(max(-MAX_INT16, min(MAX_INT16, s))) for s in samples]
            write_wav(output_dir / name, pad_with_silence(int_samples))

    # Multi-segment fixture: TTS each segment, concatenate with silence gaps
    ms_spec = FIXTURES["multi-segment.wav"]
    ms_segments: list[list[int]] = []
    for seg in ms_spec["segments"]:
        with tempfile.NamedTemporaryFile(suffix=".wav", delete=True) as tmp:
            result = subprocess.run(
                ["piper", "--model", "en_US-lessac-medium", "--output_file", tmp.name],
                input=seg["text"].encode(),
                capture_output=True,
            )
            if result.returncode != 0:
                raise RuntimeError(f"piper-tts failed for multi-segment '{seg['text']}': {result.stderr.decode()}")

            with wave.open(tmp.name, "rb") as wf:
                orig_rate = wf.getframerate()
                n_channels = wf.getnchannels()
                raw = wf.readframes(wf.getnframes())

            samples = np.frombuffer(raw, dtype=np.int16).astype(np.float64)
            if n_channels > 1:
                samples = samples[::n_channels]
            if orig_rate != SAMPLE_RATE:
                n_out = int(len(samples) * SAMPLE_RATE / orig_rate)
                indices = np.linspace(0, len(samples) - 1, n_out)
                samples = np.interp(indices, np.arange(len(samples)), samples)
            ms_segments.append([int(max(-MAX_INT16, min(MAX_INT16, s))) for s in samples])

    combined: list[int] = []
    for i, seg_samples in enumerate(ms_segments):
        if i > 0:
            combined += silence_gap(ms_spec["gap_duration"])
        combined += seg_samples
    write_wav(output_dir / "multi-segment.wav", pad_with_silence(combined, pre_s=0.3, post_s=2.0))


def verify_fixtures(output_dir: Path) -> bool:
    """Verify all expected fixtures exist and are valid 16kHz mono int16 WAV."""
    ok = True
    for name in FIXTURES:
        path = output_dir / name
        if not path.exists():
            print(f"  MISSING: {name}")
            ok = False
            continue
        try:
            with wave.open(str(path), "rb") as wf:
                assert wf.getframerate() == SAMPLE_RATE, f"bad sample rate: {wf.getframerate()}"
                assert wf.getnchannels() == 1, f"not mono: {wf.getnchannels()} channels"
                assert wf.getsampwidth() == 2, f"not int16: {wf.getsampwidth()} bytes"
                duration = wf.getnframes() / wf.getframerate()
            print(f"  OK: {name} ({duration:.2f}s)")
        except Exception as e:
            print(f"  INVALID: {name}: {e}")
            ok = False
    return ok


def main() -> None:
    parser = argparse.ArgumentParser(description="Generate audio test fixtures")
    parser.add_argument("--tts", action="store_true", help="Use piper-tts for realistic speech")
    parser.add_argument("--verify", action="store_true", help="Only verify existing fixtures")
    args = parser.parse_args()

    output_dir = OUTPUT_DIR
    output_dir.mkdir(parents=True, exist_ok=True)

    if args.verify:
        print("Verifying fixtures...")
        ok = verify_fixtures(output_dir)
        sys.exit(0 if ok else 1)

    if args.tts:
        generate_tts(output_dir)
    else:
        generate_synthetic(output_dir)

    print("\nVerifying generated fixtures...")
    ok = verify_fixtures(output_dir)
    if not ok:
        sys.exit(1)
    print("\nAll fixtures generated successfully.")


if __name__ == "__main__":
    main()
