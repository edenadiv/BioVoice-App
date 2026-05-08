"""One-shot generator for backend/data/fallback_spoof.wav.

The fallback WAV is served by `/me/spoof` when XTTS is unavailable AND
`BIOVOICE_FALLBACK_SPOOF=1` is set. It's a plausible-sounding short
synthetic clip — just enough to feed the lab's "Test Detection" path so
the demo isn't blocked on the model install. Distinct from the demo
enrolment WAVs so AASIST has a different signal to evaluate.
"""

from __future__ import annotations

import math
import struct
import wave
from pathlib import Path

SAMPLE_RATE = 24000  # matches xtts_output_sample_rate (settings)
DURATION_S = 2.5
PEAK = 0.5

OUT = Path(__file__).resolve().parent.parent / "data" / "fallback_spoof.wav"


def _sample(t: float) -> float:
    # A "robotic" steady-pitch tone — sounds slightly synthetic on purpose so
    # AASIST tends to flag it. Adds a slow vibrato + buzz harmonic.
    f0 = 165.0
    vibrato = 1.0 + 0.03 * math.sin(2 * math.pi * 5.0 * t)
    base = math.sin(2 * math.pi * f0 * vibrato * t)
    buzz = 0.3 * math.sin(2 * math.pi * f0 * 3.1 * t)
    higher = 0.18 * math.sin(2 * math.pi * f0 * 5.7 * t + 0.5)
    return base + buzz + higher


def main() -> None:
    n = int(DURATION_S * SAMPLE_RATE)
    samples = bytearray()
    for i in range(n):
        t = i / SAMPLE_RATE
        envelope = 0.6 + 0.4 * math.sin(2.4 * t)
        raw = _sample(t) * envelope
        clipped = max(-1.0, min(1.0, raw)) * PEAK
        pcm = int(clipped * 32767)
        samples += struct.pack("<h", pcm)

    OUT.parent.mkdir(parents=True, exist_ok=True)
    with wave.open(str(OUT), "wb") as wf:
        wf.setnchannels(1)
        wf.setsampwidth(2)
        wf.setframerate(SAMPLE_RATE)
        wf.writeframes(bytes(samples))
    print(f"Wrote {OUT} ({OUT.stat().st_size} bytes)")


if __name__ == "__main__":
    main()
