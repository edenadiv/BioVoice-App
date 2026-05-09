"""Deepfake detection service built around the vendored AASIST model."""

from __future__ import annotations

import logging
from pathlib import Path

logger = logging.getLogger(__name__)


class DeepfakeDetectorService:
    def __init__(self, weights_path: Path | None = None, device: str | None = None):
        self.device = device or "cpu"
        self.weights_path = Path(weights_path) if weights_path else None
        self.model = None
        self._torch = None
        self._target_peak = 0.05

    def load(self) -> None:
        if self.model is not None:
            return

        try:
            import torch
            # G1 — locally vendored under `app/vendor/aasist/` (was a stale
            # `biovoice.core.vendor.aasist` namespace that never resolved).
            from app.vendor.aasist.aasist_model import AASISTModel, AASIST_CONFIG
        except Exception as exc:  # pragma: no cover - optional dependency path
            logger.warning("AASIST optional dependencies unavailable: %s", exc)
            self.model = None
            self._torch = None
            return

        if self.weights_path is None or not self.weights_path.exists():
            logger.warning("AASIST weights not found at %s; using heuristic detector", self.weights_path)
            self.model = None
            self._torch = torch
            return

        logger.info("Loading AASIST weights from %s", self.weights_path)
        model = AASISTModel(AASIST_CONFIG)
        state_dict = torch.load(str(self.weights_path), map_location=self.device, weights_only=True)
        model.load_state_dict(state_dict)
        self.model = model.to(self.device).eval()
        self._torch = torch

    def detect(self, waveform: list[float]) -> float:
        self.load()
        if self.model is None or self._torch is None:
            return self._heuristic_score(waveform)

        tensor = self._prepare_waveform(waveform)
        x = tensor.unsqueeze(0).to(self.device)
        _, logits = self.model(x)
        probs = self._torch.nn.functional.softmax(logits, dim=-1)
        return float(probs[0, 1].item())

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

    @staticmethod
    def _heuristic_score(waveform: list[float]) -> float:
        if not waveform:
            return 0.0
        peak = max(abs(sample) for sample in waveform)
        mean_abs = sum(abs(sample) for sample in waveform) / len(waveform)
        activity = min(1.0, mean_abs / 0.08)
        stability = 1.0 - min(1.0, peak / 0.35)
        score = 0.15 + (activity * 0.45) + (stability * 0.4)
        return max(0.0, min(1.0, score))
