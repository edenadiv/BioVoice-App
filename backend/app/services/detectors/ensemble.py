"""Ensemble detector: aggregates child detector scores.

- Drops `available=False` detectors silently.
- Applies per-detector Platt calibration + weight from `EnsembleCalibration`.
- Combined score = weighted mean of calibrated scores.
- Confidence band = [mean - σ, mean + σ] over calibrated scores, clipped 0..1.
- Returns full breakdown for downstream agents.
"""

from __future__ import annotations

import math
from dataclasses import dataclass

from app.core.calibration import EnsembleCalibration
from app.services.detectors.base import Detector, DetectorScore


@dataclass(slots=True)
class EnsembleResult:
    score: float
    confidence_low: float
    confidence_high: float
    verdict: str  # REAL | DEEPFAKE | UNCERTAIN
    breakdown: list[DetectorScore]


class EnsembleDetector:
    def __init__(self, detectors: list[Detector], calibration: EnsembleCalibration):
        self._detectors = detectors
        self._calibration = calibration

    @property
    def calibration(self) -> EnsembleCalibration:
        return self._calibration

    def detectors(self) -> list[Detector]:
        return list(self._detectors)

    def detect(self, waveform: list[float], sample_rate: int = 16000) -> float:
        """Back-compat single-float entry point. Returns combined P(synthetic)."""
        return self.analyze(waveform, sample_rate=sample_rate).score

    def analyze(self, waveform: list[float], sample_rate: int = 16000) -> EnsembleResult:
        breakdown: list[DetectorScore] = []
        for detector in self._detectors:
            if not detector.available:
                continue
            raw = detector.score(waveform, sample_rate)
            if not raw.available:
                continue  # detector failed during scoring; skip rather than poison aggregate
            cal = self._calibration.for_detector(detector.name)
            calibrated = cal.calibrate(raw.raw_score)
            breakdown.append(
                DetectorScore(
                    name=raw.name,
                    score=calibrated,
                    raw_score=raw.raw_score,
                    available=True,
                    meta={**raw.meta, "weight": cal.weight, "threshold": cal.threshold},
                )
            )

        if not breakdown:
            return EnsembleResult(
                score=0.5,
                confidence_low=0.0,
                confidence_high=1.0,
                verdict="UNCERTAIN",
                breakdown=[],
            )

        scores = [b.score for b in breakdown]
        weights = [self._calibration.for_detector(b.name).weight for b in breakdown]
        total_weight = sum(weights) or 1.0
        combined = sum(s * w for s, w in zip(scores, weights)) / total_weight

        if len(scores) > 1:
            var = sum(w * (s - combined) ** 2 for s, w in zip(scores, weights)) / total_weight
            sigma = math.sqrt(max(var, 0.0))
        else:
            sigma = 0.25  # one-detector fallback: wide band signaling low confidence

        low = max(0.0, combined - sigma)
        high = min(1.0, combined + sigma)
        verdict = self._verdict(combined)
        return EnsembleResult(
            score=combined,
            confidence_low=low,
            confidence_high=high,
            verdict=verdict,
            breakdown=breakdown,
        )

    def _verdict(self, score: float) -> str:
        if score >= self._calibration.decision_high:
            return "DEEPFAKE"
        if score <= self._calibration.decision_low:
            return "REAL"
        return "UNCERTAIN"
