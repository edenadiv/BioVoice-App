"""SpoofGenerationService fallback path — when XTTS isn't installed,
falls back to system TTS (`say` on macOS, `espeak-ng` on Linux). This
test only runs when at least one is available."""

from __future__ import annotations

import shutil
import wave
from io import BytesIO

import pytest

from app.services.spoof import SpoofGenerationService
from app.storage.memory_store import MemoryStore


_HAS_SYSTEM_TTS = shutil.which("say") is not None or shutil.which("espeak-ng") is not None or shutil.which("espeak") is not None


@pytest.mark.skipif(not _HAS_SYSTEM_TTS, reason="No system TTS binary available")
def test_fallback_synthesis_produces_valid_wav(tmp_path):
    """When XTTS isn't installed, generate() should fall back to the
    system TTS and produce a valid PCM WAV.

    We force the XTTS path to fail by pointing the model_path at a
    non-existent directory (so `_ensure_model_loaded` raises the
    fallback-trigger RuntimeError)."""
    store = MemoryStore()
    service = SpoofGenerationService(
        store=store,
        model_path=tmp_path / "xtts-not-here",
        output_directory=tmp_path / "spoof-output",
        default_language="en",
        output_sample_rate=22050,
    )

    result = service.generate(
        user_id="alice",
        text="Hello from the system text to speech.",
        language="en",
    )

    assert result.audio_bytes, "fallback should produce non-empty audio"
    assert result.file_name.endswith(".wav")
    # T2 (v1.1.1) — the "system TTS fallback" terminology was retired
    # in favour of explicit engine selection. The default engine is now
    # `say` on macOS / `espeak` on Linux; either is acceptable here.
    assert result.engine_id in {"say", "espeak"}
    assert result.source_description

    # Verify the produced bytes are a real WAV (not, say, a Python error
    # message accidentally written to disk).
    with wave.open(BytesIO(result.audio_bytes), "rb") as handle:
        assert handle.getnchannels() in (1, 2)
        assert handle.getsampwidth() == 2
        n_frames = handle.getnframes()
        assert n_frames > 0


@pytest.mark.skipif(not _HAS_SYSTEM_TTS, reason="No system TTS binary available")
def test_fallback_synthesis_persists_to_output_directory(tmp_path):
    """The fallback should write the WAV into output_directory just like
    the XTTS path does."""
    store = MemoryStore()
    out_dir = tmp_path / "spoof-output"
    service = SpoofGenerationService(
        store=store,
        model_path=tmp_path / "xtts-not-here",
        output_directory=out_dir,
        default_language="en",
        output_sample_rate=22050,
    )

    result = service.generate(user_id="bob", text="Test persistence.", language="en")
    written = out_dir / result.file_name
    assert written.exists()
    assert written.read_bytes() == result.audio_bytes


def test_value_error_propagates_through_fallback(tmp_path):
    """A ValueError (empty text) should not be swallowed by the
    fallback — it's not an XTTS-availability problem, so the route
    should still see it as 400."""
    store = MemoryStore()
    service = SpoofGenerationService(
        store=store,
        model_path=tmp_path / "xtts-not-here",
        output_directory=tmp_path / "spoof-output",
        default_language="en",
        output_sample_rate=22050,
    )

    with pytest.raises(ValueError, match="Text is required"):
        service.generate(user_id="alice", text="   ", language="en")
