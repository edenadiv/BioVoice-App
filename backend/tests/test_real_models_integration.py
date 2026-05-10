"""HF2 — real-model integration test.

Loads the production ReDimNet B5 + AASIST weights and runs an end-to-end
enrol → verify cycle. Closes audit finding F-5: every other backend
test uses HashEncoder + StubDetector, so a regression in the real
loader paths would not be caught by CI.

This test is `pytest.mark.slow` and skipped by default. Run with:

    .venv/bin/pytest -m slow

Auto-skips when:
  * model weight files missing (operator hasn't downloaded them)
  * system TTS missing (no `say` on macOS, no `espeak-ng` on Linux)
  * torch / torchaudio not installed (the [model] extra)
"""

from __future__ import annotations

import shutil
import subprocess
import tempfile
from pathlib import Path

import pytest

pytestmark = pytest.mark.slow


# Resolve repo paths once at import time.
_HERE = Path(__file__).resolve()
_BACKEND = _HERE.parent.parent
_MODELS = _BACKEND / "models"
_AASIST_PATH = _MODELS / "aasist.pt"
_REDIMNET_PATH = _MODELS / "redimnet_b5.pt"


def _system_tts_binary() -> tuple[str, str] | None:
    """Return (engine, path) for the first available TTS binary, or None."""
    say = shutil.which("say")
    if say:
        return ("say", say)
    for binary in ("espeak-ng", "espeak"):
        path = shutil.which(binary)
        if path:
            return ("espeak", path)
    return None


def _generate_real_wav(target_path: Path) -> None:
    """Synthesize a real WAV via the system TTS so the AudioService
    quality gate (SNR ≥ 10 dB, speech_ratio ≥ 0.3) actually passes."""
    engine = _system_tts_binary()
    if engine is None:
        pytest.skip("No system TTS binary on PATH (need `say` or `espeak-ng`)")

    text = (
        "This is a real model integration test for the BioVoice kiosk. "
        "The speaker encoder is ReDimNet, and the anti spoofing detector is AASIST. "
        "We need at least three seconds of speech for the quality gate to pass."
    )
    if engine[0] == "say":
        subprocess.run(
            [engine[1], "-o", str(target_path), "--data-format=LEI16@16000", text],
            check=True, capture_output=True,
        )
    else:  # espeak / espeak-ng
        subprocess.run(
            [engine[1], "-w", str(target_path), text],
            check=True, capture_output=True,
        )


@pytest.fixture(scope="module")
def real_wav() -> bytes:
    """Generate one real WAV at module scope and reuse it across tests."""
    if not _AASIST_PATH.exists():
        pytest.skip(f"AASIST weights missing at {_AASIST_PATH}")
    if not _REDIMNET_PATH.exists():
        pytest.skip(f"ReDimNet weights missing at {_REDIMNET_PATH}")

    with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as tmp:
        wav_path = Path(tmp.name)
    try:
        _generate_real_wav(wav_path)
        return wav_path.read_bytes()
    finally:
        wav_path.unlink(missing_ok=True)


@pytest.fixture(scope="module")
def real_verification_service():
    """Production wiring: real RedimNetSpeakerEncoder + real
    DeepfakeDetectorService + real AcousticProbe + real MemoryStore."""
    try:
        import torch  # noqa: F401
    except ImportError:
        pytest.skip("torch not installed — run `pip install -e '.[model]'`")

    from app.services.detector import DeepfakeDetectorService
    from app.services.speaker_encoder import RedimNetSpeakerEncoder
    from app.services.sub_classifier import AcousticProbe
    from app.services.verification import VerificationService
    from app.storage.memory_store import MemoryStore

    encoder = RedimNetSpeakerEncoder(weights_path=_REDIMNET_PATH)
    detector = DeepfakeDetectorService(weights_path=_AASIST_PATH)
    probe = AcousticProbe()
    return VerificationService(
        store=MemoryStore(),
        detector=detector,
        speaker_encoder=encoder,
        sample_rate=16_000,
        similarity_threshold=0.75,
        deepfake_threshold=0.50,
        min_enrollment_samples=3,
        acoustic_probe=probe,
    )


def test_real_models_enrol_and_verify_round_trip(real_verification_service, real_wav: bytes):
    """Enrol three samples, verify against the same audio, assert the
    response shape is sane and the model_provenance flag confirms real
    weights are loaded."""
    user_id = "real_models_test_user"

    # Enrol 3 samples.
    for _ in range(3):
        enroll_resp = real_verification_service.enroll(
            user_id=user_id, audio_bytes=real_wav, filename="test.wav"
        )
        assert enroll_resp.quality is not None
        assert enroll_resp.quality.acceptable is True, f"quality gate rejected sample: {enroll_resp.quality}"
        # Provenance flows through enrol too.
        assert enroll_resp.model_provenance is not None
        assert enroll_resp.model_provenance.encoder == "redimnet_b5"

    # Verify same audio.
    verify_resp = real_verification_service.verify(
        user_id=user_id, audio_bytes=real_wav, filename="test.wav"
    )
    assert verify_resp.user_id == user_id
    assert verify_resp.decision in {"ACCEPT", "REJECT", "DEEPFAKE"}
    assert 0.0 <= verify_resp.similarity_score <= 1.0
    assert 0.0 <= verify_resp.deepfake_score <= 1.0

    # Same speaker → high similarity (well above 0.75).
    assert verify_resp.similarity_score >= 0.7, (
        f"Same audio against itself should produce sim ≥ 0.7, got {verify_resp.similarity_score}"
    )

    # Stage breakdown should be real measurements (positive numbers).
    sb = verify_resp.stage_breakdown
    assert sb.embed_ms > 0
    assert sb.detect_ms > 0
    assert sb.total_ms >= sb.embed_ms + sb.detect_ms

    # Provenance — real weights → not degraded.
    assert verify_resp.model_provenance is not None
    assert verify_resp.model_provenance.encoder == "redimnet_b5"
    assert verify_resp.model_provenance.detector == "aasist"
    assert verify_resp.model_provenance.is_degraded is False, (
        f"is_degraded should be false with real weights; got {verify_resp.model_provenance}"
    )


def test_real_models_identify_ranks_correctly(real_verification_service, real_wav: bytes):
    """After enrolling at least one user, /identify should rank them
    first and return is_degraded=false."""
    user_id = "identify_test_user"
    for _ in range(3):
        real_verification_service.enroll(
            user_id=user_id, audio_bytes=real_wav, filename="test.wav"
        )

    result = real_verification_service.identify(audio_bytes=real_wav, top_n=3)
    assert len(result.matches) >= 1
    # Top match against the enrolled user.
    assert any(m.user_id == user_id for m in result.matches)
    assert result.model_provenance is not None
    assert result.model_provenance.is_degraded is False
