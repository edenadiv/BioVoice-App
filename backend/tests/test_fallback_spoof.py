"""Tests for E2.1 — BIOVOICE_FALLBACK_SPOOF behaviour on `SpoofGenerationService.generate`."""

from __future__ import annotations

import pytest

from app.models import ReferenceSampleRecord
from app.services.spoof import FALLBACK_WAV_PATH, SpoofGenerationService
from app.storage.memory_store import MemoryStore


@pytest.fixture
def spoof_service(tmp_path):
    """SpoofGenerationService pointed at a non-existent XTTS model dir so the
    `_ensure_model_loaded` path raises RuntimeError — the trigger for the
    fallback short-circuit."""
    return SpoofGenerationService(
        store=MemoryStore(),
        model_path=tmp_path / "xtts-missing",
        output_directory=tmp_path / "out",
        default_language="en",
        output_sample_rate=24000,
    )


def _seed_reference(service: SpoofGenerationService, *, user_id: str = "alice") -> None:
    service.store._reference_samples.append(  # type: ignore[attr-defined]
        ReferenceSampleRecord(
            sample_id="ref-1",
            user_id=user_id,
            file_path="memory://alice/ref.wav",
            original_filename="ref.wav",
            source="enrollment",
        )
    )


def test_fallback_serves_bundled_wav_when_env_set(spoof_service, monkeypatch):
    monkeypatch.setenv("BIOVOICE_FALLBACK_SPOOF", "1")
    _seed_reference(spoof_service)

    result = spoof_service.generate(user_id="alice", text="hello")

    assert result.file_name == "fallback-spoof.wav"
    assert result.source_description.startswith("Fallback")
    assert len(result.audio_bytes) > 0
    # Bytes match the bundled file.
    assert result.audio_bytes == FALLBACK_WAV_PATH.read_bytes()


def test_fallback_disabled_by_default_raises(spoof_service, monkeypatch):
    monkeypatch.delenv("BIOVOICE_FALLBACK_SPOOF", raising=False)
    _seed_reference(spoof_service)

    with pytest.raises(RuntimeError):
        spoof_service.generate(user_id="alice", text="hello")


def test_fallback_text_validation_runs_first(spoof_service, monkeypatch):
    """Empty text → ValueError, not fallback. Validation precedes the fallback."""
    monkeypatch.setenv("BIOVOICE_FALLBACK_SPOOF", "1")
    _seed_reference(spoof_service)

    with pytest.raises(ValueError):
        spoof_service.generate(user_id="alice", text="   ")


def test_fallback_path_exists() -> None:
    """The bundled WAV must actually be on disk; otherwise the fallback path
    is silently broken."""
    assert FALLBACK_WAV_PATH.exists(), f"missing {FALLBACK_WAV_PATH}"
    assert FALLBACK_WAV_PATH.stat().st_size > 1000  # not an empty placeholder
