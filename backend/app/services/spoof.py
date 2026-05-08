"""Spoof sample generation using a locally downloaded XTTS-v2 checkpoint."""

from __future__ import annotations

from contextlib import contextmanager
from dataclasses import dataclass
from pathlib import Path
from tempfile import TemporaryDirectory
from threading import Lock
from typing import Any, Protocol

from app.models import ReferenceSampleRecord
from app.schemas import ReferenceSampleResponse
from app.services.audio import AudioService


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
        with self._reference_context(
            user_id=user_id,
            reference_sample_id=reference_sample_id,
            reference_audio_bytes=reference_audio_bytes,
            reference_filename=reference_filename,
        ) as (reference_paths, source_description):
            model, config = self._ensure_model_loaded()
            output = model.synthesize(
                message_text,
                config,
                speaker_wav=reference_paths[0] if len(reference_paths) == 1 else reference_paths,
                gpt_cond_len=3,
                language=language_code,
            )
        waveform = self._coerce_waveform(output.get("wav") if isinstance(output, dict) else output)
        audio_bytes = self.audio.encode_wav(waveform, sample_rate=self.output_sample_rate)
        safe_user_id = "".join(character if character.isalnum() or character in {"-", "_"} else "_" for character in user_id)
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
                    "XTTS dependencies are not installed. Install the backend with the TTS package before generating spoof samples."
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
