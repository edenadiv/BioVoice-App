"""Runtime settings for the BioVoice backend.

F2.4 — every secret + every environment-specific value reads from `os.environ`.
The committed defaults are safe for local development. Production deployments
populate a `.env` file (or equivalent) from their secret manager — see
`backend/README.md` for the workflow. `backend/.env.example` lists every
recognised variable.
"""

from __future__ import annotations

import os
from dataclasses import dataclass, field
from pathlib import Path


DEFAULT_CORS_ORIGINS: tuple[str, ...] = ("http://localhost:5173",)


def _cors_origins_from_env() -> list[str]:
    """Parse CORS_ORIGINS as a comma-separated env var (E2.2).

    Empty / unset → the default list. The frontend dev server runs at
    http://localhost:5173; LAN/phone demos add their host:port via env.
    """
    raw = os.environ.get("CORS_ORIGINS", "").strip()
    if not raw:
        return list(DEFAULT_CORS_ORIGINS)
    parsed = [item.strip() for item in raw.split(",") if item.strip()]
    return parsed or list(DEFAULT_CORS_ORIGINS)


def _int_from_env(name: str, default: int) -> int:
    raw = os.environ.get(name, "").strip()
    if not raw:
        return default
    try:
        return int(raw)
    except ValueError:
        return default


def _admin_api_key_from_env() -> str | None:
    """F2.4 — admin API key reserved for the /admin/* routes that land in F6.
    None when unset → admin routes are 503 unconditionally so no surface is
    exposed without an explicit secret."""
    value = os.environ.get("BIOVOICE_ADMIN_API_KEY", "").strip()
    return value or None


def _log_level_from_env() -> str:
    return os.environ.get("LOG_LEVEL", "INFO").upper()


def _cookie_secure_from_env() -> bool:
    """F2.5 — `Secure` flag on the session cookie. ON by default; only disable
    for HTTP local dev via `BIOVOICE_COOKIE_INSECURE=1`. Production must serve
    over HTTPS so the cookie is never visible on the wire."""
    return os.environ.get("BIOVOICE_COOKIE_INSECURE", "").strip() != "1"


@dataclass(slots=True)
class Settings:
    sample_rate: int = 16000
    similarity_threshold: float = 0.75
    deepfake_threshold: float = 0.50
    min_enrollment_samples: int = 3
    cors_origins: list[str] = field(default_factory=_cors_origins_from_env)
    # F2.1 — idle window past which a session is rejected. Refreshed on every
    # authenticated request via AuthService.get_session.
    session_idle_seconds: int = field(
        default_factory=lambda: _int_from_env("SESSION_IDLE_SECONDS", 30 * 60)
    )
    # F2.2 — brute-force defence on /auth/login. After `max_attempts` failures
    # in a `window_seconds` window, the (user_id, ip) pair is locked for
    # `lockout_seconds`. Tuned to balance demo usability vs. attack cost.
    login_rate_window_seconds: int = field(
        default_factory=lambda: _int_from_env("LOGIN_RATE_WINDOW_SECONDS", 5 * 60)
    )
    login_rate_max_attempts: int = field(
        default_factory=lambda: _int_from_env("LOGIN_RATE_MAX_ATTEMPTS", 5)
    )
    login_lockout_seconds: int = field(
        default_factory=lambda: _int_from_env("LOGIN_LOCKOUT_SECONDS", 15 * 60)
    )
    # F2.4 — admin API key gates the /admin/* surface added in F6. None when
    # unset; admin routes return 503 in that case (no zero-secret access).
    admin_api_key: str | None = field(default_factory=_admin_api_key_from_env)
    log_level: str = field(default_factory=_log_level_from_env)
    # F2.5 — session cookie. `Secure` is ON by default; flip via
    # BIOVOICE_COOKIE_INSECURE=1 for HTTP local dev. SameSite=Strict is
    # safe because the frontend dev origin (localhost:5173) and the API
    # (localhost:8000) are same-site — different port, same eTLD+1.
    session_cookie_name: str = "biovoice_session"
    session_cookie_secure: bool = field(default_factory=_cookie_secure_from_env)
    # F4.4 — per-concept thresholds for the AnalysisDetails sub-axes. Used
    # by the operator UI (F6.3) to flag recordings that pass the global
    # decision but show suspect per-axis behaviour. Defaults are calibrated
    # on the heuristic-mode probe; trained heads will recalibrate via the
    # training script's `--report-thresholds` mode.
    voice_naturalness_threshold: float = 0.45
    spectral_consistency_threshold: float = 0.50
    temporal_patterns_threshold: float = 0.40
    artifact_detection_threshold: float = 0.45
    # F4 — sub-classifier head weights. None when unset (heuristic mode);
    # set the path via env or training-script output to enable trained heads.
    sub_classifier_heads_path: Path | None = None
    aasist_weights_path: Path = Path(__file__).resolve().parents[3] / "backend" / "models" / "aasist.pt"
    redimnet_weights_path: Path = Path(__file__).resolve().parents[3] / "backend" / "models" / "redimnet_b5.pt"
    database_path: Path = Path(__file__).resolve().parents[3] / "backend" / "data" / "biovoice.sqlite3"
    reference_samples_path: Path = Path(__file__).resolve().parents[3] / "backend" / "data" / "reference_samples"
    generated_samples_path: Path = Path(__file__).resolve().parents[3] / "backend" / "data" / "generated_samples"
    xtts_model_path: Path = Path(__file__).resolve().parents[3] / "XTTS-v2"
    xtts_default_language: str = "en"
    xtts_output_sample_rate: int = 24000


settings = Settings()
