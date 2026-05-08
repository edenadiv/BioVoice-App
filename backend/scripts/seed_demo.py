"""Seed two demo speakers (alice_demo, bob_demo) for client demos.

Idempotent: skips users that already exist. Wired into `app/main.py:create_app`
when `BIOVOICE_SEED_DEMO=1` is set in the environment AND the store is empty.

The seed audio lives at `backend/data/demo/{user}.wav` — three identical
samples per user (matching the production min_enrollment_samples=3 contract).
For real demos, replace those WAVs with actual recordings of the same speakers
before enabling the env var.
"""

from __future__ import annotations

import logging
from pathlib import Path

from app.services.verification import VerificationService

logger = logging.getLogger(__name__)

DEMO_DIR = Path(__file__).resolve().parent.parent / "data" / "demo"
DEMO_USERS: tuple[tuple[str, str], ...] = (
    ("alice_demo", "alice_demo.wav"),
    ("bob_demo", "bob_demo.wav"),
)
SAMPLES_PER_USER = 3


def seed_demo_users(service: VerificationService, *, demo_dir: Path = DEMO_DIR) -> int:
    """Enrol the bundled demo users. Returns the count of users newly seeded."""
    seeded = 0
    for user_id, wav_name in DEMO_USERS:
        if not service.is_user_id_available(user_id):
            logger.info("seed_demo: user %s already enrolled, skipping", user_id)
            continue
        wav_path = demo_dir / wav_name
        if not wav_path.exists():
            logger.warning("seed_demo: %s missing, skipping %s", wav_path, user_id)
            continue
        audio_bytes = wav_path.read_bytes()
        for _ in range(SAMPLES_PER_USER):
            service.enroll(user_id=user_id, audio_bytes=audio_bytes, filename=wav_name)
        logger.info("seed_demo: enrolled %s with %d samples", user_id, SAMPLES_PER_USER)
        seeded += 1
    return seeded


if __name__ == "__main__":
    # Standalone run for ad-hoc seeding — useful for resetting demo state.
    from app.core.config import settings
    from app.core.container import build_container

    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(message)s")
    container = build_container(settings)
    n = seed_demo_users(container.verification_service)
    print(f"seeded {n} demo user(s)")
