"""F8.2 — EER + minDCF benchmark on VoxCeleb1-O.

Walks the VoxCeleb1-O `veri_test.txt` trial pairs, runs each pair
through the production verification pipeline (ReDimNet-B5 + the F3.2
VAD trim + the F3.3 quality gate disabled at bench time), and emits
per-pair (similarity, label) tuples + the computed EER + DET-curve
points + minDCF.

Usage:

    cd backend
    .venv/bin/python scripts/bench_eer_voxceleb.py \\
        --pairs /data/voxceleb1/veri_test.txt \\
        --audio-root /data/voxceleb1/wav \\
        --output docs/paper/results_eer.json

`veri_test.txt` is the trial-pair file from the upstream VoxCeleb1
release (`<label> <wav1> <wav2>` per line).
"""

from __future__ import annotations

import argparse
import hashlib
import json
import logging
import platform
import sys
import wave
from datetime import datetime, timezone
from pathlib import Path
from time import perf_counter

import numpy as np

THIS = Path(__file__).resolve()
sys.path.insert(0, str(THIS.parent.parent))

from app.core.config import settings  # noqa: E402
from app.services.audio import AudioService  # noqa: E402
from app.services.speaker_encoder import RedimNetSpeakerEncoder  # noqa: E402

logging.basicConfig(level=logging.INFO, format="%(levelname)s %(message)s")
logger = logging.getLogger("bench_eer")


def cosine_similarity(a: np.ndarray, b: np.ndarray) -> float:
    denom = np.linalg.norm(a) * np.linalg.norm(b)
    if denom <= 1e-8:
        return 0.0
    return float(np.dot(a, b) / denom)


def load_wav(path: Path) -> tuple[np.ndarray, int]:
    """Load WAV (16-bit PCM) directly via Python's wave module, or
    delegate to torchaudio for everything else (FLAC for LibriSpeech,
    OGG, etc.). Returns mono float32 at the file's native sample rate.

    Function name is kept for back-compat; despite the name it handles
    FLAC + WAV transparently."""
    if path.suffix.lower() == ".wav":
        with wave.open(str(path), "rb") as h:
            frames = h.readframes(h.getnframes())
            sr = h.getframerate()
            ch = h.getnchannels()
            sw = h.getsampwidth()
        if sw != 2:
            raise ValueError(f"{path}: expected 16-bit PCM")
        samples = np.frombuffer(frames, dtype=np.int16).astype(np.float32) / 32768.0
        if ch == 2:
            samples = samples.reshape(-1, 2).mean(axis=1)
        return samples, sr
    # FLAC / OGG / etc. — soundfile (libsndfile) handles non-WAV
    # formats with no torch dependency. torchaudio 2.11 dropped its
    # built-in loaders in favour of optional torchcodec.
    import soundfile as sf
    samples, sr = sf.read(str(path), dtype="float32", always_2d=False)
    if samples.ndim > 1:
        samples = samples.mean(axis=1).astype(np.float32)
    return samples.astype(np.float32), int(sr)


def compute_eer(scores: np.ndarray, labels: np.ndarray) -> tuple[float, float]:
    """Equal Error Rate. Returns (eer, threshold_at_eer)."""
    # Sort by score descending. False accept rate (FAR) sweeps from high to
    # low; false reject rate (FRR) sweeps the other way.
    order = np.argsort(-scores)
    s = scores[order]
    y = labels[order]
    n_pos = int(y.sum())
    n_neg = int((1 - y).sum())
    if n_pos == 0 or n_neg == 0:
        return float("nan"), float("nan")
    fa = np.cumsum(1 - y) / n_neg     # rolling FAR
    fr = 1 - np.cumsum(y) / n_pos     # rolling FRR
    diff = np.abs(fa - fr)
    idx = int(np.argmin(diff))
    return float((fa[idx] + fr[idx]) / 2.0), float(s[idx])


def compute_min_dcf(
    scores: np.ndarray,
    labels: np.ndarray,
    p_target: float = 0.01,
    c_miss: float = 1.0,
    c_fa: float = 1.0,
) -> float:
    order = np.argsort(-scores)
    y = labels[order]
    n_pos = int(y.sum())
    n_neg = int((1 - y).sum())
    if n_pos == 0 or n_neg == 0:
        return float("nan")
    far = np.cumsum(1 - y) / n_neg
    frr = 1 - np.cumsum(y) / n_pos
    dcf = c_miss * frr * p_target + c_fa * far * (1 - p_target)
    return float(np.min(dcf))


def _checkpoint_sha256(path: Path) -> str:
    """SHA-256 of the model checkpoint — proves the same weights
    produced the numbers later. Reads the file in chunks so we don't
    blow up on the larger checkpoints."""
    h = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--pairs", type=Path, required=True)
    parser.add_argument("--audio-root", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--plot-dir", type=Path, default=None,
                        help="If set, write {det,roc,score_hist}.png + scores.csv into <plot-dir>/<dataset-name>/")
    parser.add_argument("--dataset-name", type=str, default="voxceleb1_o",
                        help="Label for the JSON output + plot subdir (e.g. voxceleb1_o, librispeech_test_clean).")
    parser.add_argument("--limit", type=int, default=0, help="Cap pairs (0=all)")
    args = parser.parse_args()

    audio = AudioService(target_sample_rate=settings.sample_rate)
    encoder = RedimNetSpeakerEncoder(weights_path=settings.redimnet_weights_path)

    pairs = args.pairs.read_text().strip().splitlines()
    if args.limit > 0:
        pairs = pairs[: args.limit]
    logger.info("Running %d trial pairs", len(pairs))

    cache: dict[Path, np.ndarray] = {}
    scores = np.zeros(len(pairs), dtype=np.float32)
    labels = np.zeros(len(pairs), dtype=np.int32)
    pair_ids: list[str] = [""] * len(pairs)  # human-readable utt id for the CSV
    t0 = perf_counter()

    for i, line in enumerate(pairs):
        parts = line.split()
        if len(parts) != 3:
            logger.warning("Skipping malformed line %d: %s", i, line)
            continue
        label = int(parts[0])
        wav1 = args.audio_root / parts[1]
        wav2 = args.audio_root / parts[2]
        for path in (wav1, wav2):
            if path not in cache:
                samples, sr = load_wav(path)
                payload = audio.decode_wav(audio.encode_wav(samples.tolist(), sr))
                # F3.2 — apply the VAD trim so the bench matches production
                # behaviour. If the trim fails, embed the raw signal.
                try:
                    trimmed, _ = audio.trim_to_voice(payload)
                    waveform = trimmed.waveform
                except ValueError:
                    waveform = payload.waveform
                cache[path] = np.asarray(encoder.embed(waveform), dtype=np.float32)
        scores[i] = cosine_similarity(cache[wav1], cache[wav2])
        labels[i] = label
        pair_ids[i] = f"{parts[1]}::{parts[2]}"
        if (i + 1) % 1000 == 0:
            logger.info("  %d / %d pairs (%.1f s)", i + 1, len(pairs), perf_counter() - t0)

    eer, eer_threshold = compute_eer(scores, labels)
    min_dcf = compute_min_dcf(scores, labels, p_target=0.01)
    wall_seconds = perf_counter() - t0

    logger.info("EER: %.4f  threshold: %.4f  minDCF: %.4f", eer, eer_threshold, min_dcf)

    # B2 — emit DET / ROC / score-histogram plots + per-utterance CSV
    # alongside the JSON summary.
    if args.plot_dir is not None:
        from _plotting import (
            plot_det_curve, plot_roc_curve, plot_score_histogram, write_score_csv,
        )
        sub_dir = args.plot_dir / args.dataset_name
        title_prefix = args.dataset_name.replace("_", " ").title()
        plot_det_curve(scores, labels, sub_dir / "det.png",
                       title=f"{title_prefix} · ReDimNet B5 · n={len(pairs)} · EER {eer*100:.2f}%")
        plot_roc_curve(scores, labels, sub_dir / "roc.png",
                       title=f"{title_prefix} · ReDimNet B5 · n={len(pairs)}")
        plot_score_histogram(scores, labels, sub_dir / "score_hist.png",
                             title=f"{title_prefix} · cosine similarity distribution")
        write_score_csv(sub_dir / "scores.csv",
                        [(pair_ids[i], float(scores[i]), int(labels[i])) for i in range(len(pairs))])
        logger.info("Plots + CSV written to %s", sub_dir)

    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(
        json.dumps(
            {
                "dataset": args.dataset_name,
                "n_pairs": len(pairs),
                "eer": eer,
                "eer_threshold": eer_threshold,
                "min_dcf_pt01": min_dcf,
                "wall_seconds": wall_seconds,
                "hardware": {
                    "platform": platform.platform(),
                    "machine": platform.machine(),
                    "torch_device": "cpu",
                },
                "checkpoint_sha256": _checkpoint_sha256(settings.redimnet_weights_path),
                "completed_at": datetime.now(timezone.utc).isoformat(),
            },
            indent=2,
        )
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
