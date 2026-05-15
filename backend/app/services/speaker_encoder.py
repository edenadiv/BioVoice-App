"""Speaker embedding services."""

from __future__ import annotations

import math
from dataclasses import dataclass
from pathlib import Path
from statistics import fmean
from typing import Protocol

import torch
import torchaudio
import torchaudio.compliance.kaldi as kaldi
import yaml

from app.vendor.redimnet.model import ReDimNetWrap


class SpeakerEncoder(Protocol):
    def embed(self, waveform: list[float]) -> list[float]: ...

    def cosine_similarity(self, a: list[float], b: list[float]) -> float: ...


@dataclass(frozen=True, slots=True)
class SpeakerModelSpec:
    key: str
    provenance: str
    loader: str
    source: str
    active: bool


SUPPORTED_SPEAKER_MODELS: tuple[SpeakerModelSpec, ...] = (
    SpeakerModelSpec(
        key="redimnet_b5",
        provenance="redimnet_b5",
        loader="vendored_checkpoint",
        source="backend/models/redimnet_b5.pt",
        active=True,
    ),
    SpeakerModelSpec(
        key="ecapa_voxceleb",
        provenance="ecapa_voxceleb",
        loader="speechbrain",
        source="speechbrain/spkrec-ecapa-voxceleb",
        active=False,
    ),
    SpeakerModelSpec(
        key="wespeaker_resnet293_lm",
        provenance="wespeaker_resnet293_lm",
        loader="wespeaker",
        source="Wespeaker/wespeaker-voxceleb-resnet293-LM",
        active=False,
    ),
)


def list_supported_speaker_models() -> tuple[SpeakerModelSpec, ...]:
    return SUPPORTED_SPEAKER_MODELS


class RedimNetSpeakerEncoder:
    """Real speaker encoder backed by the vendored RedimNet checkpoint."""

    provenance: str = "redimnet_b5"

    def __init__(self, weights_path: Path):
        checkpoint = torch.load(Path(weights_path), map_location="cpu")
        model_config = dict(checkpoint["model_config"])
        self.model = ReDimNetWrap(**model_config)
        load_result = self.model.load_state_dict(checkpoint["state_dict"])
        if load_result.missing_keys or load_result.unexpected_keys:
            raise RuntimeError(f"RedimNet checkpoint mismatch: {load_result}")
        self.model.eval()

    def embed(self, waveform: list[float]) -> list[float]:
        if not waveform:
            return [0.0] * 192

        inputs = torch.tensor(waveform, dtype=torch.float32).unsqueeze(0)
        with torch.inference_mode():
            embedding = self.model(inputs).squeeze(0)
        return self._normalize_embedding(embedding.tolist())

    @staticmethod
    def cosine_similarity(a: list[float], b: list[float]) -> float:
        dot = sum(x * y for x, y in zip(a, b))
        norm_a = math.sqrt(sum(x * x for x in a))
        norm_b = math.sqrt(sum(y * y for y in b))
        denom = norm_a * norm_b
        if denom <= 1e-8:
            return 0.0
        score = dot / denom
        return (score + 1.0) / 2.0

    @staticmethod
    def _normalize_embedding(embedding: list[float]) -> list[float]:
        norm = math.sqrt(sum(value * value for value in embedding))
        if norm <= 1e-8:
            return [0.0 for _ in embedding]
        return [value / norm for value in embedding]


class EcapaSpeakerEncoder:
    """Optional SpeechBrain ECAPA-TDNN encoder.

    This is intentionally not wired into `core/container.py` yet. The
    goal of this branch is to stage and validate the loader path without
    changing production verification behavior.
    """

    provenance: str = "ecapa_voxceleb"

    def __init__(self, savedir: Path | None = None, source: str = "speechbrain/spkrec-ecapa-voxceleb"):
        try:
            from speechbrain.inference.speaker import EncoderClassifier
        except ImportError as exc:  # pragma: no cover - depends on optional extra
            raise RuntimeError(
                "SpeechBrain is not installed. Install `backend[speaker_models]` to use ECAPA."
            ) from exc

        kwargs = {"source": source}
        if savedir is not None:
            kwargs["savedir"] = str(savedir)
        self.model = EncoderClassifier.from_hparams(**kwargs)

    def embed(self, waveform: list[float]) -> list[float]:
        if not waveform:
            return [0.0] * 192

        inputs = torch.tensor(waveform, dtype=torch.float32).unsqueeze(0)
        with torch.inference_mode():
            embedding = self.model.encode_batch(inputs).squeeze()
        return RedimNetSpeakerEncoder._normalize_embedding(embedding.tolist())

    @staticmethod
    def cosine_similarity(a: list[float], b: list[float]) -> float:
        return RedimNetSpeakerEncoder.cosine_similarity(a, b)


class WeSpeakerResNet293SpeakerEncoder:
    """Optional WeSpeaker ResNet293 LM encoder.

    Uses the official ONNX export from the published Hugging Face
    checkpoint bundle. This avoids the broader WeSpeaker CLI/runtime
    dependency graph, which currently breaks on modern torchaudio builds
    in this Windows environment.
    """

    provenance: str = "wespeaker_resnet293_lm"

    def __init__(self, model_dir: Path):
        try:
            import onnxruntime as ort
        except ImportError:
            raise RuntimeError(
                "onnxruntime is not installed. Install `backend[speaker_models]` to use ResNet293."
            )

        self.model_dir = Path(model_dir)
        self.onnx_path = self.model_dir / "voxceleb_resnet293_LM.onnx"
        self.config_path = self.model_dir / "config.yaml"
        if not self.onnx_path.exists():
            raise RuntimeError(
                f"WeSpeaker ONNX checkpoint missing at '{self.onnx_path}'."
            )
        if not self.config_path.exists():
            raise RuntimeError(
                f"WeSpeaker config missing at '{self.config_path}'."
            )

        with self.config_path.open("r", encoding="utf-8") as handle:
            self.config = yaml.safe_load(handle)
        self.resample_rate = int(self.config.get("dataset_args", {}).get("resample_rate", 16_000))
        fbank_args = self.config.get("dataset_args", {}).get("fbank_args", {})
        self.num_mel_bins = int(fbank_args.get("num_mel_bins", 80))
        self.frame_length = int(fbank_args.get("frame_length", 25))
        self.frame_shift = int(fbank_args.get("frame_shift", 10))
        self.session = ort.InferenceSession(
            str(self.onnx_path),
            providers=["CPUExecutionProvider"],
        )

    def embed(self, waveform: list[float]) -> list[float]:
        if not waveform:
            return [0.0] * 256

        tensor = torch.tensor(waveform, dtype=torch.float32).unsqueeze(0)
        if self.resample_rate != 16_000:
            tensor = torchaudio.transforms.Resample(orig_freq=16_000, new_freq=self.resample_rate)(tensor)

        feats = kaldi.fbank(
            tensor,
            num_mel_bins=self.num_mel_bins,
            frame_length=self.frame_length,
            frame_shift=self.frame_shift,
            sample_frequency=self.resample_rate,
            window_type="hamming",
        )
        feats = feats - torch.mean(feats, dim=0)
        inputs = feats.unsqueeze(0).cpu().numpy()
        embedding = self.session.run(None, {"feats": inputs})[0][0]
        return RedimNetSpeakerEncoder._normalize_embedding(embedding.tolist())

    @staticmethod
    def cosine_similarity(a: list[float], b: list[float]) -> float:
        return RedimNetSpeakerEncoder.cosine_similarity(a, b)


class PlaceholderSpeakerEncoder:
    """Fallback deterministic encoder used only if the real model cannot load.

    NOT WIRED IN PRODUCTION — `core/container.py` constructs
    `RedimNetSpeakerEncoder` directly, which raises on missing weights.
    Kept as a defensive shim for any future code path that wants
    degraded-mode operation. The `provenance` flag flows through to the
    `ModelProvenance` schema so the UI can warn loudly."""

    provenance: str = "heuristic_placeholder"

    def embed(self, waveform: list[float]) -> list[float]:
        if not waveform:
            return [0.0] * 8

        mean = fmean(waveform)
        centered = [sample - mean for sample in waveform]
        rms = math.sqrt(fmean(sample * sample for sample in centered))
        peak = max(abs(sample) for sample in waveform)
        zero_crossings = self._zero_crossing_rate(centered)
        spread = self._spread(centered)
        first_moment = fmean(abs(sample) for sample in centered)
        energy_proxy = fmean(abs(cur - prev) for prev, cur in zip(centered, centered[1:])) if len(centered) > 1 else 0.0
        return [
            mean,
            spread,
            rms,
            peak,
            first_moment,
            self._percentile(centered, 0.25),
            self._percentile(centered, 0.75),
            zero_crossings + energy_proxy,
        ]

    @staticmethod
    def cosine_similarity(a: list[float], b: list[float]) -> float:
        dot = sum(x * y for x, y in zip(a, b))
        norm_a = math.sqrt(sum(x * x for x in a))
        norm_b = math.sqrt(sum(y * y for y in b))
        denom = norm_a * norm_b
        if denom <= 1e-8:
            return 0.0
        score = dot / denom
        return (score + 1.0) / 2.0

    @staticmethod
    def _zero_crossing_rate(waveform: list[float]) -> float:
        if len(waveform) < 2:
            return 0.0
        crossings = sum(
            1
            for left, right in zip(waveform, waveform[1:])
            if (left >= 0 > right) or (left < 0 <= right)
        )
        return crossings / (len(waveform) - 1)

    @staticmethod
    def _spread(waveform: list[float]) -> float:
        if len(waveform) < 2:
            return 0.0
        mean = fmean(waveform)
        variance = fmean((sample - mean) ** 2 for sample in waveform)
        return math.sqrt(variance)

    @staticmethod
    def _percentile(values: list[float], percentile: float) -> float:
        if not values:
            return 0.0
        ordered = sorted(values)
        if len(ordered) == 1:
            return ordered[0]
        index = percentile * (len(ordered) - 1)
        lower = math.floor(index)
        upper = math.ceil(index)
        if lower == upper:
            return ordered[int(index)]
        fraction = index - lower
        return ordered[lower] * (1 - fraction) + ordered[upper] * fraction
