"""AASIST-based deepfake/spoof detection wrapper."""

import logging
from pathlib import Path

import numpy as np
import torch
import torch.nn.functional as F

from biovoice.core.vendor.aasist import AASIST_CONFIG, AASIST_INPUT_LEN, AASISTModel
from biovoice.utils.constants import DEEPFAKE_THRESHOLD, SAMPLE_RATE

logger = logging.getLogger(__name__)


class DeepfakeDetector:
    """Wraps AASIST for deepfake/spoof audio detection.

    Input:  raw waveform (mono, 16 kHz)
    Output: genuineness score in [0, 1] where higher = more likely genuine
    """

    def __init__(self, weights_path: str | Path | None = None, device: str | None = None):
        self.device = device or ("cuda" if torch.cuda.is_available() else "cpu")
        self.weights_path = Path(weights_path) if weights_path else None
        self.model: AASISTModel | None = None
        self.threshold = DEEPFAKE_THRESHOLD

    def load_model(self) -> None:
        """Load AASIST model and optionally pretrained weights."""
        logger.info("Loading AASIST deepfake detection model...")
        self.model = AASISTModel(AASIST_CONFIG)

        if not self.weights_path or not self.weights_path.exists():
            raise FileNotFoundError(
                f"AASIST weights not found at '{self.weights_path}'. "
                "Place the pretrained weights file there before running."
            )

        state_dict = torch.load(
            str(self.weights_path), map_location=self.device, weights_only=True
        )
        self.model.load_state_dict(state_dict)
        logger.info("Loaded AASIST weights from %s", self.weights_path)

        self.model = self.model.to(self.device)
        self.model.eval()
        logger.info("AASIST loaded on %s", self.device)

    def _pad_or_trim(self, waveform: torch.Tensor) -> torch.Tensor:
        """Pad or trim waveform to AASIST's expected input length (64600 samples)."""
        length = waveform.shape[-1]
        if length > AASIST_INPUT_LEN:
            waveform = waveform[..., :AASIST_INPUT_LEN]
        elif length < AASIST_INPUT_LEN:
            pad_len = AASIST_INPUT_LEN - length
            waveform = F.pad(waveform, (0, pad_len))
        return waveform

    # Target peak amplitude matching ASVspoof 2019 LA operating range.
    # AASIST is amplitude-sensitive: at peak ~0.05, real speech scores ~0.93
    # (genuine) while noise/synthetic scores ~0.02 (spoof). Above peak ~0.10,
    # even real speech gets misclassified as spoof.
    _TARGET_PEAK = 0.05

    @torch.no_grad()
    def detect(self, waveform: torch.Tensor) -> float:
        """Run deepfake detection on a waveform.

        Args:
            waveform: shape [1, T] — mono audio at 16 kHz (any amplitude)

        Returns:
            Score in [0, 1]. Higher = more likely genuine.
        """
        if self.model is None:
            raise RuntimeError("Model not loaded. Call load_model() first.")

        # Squeeze to [T] if [1, T]
        if waveform.ndim == 2:
            waveform = waveform.squeeze(0)

        waveform = self._pad_or_trim(waveform)

        # Scale to target peak amplitude for AASIST's trained operating range.
        peak = waveform.abs().max()
        if peak > 1e-8:
            waveform = waveform * (self._TARGET_PEAK / peak)

        x = waveform.unsqueeze(0).to(self.device)  # [1, 64600]

        _, logits = self.model(x)  # logits: [1, 2]
        # Apply softmax: index 1 = bonafide, index 0 = spoof (clovaai/aasist convention)
        probs = F.softmax(logits, dim=-1)
        genuine_score = probs[0, 1].item()

        return genuine_score

    def is_genuine(self, score: float) -> bool:
        """Check if the score indicates genuine audio."""
        return score >= self.threshold
