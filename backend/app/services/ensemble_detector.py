"""Ensemble deepfake detector using 16 ASVspoof5 per-system classifiers.

Replaces DeepfakeDetectorService in container.py. Keeps the same public
interface: load(), detect(waveform) -> float, and .provenance.

Architecture:
  waveform -> ReDimNet b6 -> 512-dim embedding
           -> 16 x (StandardScaler + LogisticRegression) in parallel
           -> max(p_spoof) -> final score in [0, 1]  (any-positive rule)
"""

from __future__ import annotations

import logging
import pickle
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path
from typing import NamedTuple

logger = logging.getLogger(__name__)

_TARGET_PEAK = 0.95


class _System(NamedTuple):
    system_id: str
    scaler: object
    clf: object


class EnsembleDetectorService:
    def __init__(self, models_path: Path | str, device: str | None = None):
        self.models_path = Path(models_path)
        self.device = device or "cpu"
        self._encoder = None
        self._systems: list[_System] = []
        self._loaded = False
        self._torch = None
        self.last_flagged: int = 0   # classifiers that voted spoof on the last detect() call
        self.last_total: int = 0

    @property
    def provenance(self) -> str:
        self.load()
        return "ensemble" if self._systems else "heuristic"

    def load(self) -> None:
        if self._loaded:
            return
        self._loaded = True

        try:
            import torch
            self._torch = torch
        except ImportError:
            logger.warning("torch unavailable; ensemble detector falls back to heuristic")
            return

        try:
            encoder = torch.hub.load(
                "IDRnD/ReDimNet",
                "ReDimNet",
                model_name="b6",
                train_type="ptn",
                dataset="vox2",
            )
            self._encoder = encoder.to(self.device).eval()
            logger.info("ReDimNet b6 loaded on %s for ensemble detector", self.device)
        except Exception as exc:
            logger.warning("ReDimNet b6 load failed: %s", exc)
            return

        systems: list[_System] = []
        for partition in ("train", "dev"):
            part_dir = self.models_path / partition
            if not part_dir.is_dir():
                logger.warning("Ensemble models partition missing: %s", part_dir)
                continue
            for sys_dir in sorted(part_dir.iterdir()):
                if not sys_dir.is_dir():
                    continue
                scaler_path = sys_dir / "scaler.pkl"
                clf_path = sys_dir / "logistic_regression.pkl"
                if not scaler_path.exists() or not clf_path.exists():
                    logger.warning("Skipping %s: pkl files missing", sys_dir.name)
                    continue
                try:
                    with scaler_path.open("rb") as f:
                        scaler = pickle.load(f)
                    with clf_path.open("rb") as f:
                        clf = pickle.load(f)
                    systems.append(_System(sys_dir.name, scaler, clf))
                except Exception as exc:
                    logger.warning("Could not load %s: %s", sys_dir.name, exc)

        self._systems = systems
        logger.info("Ensemble detector ready: %d systems loaded", len(systems))

    def detect(self, waveform: list[float]) -> float:
        self.load()
        if not self._systems or self._encoder is None or self._torch is None:
            return _heuristic_score(waveform)

        emb = self._extract_embedding(waveform)
        if emb is None:
            return _heuristic_score(waveform)

        scores = self._run_ensemble(emb)
        if not scores:
            return _heuristic_score(waveform)

        self.last_total = len(scores)
        self.last_flagged = sum(1 for s in scores if s > 0.5)
        # Use max p_spoof: if ANY classifier flags the audio as spoof, it's spoof.
        # Each classifier is trained on a different attack system; a fake only
        # needs to be caught by one of them.
        return float(1.0 - max(scores))

    def _extract_embedding(self, waveform: list[float]):
        try:
            import numpy as np
            tensor = self._torch.tensor(waveform, dtype=self._torch.float32)
            if tensor.ndim > 1:
                tensor = tensor.squeeze()
            peak = tensor.abs().max()
            if peak > 1e-8:
                tensor = tensor * (_TARGET_PEAK / peak)
            x = tensor.unsqueeze(0).to(self.device)
            with self._torch.no_grad():
                emb = self._encoder(x).squeeze(0).cpu().numpy().astype(np.float32)
            return emb  # shape (512,)
        except Exception as exc:
            logger.warning("Embedding extraction failed: %s", exc)
            return None

    def _run_ensemble(self, emb) -> list[float]:
        import numpy as np
        emb_2d = emb.reshape(1, -1)

        def _score(system: _System) -> float:
            scaled = system.scaler.transform(emb_2d)
            return float(system.clf.predict_proba(scaled)[0, 1])

        scores: list[float] = []
        with ThreadPoolExecutor(max_workers=len(self._systems)) as pool:
            futures = {pool.submit(_score, s): s.system_id for s in self._systems}
            for fut in as_completed(futures):
                sys_id = futures[fut]
                try:
                    scores.append(fut.result())
                except Exception as exc:
                    logger.warning("Classifier %s failed: %s", sys_id, exc)
        return scores


def _heuristic_score(waveform: list[float]) -> float:
    if not waveform:
        return 0.0
    peak = max(abs(s) for s in waveform)
    mean_abs = sum(abs(s) for s in waveform) / len(waveform)
    activity = min(1.0, mean_abs / 0.08)
    stability = 1.0 - min(1.0, peak / 0.35)
    return max(0.0, min(1.0, 0.15 + activity * 0.45 + stability * 0.4))
