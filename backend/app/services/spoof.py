"""Spoof sample generation — multi-engine strategy pattern.

The DeepfakeLab synthesises an utterance from text and feeds it into
the verification pipeline. v1.1.1 ships five interchangeable engines:

1. **macOS `say`** (id=`say`) — native system TTS. Instant; tens of
   voices including premium neural ones. Mac-only.
2. **espeak / espeak-ng** (id=`espeak`) — robotic formant TTS for Linux.
3. **Microsoft Edge TTS** (id=`edge`) — neural cloud TTS via the
   public Edge endpoint. Free, no API key. ~400 voices. Requires net.
4. **Google Translate TTS** (id=`gtts`) — simple cloud fallback.
   Language-based. Requires net.
5. **XTTS-v2** (id=`xtts`) — voice cloning; conditions on a reference
   WAV. Slow on CPU. Lives behind the `[spoof]` extra.

Each engine exposes a stable id + a list of "voices" it can speak as.
The route layer surfaces the available engines via `GET /spoof/engines`
and accepts `engine` + `voice` form fields on `POST /spoof`.
"""

from __future__ import annotations

import asyncio
import io
import logging
import re
import shutil
import subprocess
import wave
from concurrent.futures import ThreadPoolExecutor
from contextlib import contextmanager
from dataclasses import dataclass, field
from pathlib import Path
from tempfile import NamedTemporaryFile, TemporaryDirectory
from threading import Lock
from typing import Any, Iterable, Protocol

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
    engine_id: str
    voice_id: str | None


@dataclass(frozen=True, slots=True)
class VoiceDescriptor:
    """One selectable voice within an engine. `id` is the stable handle
    the frontend sends back to /spoof; `label` is human-readable."""

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


class TtsEngine(Protocol):
    id: str
    label: str
    description: str
    requires_network: bool

    def is_available(self) -> bool: ...

    def list_voices(self) -> list[VoiceDescriptor]: ...

    def default_voice(self) -> str | None: ...

    def synthesize(
        self,
        text: str,
        voice_id: str | None,
        language: str,
        target_sample_rate: int,
    ) -> bytes: ...


# ---- macOS `say` -----------------------------------------------------------


class SayEngine:
    id = "say"
    label = "macOS / say"
    description = "Native system TTS. Instant. Tens of voices including premium neural ones."
    requires_network = False

    _BUILTIN_DEFAULT = "Samantha"

    def __init__(self) -> None:
        self._voices_cache: list[VoiceDescriptor] | None = None

    def is_available(self) -> bool:
        return shutil.which("say") is not None

    def list_voices(self) -> list[VoiceDescriptor]:
        if not self.is_available():
            return []
        if self._voices_cache is not None:
            return self._voices_cache
        try:
            proc = subprocess.run(["say", "-v", "?"], capture_output=True, timeout=10)
        except (subprocess.TimeoutExpired, OSError):
            self._voices_cache = []
            return self._voices_cache
        voices: list[VoiceDescriptor] = []
        # `say -v ?` lines look like: "Alex                en_US    # Most…"
        for line in proc.stdout.decode("utf-8", errors="replace").splitlines():
            m = re.match(r"^([A-Za-z0-9 .'()\-]+?)\s{2,}([a-z]{2}_[A-Z]{2})\b", line)
            if not m:
                continue
            voice_id = m.group(1).strip()
            lang = m.group(2)
            voices.append(VoiceDescriptor(id=voice_id, label=voice_id, language=lang))
        voices.sort(key=lambda v: v.id.lower())
        self._voices_cache = voices
        return voices

    def default_voice(self) -> str | None:
        voices = {v.id for v in self.list_voices()}
        return self._BUILTIN_DEFAULT if self._BUILTIN_DEFAULT in voices else (sorted(voices)[0] if voices else None)

    def synthesize(self, text, voice_id, language, target_sample_rate):
        binary = shutil.which("say")
        if not binary:
            raise RuntimeError("`say` binary not found on PATH.")
        fmt = f"LEI16@{target_sample_rate}"
        cmd = [binary, "-o", "__OUT__", "--data-format", fmt]
        if voice_id:
            cmd.extend(["-v", voice_id])
        cmd.append(text)
        with NamedTemporaryFile(suffix=".wav", delete=False) as tmp:
            out_path = tmp.name
        cmd[cmd.index("__OUT__")] = out_path
        try:
            result = subprocess.run(cmd, capture_output=True, timeout=60)
            if result.returncode != 0:
                raise RuntimeError(
                    f"`say` failed (exit {result.returncode}): {result.stderr.decode('utf-8', errors='replace')[:200]}"
                )
            return _read_wav_bytes(out_path)
        finally:
            Path(out_path).unlink(missing_ok=True)


# ---- espeak-ng (Linux fallback) -------------------------------------------


class EspeakEngine:
    id = "espeak"
    label = "espeak-ng"
    description = "Classic formant TTS — extremely fast, robotic. Good for adversarial smoke tests."
    requires_network = False

    # U1 — full voice catalogue is enumerated at runtime via
    # `espeak-ng --voices`. The hand-coded fallback below kicks in only
    # when parsing fails (very old espeak builds).
    _FALLBACK_LANGS = [
        ("en", "English"),
        ("es", "Spanish"),
        ("fr", "French"),
        ("de", "German"),
        ("it", "Italian"),
    ]

    def __init__(self) -> None:
        self._voices_cache: list[VoiceDescriptor] | None = None

    def is_available(self) -> bool:
        return any(shutil.which(b) for b in ("espeak-ng", "espeak"))

    def list_voices(self) -> list[VoiceDescriptor]:
        if not self.is_available():
            return []
        if self._voices_cache is not None:
            return self._voices_cache
        binary = shutil.which("espeak-ng") or shutil.which("espeak")
        voices: list[VoiceDescriptor] = []
        try:
            proc = subprocess.run([binary, "--voices"], capture_output=True, timeout=10)
            for line in proc.stdout.decode("utf-8", errors="replace").splitlines()[1:]:
                # Columns: Pty Language Age/Gender VoiceName File Other
                parts = line.split()
                if len(parts) < 5:
                    continue
                lang = parts[1]
                name = parts[3]
                if not lang or not name or name.lower() in {"variant", "mb"}:
                    continue
                voices.append(VoiceDescriptor(id=lang, label=f"{name} ({lang})", language=lang))
        except (subprocess.TimeoutExpired, OSError, IndexError):
            voices = []
        if not voices:
            voices = [VoiceDescriptor(id=code, label=label, language=code) for code, label in self._FALLBACK_LANGS]
        # Dedupe by id, keeping first occurrence (espeak lists variants
        # under the same language code).
        seen: set[str] = set()
        unique: list[VoiceDescriptor] = []
        for v in voices:
            if v.id in seen:
                continue
            seen.add(v.id)
            unique.append(v)
        unique.sort(key=lambda v: v.id)
        self._voices_cache = unique
        return unique

    def default_voice(self) -> str | None:
        return "en" if self.is_available() else None

    def synthesize(self, text, voice_id, language, target_sample_rate):
        binary = shutil.which("espeak-ng") or shutil.which("espeak")
        if not binary:
            raise RuntimeError("espeak-ng binary not found on PATH.")
        lang = voice_id or language or "en"
        with NamedTemporaryFile(suffix=".wav", delete=False) as tmp:
            out_path = tmp.name
        try:
            result = subprocess.run(
                [binary, "-w", out_path, "-v", lang, text],
                capture_output=True, timeout=60,
            )
            if result.returncode != 0:
                # Retry without -v in case the language flag is rejected.
                result = subprocess.run([binary, "-w", out_path, text], capture_output=True, timeout=60)
                if result.returncode != 0:
                    raise RuntimeError(
                        f"espeak failed (exit {result.returncode}): {result.stderr.decode('utf-8', errors='replace')[:200]}"
                    )
            return _read_wav_bytes(out_path)
        finally:
            Path(out_path).unlink(missing_ok=True)


# ---- Microsoft Edge TTS (free cloud) --------------------------------------


class EdgeTtsEngine:
    id = "edge"
    label = "Microsoft Edge TTS"
    description = "Neural cloud TTS, free, ~400 voices across 90+ locales. Fast (~1 s latency). Requires internet."
    requires_network = True

    # U1 — the full catalogue is fetched once from Microsoft's endpoint
    # at first use of /spoof/engines and cached for the process lifetime.
    # If the fetch fails (offline), we fall back to a curated minimum so
    # the picker isn't empty.
    _FALLBACK_VOICES = [
        VoiceDescriptor("en-US-AriaNeural",     "Aria (US, female)",        "en-US"),
        VoiceDescriptor("en-US-GuyNeural",      "Guy (US, male)",           "en-US"),
        VoiceDescriptor("en-GB-RyanNeural",     "Ryan (UK, male)",          "en-GB"),
        VoiceDescriptor("he-IL-AvriNeural",     "Avri (IL, male)",          "he-IL"),
        VoiceDescriptor("he-IL-HilaNeural",     "Hila (IL, female)",        "he-IL"),
    ]

    def __init__(self) -> None:
        self._pkg_ok: bool | None = None
        self._voices_cache: list[VoiceDescriptor] | None = None
        self._voices_lock = Lock()

    def _import(self):
        if self._pkg_ok is False:
            return None
        try:
            import edge_tts  # type: ignore
        except ImportError:
            self._pkg_ok = False
            return None
        self._pkg_ok = True
        return edge_tts

    def is_available(self) -> bool:
        return self._import() is not None

    def list_voices(self) -> list[VoiceDescriptor]:
        if not self.is_available():
            return []
        if self._voices_cache is not None:
            return self._voices_cache
        with self._voices_lock:
            if self._voices_cache is not None:
                return self._voices_cache
            edge_tts = self._import()
            assert edge_tts is not None
            # `edge_tts.list_voices()` is async + hits Microsoft's
            # catalogue endpoint. Run in a worker thread so we don't
            # nest into FastAPI's loop.
            async def _fetch():
                return await edge_tts.list_voices()
            try:
                with ThreadPoolExecutor(max_workers=1) as ex:
                    raw = ex.submit(lambda: asyncio.run(_fetch())).result(timeout=15)
            except Exception:
                self._voices_cache = list(self._FALLBACK_VOICES)
                return self._voices_cache
            voices: list[VoiceDescriptor] = []
            for entry in raw:
                short = entry.get("ShortName") or entry.get("Name")
                if not short:
                    continue
                locale = entry.get("Locale") or short.rsplit("-", 1)[0]
                gender = entry.get("Gender", "")
                friendly = entry.get("FriendlyName", "")
                # Extract just the first-name token from the FriendlyName
                # ("Microsoft Aria Online (Natural) - English (United States)").
                m = re.match(r"Microsoft\s+(\S+)", friendly or "")
                first_name = m.group(1) if m else short.split("-")[-1].replace("Neural", "")
                gender_short = "F" if gender.lower().startswith("f") else ("M" if gender.lower().startswith("m") else "?")
                voices.append(VoiceDescriptor(
                    id=short,
                    label=f"{first_name} ({locale}, {gender_short})",
                    language=locale,
                ))
            voices.sort(key=lambda v: ((v.language or ""), v.label))
            self._voices_cache = voices or list(self._FALLBACK_VOICES)
            return self._voices_cache

    def default_voice(self) -> str | None:
        return "en-US-AriaNeural" if self.is_available() else None

    def synthesize(self, text, voice_id, language, target_sample_rate):
        edge_tts = self._import()
        if edge_tts is None:
            raise RuntimeError("edge-tts is not installed. Add `edge-tts` to the backend [model] extra.")
        voice = voice_id or self.default_voice() or "en-US-AriaNeural"

        # edge-tts returns MP3 audio chunks; we collect them then decode
        # to PCM WAV via the AudioService so the rest of the pipeline
        # sees a uniform WAV regardless of engine.
        async def _collect() -> bytes:
            communicate = edge_tts.Communicate(text, voice)
            buf = io.BytesIO()
            async for chunk in communicate.stream():
                if chunk["type"] == "audio":
                    buf.write(chunk["data"])
            return buf.getvalue()

        # `service.generate()` is called from a sync code path inside an
        # async FastAPI route, so an event loop is already running on
        # this thread. `asyncio.run()` refuses to nest. Spin up a tiny
        # worker thread that owns its own loop and block on its result.
        with ThreadPoolExecutor(max_workers=1) as executor:
            future = executor.submit(lambda: asyncio.run(_collect()))
            mp3_bytes = future.result(timeout=30)
        if not mp3_bytes:
            raise RuntimeError("Edge TTS returned no audio (network failure?).")
        return _transcode_mp3_to_wav(mp3_bytes, target_sample_rate)


# ---- Google Translate TTS -------------------------------------------------


class GttsEngine:
    id = "gtts"
    label = "Google Translate TTS"
    description = "Free cloud TTS, simple language-based picker. Requires internet."
    requires_network = True

    # English-only accent variants we promote even though gTTS exposes
    # them via the `tld` parameter rather than as separate "languages".
    _EN_ACCENTS = [
        ("en-uk", "English (UK accent)"),
        ("en-au", "English (Australian accent)"),
        ("en-in", "English (Indian accent)"),
        ("en-ca", "English (Canadian accent)"),
        ("en-ie", "English (Irish accent)"),
        ("en-za", "English (South African accent)"),
    ]

    def __init__(self) -> None:
        self._pkg_ok: bool | None = None
        self._voices_cache: list[VoiceDescriptor] | None = None

    def _import(self):
        if self._pkg_ok is False:
            return None
        try:
            from gtts import gTTS  # type: ignore  # noqa: F401
        except ImportError:
            self._pkg_ok = False
            return None
        self._pkg_ok = True
        from gtts import gTTS as gTtsClass  # noqa: N813
        return gTtsClass

    def is_available(self) -> bool:
        return self._import() is not None

    def list_voices(self) -> list[VoiceDescriptor]:
        if not self.is_available():
            return []
        if self._voices_cache is not None:
            return self._voices_cache
        # U1 — full catalogue via gTTS's own language registry.
        try:
            from gtts.lang import tts_langs  # type: ignore
            langs = tts_langs()
        except Exception:
            langs = {"en": "English"}
        voices: list[VoiceDescriptor] = [
            VoiceDescriptor(id=code, label=label, language=code)
            for code, label in sorted(langs.items())
        ]
        # Bolt on the en-* accent aliases we resolve via gTTS's `tld`
        # parameter in synthesize().
        for code, label in self._EN_ACCENTS:
            voices.append(VoiceDescriptor(id=code, label=label, language="en"))
        voices.sort(key=lambda v: (v.id != "en", v.id))
        self._voices_cache = voices
        return voices

    def default_voice(self) -> str | None:
        return "en" if self.is_available() else None

    def synthesize(self, text, voice_id, language, target_sample_rate):
        gTtsClass = self._import()
        if gTtsClass is None:
            raise RuntimeError("gTTS is not installed. Add `gTTS` to the backend [model] extra.")
        lang = voice_id or language or "en"
        # gTTS accepts an optional `tld` for accent control on English.
        # We split codes like "en-uk" into ("en", "co.uk") to opt into
        # the UK English voice without flooding the language picker.
        tld = "com"
        base_lang = lang
        if "-" in lang:
            head, region = lang.split("-", 1)
            region = region.lower()
            if head == "en":
                tld = {
                    "uk": "co.uk", "au": "com.au", "in": "co.in",
                    "ca": "ca", "ie": "ie", "za": "co.za",
                }.get(region, "com")
                base_lang = "en"
            else:
                base_lang = head
        try:
            tts = gTtsClass(text=text, lang=base_lang, tld=tld)
            buf = io.BytesIO()
            tts.write_to_fp(buf)
        except Exception as exc:
            raise RuntimeError(f"gTTS failed: {exc}") from exc
        return _transcode_mp3_to_wav(buf.getvalue(), target_sample_rate)


# ---- XTTS-v2 (voice cloning, slow) ----------------------------------------


class XttsEngine:
    id = "xtts"
    label = "Coqui XTTS-v2 (voice cloning)"
    description = "Conditions on a reference WAV — clones the target's voice. Slow on CPU. Optional `[spoof]` extra."
    requires_network = False

    def __init__(self, model_path: Path) -> None:
        self.model_path = Path(model_path)
        self._load_lock = Lock()
        self._model: Any | None = None
        self._config: Any | None = None
        self._pkg_ok: bool | None = None

    def _import(self):
        if self._pkg_ok is False:
            return False
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
        # XTTS is conditioned on a reference WAV per-call, not a
        # canonical voice list. The frontend should use a reference-
        # sample picker in tandem with this engine.
        return [] if not self.is_available() else [
            VoiceDescriptor(id="enrolled", label="Selected operator's enrolled samples", language=None),
        ]

    def default_voice(self) -> str | None:
        return "enrolled" if self.is_available() else None

    def synthesize(self, text, voice_id, language, target_sample_rate):
        # The reference-WAV plumbing lives in SpoofGenerationService
        # because it needs access to the store. The engine itself is
        # called from `generate()` after the reference context is opened.
        # `synthesize()` here is intentionally NOT used for XTTS; the
        # service detects engine == "xtts" and routes through
        # `_generate_with_xtts`. We keep this method on the protocol so
        # the type checker is happy.
        raise RuntimeError("XTTS engine is invoked via SpoofGenerationService._generate_with_xtts().")

    def ensure_loaded(self):
        if self._model is not None and self._config is not None:
            return self._model, self._config
        with self._load_lock:
            if self._model is not None and self._config is not None:
                return self._model, self._config
            import torch
            from TTS.tts.configs.xtts_config import XttsConfig
            from TTS.tts.models.xtts import Xtts
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


# ---------------------------------------------------------------------------
# SpoofGenerationService — engine registry + reference-sample plumbing
# ---------------------------------------------------------------------------


# Engines are returned to the picker in this order. The first available
# engine becomes the default when the operator doesn't pass `engine=`.
_DEFAULT_ENGINE_PRIORITY = ("say", "edge", "gtts", "espeak", "xtts")


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
        self._engines: dict[str, TtsEngine] = {
            "say": SayEngine(),
            "espeak": EspeakEngine(),
            "edge": EdgeTtsEngine(),
            "gtts": GttsEngine(),
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
                "No TTS engine is available. Install macOS `say` / `espeak-ng`, "
                "or ensure edge-tts + gTTS are reachable on the network."
            )
        if chosen_id not in self._engines:
            raise ValueError(f"Unknown TTS engine '{chosen_id}'. Available: {sorted(self._engines)}")
        chosen = self._engines[chosen_id]
        if not chosen.is_available():
            raise RuntimeError(
                f"TTS engine '{chosen_id}' isn't available on this host. "
                f"Try one of: {[e.id for e in self.list_engines() if e.available]}"
            )

        # XTTS is the only engine that needs the reference-WAV plumbing.
        # All other engines speak as their own neural/system voices.
        if chosen_id == "xtts":
            return self._generate_with_xtts(
                user_id=user_id,
                text=message_text,
                language_code=language_code,
                reference_sample_id=reference_sample_id,
                reference_audio_bytes=reference_audio_bytes,
                reference_filename=reference_filename,
            )

        audio_bytes = chosen.synthesize(
            text=message_text,
            voice_id=voice,
            language=language_code,
            target_sample_rate=self.output_sample_rate,
        )
        return self._persist(
            user_id=user_id,
            audio_bytes=audio_bytes,
            engine_id=chosen.id,
            voice_id=voice or chosen.default_voice(),
            source_description=f"{chosen.label} | {voice or chosen.default_voice() or 'default voice'}",
        )

    # -- XTTS path (kept compatible with the prior contract) ---------------

    def _generate_with_xtts(
        self,
        user_id: str,
        text: str,
        language_code: str,
        reference_sample_id: str | None,
        reference_audio_bytes: bytes | None,
        reference_filename: str | None,
    ) -> SpoofGenerationResult:
        engine = self._engines["xtts"]
        assert isinstance(engine, XttsEngine)
        with self._reference_context(
            user_id=user_id,
            reference_sample_id=reference_sample_id,
            reference_audio_bytes=reference_audio_bytes,
            reference_filename=reference_filename,
        ) as (reference_paths, source_description):
            model, config = engine.ensure_loaded()
            output = model.synthesize(
                text,
                config,
                speaker_wav=reference_paths[0] if len(reference_paths) == 1 else reference_paths,
                gpt_cond_len=3,
                language=language_code,
            )
        waveform = self._coerce_waveform(output.get("wav") if isinstance(output, dict) else output)
        audio_bytes = self.audio.encode_wav(waveform, sample_rate=self.output_sample_rate)
        return self._persist(
            user_id=user_id,
            audio_bytes=audio_bytes,
            engine_id="xtts",
            voice_id="enrolled",
            source_description=f"XTTS-v2 | {source_description}",
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
# Module helpers
# ---------------------------------------------------------------------------


def _transcode_mp3_to_wav(mp3_bytes: bytes, target_sample_rate: int) -> bytes:
    """Convert an MP3 buffer (from edge-tts or gTTS) into a PCM WAV at
    the requested sample rate. Uses torchaudio if available (already a
    backend dependency); falls back to ffmpeg on PATH."""
    try:
        return _transcode_with_soundfile(mp3_bytes, target_sample_rate)
    except Exception:
        pass
    return _transcode_with_ffmpeg(mp3_bytes, target_sample_rate)


def _transcode_with_soundfile(mp3_bytes: bytes, target_sample_rate: int) -> bytes:
    import io as _io
    import soundfile as sf  # bundled via the [bench] extra; also pulled in by torchaudio
    import numpy as np

    samples, source_rate = sf.read(_io.BytesIO(mp3_bytes), dtype="float32", always_2d=False)
    if samples.ndim > 1:
        samples = samples.mean(axis=1)
    if source_rate != target_sample_rate:
        # Simple linear resample — good enough for the kiosk's spoof-test
        # workflow; AASIST + the audio service tolerate mild artefacts.
        ratio = target_sample_rate / source_rate
        n_out = int(round(len(samples) * ratio))
        x_out = np.linspace(0, len(samples) - 1, n_out)
        samples = np.interp(x_out, np.arange(len(samples)), samples).astype("float32")
    return _encode_int16_wav(samples.tolist(), target_sample_rate)


def _transcode_with_ffmpeg(mp3_bytes: bytes, target_sample_rate: int) -> bytes:
    binary = shutil.which("ffmpeg")
    if not binary:
        raise RuntimeError(
            "Cannot decode MP3 audio — install `soundfile` (already in [bench]) or `ffmpeg` on the host."
        )
    with NamedTemporaryFile(suffix=".mp3", delete=False) as inp:
        inp.write(mp3_bytes)
        in_path = inp.name
    with NamedTemporaryFile(suffix=".wav", delete=False) as outp:
        out_path = outp.name
    try:
        result = subprocess.run(
            [binary, "-y", "-i", in_path, "-ar", str(target_sample_rate), "-ac", "1", out_path],
            capture_output=True, timeout=60,
        )
        if result.returncode != 0:
            raise RuntimeError(
                f"ffmpeg transcode failed (exit {result.returncode}): "
                f"{result.stderr.decode('utf-8', errors='replace')[:200]}"
            )
        return _read_wav_bytes(out_path)
    finally:
        Path(in_path).unlink(missing_ok=True)
        Path(out_path).unlink(missing_ok=True)


def _encode_int16_wav(samples: Iterable[float], sample_rate: int) -> bytes:
    """Encode a float waveform [-1, 1] as 16-bit PCM mono WAV bytes."""
    buf = io.BytesIO()
    with wave.open(buf, "wb") as handle:
        handle.setnchannels(1)
        handle.setsampwidth(2)
        handle.setframerate(sample_rate)
        chunks = bytearray()
        for sample in samples:
            v = max(-1.0, min(1.0, float(sample)))
            chunks += int(v * 32767).to_bytes(2, "little", signed=True)
        handle.writeframes(bytes(chunks))
    return buf.getvalue()


def _read_wav_bytes(path: str) -> bytes:
    """Slurp a WAV file as bytes, validating it's actually PCM."""
    try:
        with wave.open(path, "rb") as handle:
            if handle.getnchannels() not in (1, 2):
                raise RuntimeError(f"Synth produced unexpected channel count: {handle.getnchannels()}")
            if handle.getsampwidth() != 2:
                raise RuntimeError(f"Synth produced unexpected sample width: {handle.getsampwidth()}")
    except wave.Error as exc:
        raise RuntimeError(f"Synth output is not a valid WAV: {exc}") from exc
    return Path(path).read_bytes()
