"""F4 — sub-classifier that produces the four AnalysisDetails axes from
acoustic features.

Two operating modes:

  1. **Probe-head mode** — when `aasist_heads.pt` is present in the models
     directory, load 4 small MLP heads (input dim = FEATURE_DIM, hidden 64,
     sigmoid output) and run the feature vector through each. This is the
     production path documented in `docs/paper/sub_classifier.md`.
  2. **Heuristic mode** — when no heads are bundled, derive the four axes
     directly from interpretable acoustic features (HNR for naturalness,
     spectral flatness for spectral consistency, F0 stability for temporal
     patterns, spectral flatness inverse for artifact detection). This is
     a real, audio-derived computation — every axis varies with the actual
     recording. **Not** the seeded-jitter placeholder it replaces (which
     just perturbed the global deepfake score).

The mode is selected automatically at construction time. The runtime API
is identical so verification.py doesn't need to know which path it gets.
"""

from __future__ import annotations

import logging
from pathlib import Path

import numpy as np

from app.schemas import AnalysisDetails
from app.services.acoustic_features import (
    AcousticFeatures,
    FEATURE_DIM,
    extract as extract_features,
)


logger = logging.getLogger(__name__)


class AcousticProbe:
    """Maps a recording's acoustic feature vector to the four
    AnalysisDetails axes. See module docstring for mode selection."""

    def __init__(self, heads_path: Path | None = None):
        self.heads_path = Path(heads_path) if heads_path else None
        self.heads = None  # populated lazily on first score() call
        self._torch = None

    @property
    def provenance(self) -> str:
        """`"trained_heads"` once the per-axis MLPs are loaded;
        `"heuristic"` otherwise. v1.0 ships without trained heads —
        every operator gets `"heuristic"`. Settles after the first
        `score()` call (lazy load); call `_ensure_loaded()` first if
        you need the value before any audio scoring."""
        return "trained_heads" if self.heads is not None else "heuristic"

    def _ensure_loaded(self) -> None:
        if self.heads is not None:
            return
        if self.heads_path is None or not self.heads_path.exists():
            return  # heuristic mode

        try:
            import torch
        except Exception as exc:  # pragma: no cover — torch is in [model] extra
            logger.warning("torch unavailable for sub-classifier heads: %s", exc)
            return

        state = torch.load(str(self.heads_path), map_location="cpu", weights_only=True)
        # Expected layout: {"voice_naturalness": ..., "spectral_consistency": ...,
        # "temporal_patterns": ..., "artifact_detection": ...}
        # Each value is a state dict for `_MLPHead`.
        if not isinstance(state, dict) or set(state.keys()) != _AXIS_NAMES:
            logger.warning(
                "sub_classifier heads file %s has unexpected layout (keys=%s); "
                "falling back to heuristic mode",
                self.heads_path,
                list(state.keys()) if isinstance(state, dict) else type(state).__name__,
            )
            return

        self._torch = torch
        self.heads = {
            name: _load_head(torch, sd) for name, sd in state.items()
        }

    def score(self, waveform: list[float], sample_rate: int = 16_000) -> AnalysisDetails:
        """Return the four-axis AnalysisDetails for `waveform`."""
        self._ensure_loaded()
        features = extract_features(waveform, sample_rate)
        if self.heads is not None:
            return self._score_with_heads(features)
        return self._score_heuristic(features)

    # -------------------------------------------------------------------------
    # Mode 1 — trained heads
    # -------------------------------------------------------------------------

    def _score_with_heads(self, features: AcousticFeatures) -> AnalysisDetails:
        torch = self._torch
        x = torch.tensor(features.vector, dtype=torch.float32).unsqueeze(0)
        scores = {}
        with torch.no_grad():
            for axis, head in self.heads.items():
                logit = head(x)
                scores[axis] = float(torch.sigmoid(logit).item())
        return AnalysisDetails(
            voice_naturalness=_clamp(scores["voice_naturalness"]),
            spectral_consistency=_clamp(scores["spectral_consistency"]),
            temporal_patterns=_clamp(scores["temporal_patterns"]),
            artifact_detection=_clamp(scores["artifact_detection"]),
            mode="trained_heads",
        )

    # -------------------------------------------------------------------------
    # Mode 2 — heuristic (no trained heads bundled)
    # -------------------------------------------------------------------------

    def _score_heuristic(self, features: AcousticFeatures) -> AnalysisDetails:
        """Direct mapping from interpretable features to the four axes.
        Each formula is a sigmoid-like squash so the output stays in
        [0, 1] regardless of the feature's natural range. Documented in
        `docs/paper/sub_classifier.md` §3.

        Real audio properties drive each axis — different recordings get
        different scores. This is the explicit replacement for the
        seeded-jitter placeholder.
        """
        # Voice naturalness: high HNR (clean periodic harmonic content) +
        # voiced ratio. HNR > 12 dB is "very natural"; < 0 dB is noisy.
        hnr_norm = _sigmoid_squash(features.hnr_db, centre=8.0, scale=4.0)
        voiced_norm = features.voiced_ratio
        voice_naturalness = 0.6 * hnr_norm + 0.4 * voiced_norm

        # Spectral consistency: low spectral flatness = tonal / harmonic =
        # consistent across time. flatness near 1.0 = noisy; near 0 = pure tone.
        # Real speech sits around 0.05-0.2; synthetic TTS often higher.
        flatness_inv = 1.0 - min(1.0, features.spectral_flatness_mean / 0.5)
        spectral_consistency = flatness_inv

        # Temporal patterns: F0 stability + voiced presence. A natural
        # speaker has some F0 variation (prosody) but not white-noise
        # variance. F0 std in [10, 80] Hz is the prosody sweet spot.
        if features.f0_std_hz <= 0.0:
            f0_score = 0.3 if features.voiced_ratio < 0.05 else 0.5
        else:
            # Distance from the prosody centre (45 Hz std), with a wide tolerance.
            f0_score = max(0.0, 1.0 - abs(features.f0_std_hz - 45.0) / 60.0)
        temporal_patterns = 0.7 * f0_score + 0.3 * voiced_norm

        # Artifact detection: high values mean FEW artifacts (consistent
        # with the existing schema's contract — 1.0 = clean). Use the
        # combination of HNR (artifacts kill HNR) and inverted flatness.
        artifact_score = 0.5 * hnr_norm + 0.5 * flatness_inv

        return AnalysisDetails(
            voice_naturalness=_clamp(voice_naturalness),
            spectral_consistency=_clamp(spectral_consistency),
            temporal_patterns=_clamp(temporal_patterns),
            artifact_detection=_clamp(artifact_score),
            mode="heuristic",
        )


# -----------------------------------------------------------------------------
# Trained-head plumbing (training script in scripts/train_sub_classifier.py)
# -----------------------------------------------------------------------------


_AXIS_NAMES = {
    "voice_naturalness",
    "spectral_consistency",
    "temporal_patterns",
    "artifact_detection",
}


def _load_head(torch, state_dict):
    head = _MLPHead(FEATURE_DIM)
    head.load_state_dict(state_dict)
    head.eval()
    return head


class _MLPHead:
    """Tiny torch module used both at training time and at inference. Kept
    as a hand-rolled class (not torch.nn.Module) so importing this file
    doesn't cost a torch import unless the heads exist."""

    def __init__(self, input_dim: int, hidden: int = 64):
        # Imported lazily — this class is only instantiated when torch is
        # already in scope (set up by AcousticProbe._ensure_loaded).
        import torch
        self.fc1 = torch.nn.Linear(input_dim, hidden)
        self.fc2 = torch.nn.Linear(hidden, 1)

    def __call__(self, x):
        import torch
        h = torch.relu(self.fc1(x))
        return self.fc2(h)

    def state_dict(self):
        return {"fc1": self.fc1.state_dict(), "fc2": self.fc2.state_dict()}

    def load_state_dict(self, sd):
        self.fc1.load_state_dict(sd["fc1"])
        self.fc2.load_state_dict(sd["fc2"])

    def eval(self):
        self.fc1.eval()
        self.fc2.eval()


def _sigmoid_squash(value: float, *, centre: float, scale: float) -> float:
    """Logistic squash centred at `centre` with the given slope `scale`."""
    return float(1.0 / (1.0 + np.exp(-(value - centre) / scale)))


def _clamp(value: float) -> float:
    if value < 0.0:
        return 0.0
    if value > 1.0:
        return 1.0
    return value
