"""SpoofGenerationService.generate() — cloning-only behaviour.

v1.2 removed the generic system-TTS fallback. There is no longer a
"speak in a stranger's voice" path: if no cloning engine is available,
generation fails loudly so the operator knows to install F5 / XTTS.
These tests are hermetic — they never load a real model.
"""

from __future__ import annotations

import pytest

from app.services.spoof import SpoofGenerationService
from app.storage.memory_store import MemoryStore


def _service(tmp_path) -> SpoofGenerationService:
    return SpoofGenerationService(
        store=MemoryStore(),
        model_path=tmp_path / "xtts-not-here",
        output_directory=tmp_path / "spoof-output",
        default_language="en",
        output_sample_rate=24000,
    )


def test_empty_text_raises_value_error(tmp_path):
    """Empty text is rejected before any engine is touched, so the route
    surfaces it as a 400 regardless of which engines are installed."""
    service = _service(tmp_path)
    with pytest.raises(ValueError, match="Text is required"):
        service.generate(user_id="alice", text="   ", language="en")


def test_unavailable_engine_raises_runtime_error(tmp_path):
    """Asking for XTTS when its checkpoint is missing raises RuntimeError
    (→ 503 at the route) — there is no silent fallback to another voice."""
    service = _service(tmp_path)
    with pytest.raises(RuntimeError, match="isn't available"):
        service.generate(user_id="alice", text="hello", engine="xtts")


def test_unknown_engine_raises_value_error(tmp_path):
    service = _service(tmp_path)
    with pytest.raises(ValueError, match="Unknown cloning engine"):
        service.generate(user_id="alice", text="hello", engine="bogus")
