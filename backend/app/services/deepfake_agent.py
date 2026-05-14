"""LLM-powered deepfake detection agent.

The agent calls a single tool (`run_acoustic_analysis`) which runs every
available detector + extracts prosody features. The model receives the full
breakdown and returns a calibrated JSON verdict that includes a confidence
band.
"""

from __future__ import annotations

import json
import re
from dataclasses import asdict, dataclass, field

from app.services.audio import AudioService
from app.services.detectors import EnsembleDetector
from app.services.detectors.base import DetectorScore
from app.services.llm import ImagePart, LLMClient, ToolCall, ToolDef

_MAX_TOOL_ROUNDS = 3
_VERDICTS = frozenset({"REAL", "DEEPFAKE", "UNCERTAIN"})
_ALLOWED_IMAGE_TYPES = frozenset({"image/png", "image/jpeg", "image/webp", "image/gif"})

_SYSTEM = (
    "You are a deepfake audio detection expert. You receive scores from multiple detectors "
    "(deep model + signal-based prosody features) plus a confidence band, and must reason "
    "about agreement between them. Disagreement → UNCERTAIN. Strong agreement on a high "
    "score → DEEPFAKE. Strong agreement on a low score → REAL.\n\n"
    "Always respond with exactly this JSON (no markdown fences, no commentary):\n"
    '{"verdict":"REAL"|"DEEPFAKE"|"UNCERTAIN", '
    '"score":0.0-1.0, '
    '"confidence_low":0.0-1.0, '
    '"confidence_high":0.0-1.0, '
    '"reasoning":"one sentence citing the detectors that drove the call"}\n\n'
    "Score is P(synthetic): 0=real, 1=deepfake. Use the ensemble score and band as your "
    "anchor. Adjust only if prosody features clearly conflict with the deep model."
)

_AUDIO_PROMPT = (
    "Analyze this audio for deepfake detection. "
    "Call run_acoustic_analysis once to get the detector ensemble + prosody features, "
    "then return your JSON verdict."
)

_SPECTROGRAM_PROMPT = (
    "This is an audio spectrogram. No acoustic detectors are available for image-only input. "
    "Inspect for visible artifacts (unnatural frequency banding, GAN fingerprints, harmonic "
    "discontinuities, suspicious silence). Return your JSON verdict; if uncertain because "
    "image-only inspection is weak, lower your score toward 0.5 and widen the confidence band."
)

_ACOUSTIC_TOOL = ToolDef(
    name="run_acoustic_analysis",
    description=(
        "Run all available deepfake detectors on the audio and extract prosody features. "
        "Returns ensemble score, confidence band, per-detector breakdown, and feature dict."
    ),
)


@dataclass(slots=True)
class DeepfakeCheckResult:
    verdict: str
    score: float
    confidence_low: float
    confidence_high: float
    reasoning: str
    breakdown: list[DetectorScore] = field(default_factory=list)


class DeepfakeAgent:
    def __init__(self, llm: LLMClient, ensemble: EnsembleDetector) -> None:
        self._llm = llm
        self._ensemble = ensemble
        self._audio = AudioService()

    def check_audio(self, audio_bytes: bytes) -> DeepfakeCheckResult:
        analysis_holder: dict = {}

        def handler(call: ToolCall) -> str:
            if call.name == _ACOUSTIC_TOOL.name:
                analysis = self._run_analysis(audio_bytes)
                analysis_holder.update(analysis)
                return json.dumps(_compact_for_llm(analysis))
            return json.dumps({"error": f"unknown tool: {call.name}"})

        response = self._llm.chat(
            system=_SYSTEM,
            user_prompt=_AUDIO_PROMPT,
            tools=[_ACOUSTIC_TOOL],
            force_tool=_ACOUSTIC_TOOL.name,
            tool_handler=handler,
            max_tool_rounds=_MAX_TOOL_ROUNDS,
        )

        breakdown: list[DetectorScore] = analysis_holder.get("breakdown", [])
        if response.stop_reason == "tool_use_exhausted":
            return _fallback_from_analysis(analysis_holder, "Agent did not converge")
        return _parse_verdict(response.text, breakdown)

    def check_spectrogram(self, image_bytes: bytes, media_type: str = "image/png") -> DeepfakeCheckResult:
        if media_type not in _ALLOWED_IMAGE_TYPES:
            raise ValueError(f"Unsupported image media type: {media_type}")
        response = self._llm.chat(
            system=_SYSTEM,
            user_prompt=_SPECTROGRAM_PROMPT,
            image=ImagePart(data=image_bytes, media_type=media_type),
        )
        return _parse_verdict(response.text, breakdown=[])

    def _run_analysis(self, audio_bytes: bytes) -> dict:
        try:
            payload = self._audio.decode_wav(audio_bytes)
        except Exception as exc:
            return {"error": str(exc), "breakdown": []}

        result = self._ensemble.analyze(payload.waveform, sample_rate=payload.sample_rate)
        peak = max((abs(s) for s in payload.waveform), default=0.0)
        mean_abs = (sum(abs(s) for s in payload.waveform) / len(payload.waveform)) if payload.waveform else 0.0
        return {
            "ensemble_score": round(result.score, 4),
            "confidence_low": round(result.confidence_low, 4),
            "confidence_high": round(result.confidence_high, 4),
            "preliminary_verdict": result.verdict,
            "duration_seconds": round(len(payload.waveform) / payload.sample_rate, 2),
            "peak_amplitude": round(peak, 4),
            "mean_abs_amplitude": round(mean_abs, 4),
            "sample_rate": payload.sample_rate,
            "breakdown": result.breakdown,
        }


def _compact_for_llm(analysis: dict) -> dict:
    """Strip non-JSON-serializable structures for the tool result payload."""
    out = {k: v for k, v in analysis.items() if k != "breakdown"}
    out["detectors"] = [
        {
            "name": b.name,
            "score": round(b.score, 4),
            "raw_score": round(b.raw_score, 4),
            "weight": b.meta.get("weight", 1.0),
            "features": {k: v for k, v in b.meta.items() if k not in {"weight", "threshold"}},
        }
        for b in analysis.get("breakdown", [])
    ]
    return out


def _fallback_from_analysis(analysis: dict, reason: str) -> DeepfakeCheckResult:
    return DeepfakeCheckResult(
        verdict=analysis.get("preliminary_verdict", "UNCERTAIN"),
        score=float(analysis.get("ensemble_score", 0.5)),
        confidence_low=float(analysis.get("confidence_low", 0.0)),
        confidence_high=float(analysis.get("confidence_high", 1.0)),
        reasoning=reason,
        breakdown=analysis.get("breakdown", []),
    )


def _parse_verdict(text: str, breakdown: list[DetectorScore]) -> DeepfakeCheckResult:
    data = _try_load_json(text)
    if data is None:
        return DeepfakeCheckResult(
            verdict="UNCERTAIN",
            score=0.5,
            confidence_low=0.0,
            confidence_high=1.0,
            reasoning=text[:200] or "no JSON in response",
            breakdown=breakdown,
        )

    raw_verdict = str(data.get("verdict", "")).upper()
    verdict = raw_verdict if raw_verdict in _VERDICTS else "UNCERTAIN"

    score = _clamp_float(data.get("score"), 0.5)
    low = _clamp_float(data.get("confidence_low"), max(0.0, score - 0.25))
    high = _clamp_float(data.get("confidence_high"), min(1.0, score + 0.25))
    if low > high:
        low, high = high, low

    reasoning = str(data.get("reasoning", ""))[:500]
    return DeepfakeCheckResult(
        verdict=verdict,
        score=score,
        confidence_low=low,
        confidence_high=high,
        reasoning=reasoning,
        breakdown=breakdown,
    )


def _clamp_float(value, default: float) -> float:
    try:
        result = float(value)
    except (TypeError, ValueError):
        return default
    return max(0.0, min(1.0, result))


def _try_load_json(text: str) -> dict | None:
    stripped = text.strip()
    try:
        loaded = json.loads(stripped)
        return loaded if isinstance(loaded, dict) else None
    except json.JSONDecodeError:
        pass
    match = re.search(r"\{.*\"verdict\".*\}", stripped, re.DOTALL)
    if not match:
        return None
    try:
        loaded = json.loads(match.group(0))
        return loaded if isinstance(loaded, dict) else None
    except json.JSONDecodeError:
        return None


def breakdown_to_dicts(breakdown: list[DetectorScore]) -> list[dict]:
    return [
        {
            "name": b.name,
            "score": b.score,
            "raw_score": b.raw_score,
            "meta": {k: v for k, v in b.meta.items()},
        }
        for b in breakdown
    ]
