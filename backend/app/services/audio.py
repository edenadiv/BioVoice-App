"""Audio decoding and normalization helpers."""

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
