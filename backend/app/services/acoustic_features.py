"""F4 — acoustic feature extraction for the sub-classifier.

Computes the per-recording feature vector that the four probe heads
(voice naturalness, spectral consistency, temporal patterns, artifact
detection) score against. Features are picked for two properties:

  1. They have a direct, well-understood relationship to one or more of
     the four target axes (no opaque deep features). That makes the
     methodology defensible in the research paper.
  2. They are robust to the kiosk's microphone variance — every metric
     is normalised by frame length / total energy so loudness alone
     doesn't move the score.

The vector is float32 and has fixed length `FEATURE_DIM` so a downstream
trained MLP head can ingest it without per-clip resizing.

Implementation notes:
  - We avoid `librosa` for backend dep weight; numpy + scipy.signal cover
    everything we need. A future F8 paper benchmark can swap in librosa
    for higher-fidelity features if accuracy demands it.
  - The mel filterbank construction follows HTK conventions (Slaney's
    mel scale would shift the bin centres slightly but the trained head
    absorbs the difference; document choice in the paper).
"""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np


# Tunables — kept module-level so the training script can import them and
# reproduce the exact features the runtime uses.
SAMPLE_RATE = 16_000
FRAME_MS = 25
HOP_MS = 10
N_FFT = 512
N_MELS = 32
PITCH_MIN_HZ = 60.0      # F0 search lower bound — covers low male voices
PITCH_MAX_HZ = 400.0     # F0 search upper bound — covers high female voices
EPS = 1e-10

# Aggregated feature layout — must match the training script.
# (mean + std for each per-frame statistic) + scalar global metrics.
FEATURE_DIM = (
    N_MELS * 2          # log-mel mean + std across frames
    + 2                 # spectral centroid mean + std
    + 2                 # spectral flatness mean + std
    + 2                 # zero-crossing rate mean + std
    + 2                 # F0 mean + std (Hz)
    + 1                 # voiced ratio
    + 1                 # HNR mean (dB)
    + 1                 # spectral rolloff 95% mean (Hz)
)


@dataclass(slots=True)
class AcousticFeatures:
    """Container for the 70-D feature vector + a few interpretable scalars
    we want the heuristic fallback in `sub_classifier.py` to read directly
    without re-walking the FEATURE_DIM array."""

    vector: np.ndarray   # shape (FEATURE_DIM,), float32
    voiced_ratio: float
    hnr_db: float
    spectral_centroid_mean_hz: float
    spectral_flatness_mean: float
    f0_std_hz: float


def extract(waveform: list[float] | np.ndarray, sample_rate: int = SAMPLE_RATE) -> AcousticFeatures:
    """Extract the F4 acoustic feature set from a single recording. The
    waveform is expected to already be normalised (peak ≈ 1.0) and at
    SAMPLE_RATE — `AudioService.decode_wav` produces both."""
    audio = np.asarray(waveform, dtype=np.float32)
    if audio.size == 0:
        return AcousticFeatures(
            vector=np.zeros(FEATURE_DIM, dtype=np.float32),
            voiced_ratio=0.0,
            hnr_db=0.0,
            spectral_centroid_mean_hz=0.0,
            spectral_flatness_mean=0.0,
            f0_std_hz=0.0,
        )

    if sample_rate != SAMPLE_RATE:
        # The runtime always feeds us 16 kHz; this branch only exists for
        # script callers that load arbitrary WAVs.
        audio = _resample(audio, sample_rate, SAMPLE_RATE)

    frame_size = int(SAMPLE_RATE * FRAME_MS / 1000)
    hop_size = int(SAMPLE_RATE * HOP_MS / 1000)
    if audio.size < frame_size:
        # Pad short clips so we still get one frame.
        audio = np.pad(audio, (0, frame_size - audio.size))

    frames = _frame(audio, frame_size, hop_size)
    window = np.hanning(frame_size).astype(np.float32)
    windowed = frames * window

    # Magnitude spectrum per frame.
    spec = np.fft.rfft(windowed, n=N_FFT, axis=-1)
    mag = np.abs(spec).astype(np.float32) + EPS  # (n_frames, n_bins)

    # Log mel-energies.
    mel_fb = _mel_filterbank(N_MELS, N_FFT, SAMPLE_RATE)
    mel_energies = np.log(mag @ mel_fb.T + EPS)  # (n_frames, n_mels)
    mel_mean = mel_energies.mean(axis=0).astype(np.float32)
    mel_std = mel_energies.std(axis=0).astype(np.float32)

    # Spectral centroid (Hz) per frame.
    bin_freqs = np.linspace(0, SAMPLE_RATE / 2, mag.shape[1], dtype=np.float32)
    norm_mag = mag / (mag.sum(axis=1, keepdims=True) + EPS)
    centroid = (norm_mag * bin_freqs).sum(axis=1)
    centroid_mean = float(centroid.mean())
    centroid_std = float(centroid.std())

    # Spectral flatness — geometric / arithmetic mean of magnitude.
    log_mag = np.log(mag + EPS)
    flatness = np.exp(log_mag.mean(axis=1)) / (mag.mean(axis=1) + EPS)
    flatness_mean = float(flatness.mean())
    flatness_std = float(flatness.std())

    # Zero-crossing rate per frame.
    zcr = np.mean(np.abs(np.diff(np.sign(frames), axis=-1)) > 0, axis=-1).astype(np.float32) / 2.0
    zcr_mean = float(zcr.mean())
    zcr_std = float(zcr.std())

    # F0 estimation per frame via autocorrelation.
    f0s, voiced_flags = _f0_per_frame(frames)
    voiced_ratio = float(voiced_flags.mean())
    voiced_f0 = f0s[voiced_flags]
    if voiced_f0.size > 0:
        f0_mean = float(voiced_f0.mean())
        f0_std = float(voiced_f0.std())
    else:
        f0_mean = 0.0
        f0_std = 0.0

    # HNR via the autocorrelation peak ratio. Average across voiced frames.
    hnr_db = float(_hnr_db(frames, voiced_flags))

    # Spectral rolloff (95 %).
    cum_energy = np.cumsum(mag, axis=1)
    total_energy = cum_energy[:, -1:]
    target = 0.95 * total_energy
    # Index of the first bin whose cumulative energy ≥ 95 %.
    rolloff_bins = np.argmax(cum_energy >= target, axis=1)
    rolloff_hz = bin_freqs[rolloff_bins]
    rolloff_mean = float(rolloff_hz.mean())

    vector = np.concatenate(
        [
            mel_mean,
            mel_std,
            np.array(
                [
                    centroid_mean,
                    centroid_std,
                    flatness_mean,
                    flatness_std,
                    zcr_mean,
                    zcr_std,
                    f0_mean,
                    f0_std,
                    voiced_ratio,
                    hnr_db,
                    rolloff_mean,
                ],
                dtype=np.float32,
            ),
        ]
    ).astype(np.float32)

    if vector.size != FEATURE_DIM:
        # Defensive — if the layout drifts, fail loudly rather than silently
        # producing the wrong-shaped tensor for a trained head.
        raise RuntimeError(
            f"Feature vector length {vector.size} != expected {FEATURE_DIM}. "
            "Update FEATURE_DIM and retrain the heads."
        )

    return AcousticFeatures(
        vector=vector,
        voiced_ratio=voiced_ratio,
        hnr_db=hnr_db,
        spectral_centroid_mean_hz=centroid_mean,
        spectral_flatness_mean=flatness_mean,
        f0_std_hz=f0_std,
    )


# -----------------------------------------------------------------------------
# Helpers
# -----------------------------------------------------------------------------


def _frame(audio: np.ndarray, frame_size: int, hop_size: int) -> np.ndarray:
    n = audio.size
    if n < frame_size:
        return audio[np.newaxis, :].copy()
    n_frames = 1 + (n - frame_size) // hop_size
    indices = np.arange(frame_size)[None, :] + (np.arange(n_frames) * hop_size)[:, None]
    return audio[indices]


def _mel_filterbank(n_mels: int, n_fft: int, sample_rate: int) -> np.ndarray:
    """HTK-style mel filterbank. Returns (n_mels, n_fft//2 + 1)."""
    def hz_to_mel(f: float) -> float:
        return 2595.0 * np.log10(1.0 + f / 700.0)

    def mel_to_hz(m: float) -> np.ndarray:
        return 700.0 * (10.0 ** (m / 2595.0) - 1.0)

    low_mel = hz_to_mel(0.0)
    high_mel = hz_to_mel(sample_rate / 2)
    mel_points = np.linspace(low_mel, high_mel, n_mels + 2)
    hz_points = mel_to_hz(mel_points)
    bin_indices = np.floor((n_fft + 1) * hz_points / sample_rate).astype(int)

    fb = np.zeros((n_mels, n_fft // 2 + 1), dtype=np.float32)
    for m in range(1, n_mels + 1):
        left, centre, right = bin_indices[m - 1], bin_indices[m], bin_indices[m + 1]
        if right == left:
            continue
        for k in range(left, centre):
            if centre != left:
                fb[m - 1, k] = (k - left) / (centre - left)
        for k in range(centre, right):
            if right != centre:
                fb[m - 1, k] = (right - k) / (right - centre)
    return fb


def _f0_per_frame(frames: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    """Autocorrelation-based F0 estimator. Returns (f0_hz, voiced_flag)
    arrays of length n_frames. A frame is "voiced" iff its
    autocorrelation peak exceeds a threshold (clear periodicity)."""
    n_frames = frames.shape[0]
    f0s = np.zeros(n_frames, dtype=np.float32)
    voiced = np.zeros(n_frames, dtype=bool)
    min_lag = max(1, int(SAMPLE_RATE / PITCH_MAX_HZ))
    max_lag = min(frames.shape[1] - 1, int(SAMPLE_RATE / PITCH_MIN_HZ))
    if max_lag <= min_lag:
        return f0s, voiced

    for i, frame in enumerate(frames):
        # Centred autocorrelation. Skip the zero-lag energy term.
        frame = frame - frame.mean()
        ac = np.correlate(frame, frame, mode="full")[frame.size - 1 :]
        ac0 = ac[0] if ac[0] > EPS else 1.0
        if ac0 < 1e-6:
            continue
        ac_norm = ac / ac0
        peak_index = int(np.argmax(ac_norm[min_lag : max_lag + 1])) + min_lag
        peak_value = ac_norm[peak_index]
        if peak_value > 0.3:
            voiced[i] = True
            f0s[i] = SAMPLE_RATE / peak_index
    return f0s, voiced


def _hnr_db(frames: np.ndarray, voiced_flags: np.ndarray) -> float:
    """Mean harmonic-to-noise ratio (dB) across voiced frames."""
    if not voiced_flags.any():
        return 0.0
    voiced_frames = frames[voiced_flags]
    hnrs: list[float] = []
    min_lag = max(1, int(SAMPLE_RATE / PITCH_MAX_HZ))
    max_lag = min(voiced_frames.shape[1] - 1, int(SAMPLE_RATE / PITCH_MIN_HZ))
    if max_lag <= min_lag:
        return 0.0

    for frame in voiced_frames:
        frame = frame - frame.mean()
        ac = np.correlate(frame, frame, mode="full")[frame.size - 1 :]
        if ac[0] < 1e-6:
            continue
        ac_norm = ac / ac[0]
        r = float(ac_norm[min_lag : max_lag + 1].max())
        # Cramer's HNR derivation: 10 * log10(r / (1 - r)).
        if r >= 1.0:
            r = 0.999
        if r <= 0.0:
            continue
        hnrs.append(10.0 * np.log10(r / (1.0 - r)))
    if not hnrs:
        return 0.0
    return float(np.mean(hnrs))


def _resample(audio: np.ndarray, source_rate: int, target_rate: int) -> np.ndarray:
    if source_rate == target_rate:
        return audio
    duration = audio.size / source_rate
    target_length = int(round(duration * target_rate))
    if target_length <= 1:
        return audio
    src_x = np.linspace(0, duration, audio.size, endpoint=False)
    dst_x = np.linspace(0, duration, target_length, endpoint=False)
    return np.interp(dst_x, src_x, audio).astype(np.float32)
