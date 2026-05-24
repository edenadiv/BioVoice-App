"""Spoof sample generation via pluggable TTS, cloning, and VC engines."""

from __future__ import annotations

import asyncio
import io
import json
import os
import re
import shutil
import subprocess
import sys
import urllib.error
import urllib.request
import wave
from concurrent.futures import ThreadPoolExecutor
from contextlib import contextmanager
from dataclasses import dataclass, field
from pathlib import Path
from tempfile import NamedTemporaryFile, TemporaryDirectory
from threading import Lock
from typing import Any, Iterable, Literal, Protocol

from app.models import ReferenceSampleRecord
from app.schemas import ReferenceSampleResponse
from app.services.audio import AudioService

EngineKind = Literal["tts", "voice_clone", "voice_conversion"]


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
    id: str
    label: str
    language: str | None = None


@dataclass(slots=True)
class EngineInfo:
    id: str
    label: str
    description: str
    requires_network: bool
    available: bool
    kind: EngineKind
    text_required: bool
    source_audio_required: bool
    reference_audio_required: bool
    supports_reference_sample: bool
    voices: list[VoiceDescriptor] = field(default_factory=list)
    default_voice: str | None = None


@dataclass(frozen=True, slots=True)
class ImportedVoiceModel:
    engine: Literal["rvc", "applio"]
    model_id: str
    label: str
    language: str | None
    model_path: Path
    model_filename: str
    index_path: Path | None = None
    index_filename: str | None = None
    ready: bool = True


class SpoofEngine(Protocol):
    id: str
    label: str
    description: str
    requires_network: bool
    kind: EngineKind
    text_required: bool
    source_audio_required: bool
    reference_audio_required: bool
    supports_reference_sample: bool

    def is_available(self) -> bool: ...

    def list_voices(self) -> list[VoiceDescriptor]: ...

    def default_voice(self) -> str | None: ...


class TtsEngine(SpoofEngine, Protocol):
    def synthesize(
        self,
        text: str,
        voice_id: str | None,
        language: str,
        target_sample_rate: int,
    ) -> bytes: ...


class VoiceCloneEngine(SpoofEngine, Protocol):
    def clone(
        self,
        text: str,
        voice_id: str | None,
        language: str,
        reference_paths: list[str],
        target_sample_rate: int,
    ) -> bytes: ...


class VoiceConversionEngine(SpoofEngine, Protocol):
    def convert(
        self,
        source_audio_bytes: bytes,
        voice_id: str | None,
        reference_paths: list[str],
        target_sample_rate: int,
    ) -> bytes: ...


class SayEngine:
    id = "say"
    label = "macOS / say"
    description = "Native system TTS. Instant. Tens of voices including premium neural ones."
    requires_network = False
    kind: EngineKind = "tts"
    text_required = True
    source_audio_required = False
    reference_audio_required = False
    supports_reference_sample = False

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
        for line in proc.stdout.decode("utf-8", errors="replace").splitlines():
            m = re.match(r"^([A-Za-z0-9 .'()\-]+?)\s{2,}([a-z]{2}_[A-Z]{2})\b", line)
            if not m:
                continue
            voices.append(VoiceDescriptor(id=m.group(1).strip(), label=m.group(1).strip(), language=m.group(2)))
        voices.sort(key=lambda v: v.id.lower())
        self._voices_cache = voices
        return voices

    def default_voice(self) -> str | None:
        voices = {v.id for v in self.list_voices()}
        return self._BUILTIN_DEFAULT if self._BUILTIN_DEFAULT in voices else (sorted(voices)[0] if voices else None)

    def synthesize(self, text: str, voice_id: str | None, language: str, target_sample_rate: int) -> bytes:
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


class EspeakEngine:
    id = "espeak"
    label = "espeak-ng"
    description = "Classic formant TTS - extremely fast, robotic. Good for adversarial smoke tests."
    requires_network = False
    kind: EngineKind = "tts"
    text_required = True
    source_audio_required = False
    reference_audio_required = False
    supports_reference_sample = False

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
        seen: set[str] = set()
        unique: list[VoiceDescriptor] = []
        for voice in voices:
            if voice.id in seen:
                continue
            seen.add(voice.id)
            unique.append(voice)
        unique.sort(key=lambda v: v.id)
        self._voices_cache = unique
        return unique

    def default_voice(self) -> str | None:
        return "en" if self.is_available() else None

    def synthesize(self, text: str, voice_id: str | None, language: str, target_sample_rate: int) -> bytes:
        binary = shutil.which("espeak-ng") or shutil.which("espeak")
        if not binary:
            raise RuntimeError("espeak-ng binary not found on PATH.")
        lang = voice_id or language or "en"
        with NamedTemporaryFile(suffix=".wav", delete=False) as tmp:
            out_path = tmp.name
        try:
            result = subprocess.run([binary, "-w", out_path, "-v", lang, text], capture_output=True, timeout=60)
            if result.returncode != 0:
                result = subprocess.run([binary, "-w", out_path, text], capture_output=True, timeout=60)
                if result.returncode != 0:
                    raise RuntimeError(
                        f"espeak failed (exit {result.returncode}): {result.stderr.decode('utf-8', errors='replace')[:200]}"
                    )
            return _read_wav_bytes(out_path)
        finally:
            Path(out_path).unlink(missing_ok=True)


class EdgeTtsEngine:
    id = "edge"
    label = "Microsoft Edge TTS"
    description = "Neural cloud TTS, free, ~400 voices across 90+ locales. Fast (~1 s latency). Requires internet."
    requires_network = True
    kind: EngineKind = "tts"
    text_required = True
    source_audio_required = False
    reference_audio_required = False
    supports_reference_sample = False

    _FALLBACK_VOICES = [
        VoiceDescriptor("en-US-AriaNeural", "Aria (US, female)", "en-US"),
        VoiceDescriptor("en-US-GuyNeural", "Guy (US, male)", "en-US"),
        VoiceDescriptor("en-GB-RyanNeural", "Ryan (UK, male)", "en-GB"),
        VoiceDescriptor("he-IL-AvriNeural", "Avri (IL, male)", "he-IL"),
        VoiceDescriptor("he-IL-HilaNeural", "Hila (IL, female)", "he-IL"),
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
                match = re.match(r"Microsoft\s+(\S+)", friendly or "")
                first_name = match.group(1) if match else short.split("-")[-1].replace("Neural", "")
                gender_short = "F" if gender.lower().startswith("f") else ("M" if gender.lower().startswith("m") else "?")
                voices.append(VoiceDescriptor(id=short, label=f"{first_name} ({locale}, {gender_short})", language=locale))
            voices.sort(key=lambda v: ((v.language or ""), v.label))
            self._voices_cache = voices or list(self._FALLBACK_VOICES)
            return self._voices_cache

    def default_voice(self) -> str | None:
        return "en-US-AriaNeural" if self.is_available() else None

    def synthesize(self, text: str, voice_id: str | None, language: str, target_sample_rate: int) -> bytes:
        edge_tts = self._import()
        if edge_tts is None:
            raise RuntimeError("edge-tts is not installed. Add `edge-tts` to the backend [model] extra.")
        voice = voice_id or self.default_voice() or "en-US-AriaNeural"

        async def _collect() -> bytes:
            communicate = edge_tts.Communicate(text, voice)
            buf = io.BytesIO()
            async for chunk in communicate.stream():
                if chunk["type"] == "audio":
                    buf.write(chunk["data"])
            return buf.getvalue()

        with ThreadPoolExecutor(max_workers=1) as executor:
            future = executor.submit(lambda: asyncio.run(_collect()))
            mp3_bytes = future.result(timeout=30)
        if not mp3_bytes:
            raise RuntimeError("Edge TTS returned no audio (network failure?).")
        return _transcode_mp3_to_wav(mp3_bytes, target_sample_rate)


class GttsEngine:
    id = "gtts"
    label = "Google Translate TTS"
    description = "Free cloud TTS, simple language-based picker. Requires internet."
    requires_network = True
    kind: EngineKind = "tts"
    text_required = True
    source_audio_required = False
    reference_audio_required = False
    supports_reference_sample = False

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
        try:
            from gtts.lang import tts_langs  # type: ignore

            langs = tts_langs()
        except Exception:
            langs = {"en": "English"}
        voices = [VoiceDescriptor(id=code, label=label, language=code) for code, label in sorted(langs.items())]
        for code, label in self._EN_ACCENTS:
            voices.append(VoiceDescriptor(id=code, label=label, language="en"))
        voices.sort(key=lambda v: (v.id != "en", v.id))
        self._voices_cache = voices
        return voices

    def default_voice(self) -> str | None:
        return "en" if self.is_available() else None

    def synthesize(self, text: str, voice_id: str | None, language: str, target_sample_rate: int) -> bytes:
        gtts_class = self._import()
        if gtts_class is None:
            raise RuntimeError("gTTS is not installed. Add `gTTS` to the backend [model] extra.")
        lang = voice_id or language or "en"
        tld = "com"
        base_lang = lang
        if "-" in lang:
            head, region = lang.split("-", 1)
            region = region.lower()
            if head == "en":
                tld = {
                    "uk": "co.uk",
                    "au": "com.au",
                    "in": "co.in",
                    "ca": "ca",
                    "ie": "ie",
                    "za": "co.za",
                }.get(region, "com")
                base_lang = "en"
            else:
                base_lang = head
        try:
            tts = gtts_class(text=text, lang=base_lang, tld=tld)
            buf = io.BytesIO()
            tts.write_to_fp(buf)
        except Exception as exc:
            raise RuntimeError(f"gTTS failed: {exc}") from exc
        return _transcode_mp3_to_wav(buf.getvalue(), target_sample_rate)


class XttsEngine:
    id = "xtts"
    label = "Coqui XTTS-v2"
    description = "Text-to-speech voice cloning from enrolled/reference WAVs. Slow on CPU. Optional local checkpoint."
    requires_network = False
    kind: EngineKind = "voice_clone"
    text_required = True
    source_audio_required = False
    reference_audio_required = True
    supports_reference_sample = True

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
            import importlib.util

            config_spec = importlib.util.find_spec("TTS.tts.configs.xtts_config")
            model_spec = importlib.util.find_spec("TTS.tts.models.xtts")
            if config_spec is None or model_spec is None:
                self._pkg_ok = False
                return False
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
        if not self.is_available():
            return []
        return [VoiceDescriptor(id="enrolled", label="Selected operator reference", language=None)]

    def default_voice(self) -> str | None:
        return "enrolled" if self.is_available() else None

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
            original_torch_load = torch.load

            def _trusted_checkpoint_load(*args, **kwargs):
                # XTTS checkpoints from the official Coqui release still rely on
                # full-object torch deserialization. PyTorch 2.6 flipped the
                # default to weights_only=True, which breaks these trusted local
                # checkpoints unless we opt out explicitly.
                kwargs.setdefault("weights_only", False)
                return original_torch_load(*args, **kwargs)

            torch.load = _trusted_checkpoint_load
            try:
                model.load_checkpoint(config, checkpoint_dir=str(self.model_path), eval=True)
            finally:
                torch.load = original_torch_load
            device = "cuda" if torch.cuda.is_available() else "cpu"
            if device == "cuda":
                model.cuda()
            elif hasattr(model, "to"):
                model.to(device)
            self._model = model
            self._config = config
            return model, config

    def clone(
        self,
        text: str,
        voice_id: str | None,
        language: str,
        reference_paths: list[str],
        target_sample_rate: int,
    ) -> bytes:
        model, config = self.ensure_loaded()
        from TTS.tts.models import xtts as xtts_module

        original_load_audio = xtts_module.load_audio

        def _load_audio_without_torchcodec(audiopath, sampling_rate):
            import numpy as np
            import soundfile as sf
            import torch
            import torchaudio

            audio, source_rate = sf.read(audiopath, dtype="float32", always_2d=False)
            if isinstance(audio, np.ndarray) and audio.ndim > 1:
                audio = audio.mean(axis=1)
            tensor = torch.tensor(audio, dtype=torch.float32)
            if source_rate != sampling_rate:
                tensor = torchaudio.functional.resample(tensor, source_rate, sampling_rate)
            if torch.any(torch.abs(tensor) > 10):
                tensor = tensor / (2**15)
            return tensor.unsqueeze(0)

        xtts_module.load_audio = _load_audio_without_torchcodec
        try:
            output = model.synthesize(
                text,
                config,
                speaker_wav=reference_paths[0] if len(reference_paths) == 1 else reference_paths,
                gpt_cond_len=3,
                language=language,
            )
        finally:
            xtts_module.load_audio = original_load_audio
        waveform = SpoofGenerationService._coerce_waveform(output.get("wav") if isinstance(output, dict) else output)
        return AudioService().encode_wav(waveform, sample_rate=target_sample_rate)


class HttpJsonEngineBase:
    timeout_seconds = 90

    def __init__(self, base_url: str | None) -> None:
        self.base_url = base_url.rstrip("/") if base_url else None
        self._health_cache: bool | None = None

    def is_available(self) -> bool:
        if not self.base_url:
            return False
        if self._health_cache is not None:
            return self._health_cache
        self._health_cache = self._probe_health()
        return self._health_cache

    def _probe_health(self) -> bool:
        assert self.base_url is not None
        for suffix in ("/health", "/readyz", "/healthz"):
            try:
                req = urllib.request.Request(f"{self.base_url}{suffix}", method="GET")
                with urllib.request.urlopen(req, timeout=5) as response:
                    if 200 <= getattr(response, "status", 200) < 500:
                        return True
            except Exception:
                continue
        return False

    def _get_json(self, endpoint: str) -> dict[str, Any]:
        if not self.base_url:
            raise RuntimeError("Engine endpoint is not configured.")
        request = urllib.request.Request(
            f"{self.base_url}{endpoint}",
            headers={"Accept": "application/json"},
            method="GET",
        )
        try:
            with urllib.request.urlopen(request, timeout=15) as response:
                return json.loads(response.read().decode("utf-8"))
        except urllib.error.HTTPError as exc:
            detail = exc.read().decode("utf-8", errors="replace")
            raise RuntimeError(f"{self.label} request failed: {detail[:300]}") from exc
        except urllib.error.URLError as exc:
            raise RuntimeError(f"{self.label} endpoint is unreachable: {exc.reason}") from exc

    def _post_json(self, endpoint: str, payload: dict[str, Any]) -> bytes:
        if not self.base_url:
            raise RuntimeError("Engine endpoint is not configured.")
        body = json.dumps(payload).encode("utf-8")
        request = urllib.request.Request(
            f"{self.base_url}{endpoint}",
            data=body,
            headers={"Content-Type": "application/json", "Accept": "application/json"},
            method="POST",
        )
        try:
            with urllib.request.urlopen(request, timeout=self.timeout_seconds) as response:
                data = json.loads(response.read().decode("utf-8"))
        except urllib.error.HTTPError as exc:
            detail = exc.read().decode("utf-8", errors="replace")
            raise RuntimeError(f"{self.label} request failed: {detail[:300]}") from exc
        except urllib.error.URLError as exc:
            raise RuntimeError(f"{self.label} endpoint is unreachable: {exc.reason}") from exc
        audio_base64 = data.get("audio_base64")
        if not isinstance(audio_base64, str) or not audio_base64:
            raise RuntimeError(f"{self.label} returned no `audio_base64` payload.")
        import base64

        return base64.b64decode(audio_base64)

    def _post_multipart(
        self,
        endpoint: str,
        fields: dict[str, str],
        files: list[tuple[str, str, bytes, str]],
    ) -> bytes:
        if not self.base_url:
            raise RuntimeError("Engine endpoint is not configured.")
        boundary = "----BioVoiceBoundary7d9e3a"
        body = io.BytesIO()
        for key, value in fields.items():
            body.write(f"--{boundary}\r\n".encode())
            body.write(f'Content-Disposition: form-data; name="{key}"\r\n\r\n'.encode())
            body.write(value.encode("utf-8"))
            body.write(b"\r\n")
        for field_name, file_name, payload, content_type in files:
            body.write(f"--{boundary}\r\n".encode())
            body.write(
                (
                    f'Content-Disposition: form-data; name="{field_name}"; '
                    f'filename="{file_name}"\r\n'
                ).encode()
            )
            body.write(f"Content-Type: {content_type}\r\n\r\n".encode())
            body.write(payload)
            body.write(b"\r\n")
        body.write(f"--{boundary}--\r\n".encode())
        request = urllib.request.Request(
            f"{self.base_url}{endpoint}",
            data=body.getvalue(),
            headers={"Content-Type": f"multipart/form-data; boundary={boundary}"},
            method="POST",
        )
        try:
            with urllib.request.urlopen(request, timeout=self.timeout_seconds) as response:
                return response.read()
        except urllib.error.HTTPError as exc:
            detail = exc.read().decode("utf-8", errors="replace")
            raise RuntimeError(f"{self.label} request failed: {detail[:300]}") from exc
        except urllib.error.URLError as exc:
            raise RuntimeError(f"{self.label} endpoint is unreachable: {exc.reason}") from exc


class OpenVoiceEngine(HttpJsonEngineBase):
    id = "openvoice"
    label = "OpenVoice"
    description = "Fast multilingual voice cloning via an external OpenVoice service."
    requires_network = True
    kind: EngineKind = "voice_clone"
    text_required = True
    source_audio_required = False
    reference_audio_required = True
    supports_reference_sample = True

    def __init__(self, base_url: str | None, *, enable_local_fallback: bool = False) -> None:
        super().__init__(base_url)
        self.enable_local_fallback = enable_local_fallback
        repo_root = Path(__file__).resolve().parents[3]
        self.repo_dir = Path(os.environ.get("OPENVOICE_REPO_DIR", repo_root / "third_party" / "OpenVoice")).resolve()
        self.checkpoints_dir = Path(
            os.environ.get("OPENVOICE_CHECKPOINTS_DIR", self.repo_dir / "checkpoints")
        ).resolve()
        self.device = os.environ.get("OPENVOICE_DEVICE", "cuda" if os.environ.get("CUDA_VISIBLE_DEVICES") else "cpu")
        self.default_style = os.environ.get("OPENVOICE_DEFAULT_STYLE", "default")
        self.tau = float(os.environ.get("OPENVOICE_TAU", "0.3"))
        self._pkg_ok: bool | None = None
        self._local_lock = Lock()
        self._local_loaded = False

    def _local_import_ok(self) -> bool:
        if self._pkg_ok is False:
            return False
        try:
            import importlib.util

            if importlib.util.find_spec("openvoice.api") is None:
                self._pkg_ok = False
                return False
        except (ImportError, ModuleNotFoundError):
            self._pkg_ok = False
            return False
        self._pkg_ok = True
        return True

    def _local_files_ok(self) -> bool:
        required = [
            self.checkpoints_dir / "base_speakers" / "EN" / "config.json",
            self.checkpoints_dir / "base_speakers" / "EN" / "checkpoint.pth",
            self.checkpoints_dir / "base_speakers" / "EN" / "en_default_se.pth",
            self.checkpoints_dir / "base_speakers" / "EN" / "en_style_se.pth",
            self.checkpoints_dir / "base_speakers" / "ZH" / "config.json",
            self.checkpoints_dir / "base_speakers" / "ZH" / "checkpoint.pth",
            self.checkpoints_dir / "base_speakers" / "ZH" / "zh_default_se.pth",
            self.checkpoints_dir / "converter" / "config.json",
            self.checkpoints_dir / "converter" / "checkpoint.pth",
        ]
        return all(path.exists() for path in required)

    def _local_available(self) -> bool:
        if not self.enable_local_fallback:
            return False
        if str(self.repo_dir) not in sys.path:
            sys.path.insert(0, str(self.repo_dir))
        return self._local_import_ok() and self._local_files_ok()

    def is_available(self) -> bool:
        return self._local_available() or super().is_available()

    def list_voices(self) -> list[VoiceDescriptor]:
        return [VoiceDescriptor(id="clone", label="Reference-cloned voice", language=None)] if self.is_available() else []

    def default_voice(self) -> str | None:
        return "clone" if self.is_available() else None

    def ensure_loaded(self) -> None:
        if self._local_loaded:
            return
        with self._local_lock:
            if self._local_loaded:
                return
            if not self._local_available():
                raise RuntimeError("OpenVoice local runtime is not installed.")
            import torch
            from openvoice.api import BaseSpeakerTTS, ToneColorConverter

            try:
                import wavmark

                class _DisabledWatermarkModel:
                    def to(self, device: str):
                        return None

                wavmark.load_model = lambda: _DisabledWatermarkModel()
            except Exception:
                pass
            en_dir = self.checkpoints_dir / "base_speakers" / "EN"
            zh_dir = self.checkpoints_dir / "base_speakers" / "ZH"
            converter_dir = self.checkpoints_dir / "converter"
            self.en_tts = BaseSpeakerTTS(str(en_dir / "config.json"), device=self.device)
            self.en_tts.load_ckpt(str(en_dir / "checkpoint.pth"))
            self.zh_tts = BaseSpeakerTTS(str(zh_dir / "config.json"), device=self.device)
            self.zh_tts.load_ckpt(str(zh_dir / "checkpoint.pth"))
            self.converter = ToneColorConverter(str(converter_dir / "config.json"), device=self.device)
            self.converter.load_ckpt(str(converter_dir / "checkpoint.pth"))
            self.converter.watermark_model = None
            self.en_default_se = torch.load(str(en_dir / "en_default_se.pth"), map_location=self.device).to(self.device)
            self.en_style_se = torch.load(str(en_dir / "en_style_se.pth"), map_location=self.device).to(self.device)
            self.zh_default_se = torch.load(str(zh_dir / "zh_default_se.pth"), map_location=self.device).to(self.device)
            self._local_loaded = True

    def _local_clone(
        self,
        text: str,
        language: str,
        voice_id: str | None,
        reference_paths: list[str],
        target_sample_rate: int,
    ) -> bytes:
        self.ensure_loaded()
        style = (voice_id or self.default_style or "default").strip() or "default"
        if language.lower().startswith("zh"):
            if style != "default":
                raise RuntimeError("Chinese OpenVoice base speaker only supports `default` style.")
            tts_model = self.zh_tts
            source_se = self.zh_default_se
            openvoice_language = "Chinese"
            style = "default"
        else:
            tts_model = self.en_tts
            source_se = self.en_default_se if style == "default" else self.en_style_se
            openvoice_language = "English"
        target_se = self.converter.extract_se(reference_paths)
        with TemporaryDirectory(prefix="biovoice-openvoice-") as tmp_dir:
            tmp_path = Path(tmp_dir)
            src_path = tmp_path / "source.wav"
            out_path = tmp_path / "output.wav"
            tts_model.tts(text, str(src_path), speaker=style, language=openvoice_language)
            self.converter.convert(
                audio_src_path=str(src_path),
                src_se=source_se,
                tgt_se=target_se,
                output_path=str(out_path),
                tau=self.tau,
                message="BioVoice",
            )
            return _ensure_wav_bytes(out_path.read_bytes(), target_sample_rate)

    def clone(
        self,
        text: str,
        voice_id: str | None,
        language: str,
        reference_paths: list[str],
        target_sample_rate: int,
    ) -> bytes:
        if self._local_available():
            return self._local_clone(text, language, voice_id, reference_paths, target_sample_rate)
        files = []
        for index, reference_path in enumerate(reference_paths):
            payload = Path(reference_path).read_bytes()
            files.append((f"reference_audio_{index}", Path(reference_path).name, payload, "audio/wav"))
        audio = self._post_multipart(
            "/clone",
            fields={
                "text": text,
                "language": language,
                "voice": voice_id or self.default_voice() or "clone",
                "target_sample_rate": str(target_sample_rate),
            },
            files=files,
        )
        return _ensure_wav_bytes(audio, target_sample_rate)


class RvcEngine(HttpJsonEngineBase):
    id = "rvc"
    label = "RVC"
    description = "Uploaded speech-to-speech conversion via an external RVC service backed by trained target voice models."
    requires_network = True
    kind: EngineKind = "voice_conversion"
    text_required = False
    source_audio_required = True
    reference_audio_required = False
    supports_reference_sample = False

    def is_available(self) -> bool:
        if not super().is_available():
            return False
        try:
            return len(self._list_models()) > 0
        except RuntimeError:
            return False

    def _list_models(self) -> list[VoiceDescriptor]:
        if not self.base_url:
            return []
        if not super().is_available():
            return []
        payload = self._get_json("/models")
        models = payload.get("models", [])
        voices: list[VoiceDescriptor] = []
        for model in models:
            model_id = str(model.get("id", "")).strip()
            if not model_id:
                continue
            label = str(model.get("label") or model_id)
            language = model.get("language")
            voices.append(VoiceDescriptor(id=model_id, label=label, language=str(language) if language else None))
        voices.sort(key=lambda item: item.label.lower())
        return voices

    def list_voices(self) -> list[VoiceDescriptor]:
        return self._list_models()

    def default_voice(self) -> str | None:
        voices = self.list_voices()
        return voices[0].id if voices else None

    def convert(
        self,
        source_audio_bytes: bytes,
        voice_id: str | None,
        reference_paths: list[str],
        target_sample_rate: int,
    ) -> bytes:
        if not voice_id:
            raise RuntimeError("RVC requires a target model id. Expose `/models` from the RVC service and choose one.")
        files = [("source_audio", "source.wav", source_audio_bytes, "audio/wav")]
        audio = self._post_multipart(
            "/convert",
            fields={
                "voice": voice_id,
                "target_sample_rate": str(target_sample_rate),
            },
            files=files,
        )
        return _ensure_wav_bytes(audio, target_sample_rate)


class ApplioEngine(HttpJsonEngineBase):
    id = "applio"
    label = "Applio"
    description = "Uploaded speech-to-speech conversion via an external Applio-compatible service backed by exported target models."
    requires_network = True
    kind: EngineKind = "voice_conversion"
    text_required = False
    source_audio_required = True
    reference_audio_required = False
    supports_reference_sample = False

    def is_available(self) -> bool:
        if not super().is_available():
            return False
        try:
            return len(self._list_models()) > 0
        except RuntimeError:
            return False

    def _list_models(self) -> list[VoiceDescriptor]:
        if not self.base_url:
            return []
        if not super().is_available():
            return []
        payload = self._get_json("/models")
        models = payload.get("models", [])
        voices: list[VoiceDescriptor] = []
        for model in models:
            model_id = str(model.get("id", "")).strip()
            if not model_id:
                continue
            label = str(model.get("label") or model_id)
            language = model.get("language")
            voices.append(VoiceDescriptor(id=model_id, label=label, language=str(language) if language else None))
        voices.sort(key=lambda item: item.label.lower())
        return voices

    def list_voices(self) -> list[VoiceDescriptor]:
        return self._list_models()

    def default_voice(self) -> str | None:
        voices = self.list_voices()
        return voices[0].id if voices else None

    def convert(
        self,
        source_audio_bytes: bytes,
        voice_id: str | None,
        reference_paths: list[str],
        target_sample_rate: int,
    ) -> bytes:
        if not voice_id:
            raise RuntimeError("Applio requires a target model id. Export trained models and expose them through `/models`.")
        files = [("source_audio", "source.wav", source_audio_bytes, "audio/wav")]
        audio = self._post_multipart(
            "/convert",
            fields={
                "voice": voice_id,
                "target_sample_rate": str(target_sample_rate),
            },
            files=files,
        )
        return _ensure_wav_bytes(audio, target_sample_rate)


_DEFAULT_ENGINE_PRIORITY = ("openvoice", "xtts", "edge", "gtts", "say", "espeak", "rvc", "applio")


class SpoofGenerationService:
    def __init__(
        self,
        store: ReferenceSampleStore,
        model_path: Path,
        output_directory: Path,
        default_language: str,
        output_sample_rate: int,
        openvoice_local_fallback: bool = False,
        openvoice_base_url: str | None = None,
        rvc_base_url: str | None = None,
        applio_base_url: str | None = None,
        rvc_models_path: Path | None = None,
        applio_models_path: Path | None = None,
    ):
        self.store = store
        self.model_path = Path(model_path)
        self.output_directory = Path(output_directory)
        self.output_directory.mkdir(parents=True, exist_ok=True)
        self.default_language = default_language
        self.output_sample_rate = output_sample_rate
        self.audio = AudioService()
        self.rvc_models_path = Path(rvc_models_path or Path(__file__).resolve().parents[3] / "backend" / "data" / "voice_models" / "rvc")
        self.applio_models_path = Path(applio_models_path or Path(__file__).resolve().parents[3] / "backend" / "data" / "voice_models" / "applio")
        self.rvc_models_path.mkdir(parents=True, exist_ok=True)
        self.applio_models_path.mkdir(parents=True, exist_ok=True)
        self._engines: dict[str, SpoofEngine] = {
            "openvoice": OpenVoiceEngine(openvoice_base_url, enable_local_fallback=openvoice_local_fallback),
            "xtts": XttsEngine(model_path),
            "edge": EdgeTtsEngine(),
            "gtts": GttsEngine(),
            "say": SayEngine(),
            "espeak": EspeakEngine(),
            "rvc": RvcEngine(rvc_base_url),
            "applio": ApplioEngine(applio_base_url),
        }

    def list_engines(self) -> list[EngineInfo]:
        out: list[EngineInfo] = []
        for engine_id in _DEFAULT_ENGINE_PRIORITY:
            engine = self._engines[engine_id]
            available = engine.is_available()
            out.append(
                EngineInfo(
                    id=engine.id,
                    label=engine.label,
                    description=engine.description,
                    requires_network=engine.requires_network,
                    available=available,
                    kind=engine.kind,
                    text_required=engine.text_required,
                    source_audio_required=engine.source_audio_required,
                    reference_audio_required=engine.reference_audio_required,
                    supports_reference_sample=engine.supports_reference_sample,
                    voices=engine.list_voices() if available else [],
                    default_voice=engine.default_voice() if available else None,
                )
            )
        return out

    def default_engine_id(self) -> str | None:
        for engine_id in _DEFAULT_ENGINE_PRIORITY:
            if self._engines[engine_id].is_available():
                return engine_id
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

    def list_voice_models(self) -> list[ImportedVoiceModel]:
        models: list[ImportedVoiceModel] = []
        for engine, root in (("rvc", self.rvc_models_path), ("applio", self.applio_models_path)):
            for manifest_path in sorted(root.rglob("biovoice-model.json")):
                payload = json.loads(manifest_path.read_text(encoding="utf-8"))
                model_rel = str(payload.get("model_path", "")).strip()
                if not model_rel:
                    continue
                model_path = (manifest_path.parent / model_rel).resolve()
                index_rel = str(payload.get("index_path", "")).strip() if payload.get("index_path") else ""
                index_path = (manifest_path.parent / index_rel).resolve() if index_rel else None
                models.append(
                    ImportedVoiceModel(
                        engine=engine,  # type: ignore[arg-type]
                        model_id=str(payload.get("id") or manifest_path.parent.name),
                        label=str(payload.get("label") or payload.get("id") or manifest_path.parent.name),
                        language=str(payload["language"]) if payload.get("language") else None,
                        model_path=model_path,
                        model_filename=model_path.name,
                        index_path=index_path,
                        index_filename=index_path.name if index_path else None,
                        ready=model_path.exists() and (engine == "rvc" or index_path is not None),
                    )
                )
        models.sort(key=lambda item: (item.engine, item.label.lower()))
        return models

    def import_voice_model(
        self,
        engine: str,
        label: str,
        language: str | None,
        model_bytes: bytes,
        model_filename: str,
        index_bytes: bytes | None = None,
        index_filename: str | None = None,
    ) -> ImportedVoiceModel:
        engine_key = engine.strip().lower()
        if engine_key not in {"rvc", "applio"}:
            raise ValueError("Only `rvc` and `applio` support imported voice models.")
        cleaned_label = label.strip()
        if not cleaned_label:
            raise ValueError("Model label is required.")
        if not model_filename.lower().endswith(".pth"):
            raise ValueError("Model file must be a `.pth` file.")
        if index_filename and not index_filename.lower().endswith(".index"):
            raise ValueError("Index file must end with `.index`.")
        if engine_key == "applio" and index_bytes is None:
            raise ValueError("Applio imports require both a `.pth` model and a `.index` file.")
        root = self.rvc_models_path if engine_key == "rvc" else self.applio_models_path
        model_id = self._slugify(cleaned_label)
        target_dir = root / model_id
        suffix = 2
        while target_dir.exists():
            target_dir = root / f"{model_id}-{suffix}"
            suffix += 1
        target_dir.mkdir(parents=True, exist_ok=True)
        stored_model_name = self._safe_filename(model_filename, fallback="voice.pth")
        model_path = target_dir / stored_model_name
        model_path.write_bytes(model_bytes)
        stored_index_name: str | None = None
        index_path: Path | None = None
        if index_bytes is not None:
            stored_index_name = self._safe_filename(index_filename or "voice.index", fallback="voice.index")
            index_path = target_dir / stored_index_name
            index_path.write_bytes(index_bytes)
        manifest = {
            "id": target_dir.name,
            "label": cleaned_label,
            "language": (language or "").strip() or None,
            "model_path": stored_model_name,
            "index_path": stored_index_name,
        }
        (target_dir / "biovoice-model.json").write_text(json.dumps(manifest, indent=2), encoding="utf-8")
        return ImportedVoiceModel(
            engine=engine_key,  # type: ignore[arg-type]
            model_id=target_dir.name,
            label=cleaned_label,
            language=manifest["language"],
            model_path=model_path,
            model_filename=stored_model_name,
            index_path=index_path,
            index_filename=stored_index_name,
            ready=engine_key == "rvc" or index_path is not None,
        )

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
        source_audio_bytes: bytes | None = None,
        source_filename: str | None = None,
    ) -> SpoofGenerationResult:
        language_code = (language or self.default_language).strip().lower()
        chosen_id = engine or self.default_engine_id()
        if chosen_id is None:
            raise RuntimeError(
                "No spoof engines are available. Install XTTS/OpenVoice or expose a cloud/local engine endpoint."
            )
        if chosen_id not in self._engines:
            raise ValueError(f"Unknown spoof engine '{chosen_id}'. Available: {sorted(self._engines)}")
        chosen = self._engines[chosen_id]
        if not chosen.is_available():
            raise RuntimeError(
                f"Spoof engine '{chosen_id}' isn't available on this host. "
                f"Try one of: {[e.id for e in self.list_engines() if e.available]}"
            )
        message_text = text.strip()
        if chosen.text_required and not message_text:
            raise ValueError(f"Engine '{chosen_id}' requires non-empty text input.")
        if chosen.source_audio_required and source_audio_bytes is None:
            raise ValueError(f"Engine '{chosen_id}' requires source audio input.")
        if chosen.reference_audio_required:
            with self._reference_context(
                user_id=user_id,
                reference_sample_id=reference_sample_id,
                reference_audio_bytes=reference_audio_bytes,
                reference_filename=reference_filename,
            ) as (reference_paths, reference_description):
                return self._generate_for_engine(
                    engine=chosen,
                    user_id=user_id,
                    voice=voice,
                    text=message_text,
                    language_code=language_code,
                    reference_paths=reference_paths,
                    reference_description=reference_description,
                    source_audio_bytes=source_audio_bytes,
                    source_filename=source_filename,
                )
        return self._generate_for_engine(
            engine=chosen,
            user_id=user_id,
            voice=voice,
            text=message_text,
            language_code=language_code,
            reference_paths=[],
            reference_description=None,
            source_audio_bytes=source_audio_bytes,
            source_filename=source_filename,
        )

    def _generate_for_engine(
        self,
        engine: SpoofEngine,
        user_id: str,
        voice: str | None,
        text: str,
        language_code: str,
        reference_paths: list[str],
        reference_description: str | None,
        source_audio_bytes: bytes | None,
        source_filename: str | None,
    ) -> SpoofGenerationResult:
        source_description: str
        if engine.kind == "tts":
            tts_engine = engine
            assert isinstance(tts_engine, (SayEngine, EspeakEngine, EdgeTtsEngine, GttsEngine))
            audio_bytes = tts_engine.synthesize(
                text=text,
                voice_id=voice,
                language=language_code,
                target_sample_rate=self.output_sample_rate,
            )
            source_description = f"{tts_engine.label} | {voice or tts_engine.default_voice() or 'default voice'}"
        elif engine.kind == "voice_clone":
            clone_engine = engine
            assert isinstance(clone_engine, (XttsEngine, OpenVoiceEngine))
            audio_bytes = clone_engine.clone(
                text=text,
                voice_id=voice,
                language=language_code,
                reference_paths=reference_paths,
                target_sample_rate=self.output_sample_rate,
            )
            source_description = f"{clone_engine.label} | {reference_description or 'reference audio'}"
        else:
            convert_engine = engine
            assert isinstance(convert_engine, (RvcEngine, ApplioEngine))
            assert source_audio_bytes is not None
            normalized_source = self.audio.decode_wav(source_audio_bytes)
            source_wav = self.audio.encode_wav(
                normalized_source.waveform,
                sample_rate=normalized_source.sample_rate,
            )
            audio_bytes = convert_engine.convert(
                source_audio_bytes=source_wav,
                voice_id=voice,
                reference_paths=reference_paths,
                target_sample_rate=self.output_sample_rate,
            )
            source_label = source_filename or "uploaded-source.wav"
            source_description = (
                f"{convert_engine.label} | Source: {source_label} | Target: {reference_description or 'reference audio'}"
            )
        return self._persist(
            user_id=user_id,
            audio_bytes=audio_bytes,
            engine_id=engine.id,
            voice_id=voice or engine.default_voice(),
            source_description=source_description,
        )

    def _persist(
        self,
        user_id: str,
        audio_bytes: bytes,
        engine_id: str,
        voice_id: str | None,
        source_description: str,
    ) -> SpoofGenerationResult:
        safe_user_id = "".join(character if character.isalnum() or character in {"-", "_"} else "_" for character in user_id)
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
                raise ValueError("Reference sample not found for the requested user")
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
    def _slugify(value: str) -> str:
        lowered = value.strip().lower()
        lowered = re.sub(r"[^a-z0-9]+", "-", lowered)
        lowered = lowered.strip("-")
        return lowered or "voice-model"

    @staticmethod
    def _safe_filename(filename: str, fallback: str) -> str:
        name = Path(filename).name.strip()
        safe = re.sub(r"[^A-Za-z0-9._-]+", "-", name).strip(".-")
        return safe or fallback

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


def _ensure_wav_bytes(audio_bytes: bytes, target_sample_rate: int) -> bytes:
    if audio_bytes[:4] == b"RIFF":
        return audio_bytes
    return _transcode_mp3_to_wav(audio_bytes, target_sample_rate)


def _transcode_mp3_to_wav(mp3_bytes: bytes, target_sample_rate: int) -> bytes:
    try:
        return _transcode_with_soundfile(mp3_bytes, target_sample_rate)
    except Exception:
        pass
    return _transcode_with_ffmpeg(mp3_bytes, target_sample_rate)


def _transcode_with_soundfile(mp3_bytes: bytes, target_sample_rate: int) -> bytes:
    import io as _io

    import numpy as np
    import soundfile as sf

    samples, source_rate = sf.read(_io.BytesIO(mp3_bytes), dtype="float32", always_2d=False)
    if samples.ndim > 1:
        samples = samples.mean(axis=1)
    if source_rate != target_sample_rate:
        ratio = target_sample_rate / source_rate
        n_out = int(round(len(samples) * ratio))
        x_out = np.linspace(0, len(samples) - 1, n_out)
        samples = np.interp(x_out, np.arange(len(samples)), samples).astype("float32")
    return _encode_int16_wav(samples.tolist(), target_sample_rate)


def _transcode_with_ffmpeg(mp3_bytes: bytes, target_sample_rate: int) -> bytes:
    binary = shutil.which("ffmpeg")
    if not binary:
        raise RuntimeError("Cannot decode compressed audio - install `soundfile` or `ffmpeg` on the host.")
    with NamedTemporaryFile(suffix=".bin", delete=False) as inp:
        inp.write(mp3_bytes)
        in_path = inp.name
    with NamedTemporaryFile(suffix=".wav", delete=False) as outp:
        out_path = outp.name
    try:
        result = subprocess.run(
            [binary, "-y", "-i", in_path, "-ar", str(target_sample_rate), "-ac", "1", out_path],
            capture_output=True,
            timeout=60,
        )
        if result.returncode != 0:
            raise RuntimeError(
                f"ffmpeg transcode failed (exit {result.returncode}): {result.stderr.decode('utf-8', errors='replace')[:200]}"
            )
        return _read_wav_bytes(out_path)
    finally:
        Path(in_path).unlink(missing_ok=True)
        Path(out_path).unlink(missing_ok=True)


def _encode_int16_wav(samples: Iterable[float], sample_rate: int) -> bytes:
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
    try:
        with wave.open(path, "rb") as handle:
            if handle.getnchannels() not in (1, 2):
                raise RuntimeError(f"Synth produced unexpected channel count: {handle.getnchannels()}")
            if handle.getsampwidth() != 2:
                raise RuntimeError(f"Synth produced unexpected sample width: {handle.getsampwidth()}")
    except wave.Error as exc:
        raise RuntimeError(f"Synth output is not a valid WAV: {exc}") from exc
    return Path(path).read_bytes()
