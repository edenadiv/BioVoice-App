"""Runtime settings for the BioVoice backend.

Every environment-specific value reads from `os.environ`. The committed
defaults are safe for local development. Production deployments populate
a `.env` file (or equivalent) from their secret manager — see
`backend/README.md` for the workflow. `backend/.env.example` lists every
recognised variable.
"""

from __future__ import annotations

import os
from dataclasses import dataclass, field
from pathlib import Path


DEFAULT_CORS_ORIGINS: tuple[str, ...] = ("http://localhost:5173",)


def _cors_origins_from_env() -> list[str]:
    """Parse CORS_ORIGINS as a comma-separated env var.

    Empty / unset → the default list. The frontend dev server runs at
    http://localhost:5173; LAN/phone demos add their host:port via env.
    """
    raw = os.environ.get("CORS_ORIGINS", "").strip()
    if not raw:
        return list(DEFAULT_CORS_ORIGINS)
    parsed = [item.strip() for item in raw.split(",") if item.strip()]
    return parsed or list(DEFAULT_CORS_ORIGINS)


def _log_level_from_env() -> str:
    return os.environ.get("LOG_LEVEL", "INFO").upper()


@dataclass(slots=True)
class Settings:
    sample_rate: int = 16000

    # ⚠️ HF4 — these defaults are SDD conventions, NOT calibrated against
    # any dataset. See docs/thresholds.md for the operating-point
    # rationale, FAR/FRR trade-offs, and the procedure to retune. The
    # ASVspoof + VoxCeleb benchmarks (Plan.md S3 / docs/benchmarks.md)
    # are the path to data-driven values; until those land, treat both
    # numbers as placeholders.
    #
    # similarity_threshold: cosine sim cutoff for "ACCEPT" decisions.
    # Lower → more false accepts (security risk); higher → more false
    # rejects (operator unusability). 0.75 is the SDD default.
    similarity_threshold: float = 0.75
    # deepfake_threshold: AASIST score cutoff for "GENUINE" decisions.
    # Lower → more synthetic audio passes through; higher → more real
    # voices flagged as DEEPFAKE. 0.50 is the SDD default.
    deepfake_threshold: float = 0.50

    min_enrollment_samples: int = 3
    cors_origins: list[str] = field(default_factory=_cors_origins_from_env)
    log_level: str = field(default_factory=_log_level_from_env)
    aasist_weights_path: Path = Path(__file__).resolve().parents[3] / "backend" / "models" / "aasist.pt"
    redimnet_weights_path: Path = Path(__file__).resolve().parents[3] / "backend" / "models" / "redimnet_b5.pt"
    database_path: Path = Path(__file__).resolve().parents[3] / "backend" / "data" / "biovoice.sqlite3"
    reference_samples_path: Path = Path(__file__).resolve().parents[3] / "backend" / "data" / "reference_samples"
    generated_samples_path: Path = Path(__file__).resolve().parents[3] / "backend" / "data" / "generated_samples"
    xtts_model_path: Path = Path(__file__).resolve().parents[3] / "XTTS-v2"
    xtts_default_language: str = "en"
    xtts_output_sample_rate: int = 24000


settings = Settings()
