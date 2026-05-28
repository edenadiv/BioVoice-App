"""Build a sub-classifier training manifest from a make_spoof_eval output dir.

Bridges `scripts/make_spoof_eval.py` (which writes `audio/` + `protocol.txt`)
to `scripts/train_sub_classifier.py` (which consumes a CSV of `path` + the
four axis labels).

The axis labels are PROXY labels, not hand annotations. For each clip we
take the heuristic `AcousticProbe` axes (derived from real acoustic
features) and blend them toward a high anchor for bonafide / a low anchor
for spoof:

    target_axis = w * heuristic_axis + (1 - w) * anchor

This teaches the heads the feature->axis mapping with a label-driven bias.
It is NOT a substitute for annotated data — published numbers must use
hand-annotated subsets (see docs/paper/sub_classifier.md).

Usage:
    cd backend
    .venv/bin/python scripts/build_spoof_manifest.py \\
        --eval-dir /tmp/spoof_eval --out /tmp/manifest.csv
"""

from __future__ import annotations

import argparse
import csv
import logging
import sys
from pathlib import Path

THIS_DIR = Path(__file__).resolve().parent
BACKEND_ROOT = THIS_DIR.parent
sys.path.insert(0, str(BACKEND_ROOT))

from app.services.audio import AudioService  # noqa: E402
from app.services.sub_classifier import AcousticProbe  # noqa: E402

logging.basicConfig(level=logging.INFO, format="%(levelname)s %(message)s")
logger = logging.getLogger("build_spoof_manifest")

AXIS_NAMES = (
    "voice_naturalness",
    "spectral_consistency",
    "temporal_patterns",
    "artifact_detection",
)


def parse_protocol(path: Path) -> list[tuple[str, int]]:
    """`<spk> <utt_id> - - <bonafide|spoof>` -> (utt_id, is_bonafide)."""
    rows: list[tuple[str, int]] = []
    for line in path.read_text().splitlines():
        parts = line.split()
        if len(parts) < 5:
            continue
        rows.append((parts[1], 1 if parts[-1] == "bonafide" else 0))
    return rows


def _clamp(v: float) -> float:
    return 0.0 if v < 0.0 else 1.0 if v > 1.0 else v


def build_rows(
    eval_dir: Path,
    *,
    bonafide_anchor: float,
    spoof_anchor: float,
    feature_weight: float,
) -> list[dict[str, str]]:
    audio_dir = eval_dir / "audio"
    protocol_path = eval_dir / "protocol.txt"
    if not protocol_path.is_file():
        raise SystemExit(f"protocol not found: {protocol_path}")

    audio = AudioService(target_sample_rate=16000)
    # Heuristic mode (no heads_path) — gives feature-driven axis values.
    probe = AcousticProbe()

    out_rows: list[dict[str, str]] = []
    for utt_id, is_bona in parse_protocol(protocol_path):
        wav_path = audio_dir / f"{utt_id}.wav"
        if not wav_path.is_file():
            logger.warning("missing audio, skipping: %s", wav_path)
            continue
        payload = audio.decode_wav(wav_path.read_bytes())
        details = probe.score(payload.waveform)
        anchor = bonafide_anchor if is_bona else spoof_anchor
        heuristic = {
            "voice_naturalness": details.voice_naturalness,
            "spectral_consistency": details.spectral_consistency,
            "temporal_patterns": details.temporal_patterns,
            "artifact_detection": details.artifact_detection,
        }
        row: dict[str, str] = {"path": str(wav_path.resolve())}
        for axis in AXIS_NAMES:
            target = feature_weight * heuristic[axis] + (1.0 - feature_weight) * anchor
            row[axis] = f"{_clamp(target):.4f}"
        out_rows.append(row)
    return out_rows


def main() -> int:
    parser = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    parser.add_argument(
        "--eval-dir", type=Path, required=True,
        help="make_spoof_eval output dir (contains audio/ + protocol.txt).",
    )
    parser.add_argument("--out", type=Path, required=True, help="Destination CSV.")
    parser.add_argument("--bonafide-anchor", type=float, default=0.9)
    parser.add_argument("--spoof-anchor", type=float, default=0.15)
    parser.add_argument(
        "--feature-weight", type=float, default=0.5,
        help="Blend weight w in target = w*heuristic + (1-w)*anchor.",
    )
    args = parser.parse_args()

    rows = build_rows(
        args.eval_dir,
        bonafide_anchor=args.bonafide_anchor,
        spoof_anchor=args.spoof_anchor,
        feature_weight=args.feature_weight,
    )
    if not rows:
        raise SystemExit("no usable clips found")

    args.out.parent.mkdir(parents=True, exist_ok=True)
    with args.out.open("w", newline="") as f:
        writer = csv.DictWriter(f, fieldnames=["path", *AXIS_NAMES])
        writer.writeheader()
        writer.writerows(rows)
    logger.info("wrote %d rows -> %s", len(rows), args.out)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
