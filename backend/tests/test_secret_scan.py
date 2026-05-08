"""F2.4 — guard against committed secrets.

Walks `backend/app/`, `backend/scripts/`, the project root scripts, and config
files; greps for high-confidence secret signatures. False positives are quiet
death for these scanners, so the patterns here only fire on shapes that have
no legitimate reason to live in source control.

The CI workflow runs `pytest backend/tests/test_secret_scan.py` before
anything else; a fresh hire failing this test gets the secrets-management
README pointed at them.
"""

from __future__ import annotations

import re
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parents[2]

# Files / directories that we deliberately read but never scan for matches:
#   - This test itself (it contains the patterns).
#   - The .env.example template (placeholders + comments — no real secrets).
#   - Vendor / generated content.
EXCLUDED_NAMES = {
    "test_secret_scan.py",
    ".env.example",
}
EXCLUDED_DIRS = {
    "node_modules",
    "dist",
    "build",
    ".venv",
    "__pycache__",
    "data",
    ".git",
    "models",        # ML weight binaries
    "XTTS-v2",       # ML weight binaries
}

# Each entry is (label, compiled regex). Add cautiously — the CI workflow
# blocks merges on any match.
PATTERNS: list[tuple[str, re.Pattern[str]]] = [
    ("AWS access key id", re.compile(r"\bAKIA[0-9A-Z]{16}\b")),
    ("GitHub personal token", re.compile(r"\bgh[pousr]_[A-Za-z0-9]{36,255}\b")),
    ("Slack token", re.compile(r"\bxox[abprs]-[A-Za-z0-9-]{10,}\b")),
    ("Google API key", re.compile(r"\bAIza[0-9A-Za-z_\-]{35}\b")),
    ("Stripe live key", re.compile(r"\b(sk|rk)_live_[A-Za-z0-9]{16,}\b")),
    ("RSA / EC private key", re.compile(r"-----BEGIN (RSA|EC|OPENSSH|DSA|PGP) PRIVATE KEY-----")),
    ("PEM private key (generic)", re.compile(r"-----BEGIN PRIVATE KEY-----")),
    # Coquihalla-style SSH key prefix occasionally pasted in error.
    ("SSH RSA key body", re.compile(r"\bssh-rsa AAAA[0-9A-Za-z+/]{100,}")),
]


def _walk_repo() -> list[Path]:
    out: list[Path] = []
    for path in REPO_ROOT.rglob("*"):
        if not path.is_file():
            continue
        if any(part in EXCLUDED_DIRS for part in path.parts):
            continue
        if path.name in EXCLUDED_NAMES:
            continue
        # Skip binaries — anything > 5 MB or with non-text extensions.
        if path.suffix.lower() in {".png", ".jpg", ".jpeg", ".gif", ".webp", ".pdf",
                                    ".zip", ".tar", ".gz", ".pth", ".pt", ".bin",
                                    ".wav", ".mp3", ".sqlite3", ".sqlite", ".db",
                                    ".lock"}:
            continue
        try:
            if path.stat().st_size > 5_000_000:
                continue
        except OSError:
            continue
        out.append(path)
    return out


@pytest.mark.parametrize("label,pattern", PATTERNS, ids=[p[0] for p in PATTERNS])
def test_no_secrets_match(label: str, pattern: re.Pattern[str]) -> None:
    hits: list[tuple[str, int, str]] = []
    for path in _walk_repo():
        try:
            text = path.read_text(encoding="utf-8", errors="ignore")
        except OSError:
            continue
        for line_no, line in enumerate(text.splitlines(), start=1):
            if pattern.search(line):
                hits.append((str(path.relative_to(REPO_ROOT)), line_no, line.strip()[:160]))
    assert not hits, (
        f"Possible secret leak — pattern '{label}' matched:\n"
        + "\n".join(f"  {p}:{ln}: {snippet}" for p, ln, snippet in hits)
        + "\n\nIf this is a false positive, narrow the regex in test_secret_scan.py "
        "or add the file to EXCLUDED_NAMES with a justification."
    )


def test_dotenv_is_gitignored() -> None:
    """Ensure a real `.env` file can never be committed."""
    gitignore = REPO_ROOT / ".gitignore"
    assert gitignore.exists()
    text = gitignore.read_text()
    assert ".env" in text.split(), (
        "Add `.env` to .gitignore — secret values are env-managed and the "
        "real .env must never enter git history."
    )


def test_env_example_lists_known_vars() -> None:
    """Quick sanity that .env.example mentions every env var Settings reads,
    so a fresh contributor copying the template doesn't miss one. The check
    is loose — it only verifies the variable names appear somewhere in the
    file (commented or active)."""
    example = (REPO_ROOT / "backend" / ".env.example").read_text()
    expected = (
        "CORS_ORIGINS",
        "SESSION_IDLE_SECONDS",
        "LOGIN_RATE_MAX_ATTEMPTS",
        "LOGIN_RATE_WINDOW_SECONDS",
        "LOGIN_LOCKOUT_SECONDS",
        "BIOVOICE_ADMIN_API_KEY",
        "LOG_LEVEL",
        "DATABASE_URL",
    )
    missing = [name for name in expected if name not in example]
    assert not missing, f"Add to backend/.env.example: {missing}"
