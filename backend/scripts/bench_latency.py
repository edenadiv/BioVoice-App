"""F8.4 — in-process latency benchmark.

Runs the full verification pipeline N times against a bundled WAV
(default: a 2-second 220 Hz sine generated on the fly) and reports
p50 / p95 / p99 wall-clock + per-stage breakdown. Self-contained — no
running backend required.

Usage:

    cd backend
    .venv/bin/python scripts/bench_latency.py --runs 1000 --output docs/paper/results_latency.json

For real-microphone-style audio, pass --wav <path>; the script will
loop the same recording N times. To compare cold-start vs warm,
prepend `--warmup 1` to discount the first N runs.
"""

from __future__ import annotations

import argparse
import json
import logging
import math
import statistics
import sys
import wave
from io import BytesIO
from pathlib import Path
from time import perf_counter

import numpy as np

THIS = Path(__file__).resolve()
sys.path.insert(0, str(THIS.parent.parent))

from app.core.config import settings  # noqa: E402
from app.services.audio import AudioService  # noqa: E402
from app.services.detector import DeepfakeDetectorService  # noqa: E402
from app.services.speaker_encoder import RedimNetSpeakerEncoder  # noqa: E402
from app.services.sub_classifier import AcousticProbe  # noqa: E402
from app.services.verification import VerificationService  # noqa: E402
from app.storage.memory_store import MemoryStore  # noqa: E402

logging.basicConfig(level=logging.INFO, format="%(levelname)s %(message)s")
logger = logging.getLogger("bench_latency")


def synth_wav(duration_s: float = 2.0, frequency: float = 220.0, sample_rate: int = 16000) -> bytes:
    n = int(duration_s * sample_rate)
    samples = np.array(
        [int(0.6 * 32767 * math.sin(2 * math.pi * frequency * i / sample_rate)) for i in range(n)],
        dtype=np.int16,
    )
    buf = BytesIO()
    with wave.open(buf, "wb") as h:
        h.setnchannels(1)
        h.setsampwidth(2)
        h.setframerate(sample_rate)
        h.writeframes(samples.tobytes())
    return buf.getvalue()


def percentiles(samples: list[float]) -> dict[str, float]:
    s = sorted(samples)
    n = len(s)
    if n == 0:
        return {"p50": 0.0, "p95": 0.0, "p99": 0.0}
    def pick(p: float) -> float:
        idx = max(0, min(n - 1, int(round(p * (n - 1)))))
        return s[idx]
    return {"p50": pick(0.50), "p95": pick(0.95), "p99": pick(0.99)}


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--runs", type=int, default=100)
    parser.add_argument("--warmup", type=int, default=3, help="Discard the first N runs from stats")
    parser.add_argument("--wav", type=Path, default=None, help="Real WAV to bench against")
    parser.add_argument("--output", type=Path, default=None)
    args = parser.parse_args()

    audio_bytes = args.wav.read_bytes() if args.wav else synth_wav(2.0)

    store = MemoryStore()
    detector = DeepfakeDetectorService(weights_path=settings.aasist_weights_path)
    encoder = RedimNetSpeakerEncoder(weights_path=settings.redimnet_weights_path)
    probe = AcousticProbe(heads_path=settings.sub_classifier_heads_path)
    service = VerificationService(
        store=store,
        detector=detector,
        speaker_encoder=encoder,
        sample_rate=settings.sample_rate,
        similarity_threshold=settings.similarity_threshold,
        deepfake_threshold=settings.deepfake_threshold,
        min_enrollment_samples=3,
        acoustic_probe=probe,
    )
    # Enrol the bench user — three samples of the same audio.
    user_id = "bench_user"
    for _ in range(3):
        service.enroll(user_id=user_id, audio_bytes=audio_bytes, filename="enrol.wav")
    logger.info("Enrolled %s; running %d warmup + %d timed iterations", user_id, args.warmup, args.runs)

    stage_keys = ("load_ms", "resample_ms", "normalize_ms", "vad_ms", "embed_ms", "detect_ms", "total_ms")
    stage_samples: dict[str, list[float]] = {k: [] for k in stage_keys}
    wall_samples: list[float] = []

    total_runs = args.warmup + args.runs
    for i in range(total_runs):
        t0 = perf_counter()
        result = service.verify(user_id=user_id, audio_bytes=audio_bytes)
        wall = (perf_counter() - t0) * 1000.0
        if i < args.warmup:
            continue
        wall_samples.append(wall)
        breakdown = result.stage_breakdown.model_dump()
        for k in stage_keys:
            stage_samples[k].append(float(breakdown.get(k, 0.0)))
        if (i + 1) % 100 == 0:
            logger.info("  %d / %d runs", i + 1, total_runs)

    summary = {
        "runs": args.runs,
        "wav_bytes": len(audio_bytes),
        "wall_ms": percentiles(wall_samples),
        "stage_ms": {k: percentiles(stage_samples[k]) for k in stage_keys},
        "wall_mean_ms": statistics.fmean(wall_samples) if wall_samples else 0.0,
        "wall_stdev_ms": statistics.pstdev(wall_samples) if len(wall_samples) > 1 else 0.0,
    }

    rendered = json.dumps(summary, indent=2)
    if args.output:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(rendered)
        logger.info("Wrote %s", args.output)
    else:
        print(rendered)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
