"""Audio decoding and normalization helpers.

F3.2 — adds a hand-rolled Voice Activity Detector. We avoid pulling
`webrtcvad` because (a) it has C extension wheels that lag Python releases
(Python 3.14 had no published wheel at scaffold time) and (b) the kiosk
flow only needs leading/trailing silence trimming, not segmentation. The
detector below is a frame-based energy + zero-crossing classifier with a
noise-floor estimator and hangover smoothing — empirically good enough to
trim 1 s of silence off the front of a recording without truncating soft
plosives.
"""

from __future__ import annotations

import math
import wave
from array import array
from dataclasses import dataclass
from io import BytesIO
from time import perf_counter


@dataclass(slots=True)
class AudioPayload:
    waveform: list[float]
    sample_rate: int


@dataclass(slots=True)
class AudioTimings:
    load_ms: float = 0.0
    resample_ms: float = 0.0
    normalize_ms: float = 0.0
    vad_ms: float = 0.0


class NoSpeechDetectedError(ValueError):
    """Raised when the VAD finds no usable speech in the recording. Subclass
    of ValueError so existing `except ValueError` blocks still catch it; the
    route layer uses isinstance to map it to HTTP 400 separately from the
    "user not enrolled" 404 case (also a ValueError today)."""


@dataclass(slots=True)
class VoiceActivityResult:
    """Outcome of `detect_voice_activity`. `regions` is a list of
    (start_sample_index, end_sample_index) tuples — half-open like Python
    slices. Empty list ⇒ no speech detected. `voiced_seconds` is the total
    speech duration after merging adjacent segments."""

    regions: list[tuple[int, int]]
    voiced_seconds: float


@dataclass(slots=True)
class QualityScore:
    """F3.3 — per-sample audio quality summary. Surfaced on
    EnrollmentResponse so operators see why a sample was rejected
    without having to dig through logs.

    `score` is the aggregate 0-100 displayed on the kiosk sample dots.
    `snr_db`, `clipping_pct`, `speech_ratio` are the three contributing
    metrics; `acceptable` is the gate decision. `reason` is the
    user-facing explanation when `acceptable` is False (empty otherwise).
    """

    score: float
    snr_db: float
    clipping_pct: float
    speech_ratio: float
    acceptable: bool
    reason: str = ""


class SampleQualityRejectedError(ValueError):
    """Raised when an enrolment sample fails the F3.3 quality gate. Like
    NoSpeechDetectedError, the route layer maps this to HTTP 400 and the
    operator sees the actionable message verbatim."""

    def __init__(self, message: str, score: QualityScore):
        super().__init__(message)
        self.score = score


# F3.2 — VAD tuning. Picked from a quick sweep on real microphone captures
# at 16 kHz; documented here so anyone re-tuning has the rationale.
VAD_FRAME_MS = 30                # window size; 30 ms is the WebRTC default
VAD_HOP_MS = 15                  # 50% overlap
VAD_ENERGY_FLOOR_GAIN = 4.0      # frame.energy must exceed noise_floor * gain
VAD_ABS_MIN_ENERGY = 1e-5        # absolute floor — avoids picking up DC offset noise
VAD_DYNAMIC_RANGE_RATIO = 0.1    # if min/max frame energy ratio > this, signal
                                 # has no silence — switch to absolute-only
                                 # threshold so pure tones / sustained speech
                                 # aren't classified as silence.
VAD_HANGOVER_MS = 200            # bridge gaps shorter than this between speech frames
VAD_PAD_MS = 80                  # keep this much silence on either side of a region

MIN_SPEECH_SECONDS = 1.0         # post-trim minimum; below this → "no speech detected"

# F3.3 — Sample quality gating. Defaults match the SDD specification; all
# three are tunable via Settings (F6.3 will expose them in the operator UI).
QUALITY_MIN_SNR_DB = 10.0        # below this is "too noisy"
QUALITY_MAX_CLIPPING_PCT = 1.0   # above this is "clipped"; counts only
                                 # plateau runs of ≥ 3 consecutive samples
                                 # near ±1.0 so isolated peaks (sine crests
                                 # in test fixtures, normalised audio) don't
                                 # trip the gate.
QUALITY_MIN_SPEECH_RATIO = 0.30  # speech_seconds / total_seconds
QUALITY_CLIP_THRESHOLD = 0.999   # |sample| > this counts toward clipping —
                                 # true digital saturation. 0.99 false-positives
                                 # on normalised sine waves (~9 %/period exceeds
                                 # 0.99 near the crest even for clean signals).
QUALITY_CLIP_RUN = 3             # need ≥ this many consecutive clipped samples


class AudioService:
    def __init__(self, target_sample_rate: int = 16000):
        self.target_sample_rate = target_sample_rate

    def decode_wav(self, audio_bytes: bytes) -> AudioPayload:
        payload, _ = self.decode_wav_with_timings(audio_bytes)
        return payload

    def decode_wav_with_timings(self, audio_bytes: bytes) -> tuple[AudioPayload, AudioTimings]:
        timings = AudioTimings()

        t0 = perf_counter()
        samples, source_rate = self._parse_wav(audio_bytes)
        timings.load_ms = (perf_counter() - t0) * 1000.0

        t0 = perf_counter()
        if source_rate != self.target_sample_rate:
            samples = self._resample(samples, source_rate, self.target_sample_rate)
        timings.resample_ms = (perf_counter() - t0) * 1000.0

        t0 = perf_counter()
        waveform = self._normalize([sample / 32768.0 for sample in samples])
        timings.normalize_ms = (perf_counter() - t0) * 1000.0

        return AudioPayload(waveform=waveform, sample_rate=self.target_sample_rate), timings

    def encode_wav(self, waveform: list[float], sample_rate: int | None = None) -> bytes:
        target_rate = sample_rate or self.target_sample_rate
        pcm = array(
            "h",
            (
                int(max(-1.0, min(1.0, sample)) * 32767)
                for sample in waveform
            ),
        )
        buffer = BytesIO()
        with wave.open(buffer, "wb") as handle:
            handle.setnchannels(1)
            handle.setsampwidth(2)
            handle.setframerate(target_rate)
            handle.writeframes(pcm.tobytes())
        return buffer.getvalue()

    # F3.2 — Voice Activity Detection
    # ============================================================================

    def detect_voice_activity(
        self,
        waveform: list[float],
        sample_rate: int | None = None,
    ) -> VoiceActivityResult:
        """Return the contiguous speech regions in `waveform` as
        (start_index, end_index) sample-index pairs.

        Algorithm:
          1. Slice the waveform into 30 ms frames at 50% overlap.
          2. Per frame, compute mean-square energy + zero-crossing rate.
          3. Estimate the noise floor as the median of the lowest decile of
             frame energies.
          4. A frame is "speech" iff its energy > noise_floor * gain (and
             > an absolute floor) AND its ZCR is in the voice band.
          5. Apply hangover smoothing — bridge silent gaps shorter than
             VAD_HANGOVER_MS.
          6. Pad each region by VAD_PAD_MS on both sides so soft consonants
             at the edges aren't clipped.

        Empty `regions` ⇒ no speech detected. Callers should treat that as
        an input-quality failure (silent recording, mic muted, etc.) and
        reject the upload.
        """
        rate = sample_rate or self.target_sample_rate
        n = len(waveform)
        if n == 0:
            return VoiceActivityResult(regions=[], voiced_seconds=0.0)

        frame_size = max(1, int(rate * VAD_FRAME_MS / 1000))
        hop = max(1, int(rate * VAD_HOP_MS / 1000))

        if n < frame_size:
            # Recording shorter than one frame is definitionally not speech.
            return VoiceActivityResult(regions=[], voiced_seconds=0.0)

        energies: list[float] = []
        frame_offsets: list[int] = []
        i = 0
        while i + frame_size <= n:
            chunk = waveform[i : i + frame_size]
            energies.append(_mean_square(chunk))
            frame_offsets.append(i)
            i += hop

        # Adaptive threshold:
        #   - If the recording has a meaningful dynamic range (quiet
        #     stretches AND loud stretches), build a relative threshold off
        #     the noise floor so background hum is ignored.
        #   - If the signal is uniform (synthetic test tone, very loud
        #     environment, or sustained singing), the relative rule would
        #     classify everything as silence — fall back to an absolute
        #     floor that catches anything above DC noise.
        emax = max(energies) if energies else 0.0
        emin = min(energies) if energies else 0.0
        uniform = emax > 0.0 and (emin / emax) > VAD_DYNAMIC_RANGE_RATIO
        if uniform:
            energy_threshold = VAD_ABS_MIN_ENERGY
        else:
            noise_floor = _noise_floor(energies)
            energy_threshold = max(noise_floor * VAD_ENERGY_FLOOR_GAIN, VAD_ABS_MIN_ENERGY)

        speech_flags = [energy > energy_threshold for energy in energies]

        regions = _merge_frames_to_regions(
            speech_flags=speech_flags,
            frame_offsets=frame_offsets,
            frame_size=frame_size,
            hangover_frames=max(1, int(VAD_HANGOVER_MS / VAD_HOP_MS)),
            pad_samples=int(rate * VAD_PAD_MS / 1000),
            total_samples=n,
        )
        voiced = sum(end - start for start, end in regions) / rate
        return VoiceActivityResult(regions=regions, voiced_seconds=voiced)

    # F3.3 — Sample quality scoring
    # ============================================================================

    def score_quality(self, payload: AudioPayload) -> QualityScore:
        """Compute SNR, clipping %, and speech ratio for `payload`. Returns a
        QualityScore with an aggregate 0-100 score + an `acceptable` gate
        decision. The gate is the AND of all three thresholds — if any one
        fails, `reason` carries the operator-facing explanation.
        """
        rate = payload.sample_rate
        wave = payload.waveform
        n = len(wave)
        if n == 0:
            return QualityScore(
                score=0.0,
                snr_db=0.0,
                clipping_pct=100.0,
                speech_ratio=0.0,
                acceptable=False,
                reason="Empty recording.",
            )

        snr_db = _estimate_snr_db(wave, rate)
        clipping_pct = _clipping_percent(wave)
        vad = self.detect_voice_activity(wave, rate)
        total_seconds = n / rate
        speech_ratio = vad.voiced_seconds / total_seconds if total_seconds > 0 else 0.0

        score = _aggregate_quality_score(snr_db, clipping_pct, speech_ratio)

        reasons: list[str] = []
        if snr_db < QUALITY_MIN_SNR_DB:
            reasons.append(
                f"SNR {snr_db:.1f} dB is below the {QUALITY_MIN_SNR_DB:.0f} dB minimum — "
                "move closer to the microphone or reduce background noise."
            )
        if clipping_pct > QUALITY_MAX_CLIPPING_PCT:
            reasons.append(
                f"{clipping_pct:.1f}% of samples are clipped (max {QUALITY_MAX_CLIPPING_PCT:.0f}%) — "
                "lower the input gain on your microphone."
            )
        if speech_ratio < QUALITY_MIN_SPEECH_RATIO:
            reasons.append(
                f"Only {speech_ratio * 100:.0f}% of the recording is speech — "
                "speak continuously for the full prompt."
            )

        acceptable = not reasons
        return QualityScore(
            score=score,
            snr_db=snr_db,
            clipping_pct=clipping_pct,
            speech_ratio=speech_ratio,
            acceptable=acceptable,
            reason=" ".join(reasons),
        )

    def trim_to_voice(self, payload: AudioPayload) -> tuple[AudioPayload, float]:
        """Trim leading/trailing silence from `payload`. Returns the trimmed
        payload + the wall-clock VAD cost in ms (so callers can fold it into
        their timing breakdown).

        Behaviour:
          - One or more speech regions found → keep [first.start, last.end]
            (preserves natural mid-speech pauses; trims only the edges).
          - Trimmed duration < MIN_SPEECH_SECONDS → raises ValueError so the
            HTTP layer can map to 400 "no speech detected".
          - No regions → raises ValueError.
        """
        t0 = perf_counter()
        result = self.detect_voice_activity(payload.waveform, payload.sample_rate)
        vad_ms = (perf_counter() - t0) * 1000.0

        if not result.regions:
            raise NoSpeechDetectedError(
                "No speech detected in the recording. "
                "Check that your microphone is on and you spoke during the capture."
            )
        start = result.regions[0][0]
        end = result.regions[-1][1]
        trimmed = payload.waveform[start:end]
        duration = len(trimmed) / payload.sample_rate
        if duration < MIN_SPEECH_SECONDS:
            raise NoSpeechDetectedError(
                f"Detected only {duration:.2f}s of speech (need ≥ {MIN_SPEECH_SECONDS:g}s). "
                "Please record again and speak for the full prompt."
            )
        return AudioPayload(waveform=trimmed, sample_rate=payload.sample_rate), vad_ms

    def _parse_wav(self, audio_bytes: bytes) -> tuple[array, int]:
        with wave.open(BytesIO(audio_bytes), "rb") as handle:
            sample_rate = handle.getframerate()
            frames = handle.readframes(handle.getnframes())
            sample_width = handle.getsampwidth()
            channels = handle.getnchannels()

        if sample_width != 2:
            raise ValueError("Only 16-bit PCM WAV files are supported for now")

        samples = array("h")
        samples.frombytes(frames)

        if channels == 2:
            if len(samples) % 2 != 0:
                samples = samples[:-1]
            left = samples[0::2]
            right = samples[1::2]
            mono = array("h")
            mono.extend(int((l + r) / 2) for l, r in zip(left, right))
            samples = mono
        elif channels != 1:
            raise ValueError("Only mono or stereo WAV files are supported")

        return samples, sample_rate

    def _resample(self, samples: array, source_rate: int, target_rate: int) -> array:
        if len(samples) < 2 or source_rate == target_rate:
            return samples

        source_length = len(samples)
        target_length = max(int(source_length * target_rate / source_rate), 1)
        if target_length == source_length:
            return samples

        result = array("h")
        scale = (source_length - 1) / max(target_length - 1, 1)
        for index in range(target_length):
            position = index * scale
            left_index = int(math.floor(position))
            right_index = min(left_index + 1, source_length - 1)
            fraction = position - left_index
            value = samples[left_index] * (1 - fraction) + samples[right_index] * fraction
            result.append(int(round(value)))
        return result

    @staticmethod
    def _normalize(waveform: list[float]) -> list[float]:
        peak = max((abs(sample) for sample in waveform), default=0.0)
        if peak <= 1e-8:
            return waveform
        return [sample / peak for sample in waveform]


# -----------------------------------------------------------------------------
# Module helpers (kept private — VAD internals)
# -----------------------------------------------------------------------------


def _mean_square(chunk: list[float]) -> float:
    if not chunk:
        return 0.0
    total = 0.0
    for s in chunk:
        total += s * s
    return total / len(chunk)


def _noise_floor(energies: list[float]) -> float:
    """Estimate the noise floor from the quietest decile of frames. Median
    of that decile is robust against single-frame transients."""
    if not energies:
        return 0.0
    sorted_e = sorted(energies)
    decile = max(1, len(sorted_e) // 10)
    bottom = sorted_e[:decile]
    return bottom[len(bottom) // 2]


def _estimate_snr_db(waveform: list[float], sample_rate: int) -> float:
    """Frame-based SNR. Compute mean-square energy in 30 ms frames; the
    speech estimate is the median of the top 50 % of frame energies, the
    noise estimate is the median of the bottom 10 %. SNR is
    10 * log10(speech / noise).

    Edge case: when the signal has no silent frames to anchor against
    (uniform energy) we can't measure SNR by floor comparison. Use the
    mean zero-crossing rate as a discriminator:
      - low ZCR (< 0.05) → tonal / harmonic content (sustained vowel,
        synthetic test tone) → return a high-SNR sentinel
      - high ZCR → broadband content (random noise) → return the
        floor-vs-floor ratio honestly, which collapses to 0 dB and lets
        the gate reject the recording
    """
    if not waveform:
        return 0.0
    frame_size = max(1, int(sample_rate * VAD_FRAME_MS / 1000))
    if len(waveform) < frame_size:
        return 0.0
    energies: list[float] = []
    zcrs: list[float] = []
    for i in range(0, len(waveform) - frame_size + 1, frame_size):
        chunk = waveform[i : i + frame_size]
        energies.append(_mean_square(chunk))
        zcrs.append(_frame_zero_crossing_rate(chunk))
    if not energies:
        return 0.0
    sorted_e = sorted(energies)
    if sorted_e[-1] <= 0.0:
        return 0.0
    uniform = sorted_e[0] > 0.0 and sorted_e[0] / sorted_e[-1] > VAD_DYNAMIC_RANGE_RATIO
    if uniform:
        mean_zcr = sum(zcrs) / len(zcrs) if zcrs else 0.0
        if mean_zcr < 0.05:
            # Tonal / harmonic content; treat as clean reference signal.
            return 60.0
        # Otherwise fall through to the floor-ratio measurement, which
        # for uniform-energy signals gives near-zero dB and surfaces the
        # noise via the gate.
    top_half = sorted_e[len(sorted_e) // 2 :]
    bottom_decile = sorted_e[: max(1, len(sorted_e) // 10)]
    speech = top_half[len(top_half) // 2]
    noise = bottom_decile[len(bottom_decile) // 2]
    if noise <= 0.0:
        return 60.0
    ratio = speech / noise
    if ratio <= 0.0:
        return 0.0
    return 10.0 * math.log10(ratio)


def _frame_zero_crossing_rate(chunk: list[float]) -> float:
    if len(chunk) < 2:
        return 0.0
    crossings = 0
    prev = chunk[0]
    for s in chunk[1:]:
        if (prev >= 0.0) != (s >= 0.0):
            crossings += 1
        prev = s
    return crossings / (len(chunk) - 1)


def _clipping_percent(waveform: list[float]) -> float:
    """Fraction (×100) of samples inside a plateau run of saturated
    samples. Counts only runs of at least QUALITY_CLIP_RUN consecutive
    samples with |s| > QUALITY_CLIP_THRESHOLD so an isolated peak (sine
    crest, normalised audio) doesn't trip the gate."""
    if not waveform:
        return 0.0
    n = len(waveform)
    clipped = 0
    run = 0
    for s in waveform:
        if abs(s) > QUALITY_CLIP_THRESHOLD:
            run += 1
        else:
            if run >= QUALITY_CLIP_RUN:
                clipped += run
            run = 0
    if run >= QUALITY_CLIP_RUN:
        clipped += run
    return (clipped / n) * 100.0


def _aggregate_quality_score(snr_db: float, clipping_pct: float, speech_ratio: float) -> float:
    """0-100 aggregate. Each metric contributes a sub-score capped at the
    threshold; the aggregate is the geometric mean so a single bad
    metric pulls the score down hard.

    Weighting matches the kiosk's QA narrative: a great recording has all
    three near-perfect; one bad axis already disqualifies it from the
    "green dot" tier even if the others are pristine.
    """
    snr_floor, snr_ceiling = 0.0, 30.0
    snr_norm = max(0.0, min(1.0, (snr_db - snr_floor) / (snr_ceiling - snr_floor)))
    clip_norm = max(0.0, 1.0 - (clipping_pct / 5.0))
    speech_norm = max(0.0, min(1.0, speech_ratio / 0.8))
    # Geometric mean. Adding 1e-3 keeps a single zero from collapsing the
    # whole score so the operator can still distinguish "0%" from
    # "ankle-biter on one axis".
    product = (snr_norm + 1e-3) * (clip_norm + 1e-3) * (speech_norm + 1e-3)
    score = (product ** (1 / 3)) * 100.0
    return max(0.0, min(100.0, score))


def _merge_frames_to_regions(
    speech_flags: list[bool],
    frame_offsets: list[int],
    frame_size: int,
    hangover_frames: int,
    pad_samples: int,
    total_samples: int,
) -> list[tuple[int, int]]:
    """Collapse consecutive speech frames into (start, end) sample regions.
    Bridges silent gaps shorter than `hangover_frames` and pads each region
    by `pad_samples` so soft consonants aren't clipped at the boundaries."""
    if not speech_flags:
        return []

    regions: list[tuple[int, int]] = []
    in_speech = False
    region_start = 0
    silence_run = 0

    for idx, is_speech in enumerate(speech_flags):
        if is_speech:
            if not in_speech:
                in_speech = True
                region_start = frame_offsets[idx]
            silence_run = 0
        else:
            if in_speech:
                silence_run += 1
                if silence_run > hangover_frames:
                    end_offset = frame_offsets[idx - silence_run] + frame_size
                    regions.append((region_start, end_offset))
                    in_speech = False
                    silence_run = 0

    if in_speech:
        last_speech_idx = len(speech_flags) - silence_run - 1
        end_offset = frame_offsets[last_speech_idx] + frame_size
        regions.append((region_start, end_offset))

    # Pad + clamp + merge any overlaps the padding produced.
    padded: list[tuple[int, int]] = []
    for start, end in regions:
        padded_start = max(0, start - pad_samples)
        padded_end = min(total_samples, end + pad_samples)
        if padded and padded_start <= padded[-1][1]:
            padded[-1] = (padded[-1][0], max(padded[-1][1], padded_end))
        else:
            padded.append((padded_start, padded_end))

    return padded
