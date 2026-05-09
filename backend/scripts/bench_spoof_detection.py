"""F8.3 — spoof-detection benchmark.

Two evaluations in one harness:

1. ASVspoof2019 LA eval split — EER on the bonafide / spoof binary.
2. Modern TTS clones (F5-TTS, XTTS, ElevenLabs) — detection rate
   (fraction flagged as spoof at the production threshold).

Usage:

    cd backend
    .venv/bin/python scripts/bench_spoof_detection.py \\
        --asvspoof-dir /data/asvspoof2019_la/eval \\
        --asvspoof-protocol /data/asvspoof2019_la/eval/ASVspoof2019.LA.cm.eval.trl.txt \\
        --clones-dir /data/biovoice/clones \\
        --output docs/paper/results_spoof.json
"""

from __future__ import annotations

import argparse
import json
import logging
import sys
import wave
from pathlib import Path
from time import perf_counter

import numpy as np

THIS = Path(__file__).resolve()
sys.path.insert(0, str(THIS.parent.parent))

from app.core.config import settings  # noqa: E402
from app.services.audio import AudioService  # noqa: E402
from app.services.detector import DeepfakeDetectorService  # noqa: E402
from app.services.sub_classifier import AcousticProbe  # noqa: E402

logging.basicConfig(level=logging.INFO, format="%(levelname)s %(message)s")
logger = logging.getLogger("bench_spoof")


def load_wav(path: Path) -> tuple[np.ndarray, int]:
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


def parse_asvspoof_protocol(path: Path) -> list[tuple[str, int]]:
    """Each line: `<speaker_id> <utt_id> - <attack_id> <bonafide|spoof>`.
    We only need utt_id + bonafide/spoof label."""
    out: list[tuple[str, int]] = []
    for line in path.read_text().splitlines():
        parts = line.strip().split()
        if len(parts) < 5:
            continue
        utt_id = parts[1]
        label = 1 if parts[-1] == "bonafide" else 0
        out.append((utt_id, label))
    return out


def compute_eer(scores: np.ndarray, labels: np.ndarray) -> tuple[float, float]:
    order = np.argsort(-scores)
    s = scores[order]
    y = labels[order]
    n_pos = int(y.sum())
    n_neg = int((1 - y).sum())
    if n_pos == 0 or n_neg == 0:
        return float("nan"), float("nan")
    fa = np.cumsum(1 - y) / n_neg
    fr = 1 - np.cumsum(y) / n_pos
    diff = np.abs(fa - fr)
    idx = int(np.argmin(diff))
    return float((fa[idx] + fr[idx]) / 2.0), float(s[idx])


def evaluate_asvspoof(
    audio: AudioService,
    detector: DeepfakeDetectorService,
    protocol: list[tuple[str, int]],
    audio_root: Path,
) -> dict:
    scores = []
    labels = []
    t0 = perf_counter()
    for i, (utt_id, label) in enumerate(protocol):
        path = audio_root / f"{utt_id}.wav"
        if not path.exists():
            # Some protocol entries may be missing files; skip + log.
            continue
        samples, sr = load_wav(path)
        payload = audio.decode_wav(audio.encode_wav(samples.tolist(), sr))
        score = detector.detect(payload.waveform)
        scores.append(score)
        labels.append(label)
        if (i + 1) % 1000 == 0:
            logger.info("  ASVspoof %d / %d (%.1f s)", i + 1, len(protocol), perf_counter() - t0)
    scores_arr = np.asarray(scores, dtype=np.float32)
    labels_arr = np.asarray(labels, dtype=np.int32)
    eer, threshold = compute_eer(scores_arr, labels_arr)
    return {
        "n_clips": int(scores_arr.size),
        "eer": eer,
        "eer_threshold": threshold,
        "wall_seconds": perf_counter() - t0,
    }


def evaluate_clones(
    audio: AudioService,
    detector: DeepfakeDetectorService,
    probe: AcousticProbe,
    clones_root: Path,
    decision_threshold: float,
) -> dict[str, dict]:
    """Walk subdirectories of `clones_root` — each subdir is a TTS family.
    Return per-family detection rate + mean per-axis sub-score."""
    out: dict[str, dict] = {}
    for subdir in sorted(p for p in clones_root.iterdir() if p.is_dir()):
        family = subdir.name
        clip_paths = sorted(subdir.glob("*.wav"))
        if not clip_paths:
            continue
        flagged = 0
        sub_scores = []
        for path in clip_paths:
            samples, sr = load_wav(path)
            payload = audio.decode_wav(audio.encode_wav(samples.tolist(), sr))
            score = detector.detect(payload.waveform)
            if score < decision_threshold:
                flagged += 1
            sub = probe.score(payload.waveform)
            sub_scores.append([
                sub.voice_naturalness,
                sub.spectral_consistency,
                sub.temporal_patterns,
                sub.artifact_detection,
            ])
        sub_arr = np.asarray(sub_scores, dtype=np.float32)
        out[family] = {
            "n_clips": len(clip_paths),
            "detection_rate": flagged / len(clip_paths),
            "sub_axes_mean": {
                "voice_naturalness": float(sub_arr[:, 0].mean()),
                "spectral_consistency": float(sub_arr[:, 1].mean()),
                "temporal_patterns": float(sub_arr[:, 2].mean()),
                "artifact_detection": float(sub_arr[:, 3].mean()),
            },
        }
    return out


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--asvspoof-dir", type=Path)
    parser.add_argument("--asvspoof-protocol", type=Path)
    parser.add_argument("--clones-dir", type=Path)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()

    audio = AudioService(target_sample_rate=settings.sample_rate)
    detector = DeepfakeDetectorService(weights_path=settings.aasist_weights_path)
    probe = AcousticProbe(heads_path=settings.sub_classifier_heads_path)

    results: dict = {"deepfake_threshold": settings.deepfake_threshold}

    if args.asvspoof_protocol and args.asvspoof_dir:
        protocol = parse_asvspoof_protocol(args.asvspoof_protocol)
        logger.info("ASVspoof: %d clips", len(protocol))
        results["asvspoof2019_la"] = evaluate_asvspoof(audio, detector, protocol, args.asvspoof_dir)

    if args.clones_dir:
        logger.info("Evaluating clones under %s", args.clones_dir)
        results["clones"] = evaluate_clones(
            audio, detector, probe, args.clones_dir, settings.deepfake_threshold
        )

    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(results, indent=2))
    logger.info("Wrote %s", args.output)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
