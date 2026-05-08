"""Tests for E2.3 demo seeding."""

from __future__ import annotations

import importlib.util
from pathlib import Path

from app.services.verification import VerificationService
from app.storage.memory_store import MemoryStore

from .conftest import HashEncoder, StubDetector, make_wav, SAMPLE_RATE


def _load_seed_module():
    """Load `scripts/seed_demo.py` directly — pytest's cwd is `backend/`, so
    `from backend.scripts import seed_demo` doesn't resolve as a package."""
    seed_path = Path(__file__).resolve().parent.parent / "scripts" / "seed_demo.py"
    spec = importlib.util.spec_from_file_location("seed_demo_test", seed_path)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _service() -> VerificationService:
    return VerificationService(
        store=MemoryStore(),
        detector=StubDetector(score=0.9),
        speaker_encoder=HashEncoder(),
        sample_rate=SAMPLE_RATE,
        similarity_threshold=0.75,
        deepfake_threshold=0.5,
        min_enrollment_samples=3,
    )


def _populate_demo_dir(tmp_path: Path) -> Path:
    """Drop synthetic WAVs into a tmp dir so the seed script doesn't need the
    real bundled assets — this isolates the test from repo state."""
    (tmp_path / "alice_demo.wav").write_bytes(make_wav(2.0, frequency=220.0))
    (tmp_path / "bob_demo.wav").write_bytes(make_wav(2.0, frequency=120.0))
    return tmp_path


def test_seed_demo_enrols_two_users(tmp_path):
    seed_demo = _load_seed_module()

    service = _service()
    demo_dir = _populate_demo_dir(tmp_path)

    seeded = seed_demo.seed_demo_users(service, demo_dir=demo_dir)

    assert seeded == 2
    users = service.list_users()
    assert {u.user_id for u in users} == {"alice_demo", "bob_demo"}
    assert all(u.sample_count == 3 for u in users)


def test_seed_demo_is_idempotent(tmp_path):
    seed_demo = _load_seed_module()

    service = _service()
    demo_dir = _populate_demo_dir(tmp_path)

    first = seed_demo.seed_demo_users(service, demo_dir=demo_dir)
    second = seed_demo.seed_demo_users(service, demo_dir=demo_dir)

    assert first == 2
    assert second == 0  # nothing new on the second call
    assert len(service.list_users()) == 2


def test_seed_demo_skips_missing_wav(tmp_path):
    seed_demo = _load_seed_module()

    service = _service()
    # Only alice's WAV exists — bob should be skipped, not crash.
    (tmp_path / "alice_demo.wav").write_bytes(make_wav(2.0, frequency=220.0))

    seeded = seed_demo.seed_demo_users(service, demo_dir=tmp_path)

    assert seeded == 1
    assert {u.user_id for u in service.list_users()} == {"alice_demo"}
