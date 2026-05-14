"""Signal-based prosody detector.

Real human speech has micro-variation (pitch jitter, energy variance,
breath/silence, formant richness) that current TTS often under-produces.
We extract a handful of features and combine them into a P(synthetic) score.

Backends, picked at runtime per feature:
  - parselmouth (Praat) → jitter, shimmer, HNR  (gold standard when available)
  - librosa             → MFCC mean + std       (40 dims)
  - numpy fallback      → autocorrelation pitch, ZCR, energy, spectral flatness

This is NOT a trained model — it is a calibratable heuristic. Use the
calibration CLI to fit a Platt-scaled threshold on real data.
"""

from __future__ import annotations

import logging

from app.services.detectors.base import Detector, DetectorScore

logger = logging.getLogger(__name__)

_FRAME_MS = 30
_HOP_MS = 10
_F0_MIN = 70
_F0_MAX = 400
_VOICED_AUTOCORR_THRESHOLD = 0.3


class ProsodyDetector(Detector):
    name = "prosody"

    def __init__(self) -> None:
        self._np = None
        self._praat = None
        self._librosa = None
        self._loaded = False

    @property
    def available(self) -> bool:
        self._load_lazy()
        return self._np is not None

    def score(self, waveform: list[float], sample_rate: int) -> DetectorScore:
        self._load_lazy()
        if self._np is None:
            return DetectorScore(
                name=self.name,
                score=0.5,
                raw_score=0.5,
                available=False,
                meta={"reason": "numpy unavailable"},
            )

        np = self._np
        signal = np.asarray(waveform, dtype=np.float32)
        if signal.size < int(sample_rate * 0.5):
            return DetectorScore(
                name=self.name,
                score=0.5,
                raw_score=0.5,
                available=False,
                meta={"reason": "audio too short (<0.5s)"},
            )

        features: dict = {}
        features.update(self._praat_features(signal, sample_rate))
        features.update(self._numpy_features(signal, sample_rate))
        features.update(self._librosa_features(signal, sample_rate))

        raw = _features_to_score(features)
        return DetectorScore(
            name=self.name,
            score=raw,
            raw_score=raw,
            available=True,
            meta=features,
        )

    def _load_lazy(self) -> None:
        if self._loaded:
            return
        self._loaded = True
        try:
            import numpy as np
        except Exception as exc:
            logger.warning("ProsodyDetector requires numpy: %s", exc)
            return
        self._np = np

        try:
            import parselmouth
            self._praat = parselmouth
        except Exception as exc:
            logger.info("parselmouth unavailable, falling back to numpy prosody: %s", exc)

        try:
            import librosa
            self._librosa = librosa
        except Exception as exc:
            logger.info("librosa unavailable, skipping MFCC features: %s", exc)

    def _praat_features(self, signal, sr: int) -> dict:
        if self._praat is None:
            return {}
        try:
            sound = self._praat.Sound(signal.astype("float64"), sampling_frequency=sr)
            point_process = self._praat.praat.call(sound, "To PointProcess (periodic, cc)", _F0_MIN, _F0_MAX)
            jitter_local = self._praat.praat.call(
                point_process, "Get jitter (local)", 0.0, 0.0, 0.0001, 0.02, 1.3
            )
            shimmer_local = self._praat.praat.call(
                [sound, point_process], "Get shimmer (local)", 0.0, 0.0, 0.0001, 0.02, 1.3, 1.6
            )
            harmonicity = self._praat.praat.call(sound, "To Harmonicity (cc)", 0.01, _F0_MIN, 0.1, 1.0)
            hnr_db = self._praat.praat.call(harmonicity, "Get mean", 0.0, 0.0)
            pitch = self._praat.praat.call(sound, "To Pitch", 0.0, _F0_MIN, _F0_MAX)
            f0_mean = self._praat.praat.call(pitch, "Get mean", 0.0, 0.0, "Hertz")
            f0_std = self._praat.praat.call(pitch, "Get standard deviation", 0.0, 0.0, "Hertz")
            return {
                "praat_jitter_local": _safe(jitter_local),
                "praat_shimmer_local": _safe(shimmer_local),
                "praat_hnr_db": _safe(hnr_db),
                "praat_f0_mean_hz": _safe(f0_mean),
                "praat_f0_std_hz": _safe(f0_std),
            }
        except Exception as exc:
            logger.warning("Praat feature extraction failed: %s", exc)
            return {"praat_error": str(exc)[:120]}

    def _numpy_features(self, signal, sr: int) -> dict:
        np = self._np
        frame_len = int(sr * _FRAME_MS / 1000)
        hop_len = int(sr * _HOP_MS / 1000)
        n_frames = max(1, 1 + (len(signal) - frame_len) // hop_len)

        f0_series = []
        energies = np.empty(n_frames, dtype=np.float32)
        zcrs = np.empty(n_frames, dtype=np.float32)
        lag_min = int(sr / _F0_MAX)
        lag_max = int(sr / _F0_MIN)

        for i in range(n_frames):
            start = i * hop_len
            frame = signal[start : start + frame_len]
            if frame.size < frame_len:
                break
            energies[i] = float(np.sqrt(np.mean(frame * frame)))
            zcrs[i] = float(np.mean(np.abs(np.diff(np.sign(frame))) > 0))
            f0 = _estimate_f0(np, frame, sr, lag_min, lag_max)
            if f0 is not None:
                f0_series.append(f0)

        f0_arr = np.asarray(f0_series, dtype=np.float32) if f0_series else np.zeros(0, dtype=np.float32)
        voiced_ratio = float(f0_arr.size / max(n_frames, 1))
        f0_mean = float(np.mean(f0_arr)) if f0_arr.size else 0.0
        f0_std = float(np.std(f0_arr)) if f0_arr.size else 0.0
        if f0_arr.size > 1 and f0_mean > 0:
            jitter_fallback = float(np.mean(np.abs(np.diff(f0_arr))) / f0_mean)
        else:
            jitter_fallback = 0.0

        energy_db = 20 * np.log10(np.maximum(energies, 1e-8))
        silence_threshold = float(np.percentile(energy_db, 40)) - 6.0
        silence_ratio = float(np.mean(energy_db < silence_threshold))
        energy_std = float(np.std(energies))

        spec_flatness = _spectral_flatness(np, signal, frame_len, hop_len)
        zcr_std = float(np.std(zcrs))

        return {
            "voiced_ratio": round(voiced_ratio, 4),
            "f0_mean_hz": round(f0_mean, 2),
            "f0_std_hz": round(f0_std, 2),
            "f0_jitter_fallback": round(jitter_fallback, 5),
            "silence_ratio": round(silence_ratio, 4),
            "energy_std": round(energy_std, 5),
            "zcr_std": round(zcr_std, 5),
            "spectral_flatness_mean": round(float(np.mean(spec_flatness)), 4) if spec_flatness.size else 0.0,
            "spectral_flatness_std": round(float(np.std(spec_flatness)), 4) if spec_flatness.size else 0.0,
        }

    def _librosa_features(self, signal, sr: int) -> dict:
        if self._librosa is None:
            return {}
        try:
            mfcc = self._librosa.feature.mfcc(y=signal.astype("float32"), sr=sr, n_mfcc=20)
            return {
                "mfcc_means": [round(float(v), 4) for v in mfcc.mean(axis=1).tolist()],
                "mfcc_stds": [round(float(v), 4) for v in mfcc.std(axis=1).tolist()],
            }
        except Exception as exc:
            logger.warning("librosa MFCC extraction failed: %s", exc)
            return {"librosa_error": str(exc)[:120]}


def _safe(value) -> float | None:
    try:
        f = float(value)
    except (TypeError, ValueError):
        return None
    if f != f or f in (float("inf"), float("-inf")):  # NaN / inf
        return None
    return round(f, 5)


def _estimate_f0(np, frame, sr: int, lag_min: int, lag_max: int) -> float | None:
    if frame.size < lag_max + 1:
        return None
    frame = frame - frame.mean()
    autocorr = np.correlate(frame, frame, mode="full")
    autocorr = autocorr[autocorr.size // 2 :]
    if autocorr[0] <= 1e-8:
        return None
    region = autocorr[lag_min : min(lag_max, autocorr.size)]
    if region.size == 0:
        return None
    peak = int(np.argmax(region))
    if region[peak] < _VOICED_AUTOCORR_THRESHOLD * autocorr[0]:
        return None
    lag_samples = lag_min + peak
    if lag_samples <= 0:
        return None
    return float(sr) / float(lag_samples)


def _spectral_flatness(np, signal, frame_len: int, hop_len: int):
    n_frames = max(0, 1 + (len(signal) - frame_len) // hop_len)
    if n_frames == 0:
        return np.zeros(0, dtype=np.float32)
    window = np.hanning(frame_len).astype(np.float32)
    out = np.empty(n_frames, dtype=np.float32)
    for i in range(n_frames):
        frame = signal[i * hop_len : i * hop_len + frame_len] * window
        spec = np.abs(np.fft.rfft(frame)) + 1e-10
        geo = float(np.exp(np.mean(np.log(spec))))
        arith = float(np.mean(spec))
        out[i] = geo / arith if arith > 0 else 0.0
    return out


def _features_to_score(features: dict) -> float:
    """Map prosody features → P(synthetic) heuristic.

    Bias toward "synthetic" when:
      - jitter very low (TTS too smooth) — prefer Praat jitter, fall back to autocorr
      - shimmer very low
      - HNR very high (clean output, no breath/noise)
      - voiced ratio extremely high with low silence (no breaths)
      - spectral flatness uniform (no formant richness)
      - energy variance very low (constant amplitude)
    """
    jitter = features.get("praat_jitter_local")
    if jitter is None:
        jitter = features.get("f0_jitter_fallback", 0.0)
    shimmer = features.get("praat_shimmer_local")
    hnr_db = features.get("praat_hnr_db")
    voiced = features.get("voiced_ratio", 0.0)
    silence_ratio = features.get("silence_ratio", 0.0)
    energy_std = features.get("energy_std", 0.0)
    flatness_std = features.get("spectral_flatness_std", 0.0)
    f0_std = features.get("f0_std_hz", 0.0)

    score = 0.5
    if jitter is not None:
        if jitter < 0.005:
            score += 0.20
        elif jitter > 0.02:
            score -= 0.10
    if shimmer is not None:
        if shimmer < 0.02:
            score += 0.15
        elif shimmer > 0.08:
            score -= 0.05
    if hnr_db is not None and hnr_db > 25.0:
        score += 0.10  # suspiciously clean
    if voiced > 0.92 and silence_ratio < 0.05:
        score += 0.10
    if energy_std < 0.005:
        score += 0.10
    if flatness_std < 0.02:
        score += 0.05
    if f0_std < 5.0 and voiced > 0.5:
        score += 0.10
    return max(0.0, min(1.0, score))
