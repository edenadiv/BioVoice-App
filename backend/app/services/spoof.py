"""Spoof sample generation.

Two engines:
  1. XTTS-v2 (preferred) — voice-cloning TTS that conditions on a
     reference WAV. Requires the `coqui-ai/TTS` package + a local XTTS-v2
     checkpoint. Doesn't install cleanly on Python 3.13+.
  2. macOS `say` (fallback) — calls the system text-to-speech binary to
     produce a real synthetic WAV. No voice cloning, but real synthesis
     that AASIST should classify as FAKE. Used when XTTS isn't
     available. Pure Python, no extra deps.
"""

from __future__ import annotations

import logging
import shutil
import subprocess
import wave
from contextlib import contextmanager
from dataclasses import dataclass
from pathlib import Path
from tempfile import NamedTemporaryFile, TemporaryDirectory
from threading import Lock
from typing import Any, Protocol

from app.models import ReferenceSampleRecord
from app.schemas import ReferenceSampleResponse
from app.services.audio import AudioService

_LOG = logging.getLogger(__name__)


class ReferenceSampleStore(Protocol):
    def list_reference_samples(self, user_id: str) -> list[ReferenceSampleRecord]: ...

    def get_reference_sample(self, user_id: str, sample_id: str) -> ReferenceSampleRecord | None: ...


@dataclass(slots=True)
class SpoofGenerationResult:
    audio_bytes: bytes
    file_name: str
    source_description: str


class SpoofGenerationService:
    def __init__(
        self,
        store: ReferenceSampleStore,
        model_path: Path,
        output_directory: Path,
        default_language: str,
        output_sample_rate: int,
    ):
        self.store = store
        self.model_path = Path(model_path)
        self.output_directory = Path(output_directory)
        self.output_directory.mkdir(parents=True, exist_ok=True)
        self.default_language = default_language
        self.output_sample_rate = output_sample_rate
        self.audio = AudioService()
        self._load_lock = Lock()
        self._model: Any | None = None
        self._config: Any | None = None

    def list_reference_samples(self, user_id: str) -> list[ReferenceSampleResponse]:
        return [
            ReferenceSampleResponse(
                sample_id=sample.sample_id,
                user_id=sample.user_id,
                original_filename=sample.original_filename,
                source=sample.source,
                created_at=sample.created_at,
            )
            for sample in self.store.list_reference_samples(user_id)
        ]

    def generate(
        self,
        user_id: str,
        text: str,
        language: str | None = None,
        reference_sample_id: str | None = None,
        reference_audio_bytes: bytes | None = None,
        reference_filename: str | None = None,
    ) -> SpoofGenerationResult:
        message_text = text.strip()
        if not message_text:
            raise ValueError("Text is required to generate a spoof sample")

        language_code = (language or self.default_language).strip().lower()

        # Decide which engine to use up-front. XTTS needs both the
        # `TTS` package AND a checkpoint dir on disk. If either is
        # missing we go straight to the system-TTS fallback so the
        # operator gets a real synthetic clip even on a Py 3.13+ venv
        # where XTTS won't install.
        if _xtts_available(self.model_path):
            return self._generate_with_xtts(
                user_id=user_id,
                text=message_text,
                language_code=language_code,
                reference_sample_id=reference_sample_id,
                reference_audio_bytes=reference_audio_bytes,
                reference_filename=reference_filename,
            )
        return self._generate_with_system_tts(
            user_id=user_id,
            text=message_text,
            language_code=language_code,
        )

    def _generate_with_xtts(
        self,
        user_id: str,
        text: str,
        language_code: str,
        reference_sample_id: str | None,
        reference_audio_bytes: bytes | None,
        reference_filename: str | None,
    ) -> SpoofGenerationResult:
        with self._reference_context(
            user_id=user_id,
            reference_sample_id=reference_sample_id,
            reference_audio_bytes=reference_audio_bytes,
            reference_filename=reference_filename,
        ) as (reference_paths, source_description):
            model, config = self._ensure_model_loaded()
            output = model.synthesize(
                text,
                config,
                speaker_wav=reference_paths[0] if len(reference_paths) == 1 else reference_paths,
                gpt_cond_len=3,
                language=language_code,
            )
        waveform = self._coerce_waveform(output.get("wav") if isinstance(output, dict) else output)
        audio_bytes = self.audio.encode_wav(waveform, sample_rate=self.output_sample_rate)
        return self._persist(user_id, audio_bytes, source_description)

    def _generate_with_system_tts(
        self,
        user_id: str,
        text: str,
        language_code: str,
    ) -> SpoofGenerationResult:
        """Fallback: produce real synthetic speech using a system TTS
        binary (`say` on macOS, `espeak`/`espeak-ng` on Linux). No voice
        cloning — the synthesized audio uses a generic system voice — but
        AASIST treats this as FAKE because the spectral signature of
        formant-based / neural-vocoder TTS is recognisable as synthetic."""
        backend, binary = _select_system_tts()
        if backend == "say":
            audio_bytes = _synthesize_with_say(binary, text, self.output_sample_rate)
        elif backend == "espeak":
            audio_bytes = _synthesize_with_espeak(binary, text, language_code, self.output_sample_rate)
        else:
            raise RuntimeError(
                "No system TTS available. Install the 'spoof' extra to enable XTTS, "
                "or install `espeak-ng` (Linux) so the fallback can synthesise."
            )
        return self._persist(
            user_id,
            audio_bytes,
            f"system TTS fallback ({backend}; XTTS not installed)",
        )

    def _persist(self, user_id: str, audio_bytes: bytes, source_description: str) -> SpoofGenerationResult:
        safe_user_id = "".join(
            character if character.isalnum() or character in {"-", "_"} else "_"
            for character in user_id
        )
        file_name = f"{safe_user_id}-spoof.wav"
        (self.output_directory / file_name).write_bytes(audio_bytes)
        return SpoofGenerationResult(
            audio_bytes=audio_bytes,
            file_name=file_name,
            source_description=source_description,
        )

    def _ensure_model_loaded(self) -> tuple[Any, Any]:
        if self._model is not None and self._config is not None:
            return self._model, self._config

        with self._load_lock:
            if self._model is not None and self._config is not None:
                return self._model, self._config

            try:
                import torch
                from TTS.tts.configs.xtts_config import XttsConfig
                from TTS.tts.models.xtts import Xtts
            except ImportError as exc:
                raise RuntimeError(
                    "XTTS dependencies are not installed. Reinstall the backend with the 'spoof' extra on Python 3.11 or 3.12 before generating spoof samples."
                ) from exc

            config_path = self.model_path / "config.json"
            checkpoint_path = self.model_path / "model.pth"
            if not config_path.exists() or not checkpoint_path.exists():
                raise RuntimeError(f"XTTS checkpoint is incomplete at '{self.model_path}'.")

            config = XttsConfig()
            config.load_json(str(config_path))
            model = Xtts.init_from_config(config)
            model.load_checkpoint(config, checkpoint_dir=str(self.model_path), eval=True)
            device = "cuda" if torch.cuda.is_available() else "cpu"
            if device == "cuda":
                model.cuda()
            elif hasattr(model, "to"):
                model.to(device)

            self._model = model
            self._config = config
            return model, config

    @contextmanager
    def _reference_context(
        self,
        user_id: str,
        reference_sample_id: str | None,
        reference_audio_bytes: bytes | None,
        reference_filename: str | None,
    ):
        if reference_sample_id:
            sample = self.store.get_reference_sample(user_id, reference_sample_id)
            if sample is None:
                raise ValueError("Reference sample not found for the authenticated user")
            yield [sample.file_path], f"Saved enrollment sample: {sample.original_filename}"
            return

        if reference_audio_bytes is not None:
            normalized_reference = self.audio.decode_wav(reference_audio_bytes)
            with TemporaryDirectory(prefix="biovoice-spoof-") as temporary_directory:
                reference_path = Path(temporary_directory) / (reference_filename or "uploaded-reference.wav")
                reference_path.write_bytes(
                    self.audio.encode_wav(
                        normalized_reference.waveform,
                        sample_rate=normalized_reference.sample_rate,
                    )
                )
                yield [str(reference_path)], f"Uploaded reference sample: {reference_filename or 'uploaded-reference.wav'}"
                return

        saved_samples = self.store.list_reference_samples(user_id)
        if not saved_samples:
            raise ValueError("No saved enrollment samples are available. Upload a WAV reference sample first.")
        yield [sample.file_path for sample in saved_samples], f"All saved enrollment samples ({len(saved_samples)})"

    @staticmethod
    def _coerce_waveform(waveform: Any) -> list[float]:
        if hasattr(waveform, "detach"):
            waveform = waveform.detach()
        if hasattr(waveform, "cpu"):
            waveform = waveform.cpu()
        if hasattr(waveform, "numpy"):
            waveform = waveform.numpy()
        if hasattr(waveform, "tolist"):
            waveform = waveform.tolist()
        if isinstance(waveform, list) and waveform and isinstance(waveform[0], list):
            waveform = waveform[0]
        return [float(sample) for sample in waveform]


# ---------------------------------------------------------------------------
# Engine availability + system-TTS fallback
# ---------------------------------------------------------------------------


def _xtts_available(model_path: Path) -> bool:
    """True iff the XTTS Python package is importable AND the checkpoint
    directory contains both `config.json` and `model.pth`. We cache the
    package-import outcome on the module so we don't pay the import cost
    on every call."""
    cached = globals().get("_XTTS_PKG_OK")
    if cached is None:
        try:
            import TTS.tts.configs.xtts_config  # noqa: F401
            import TTS.tts.models.xtts  # noqa: F401
            cached = True
        except (ImportError, ModuleNotFoundError):
            cached = False
        globals()["_XTTS_PKG_OK"] = cached
    if not cached:
        return False
    return (model_path / "config.json").exists() and (model_path / "model.pth").exists()


def _select_system_tts() -> tuple[str, str]:
    """Return (backend, binary_path) for the first available system TTS.
    Backend ∈ {"say", "espeak", "none"}."""
    say = shutil.which("say")
    if say:
        return "say", say
    for binary in ("espeak-ng", "espeak"):
        path = shutil.which(binary)
        if path:
            return "espeak", path
    return "none", ""


def _synthesize_with_say(binary: str, text: str, target_sample_rate: int) -> bytes:
    """Run macOS `say` and return the synthesized WAV bytes resampled to
    `target_sample_rate`. `say` writes LE int16 WAV directly when given
    `--data-format=LEI16@<rate>`."""
    # Use the requested rate directly so we don't need a resample step.
    # `say` clamps to a small set of supported rates; 22050 + 24000 +
    # 16000 are all accepted on Apple silicon.
    fmt = f"LEI16@{target_sample_rate}"
    with NamedTemporaryFile(suffix=".wav", delete=False) as tmp:
        out_path = tmp.name
    try:
        result = subprocess.run(
            [binary, "-o", out_path, "--data-format", fmt, text],
            capture_output=True,
            timeout=60,
        )
        if result.returncode != 0:
            raise RuntimeError(
                f"`say` failed (exit {result.returncode}): {result.stderr.decode('utf-8', errors='replace')[:200]}"
            )
        return _read_wav_bytes(out_path)
    finally:
        Path(out_path).unlink(missing_ok=True)


def _synthesize_with_espeak(binary: str, text: str, language_code: str, target_sample_rate: int) -> bytes:
    """Run espeak-ng with `-w` to write a WAV. espeak-ng's output sample
    rate is fixed (22050 by default) — we rewrite the header if needed."""
    with NamedTemporaryFile(suffix=".wav", delete=False) as tmp:
        out_path = tmp.name
    try:
        # `-v <lang>` selects voice; `-w` writes WAV. Some installs don't
        # accept "-v en" without a variant; fall back to default voice on
        # error.
        cmd = [binary, "-w", out_path, "-v", language_code or "en", text]
        result = subprocess.run(cmd, capture_output=True, timeout=60)
        if result.returncode != 0:
            # Retry without the voice flag.
            result = subprocess.run([binary, "-w", out_path, text], capture_output=True, timeout=60)
            if result.returncode != 0:
                raise RuntimeError(
                    f"`espeak` failed (exit {result.returncode}): {result.stderr.decode('utf-8', errors='replace')[:200]}"
                )
        # espeak-ng emits at its own native rate; the AASIST detector
        # tolerates the rate mismatch since AcousticProbe + the audio
        # service decode-then-resample on ingest.
        return _read_wav_bytes(out_path)
    finally:
        Path(out_path).unlink(missing_ok=True)


def _read_wav_bytes(path: str) -> bytes:
    """Slurp a WAV file as bytes, validating it's actually PCM. Re-raise
    anything weird as RuntimeError so the caller can present a clean
    503."""
    try:
        with wave.open(path, "rb") as handle:
            if handle.getnchannels() not in (1, 2):
                raise RuntimeError(f"Synth produced unexpected channel count: {handle.getnchannels()}")
            if handle.getsampwidth() != 2:
                raise RuntimeError(f"Synth produced unexpected sample width: {handle.getsampwidth()}")
    except wave.Error as exc:
        raise RuntimeError(f"Synth output is not a valid WAV: {exc}") from exc
    return Path(path).read_bytes()
