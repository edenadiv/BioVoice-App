"""Speaker embedding services."""

from __future__ import annotations

import math
from pathlib import Path
from statistics import fmean
from typing import Protocol

import torch

from app.vendor.redimnet.model import ReDimNetWrap


class SpeakerEncoder(Protocol):
    def embed(self, waveform: list[float]) -> list[float]: ...

    def cosine_similarity(self, a: list[float], b: list[float]) -> float: ...


class RedimNetSpeakerEncoder:
    """Real speaker encoder backed by the vendored RedimNet checkpoint."""

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


class PlaceholderSpeakerEncoder:
    """Fallback deterministic encoder used only if the real model cannot load."""

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
