"""RawNet2 detector adapter (stub).

Drop weights at the configured `rawnet2_weights_path`, then implement
`_load_lazy` / `score` against a RawNet2 model (e.g. ASVspoof 2021 baseline).
Until then this detector reports `available=False` and is skipped by the
ensemble.
"""

from __future__ import annotations

import logging
from pathlib import Path

from app.services.detectors.base import Detector, DetectorScore

logger = logging.getLogger(__name__)


class RawNet2Detector(Detector):
    name = "rawnet2"

    def __init__(self, weights_path: Path | None = None, device: str | None = None):
        self.weights_path = Path(weights_path) if weights_path else None
        self.device = device or "cpu"

    @property
    def available(self) -> bool:
        return False  # implement when weights + model code are added

    def score(self, waveform: list[float], sample_rate: int) -> DetectorScore:
        return DetectorScore(
            name=self.name,
            score=0.5,
            raw_score=0.5,
            available=False,
            meta={"reason": "RawNet2 adapter not implemented"},
        )
