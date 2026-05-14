"""Detector protocol + score type."""

from __future__ import annotations

from abc import ABC, abstractmethod
from dataclasses import dataclass, field


@dataclass(slots=True)
class DetectorScore:
    name: str
    score: float  # 0..1, 1 = synthetic
    raw_score: float  # pre-calibration
    available: bool
    meta: dict = field(default_factory=dict)


class Detector(ABC):
    """Single deepfake detector. score = P(synthetic)."""

    name: str = "detector"

    @property
    @abstractmethod
    def available(self) -> bool:
        """True when detector can produce a real score (deps + weights present)."""

    @abstractmethod
    def score(self, waveform: list[float], sample_rate: int) -> DetectorScore:
        """Return P(synthetic) plus diagnostic features."""
