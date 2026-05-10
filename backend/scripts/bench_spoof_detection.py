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
from app.services.detector import DeepfakeDetectorService  # noqa: E402
from app.services.sub_classifier import AcousticProbe  # noqa: E402

logging.basicConfig(level=logging.INFO, format="%(levelname)s %(message)s")
logger = logging.getLogger("bench_spoof")


def load_audio(path: Path) -> tuple[np.ndarray, int]:
    """Load WAV (16-bit PCM) directly via Python's wave module, or
    delegate to torchaudio for everything else (FLAC, OGG, etc.).
    Returns mono float32 at the file's native sample rate."""
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
    # FLAC / OGG / etc. — soundfile (libsndfile) avoids the torchaudio
    # 2.11 torchcodec requirement.
    import soundfile as sf
    samples, sr = sf.read(str(path), dtype="float32", always_2d=False)
    if samples.ndim > 1:
        samples = samples.mean(axis=1).astype(np.float32)
    return samples.astype(np.float32), int(sr)


# Back-compat alias — `load_wav` was the original name; tests/imports may
# still reference it.
load_wav = load_audio


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
) -> tuple[dict, np.ndarray, np.ndarray, list[str]]:
    """Returns (summary_dict, scores_arr, labels_arr, utt_ids).
    The arrays are returned alongside the summary so the caller can
    plot DET/ROC + write a per-utterance CSV without re-running."""
    scores = []
    labels = []
    utt_ids: list[str] = []
    t0 = perf_counter()
    for i, (utt_id, label) in enumerate(protocol):
        # ASVspoof ships FLAC; some mirrors ship WAV. Try both.
        path = None
        for ext in (".flac", ".wav"):
            candidate = audio_root / f"{utt_id}{ext}"
            if candidate.exists():
                path = candidate
                break
        if path is None:
            # Some protocol entries may be missing files; skip + log.
            continue
        samples, sr = load_audio(path)
        payload = audio.decode_wav(audio.encode_wav(samples.tolist(), sr))
        score = detector.detect(payload.waveform)
        scores.append(score)
        labels.append(label)
        utt_ids.append(utt_id)
        if (i + 1) % 1000 == 0:
            logger.info("  ASVspoof %d / %d (%.1f s)", i + 1, len(protocol), perf_counter() - t0)
    scores_arr = np.asarray(scores, dtype=np.float32)
    labels_arr = np.asarray(labels, dtype=np.int32)
    eer, threshold = compute_eer(scores_arr, labels_arr)
    summary = {
        "n_clips": int(scores_arr.size),
        "eer": eer,
        "eer_threshold": threshold,
        "wall_seconds": perf_counter() - t0,
    }
    return summary, scores_arr, labels_arr, utt_ids


def _checkpoint_sha256(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


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
            samples, sr = load_audio(path)
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
    parser.add_argument("--asvspoof-dir", type=Path, help="Directory containing the eval audio (FLAC or WAV files named <utt_id>.{wav,flac}).")
    parser.add_argument("--asvspoof-protocol", type=Path, help="ASVspoof2019.LA.cm.eval.trl.txt protocol file.")
    parser.add_argument("--clones-dir", type=Path, help="Directory of TTS subdirs (one per family) containing WAV clones.")
    parser.add_argument("--plot-dir", type=Path, default=None,
                        help="If set, write {det,roc,score_hist}.png + scores.csv into <plot-dir>/asvspoof2019_la/")
    parser.add_argument("--limit", type=int, default=0, help="Cap the ASVspoof eval at the first N protocol entries (0 = all).")
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()

    audio = AudioService(target_sample_rate=settings.sample_rate)
    detector = DeepfakeDetectorService(weights_path=settings.aasist_weights_path)
    # Heuristic mode (no trained heads) — the heads_path setting was
    # removed in the strip; the trained-heads path is a v1.1 follow-up.
    probe = AcousticProbe()

    results: dict = {
        "dataset": "asvspoof2019_la",
        "deepfake_threshold": settings.deepfake_threshold,
        "hardware": {
            "platform": platform.platform(),
            "machine": platform.machine(),
            "torch_device": "cpu",
        },
        "checkpoint_sha256": _checkpoint_sha256(settings.aasist_weights_path),
        "completed_at": datetime.now(timezone.utc).isoformat(),
    }

    if args.asvspoof_protocol and args.asvspoof_dir:
        protocol = parse_asvspoof_protocol(args.asvspoof_protocol)
        if args.limit and args.limit > 0:
            protocol = protocol[: args.limit]
            logger.info("ASVspoof: %d clips (limited from full protocol)", len(protocol))
        else:
            logger.info("ASVspoof: %d clips", len(protocol))
        summary, scores_arr, labels_arr, utt_ids = evaluate_asvspoof(
            audio, detector, protocol, args.asvspoof_dir
        )
        results["asvspoof2019_la"] = summary

        # B2 — emit DET / ROC / score-histogram plots + per-utterance CSV.
        if args.plot_dir is not None:
            from _plotting import (
                plot_det_curve, plot_roc_curve, plot_score_histogram, write_score_csv,
            )
            sub_dir = args.plot_dir / "asvspoof2019_la"
            n = len(scores_arr)
            eer_pct = summary["eer"] * 100.0
            plot_det_curve(scores_arr, labels_arr, sub_dir / "det.png",
                           title=f"ASVspoof 2019 LA · AASIST · n={n} · EER {eer_pct:.2f}%")
            plot_roc_curve(scores_arr, labels_arr, sub_dir / "roc.png",
                           title=f"ASVspoof 2019 LA · AASIST · n={n}")
            plot_score_histogram(scores_arr, labels_arr, sub_dir / "score_hist.png",
                                 title=f"ASVspoof 2019 LA · AASIST score distribution")
            write_score_csv(sub_dir / "scores.csv",
                            [(utt_ids[i], float(scores_arr[i]), int(labels_arr[i])) for i in range(n)])
            logger.info("Plots + CSV written to %s", sub_dir)

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
