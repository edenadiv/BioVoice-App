"""Download a portable local ECAPA model directory for BioVoice.

This avoids committing machine-specific symlinks into the repo. It
materializes the SpeechBrain model files directly under
`backend/models/ecapa_voxceleb/`, which is the path the backend uses
when `ENABLE_ECAPA_COMPARISON=1`.
"""

from __future__ import annotations

import argparse
from pathlib import Path


DEFAULT_REPO_ID = "speechbrain/spkrec-ecapa-voxceleb"


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--repo-id",
        default=DEFAULT_REPO_ID,
        help=f"Hugging Face repo id to download (default: {DEFAULT_REPO_ID})",
    )
    parser.add_argument(
        "--target-dir",
        default=str(Path(__file__).resolve().parents[1] / "models" / "ecapa_voxceleb"),
        help="Directory to populate with ECAPA model files",
    )
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    target_dir = Path(args.target_dir).resolve()
    target_dir.mkdir(parents=True, exist_ok=True)

    try:
        from huggingface_hub import snapshot_download
    except ImportError as exc:  # pragma: no cover
        raise SystemExit(
            "huggingface_hub is not installed. Install backend[model] first."
        ) from exc

    print(f"Downloading {args.repo_id} into {target_dir} ...")
    snapshot_download(
        repo_id=args.repo_id,
        local_dir=str(target_dir),
        local_dir_use_symlinks=False,
    )
    print("ECAPA model files are ready.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
