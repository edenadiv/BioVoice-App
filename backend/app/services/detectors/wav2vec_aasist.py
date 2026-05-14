"""Wav2Vec-AASIST detector adapter (stub).

A modern variant of AASIST that replaces the SincNet frontend with a
self-supervised wav2vec2 / XLS-R encoder. Strong out-of-distribution
performance vs. the 2019 AASIST baseline.

To enable:
  1. Get weights. Candidate sources:
       - https://huggingface.co/yangwang825/wav2vec2-base-aasist
       - https://github.com/TakHemlata/SSL_Anti-spoofing  (release weights)
     Save under `backend/models/wav2vec_aasist.pt` (or set
     `WAV2VEC_AASIST_WEIGHTS_PATH`).
  2. Implement `_load_lazy`: instantiate the matching architecture (wav2vec2
     frontend + AASIST graph backend) and load `state_dict`.
  3. Implement `score`: feed (waveform, sample_rate) through the model and
     softmax → P(spoof). Return `available=True`.

Until the loader is implemented this detector reports `available=False` and
is skipped by the ensemble.
"""

from __future__ import annotations

import logging
from pathlib import Path

from app.services.detectors.base import Detector, DetectorScore

logger = logging.getLogger(__name__)


class Wav2VecAASISTDetector(Detector):
    name = "wav2vec_aasist"

    def __init__(self, weights_path: Path | None = None, device: str | None = None):
        self.weights_path = Path(weights_path) if weights_path else None
        self.device = device or "cpu"

    @property
    def available(self) -> bool:
        return False

    def score(self, waveform: list[float], sample_rate: int) -> DetectorScore:
        return DetectorScore(
            name=self.name,
            score=0.5,
            raw_score=0.5,
            available=False,
            meta={"reason": "Wav2Vec-AASIST adapter not implemented; see module docstring"},
        )
