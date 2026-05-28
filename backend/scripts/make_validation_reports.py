"""Generate validation reports into /reports by orchestrating the bench scripts.

For each dataset whose inputs are present, runs the matching benchmark and
writes:

    <out>/<dataset>/<UTC-stamp>/summary.json
    <out>/<dataset>/<UTC-stamp>/<dataset>/{det,roc,score_hist}.png + scores.csv

and appends a row to <out>/index.json. Datasets whose inputs are absent are
SKIPPED (logged), not treated as errors.

Local-only: needs the `[bench]` extra (matplotlib + scikit-learn) and the
datasets / system TTS. Not run in CI.

Usage:
    cd backend
    .venv/bin/python scripts/make_validation_reports.py --out ../reports \\
        --spoof-eval /tmp/spoof_eval \\
        --voxceleb-pairs pairs.txt --voxceleb-audio-root /data/voxceleb1
"""

from __future__ import annotations

import argparse
import json
import logging
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path

THIS_DIR = Path(__file__).resolve().parent

logging.basicConfig(level=logging.INFO, format="%(levelname)s %(message)s")
logger = logging.getLogger("make_validation_reports")


def _stamp() -> str:
    return datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")


def discover_jobs(args) -> list[dict]:
    """Return one job per dataset whose inputs exist on disk. Each job names
    the bench script + its dataset-specific argv. Missing inputs -> no job."""
    jobs: list[dict] = []

    spoof_eval = getattr(args, "spoof_eval", None)
    if spoof_eval is not None:
        audio = spoof_eval / "audio"
        protocol = spoof_eval / "protocol.txt"
        if audio.is_dir() and protocol.is_file():
            jobs.append({
                "name": args.spoof_dataset_name,
                "script": THIS_DIR / "bench_spoof_detection.py",
                "args": ["--asvspoof-dir", str(audio), "--asvspoof-protocol", str(protocol)],
            })
        else:
            logger.warning("skip spoof: %s missing audio/ or protocol.txt", spoof_eval)

    pairs = getattr(args, "voxceleb_pairs", None)
    audio_root = getattr(args, "voxceleb_audio_root", None)
    if pairs is not None and audio_root is not None:
        if pairs.is_file() and audio_root.is_dir():
            jobs.append({
                "name": args.voxceleb_dataset_name,
                "script": THIS_DIR / "bench_eer_voxceleb.py",
                "args": ["--pairs", str(pairs), "--audio-root", str(audio_root)],
            })
        else:
            logger.warning("skip voxceleb: missing pairs file or audio root")

    return jobs


def append_index(out_root: Path, record: dict) -> None:
    """Append a run record to <out>/index.json (creating it if absent)."""
    index = out_root / "index.json"
    rows: list[dict] = []
    if index.is_file():
        try:
            rows = json.loads(index.read_text())
            if not isinstance(rows, list):
                rows = []
        except json.JSONDecodeError:
            rows = []
    rows.append(record)
    index.write_text(json.dumps(rows, indent=2) + "\n")


def run_job(job: dict, out_root: Path, python: str, limit: int) -> dict:
    stamp = _stamp()
    job_dir = out_root / job["name"] / stamp
    job_dir.mkdir(parents=True, exist_ok=True)
    summary_path = job_dir / "summary.json"
    cmd = [
        python, str(job["script"]), *job["args"],
        "--output", str(summary_path),
        "--plot-dir", str(job_dir),
        "--dataset-name", job["name"],
    ]
    if limit:
        cmd += ["--limit", str(limit)]
    subprocess.run(cmd, check=True)
    summary = json.loads(summary_path.read_text()) if summary_path.is_file() else {}
    ds = summary.get(job["name"], {}) if isinstance(summary, dict) else {}
    return {
        "dataset": job["name"],
        "stamp": stamp,
        "dir": str(job_dir.relative_to(out_root)),
        "eer": ds.get("eer"),
        "eer_threshold": ds.get("eer_threshold"),
        "min_dcf": ds.get("min_dcf"),
        "completed_at": datetime.now(timezone.utc).isoformat(),
    }


def main() -> int:
    parser = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    parser.add_argument("--out", type=Path, default=THIS_DIR.parent.parent / "reports")
    parser.add_argument("--spoof-eval", type=Path, default=None,
                        help="make_spoof_eval output dir (audio/ + protocol.txt).")
    parser.add_argument("--spoof-dataset-name", type=str, default="spoof_libri_say")
    parser.add_argument("--voxceleb-pairs", type=Path, default=None)
    parser.add_argument("--voxceleb-audio-root", type=Path, default=None)
    parser.add_argument("--voxceleb-dataset-name", type=str, default="voxceleb1_o")
    parser.add_argument("--limit", type=int, default=0, help="Cap clips/pairs (0 = all).")
    args = parser.parse_args()

    out_root: Path = args.out
    out_root.mkdir(parents=True, exist_ok=True)

    jobs = discover_jobs(args)
    if not jobs:
        logger.warning(
            "No datasets found — nothing to do. Provide --spoof-eval and/or "
            "--voxceleb-pairs + --voxceleb-audio-root."
        )
        return 0

    python = sys.executable
    for job in jobs:
        logger.info("Running benchmark: %s", job["name"])
        record = run_job(job, out_root, python, args.limit)
        append_index(out_root, record)
        logger.info("  wrote %s (EER=%s)", record["dir"], record["eer"])

    logger.info("Reports under %s · index at %s", out_root, out_root / "index.json")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
