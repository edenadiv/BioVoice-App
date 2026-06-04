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


DEFAULT_CORS_ORIGINS: tuple[str, ...] = (
    "http://localhost:5173",
    "http://127.0.0.1:5173",
)
_REPO_ROOT = Path(__file__).resolve().parents[3]
_BACKEND_DIR = _REPO_ROOT / "backend"


def _load_env_file(path: Path) -> None:
    """Populate os.environ from a simple KEY=VALUE file.

    The loader is intentionally lightweight so local dev does not depend
    on python-dotenv. Existing process env vars win over file values.
    """
    if not path.is_file():
        return
    for raw_line in path.read_text(encoding="utf-8").splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        key = key.strip()
        value = value.strip()
        if not key or key in os.environ:
            continue
        if len(value) >= 2 and value[0] == value[-1] and value[0] in {'"', "'"}:
            value = value[1:-1]
        os.environ[key] = value


def _load_local_env_files() -> None:
    _load_env_file(_BACKEND_DIR / ".env")
    _load_env_file(_BACKEND_DIR / ".env.local")


_load_local_env_files()


def _cors_origins_from_env() -> list[str]:
    """Parse CORS_ORIGINS as a comma-separated env var.

    Empty / unset → the default list. The frontend dev server runs at
    http://localhost:5173 and http://127.0.0.1:5173; LAN/phone demos
    add their host:port via env.
    """
    raw = os.environ.get("CORS_ORIGINS", "").strip()
    if not raw:
        return list(DEFAULT_CORS_ORIGINS)
    parsed = [item.strip() for item in raw.split(",") if item.strip()]
    return parsed or list(DEFAULT_CORS_ORIGINS)


def _log_level_from_env() -> str:
    return os.environ.get("LOG_LEVEL", "INFO").upper()


def _bool_from_env(name: str, default: bool) -> bool:
    raw = os.environ.get(name)
    if raw is None or raw.strip() == "":
        return default
    return raw.strip().lower() in {"1", "true", "yes", "on"}


def _float_from_env(name: str, default: float) -> float:
    raw = os.environ.get(name)
    if raw is None or raw.strip() == "":
        return default
    try:
        return float(raw)
    except ValueError:
        return default


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
    redimnet_similarity_threshold: float = field(default_factory=lambda: _float_from_env("REDIMNET_SIMILARITY_THRESHOLD", 0.75))
    ecapa_similarity_threshold: float = field(default_factory=lambda: _float_from_env("ECAPA_SIMILARITY_THRESHOLD", 0.75))
    wespeaker_similarity_threshold: float = field(default_factory=lambda: _float_from_env("WESPEAKER_SIMILARITY_THRESHOLD", 0.75))

    min_enrollment_samples: int = 3
    cam_thr_aasist: float = float(os.environ.get("CAM_THR_AASIST", "0.55"))
    cam_thr_redimnet: float = float(os.environ.get("CAM_THR_REDIMNET", "0.50"))
    cam_thr_ecapa: float = float(os.environ.get("CAM_THR_ECAPA", "0.50"))
    cors_origins: list[str] = field(default_factory=_cors_origins_from_env)
    log_level: str = field(default_factory=_log_level_from_env)
    aasist_weights_path: Path = _BACKEND_DIR / "models" / "aasist.pt"
    # F4 — trained sub-classifier heads for the four forensic axes. When
    # this file is present AcousticProbe loads it and reports
    # provenance "trained_heads"; otherwise it falls back to the
    # heuristic axis mapping. Produced by scripts/train_sub_classifier.py.
    aasist_heads_path: Path = _BACKEND_DIR / "models" / "aasist_heads.pt"
    # Ensemble detector: folder containing ASVspoof5 per-system classifiers.
    # Expected layout: <root>/train/A01..A08/ and <root>/dev/A09..A16/,
    # each with logistic_regression.pkl + scaler.pkl.
    ensemble_models_path: Path = _BACKEND_DIR / "models" / "asvspoof5_train_dev_16_systems"
    redimnet_weights_path: Path = _BACKEND_DIR / "models" / "redimnet_b5.pt"
    ecapa_savedir: Path = _BACKEND_DIR / "models" / "ecapa_voxceleb"
    wespeaker_resnet293_dir: Path = _BACKEND_DIR / "models" / "wespeaker_resnet293_lm"
    enable_ecapa_comparison: bool = field(default_factory=lambda: _bool_from_env("ENABLE_ECAPA_COMPARISON", True))
    enable_wespeaker_comparison: bool = field(default_factory=lambda: _bool_from_env("ENABLE_WESPEAKER_COMPARISON", False))
    # When set, MySQLStore is used instead of SQLiteStore.
    # Format: mysql+pymysql://user:password@host:3306/dbname
    # Leave empty (default) to keep using the local SQLite file.
    database_url: str = field(default_factory=lambda: os.environ.get("DATABASE_URL", ""))
    database_path: Path = _BACKEND_DIR / "data" / "biovoice.sqlite3"
    reference_samples_path: Path = _BACKEND_DIR / "data" / "reference_samples"
    generated_samples_path: Path = _BACKEND_DIR / "data" / "generated_samples"
    xtts_model_path: Path = _REPO_ROOT / "XTTS-v2"
    xtts_default_language: str = "en"
    xtts_output_sample_rate: int = 24000
    # F5-TTS checkpoint id (downloaded from Hugging Face on first load).
    f5_model_name: str = "F5TTS_v1_Base"


settings = Settings()
