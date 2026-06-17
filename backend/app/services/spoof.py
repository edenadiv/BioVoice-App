"""Voice-cloning spoof generation — cloning-only engine strategy.

The DeepfakeLab synthesises an utterance in a *target's own voice* and
feeds it into the verification pipeline. Generic TTS (system voices,
cloud neural voices) was removed in v1.2 — it speaks in a stranger's
voice and never resembles the enrolled target, so it added nothing to a
detection/red-team workflow.

Every engine here is conditioned on a reference WAV of the target
(enrolled samples or an uploaded clip):

1. **F5-TTS** (id=`f5`) — flow-matching DiT zero-shot cloner. Faster +
   more natural than XTTS. Lives behind the `[spoof]` extra.
2. **Coqui XTTS-v2** (id=`xtts`) — autoregressive zero-shot cloner.
   Slower on CPU. Also behind the `[spoof]` extra.

Each engine exposes a stable id. The route layer surfaces the available
engines via `GET /spoof/engines` and accepts `engine` + a reference
(saved `reference_sample_id` or an uploaded WAV) on `POST /spoof`.
"""

from __future__ import annotations

import logging
import os
from contextlib import contextmanager
from dataclasses import dataclass, field
from pathlib import Path
from tempfile import TemporaryDirectory
from threading import Lock
from typing import Any, Protocol

from app.models import ReferenceSampleRecord
from app.schemas import ReferenceSampleResponse
from app.services.audio import AudioService

_LOG = logging.getLogger(__name__)


def _sanitize_speechbrain_lazy_modules() -> None:
    """Work around a speechbrain/torch interaction bug.

    speechbrain registers `LazyModule` proxies (for optional deps like
    k2, spacy, flair) in `sys.modules`. Importing `transformers` pulls in
    `torch._dynamo`, whose import chain calls `inspect.getmodule()` on
    every `sys.modules` entry -- which does `hasattr(module, "__file__")`.
    `LazyModule.__getattr__` raises `ImportError` for those missing deps,
    and `hasattr()` only suppresses `AttributeError`, so the ImportError
    propagates and crashes the unrelated `f5_tts`/`TTS` import. Replace
    any such proxies with inert empty modules first.
    """
    try:
        from speechbrain.utils.importutils import LazyModule
    except ImportError:
        return
    import sys
    import types

    for name, module in list(sys.modules.items()):
        if isinstance(module, LazyModule):
            sys.modules[name] = types.ModuleType(name)


_ffmpeg_dll_dir_registered = False


def _register_ffmpeg_shared_dll_dir() -> None:
    """Make FFmpeg's shared libraries discoverable by torchcodec.

    F5-TTS/XTTS load reference audio via `torchaudio.load`, which on
    recent torchaudio versions requires `torchcodec`. torchcodec loads
    its `libtorchcodec_core*.dll` via `ctypes.CDLL`, which on Python 3.8+
    does not search `PATH` for that DLL's own dependencies (FFmpeg's
    avutil/avcodec/etc DLLs) -- it needs `os.add_dll_directory`. Find the
    FFmpeg *shared* build's `bin` directory (the one shipping
    `avutil-*.dll`, not just `ffmpeg.exe`) on PATH and register it.
    """
    global _ffmpeg_dll_dir_registered
    if _ffmpeg_dll_dir_registered or not hasattr(os, "add_dll_directory"):
        return
    for directory in os.environ.get("PATH", "").split(os.pathsep):
        if not directory:
            continue
        d = Path(directory)
        try:
            if any(d.glob("avutil-*.dll")):
                os.add_dll_directory(str(d))
                _ffmpeg_dll_dir_registered = True
                return
        except OSError:
            continue


class ReferenceSampleStore(Protocol):
    def list_reference_samples(self, user_id: str) -> list[ReferenceSampleRecord]: ...

    def get_reference_sample(self, user_id: str, sample_id: str) -> ReferenceSampleRecord | None: ...


@dataclass(slots=True)
class SpoofGenerationResult:
    audio_bytes: bytes
    file_name: str
    source_description: str
    engine_id: str
    voice_id: str | None


@dataclass(frozen=True, slots=True)
class VoiceDescriptor:
    """One selectable voice within an engine. `id` is the stable handle
    the frontend sends back to /spoof; `label` is human-readable.

    Cloning engines don't have a canonical voice list — they condition on
    the target's reference WAV — so they expose a single `enrolled`
    pseudo-voice purely so the picker has something to show."""

    id: str
    label: str
    language: str | None = None


@dataclass(slots=True)
class EngineInfo:
    """Engine metadata surfaced by GET /spoof/engines."""

    id: str
    label: str
    description: str
    requires_network: bool
    available: bool
    voices: list[VoiceDescriptor] = field(default_factory=list)
    default_voice: str | None = None


# ---------------------------------------------------------------------------
# Engine Protocol + implementations
# ---------------------------------------------------------------------------


class CloningEngine(Protocol):
    """A voice-cloning TTS engine. Conditions synthesis on one or more
    reference WAVs of the target speaker."""

    id: str
    label: str
    description: str
    requires_network: bool

    def is_available(self) -> bool: ...

    def list_voices(self) -> list[VoiceDescriptor]: ...

    def default_voice(self) -> str | None: ...

    def synthesize_clone(
        self,
        text: str,
        reference_paths: list[str],
        language: str,
    ) -> tuple[list[float], int]:
        """Return (waveform, native_sample_rate). `reference_paths` are the
        target's reference WAVs; the engine clones that voice speaking
        `text`. The service resamples to its output rate if needed."""
        ...


# A single pseudo-voice all cloning engines expose so the picker isn't
# empty. The real "voice" is whichever reference WAV the caller supplies.
_ENROLLED_VOICE = VoiceDescriptor(
    id="enrolled",
    label="Target's enrolled / uploaded reference",
    language=None,
)


# ---- F5-TTS (flow-matching DiT, fast + natural) ---------------------------


class F5TtsEngine:
    id = "f5"
    label = "F5-TTS (voice cloning)"
    description = (
        "Flow-matching DiT zero-shot cloner — conditions on a reference WAV. "
        "Faster + more natural than XTTS. English. Optional `[spoof]` extra."
    )
    requires_network = False
    # F5-TTS's Vocos vocoder emits 24 kHz audio.
    NATIVE_SR = 24000

    def __init__(self, model_name: str = "F5TTS_v1_Base") -> None:
        self.model_name = model_name
        self._load_lock = Lock()
        self._model: Any | None = None
        self._pkg_ok: bool | None = None

    def _import(self):
        if self._pkg_ok is False:
            return None
        _sanitize_speechbrain_lazy_modules()
        _register_ffmpeg_shared_dll_dir()
        try:
            from f5_tts.api import F5TTS  # type: ignore
        except (ImportError, ModuleNotFoundError):
            self._pkg_ok = False
            return None
        self._pkg_ok = True
        return F5TTS

    def is_available(self) -> bool:
        # F5-TTS downloads its checkpoints from Hugging Face on first load,
        # so availability is purely "is the package importable?".
        return self._import() is not None

    def list_voices(self) -> list[VoiceDescriptor]:
        return [_ENROLLED_VOICE] if self.is_available() else []

    def default_voice(self) -> str | None:
        return _ENROLLED_VOICE.id if self.is_available() else None

    def ensure_loaded(self):
        if self._model is not None:
            return self._model
        with self._load_lock:
            if self._model is not None:
                return self._model
            f5_cls = self._import()
            if f5_cls is None:
                raise RuntimeError(
                    "f5-tts is not installed. Add `f5-tts` to the backend [spoof] extra."
                )
            # device=None lets F5TTS auto-pick cuda → mps → cpu.
            self._model = f5_cls(model=self.model_name)
            return self._model

    def synthesize_clone(self, text, reference_paths, language):
        model = self.ensure_loaded()
        # F5 conditions on a single reference clip; use the first
        # enrolled/uploaded sample. ref_text="" makes F5 auto-transcribe
        # the reference with Whisper so the caller needn't supply one —
        # that transcription step shells out to `ffmpeg` to load the clip.
        try:
            wav, sample_rate, _ = model.infer(
                ref_file=reference_paths[0],
                ref_text="",
                gen_text=text,
                remove_silence=False,
            )
        except ValueError as exc:
            if "ffmpeg" in str(exc).lower():
                raise RuntimeError(
                    "F5-TTS needs `ffmpeg` on PATH to auto-transcribe the reference "
                    "clip. Install it (`brew install ffmpeg` / `apt-get install ffmpeg`)."
                ) from exc
            raise
        return _coerce_waveform(wav), int(sample_rate)


# ---- XTTS-v2 (autoregressive zero-shot cloner) ----------------------------


class XttsEngine:
    id = "xtts"
    label = "Coqui XTTS-v2 (voice cloning)"
    description = (
        "Autoregressive zero-shot cloner — conditions on a reference WAV. "
        "Multilingual. Slower on CPU. Optional `[spoof]` extra."
    )
    requires_network = False
    # XTTS-v2's decoder emits 24 kHz audio.
    NATIVE_SR = 24000

    def __init__(self, model_path: Path) -> None:
        self.model_path = Path(model_path)
        self._load_lock = Lock()
        self._model: Any | None = None
        self._config: Any | None = None
        self._pkg_ok: bool | None = None

    def _import(self) -> bool:
        if self._pkg_ok is False:
            return False
        _sanitize_speechbrain_lazy_modules()
        _register_ffmpeg_shared_dll_dir()
        try:
            import TTS.tts.configs.xtts_config  # noqa: F401
            import TTS.tts.models.xtts  # noqa: F401
        except (ImportError, ModuleNotFoundError):
            self._pkg_ok = False
            return False
        self._pkg_ok = True
        return True

    def is_available(self) -> bool:
        if not self._import():
            return False
        return (self.model_path / "config.json").exists() and (self.model_path / "model.pth").exists()

    def list_voices(self) -> list[VoiceDescriptor]:
        return [_ENROLLED_VOICE] if self.is_available() else []

    def default_voice(self) -> str | None:
        return _ENROLLED_VOICE.id if self.is_available() else None

    def ensure_loaded(self):
        if self._model is not None and self._config is not None:
            return self._model, self._config
        with self._load_lock:
            if self._model is not None and self._config is not None:
                return self._model, self._config
            import torch
            from TTS.tts.configs.xtts_config import XttsConfig
            from TTS.tts.models.xtts import Xtts, XttsArgs, XttsAudioConfig
            from TTS.config.shared_configs import BaseDatasetConfig

            # torch>=2.6 flipped `torch.load(weights_only=...)` to True, which
            # rejects XTTS's pickled config classes. The Coqui checkpoint is a
            # trusted local file (pulled from the official HF repo by
            # scripts/setup_xtts.sh), so allowlist its globals.
            torch.serialization.add_safe_globals(
                [XttsConfig, XttsAudioConfig, XttsArgs, BaseDatasetConfig]
            )
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

    def synthesize_clone(self, text, reference_paths, language):
        model, config = self.ensure_loaded()
        output = model.synthesize(
            text,
            config,
            speaker_wav=reference_paths[0] if len(reference_paths) == 1 else reference_paths,
            gpt_cond_len=3,
            language=language,
        )
        wav = output.get("wav") if isinstance(output, dict) else output
        return _coerce_waveform(wav), self.NATIVE_SR


# ---------------------------------------------------------------------------
# SpoofGenerationService — engine registry + reference-sample plumbing
# ---------------------------------------------------------------------------


# Engines are returned to the picker in this order. The first available
# engine becomes the default when the operator doesn't pass `engine=`.
# F5 leads (best quality/speed); XTTS is the fallback default.
_DEFAULT_ENGINE_PRIORITY = ("f5", "xtts")


class SpoofGenerationService:
    def __init__(
        self,
        store: ReferenceSampleStore,
        model_path: Path,
        output_directory: Path,
        default_language: str,
        output_sample_rate: int,
        f5_model_name: str = "F5TTS_v1_Base",
    ):
        self.store = store
        self.model_path = Path(model_path)
        self.output_directory = Path(output_directory)
        self.output_directory.mkdir(parents=True, exist_ok=True)
        self.default_language = default_language
        self.output_sample_rate = output_sample_rate
        self.audio = AudioService()
        self._engines: dict[str, CloningEngine] = {
            "f5": F5TtsEngine(f5_model_name),
            "xtts": XttsEngine(model_path),
        }

    # -- introspection ------------------------------------------------------

    def list_engines(self) -> list[EngineInfo]:
        out: list[EngineInfo] = []
        for eid in _DEFAULT_ENGINE_PRIORITY:
            engine = self._engines[eid]
            available = engine.is_available()
            out.append(
                EngineInfo(
                    id=engine.id,
                    label=engine.label,
                    description=engine.description,
                    requires_network=engine.requires_network,
                    available=available,
                    voices=engine.list_voices() if available else [],
                    default_voice=engine.default_voice() if available else None,
                )
            )
        return out

    def default_engine_id(self) -> str | None:
        for eid in _DEFAULT_ENGINE_PRIORITY:
            if self._engines[eid].is_available():
                return eid
        return None

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

    # -- public synth entry point ------------------------------------------

    def generate(
        self,
        user_id: str,
        text: str,
        language: str | None = None,
        engine: str | None = None,
        voice: str | None = None,
        reference_sample_id: str | None = None,
        reference_audio_bytes: bytes | None = None,
        reference_filename: str | None = None,
    ) -> SpoofGenerationResult:
        message_text = text.strip()
        if not message_text:
            raise ValueError("Text is required to generate a spoof sample")
        language_code = (language or self.default_language).strip().lower()

        chosen_id = engine or self.default_engine_id()
        if chosen_id is None:
            raise RuntimeError(
                "No voice-cloning engine is available. Install F5-TTS or XTTS-v2 "
                "on the backend (`pip install -e '.[model,spoof]'`; for XTTS also "
                "run `bash backend/scripts/setup_xtts.sh`)."
            )
        if chosen_id not in self._engines:
            raise ValueError(
                f"Unknown cloning engine '{chosen_id}'. Available: {sorted(self._engines)}"
            )
        chosen = self._engines[chosen_id]
        if not chosen.is_available():
            raise RuntimeError(
                f"Cloning engine '{chosen_id}' isn't available on this host. "
                f"Try one of: {[e.id for e in self.list_engines() if e.available]}"
            )

        with self._reference_context(
            user_id=user_id,
            reference_sample_id=reference_sample_id,
            reference_audio_bytes=reference_audio_bytes,
            reference_filename=reference_filename,
        ) as (reference_paths, source_description):
            waveform, native_sr = chosen.synthesize_clone(
                text=message_text,
                reference_paths=reference_paths,
                language=language_code,
            )

        if native_sr != self.output_sample_rate:
            waveform = _resample_linear(waveform, native_sr, self.output_sample_rate)
        audio_bytes = self.audio.encode_wav(waveform, sample_rate=self.output_sample_rate)
        return self._persist(
            user_id=user_id,
            audio_bytes=audio_bytes,
            engine_id=chosen.id,
            voice_id=chosen.default_voice(),
            source_description=f"{chosen.label} | {source_description}",
        )

    # -- helpers -----------------------------------------------------------

    def _persist(
        self,
        user_id: str,
        audio_bytes: bytes,
        engine_id: str,
        voice_id: str | None,
        source_description: str,
    ) -> SpoofGenerationResult:
        safe_user_id = "".join(
            character if character.isalnum() or character in {"-", "_"} else "_"
            for character in user_id
        )
        file_name = f"{safe_user_id}-{engine_id}-spoof.wav"
        (self.output_directory / file_name).write_bytes(audio_bytes)
        return SpoofGenerationResult(
            audio_bytes=audio_bytes,
            file_name=file_name,
            source_description=source_description,
            engine_id=engine_id,
            voice_id=voice_id,
        )

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


# ---------------------------------------------------------------------------
# Module helpers
# ---------------------------------------------------------------------------


def _coerce_waveform(waveform: Any) -> list[float]:
    """Flatten a torch tensor / numpy array / nested list into a flat
    list of float samples."""
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


def _resample_linear(waveform: list[float], source_rate: int, target_rate: int) -> list[float]:
    """Simple linear resample. Good enough for the kiosk's spoof-test
    workflow — AASIST + the audio service tolerate mild artefacts."""
    if source_rate == target_rate or not waveform:
        return waveform
    import numpy as np

    samples = np.asarray(waveform, dtype="float32")
    n_out = int(round(len(samples) * target_rate / source_rate))
    if n_out <= 0:
        return []
    x_out = np.linspace(0, len(samples) - 1, n_out)
    resampled = np.interp(x_out, np.arange(len(samples)), samples)
    return resampled.astype("float32").tolist()
