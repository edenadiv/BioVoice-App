"""One-shot script to generate the bundled demo WAVs (alice_demo / bob_demo).

Invoked manually when the seed audio needs to be regenerated. The output is
committed to `backend/data/demo/` so the seed flow has audio to enrol.

These are synthetic-but-distinct waveforms — adequate for the placeholder
HashEncoder + heuristic detector path, NOT meant to model real human voices.
For client demos with the real ReDimNet + AASIST stack, replace these files
with actual short voice recordings of the same speakers.
"""

from __future__ import annotations

import math
import struct
import wave
from pathlib import Path

SAMPLE_RATE = 16000
DURATION_S = 3.0
PEAK = 0.55  # leave headroom

OUT_DIR = Path(__file__).resolve().parent.parent / "data" / "demo"


def _envelope(t: float) -> float:
    # Word-like cadence: short bursts of energy with breaths between.
    word = 0.5 + 0.5 * math.sin(2.0 * t)
    breath = max(0.0, math.sin(0.7 * t) * 0.7 + 0.3)
    return word * breath


def _alice_sample(t: float) -> float:
    # Higher pitch + prominent F2/F3 formants — distinct from bob.
    f0 = 215.0 + 25.0 * math.sin(0.9 * t)
    return (
        0.55 * math.sin(2 * math.pi * f0 * t)
        + 0.30 * math.sin(2 * math.pi * (f0 * 2.6) * t + 0.4 * math.sin(t))
        + 0.15 * math.sin(2 * math.pi * (f0 * 4.4) * t)
    )


def _bob_sample(t: float) -> float:
    # Lower pitch + flatter formants.
    f0 = 118.0 + 12.0 * math.sin(0.6 * t)
    return (
        0.50 * math.sin(2 * math.pi * f0 * t)
        + 0.32 * math.sin(2 * math.pi * (f0 * 2.1) * t + 0.3 * math.sin(0.5 * t))
        + 0.12 * math.sin(2 * math.pi * (f0 * 3.5) * t)
    )


def _generate(gen: callable, dest: Path) -> None:
    n = int(DURATION_S * SAMPLE_RATE)
    samples = bytearray()
    for i in range(n):
        t = i / SAMPLE_RATE
        envelope = _envelope(t)
        raw = gen(t) * envelope
        # Soft clip + peak target.
        clipped = max(-1.0, min(1.0, raw)) * PEAK
        pcm = int(clipped * 32767)
        samples += struct.pack("<h", pcm)

    dest.parent.mkdir(parents=True, exist_ok=True)
    with wave.open(str(dest), "wb") as wf:
        wf.setnchannels(1)
        wf.setsampwidth(2)
        wf.setframerate(SAMPLE_RATE)
        wf.writeframes(bytes(samples))


def main() -> None:
    _generate(_alice_sample, OUT_DIR / "alice_demo.wav")
    _generate(_bob_sample, OUT_DIR / "bob_demo.wav")
    print(f"Wrote demo WAVs to {OUT_DIR}")


if __name__ == "__main__":
    main()
