"""Cluster-ensemble deepfake detector using 7 ECAPA-TDNN attack-family classifiers.

Replaces EnsembleDetectorService in container.py. Keeps the same public
interface: load(), detect(waveform) -> float, and .provenance, plus a new
.last_top_cluster attribute for explainability.

Architecture:
  waveform -> ECAPA-TDNN (speechbrain) -> 192-dim raw embedding
           -> 7 x (StandardScaler + LogisticRegression) in parallel, one per
              attack-family cluster (K=7 hierarchical clustering of the 32
              ASVspoof5 attack systems)
           -> max(p_spoof) -> final score in [0, 1]  (any-positive rule)
           -> winning cluster's semantic label surfaced as .last_top_cluster
"""

from __future__ import annotations

import csv
import json
import logging
import pickle
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path
from typing import NamedTuple

from app.services.ensemble_detector import _heuristic_score  # reuse fallback

logger = logging.getLogger(__name__)

_TARGET_PEAK = 0.95
_BACKBONE = "ECAPA"  # filter row in cluster_semantic_labels.csv


class _ClusterMeta(NamedTuple):
    cluster_id: int
    label: str          # suggested_label from CSV (backbone == "ECAPA")
    members: list[str]  # from cluster_N/members.json


class _ClusterSystem(NamedTuple):
    cluster_id: int
    scaler: object       # LR StandardScaler
    clf: object          # LR LogisticRegression
    xgb: object | None   # XGBClassifier on raw embeddings, or None if unavailable
    meta: _ClusterMeta


class TopClusterInfo(NamedTuple):
    cluster_id: int
    label: str
    p_spoof: float
    members: list[str]


class ClusterEnsembleDetectorService:
    def __init__(self, models_path: Path | str, ecapa_savedir: Path | str | None = None,
                 ecapa_source: str = "speechbrain/spkrec-ecapa-voxceleb", device: str | None = None,
                 use_xgb: bool = False):
        self.models_path = Path(models_path)
        self.ecapa_savedir = Path(ecapa_savedir) if ecapa_savedir else None
        self.ecapa_source = ecapa_source
        self.device = device or "cpu"
        self.use_xgb = bool(use_xgb)   # runtime-switchable: prefer XGB when available
        self._xgb_available = False     # set in load(): True iff every cluster has an XGB model
        self._encoder = None        # speechbrain EncoderClassifier
        self._torch = None
        self._clusters: list[_ClusterSystem] = []
        self._loaded = False
        self.last_flagged: int = 0   # clusters that voted spoof on the last detect() call
        self.last_total: int = 0
        self.last_top_cluster: TopClusterInfo | None = None

    @property
    def provenance(self) -> str:
        self.load()
        if not self._clusters:
            return "heuristic"
        return "ecapa_cluster_ensemble_xgb" if self._xgb_active else "ecapa_cluster_ensemble"

    @property
    def xgb_available(self) -> bool:
        """True when every loaded cluster has an XGB model (so the toggle is usable)."""
        self.load()
        return self._xgb_available

    @property
    def _xgb_active(self) -> bool:
        """Effective backend: XGB only when requested AND fully available."""
        return bool(self.use_xgb and self._xgb_available)

    def load(self) -> None:
        if self._loaded:
            return
        self._loaded = True

        try:
            import torch
            self._torch = torch
        except ImportError:
            logger.warning("torch unavailable; cluster detector falls back to heuristic")
            return

        cluster_meta = self._load_cluster_metadata()
        if not cluster_meta:
            logger.warning("No ECAPA cluster metadata found under %s", self.models_path)
            return

        try:
            from speechbrain.inference.speaker import EncoderClassifier
            kwargs = {"source": self.ecapa_source}
            if self.ecapa_savedir is not None:
                kwargs["savedir"] = str(self.ecapa_savedir)
            self._encoder = EncoderClassifier.from_hparams(**kwargs)
            logger.info("ECAPA-TDNN encoder loaded for cluster detector")
        except Exception as exc:
            logger.warning("ECAPA-TDNN encoder load failed: %s", exc)
            self._encoder = None
            return

        # XGBClassifier is optional — only needed if xgboost.json files exist.
        xgb_cls = None
        try:
            from xgboost import XGBClassifier
            xgb_cls = XGBClassifier
        except ImportError:
            logger.info("xgboost not installed; cluster detector runs LR-only")

        clusters: list[_ClusterSystem] = []
        xgb_count = 0
        for cid, meta in cluster_meta.items():
            cdir = self.models_path / f"cluster_{cid}"
            scaler_path = cdir / "scaler.pkl"
            clf_path = cdir / "logistic_regression.pkl"
            xgb_path = cdir / "xgboost.json"

            # LR is the baseline and is required.
            if not scaler_path.exists() or not clf_path.exists():
                logger.warning("Skipping cluster_%d: LR pkl files missing", cid)
                continue
            try:
                with scaler_path.open("rb") as f:
                    scaler = pickle.load(f)
                with clf_path.open("rb") as f:
                    clf = pickle.load(f)
            except Exception as exc:
                logger.warning("Could not load LR cluster_%d: %s", cid, exc)
                continue

            # XGB is optional and loaded alongside LR so the backend can be
            # switched at runtime (scored on raw embeddings, no scaler).
            xgb = None
            if xgb_cls is not None and xgb_path.exists():
                try:
                    xgb = xgb_cls()
                    xgb.load_model(str(xgb_path))
                    xgb_count += 1
                except Exception as exc:
                    logger.warning("Could not load XGB cluster_%d (%s); LR only for it", cid, exc)
                    xgb = None

            clusters.append(_ClusterSystem(cid, scaler, clf, xgb, meta))

        self._clusters = clusters
        self._xgb_available = bool(clusters) and xgb_count == len(clusters)
        logger.info(
            "Cluster ensemble detector ready: %d clusters loaded (XGB available: %s, active backend: %s)",
            len(clusters), self._xgb_available, "XGB" if self._xgb_active else "LR",
        )

    def _load_cluster_metadata(self) -> dict[int, _ClusterMeta]:
        """Parse cluster_semantic_labels.csv (backbone==ECAPA rows) for
        suggested_label, and each cluster_N/members.json for member ids."""
        csv_path = self.models_path / "cluster_semantic_labels.csv"
        labels: dict[int, str] = {}
        if csv_path.exists():
            with csv_path.open(newline="", encoding="utf-8") as f:
                for row in csv.DictReader(f):
                    if row.get("backbone") != _BACKBONE:
                        continue
                    try:
                        cid = int(row["cluster_id"])
                    except (KeyError, ValueError):
                        continue
                    labels[cid] = row.get("suggested_label", f"Cluster {cid}")
        else:
            logger.warning("cluster_semantic_labels.csv missing at %s", csv_path)

        out: dict[int, _ClusterMeta] = {}
        for cid, label in labels.items():
            members_path = self.models_path / f"cluster_{cid}" / "members.json"
            members: list[str] = []
            if members_path.exists():
                try:
                    members = json.loads(members_path.read_text(encoding="utf-8"))
                except Exception as exc:
                    logger.warning("Could not parse %s: %s", members_path, exc)
            out[cid] = _ClusterMeta(cluster_id=cid, label=label, members=members)
        return out

    def detect(self, waveform: list[float]) -> float:
        self.load()
        if not self._clusters or self._encoder is None or self._torch is None:
            self.last_top_cluster = None
            return _heuristic_score(waveform)

        emb = self._extract_embedding(waveform)
        if emb is None:
            self.last_top_cluster = None
            return _heuristic_score(waveform)

        results = self._run_clusters(emb)
        if not results:
            self.last_top_cluster = None
            return _heuristic_score(waveform)

        self.last_total = len(results)
        self.last_flagged = sum(1 for _, p in results if p > 0.5)

        top_system, top_p = max(results, key=lambda item: item[1])
        self.last_top_cluster = TopClusterInfo(
            cluster_id=top_system.meta.cluster_id,
            label=top_system.meta.label,
            p_spoof=float(top_p),
            members=list(top_system.meta.members),
        )

        # Same "any-positive" rule as the 16-system ensemble.
        return float(1.0 - top_p)

    def _extract_embedding(self, waveform: list[float]):
        try:
            import numpy as np
            tensor = self._torch.tensor(waveform, dtype=self._torch.float32)
            if tensor.ndim > 1:
                tensor = tensor.squeeze()
            peak = tensor.abs().max()
            if peak > 1e-8:
                tensor = tensor * (_TARGET_PEAK / peak)
            x = tensor.unsqueeze(0)
            with self._torch.no_grad():
                emb = self._encoder.encode_batch(x).squeeze()
            # IMPORTANT: do NOT L2-normalize -- cluster scalers were fit on
            # raw embeddings (scaler.mean_ norm ~81).
            return emb.cpu().numpy().astype(np.float32)  # shape (192,)
        except Exception as exc:
            logger.warning("ECAPA embedding extraction failed: %s", exc)
            return None

    def _run_clusters(self, emb) -> list[tuple[_ClusterSystem, float]]:
        emb_2d = emb.reshape(1, -1)

        use_xgb = self._xgb_active

        def _score(system: _ClusterSystem) -> tuple[_ClusterSystem, float]:
            if use_xgb and system.xgb is not None:
                p_spoof = float(system.xgb.predict_proba(emb_2d)[0, 1])  # raw embeddings
            else:
                p_spoof = float(system.clf.predict_proba(system.scaler.transform(emb_2d))[0, 1])
            return system, p_spoof

        results: list[tuple[_ClusterSystem, float]] = []
        with ThreadPoolExecutor(max_workers=len(self._clusters)) as pool:
            futures = {pool.submit(_score, s): s.meta.cluster_id for s in self._clusters}
            for fut in as_completed(futures):
                cid = futures[fut]
                try:
                    results.append(fut.result())
                except Exception as exc:
                    logger.warning("Cluster %d classifier failed: %s", cid, exc)
        return results
