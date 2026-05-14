"""AASIST detector (ASVspoof 2019 baseline). Score = P(spoof)."""

from __future__ import annotations

import logging
from pathlib import Path

from app.services.detectors.base import Detector, DetectorScore

logger = logging.getLogger(__name__)


class AASISTDetector(Detector):
    name = "aasist"

    def __init__(self, weights_path: Path | None = None, device: str | None = None):
        self.device = device or "cpu"
        self.weights_path = Path(weights_path) if weights_path else None
        self._model = None
        self._torch = None
        self._target_peak = 0.05
        self._loaded = False

    @property
    def available(self) -> bool:
        self._load_lazy()
        return self._model is not None

    def score(self, waveform: list[float], sample_rate: int) -> DetectorScore:
        self._load_lazy()
        if self._model is None or self._torch is None:
            return DetectorScore(
                name=self.name,
                score=0.5,
                raw_score=0.5,
                available=False,
                meta={"reason": "weights or torch unavailable"},
            )

        tensor = self._prepare_waveform(waveform)
        x = tensor.unsqueeze(0).to(self.device)
        try:
            _, logits = self._model(x)
            probs = self._torch.nn.functional.softmax(logits, dim=-1)
            spoof_prob = float(probs[0, 1].item())
        except Exception as exc:
            logger.warning("AASIST forward pass failed: %s", exc)
            return DetectorScore(
                name=self.name,
                score=0.5,
                raw_score=0.5,
                available=False,
                meta={"error": str(exc)},
            )

        return DetectorScore(
            name=self.name,
            score=spoof_prob,
            raw_score=spoof_prob,
            available=True,
            meta={"input_samples": int(tensor.numel())},
        )

    def _load_lazy(self) -> None:
        if self._loaded:
            return
        self._loaded = True
        try:
            import torch
            from app.vendor.aasist.aasist_model import AASIST_CONFIG, AASISTModel
        except Exception as exc:
            logger.warning("AASIST optional dependencies unavailable: %s", exc)
            return

        self._torch = torch
        if self.weights_path is None or not self.weights_path.exists():
            logger.warning("AASIST weights not found at %s; detector disabled", self.weights_path)
            return

        logger.info("Loading AASIST weights from %s", self.weights_path)
        model = AASISTModel(AASIST_CONFIG)
        state_dict = torch.load(str(self.weights_path), map_location=self.device, weights_only=True)
        missing, unexpected = model.load_state_dict(state_dict, strict=False)
        if unexpected:
            logger.warning("Unexpected AASIST keys (ignored): %s", unexpected)
        if missing:
            logger.info("AASIST keys not in checkpoint (init): %s", missing)
        self._model = model.to(self.device).eval()

    def _prepare_waveform(self, waveform: list[float]):
        tensor = self._torch.tensor(waveform, dtype=self._torch.float32)
        if tensor.ndim > 1:
            tensor = tensor.squeeze()

        input_len = 64600
        if tensor.numel() > input_len:
            tensor = tensor[:input_len]
        elif tensor.numel() < input_len:
            pad_len = input_len - tensor.numel()
            tensor = self._torch.nn.functional.pad(tensor, (0, pad_len))

        peak = tensor.abs().max()
        if peak > 1e-8:
            tensor = tensor * (self._target_peak / peak)
        return tensor
