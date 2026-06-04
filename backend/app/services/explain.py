"""Grad-CAM attribution for the explain tab. WeSpeaker is ONNX → excluded."""

from __future__ import annotations

import logging
import math
from dataclasses import dataclass
from typing import Callable

import torch
import torch.nn.functional as F
import torchaudio

from app.core.config import settings
from app.schemas import CamSegment, ExplainModelKey, ModelCAM

logger = logging.getLogger(__name__)

SAMPLE_RATE = 16000
HEATMAP_T = 200
HEATMAP_F = 64


def input_spectrogram(waveform: list[float]) -> list[list[float]]:
    """Log-mel spectrogram of the input on the same [T][F] grid as the CAM
    heatmaps, normalised to 0..1 — the base layer the UI overlays a heatmap on."""
    if not waveform:
        return [[0.0] * HEATMAP_F for _ in range(HEATMAP_T)]
    wav = torch.tensor(waveform, dtype=torch.float32).unsqueeze(0)
    mel = torchaudio.transforms.MelSpectrogram(
        sample_rate=SAMPLE_RATE,
        n_fft=512,
        hop_length=160,
        n_mels=HEATMAP_F,
        power=2.0,
    )(wav)
    logmel = torch.log(mel + 1e-6)  # (1, F, frames)
    grid = F.interpolate(
        logmel.unsqueeze(0), size=(HEATMAP_F, HEATMAP_T), mode="bilinear", align_corners=False
    ).squeeze(0).squeeze(0)  # (F, T)
    grid = grid - grid.min()
    mx = grid.max()
    if mx > 1e-8:
        grid = grid / mx
    return grid.transpose(0, 1).tolist()  # [T][F]


@dataclass(slots=True)
class _AdapterCtx:
    model: torch.nn.Module
    target_layer: torch.nn.Module
    waveform_to_input: Callable[[torch.Tensor], torch.Tensor]
    forward_target: Callable[[torch.Tensor], torch.Tensor]


def _aasist_adapter(detector_model: torch.nn.Module) -> _AdapterCtx:
    target_layer = detector_model.encoder[-1]

    def prep(wav: torch.Tensor) -> torch.Tensor:
        x = wav
        if x.numel() > 64600:
            x = x[:64600]
        elif x.numel() < 64600:
            x = F.pad(x, (0, 64600 - x.numel()))
        peak = x.abs().max()
        if peak > 1e-8:
            x = x * (0.05 / peak)
        return x.unsqueeze(0)

    def forward(x: torch.Tensor) -> torch.Tensor:
        _, logits = detector_model(x)
        return logits[:, 0]

    return _AdapterCtx(detector_model, target_layer, prep, forward)


def _cosine_or_norm(emb: torch.Tensor, centroid: torch.Tensor | None) -> torch.Tensor:
    if centroid is None:
        return emb.norm(dim=-1)
    e = emb / (emb.norm(dim=-1, keepdim=True) + 1e-8)
    c = centroid / (centroid.norm() + 1e-8)
    return (e * c).sum(dim=-1)


def _redimnet_adapter(
    encoder_model: torch.nn.Module,
    centroid: torch.Tensor | None = None,
    target_layer: torch.nn.Module | None = None,
) -> _AdapterCtx:
    # Default: the backbone output (B, F·C, T) — frequency is folded into the
    # channel axis there, so the resulting CAM is time-only. Pass an inner 2D
    # conv layer (see scripts/cam_layer_sweep.py) for a real time–frequency CAM.
    layer = target_layer if target_layer is not None else encoder_model.backbone

    def prep(wav: torch.Tensor) -> torch.Tensor:
        return wav.unsqueeze(0)

    def forward(x: torch.Tensor) -> torch.Tensor:
        emb = encoder_model(x)
        return _cosine_or_norm(emb, centroid)

    return _AdapterCtx(encoder_model, layer, prep, forward)


def _ecapa_adapter(encoder_model, centroid: torch.Tensor | None = None) -> _AdapterCtx:
    inner = encoder_model.mods.embedding_model
    target_layer = inner.mfa

    def prep(wav: torch.Tensor) -> torch.Tensor:
        return wav.unsqueeze(0)

    def forward(x: torch.Tensor) -> torch.Tensor:
        emb = encoder_model.encode_batch(x).squeeze(1)
        return _cosine_or_norm(emb, centroid)

    return _AdapterCtx(encoder_model, target_layer, prep, forward)


_THRESHOLDS = {
    "aasist": settings.cam_thr_aasist,
    "redimnet_b5": settings.cam_thr_redimnet,
    "ecapa_voxceleb": settings.cam_thr_ecapa,
}


def _compute_cam(ctx: _AdapterCtx, waveform: list[float]) -> torch.Tensor:
    activations: dict = {}

    def fwd_hook(_m, _inp, out):
        activations["v"] = out

    h = ctx.target_layer.register_forward_hook(fwd_hook)
    try:
        ctx.model.eval()
        with torch.enable_grad():
            wav = torch.tensor(waveform, dtype=torch.float32, requires_grad=True)
            x = ctx.waveform_to_input(wav)
            target = ctx.forward_target(x)
            act = activations["v"]
            grad = torch.autograd.grad(
                outputs=target.sum(), inputs=act, retain_graph=False
            )[0]
    finally:
        h.remove()

    act = act.detach()
    grad = grad.detach()

    weights = grad.mean(dim=tuple(range(2, grad.ndim)), keepdim=True)
    cam = (weights * act).sum(dim=1)
    cam = torch.relu(cam)[0]

    if cam.ndim == 1:
        cam = cam.unsqueeze(0)
    elif cam.ndim > 2:
        cam = cam.flatten(0, -2)

    cam = cam - cam.min()
    mx = cam.max()
    if mx > 1e-8:
        cam = cam / mx
    return cam


def _resize_and_orient(cam: torch.Tensor) -> torch.Tensor:
    if cam.shape[0] == 1:
        cam = cam.expand(HEATMAP_F, -1)
    cam = cam.unsqueeze(0).unsqueeze(0)
    cam = F.interpolate(
        cam, size=(HEATMAP_F, HEATMAP_T), mode="bilinear", align_corners=False
    )
    return cam.squeeze(0).squeeze(0).transpose(0, 1)


def _pool_and_mask(cam_tf: torch.Tensor, threshold: float) -> tuple[torch.Tensor, torch.Tensor]:
    """Collapse the CAM over frequency → a per-time-frame saliency profile,
    and the boolean above-threshold mask. Single source of truth shared by
    the salient-segment extraction and the faithfulness masking.

    Pools by MAX over frequency: a time frame is salient if it's hot at *any*
    frequency. Mean-pooling would wash out a real 2-D CAM (energy sits in a
    few freq bins, so the per-frame mean never clears the threshold and
    coverage collapses to 0%). For the tiled backbone CAM, max == mean, so
    this is a no-op there."""
    pooled = cam_tf.amax(dim=1)
    return pooled, pooled > threshold


def _segments_from_mask(
    mask: list[bool], pooled: torch.Tensor, duration_ms: float
) -> list[CamSegment]:
    """Contiguous above-mask runs as time bands (for display + playback)."""
    segments: list[CamSegment] = []
    T = len(mask)
    if T == 0:
        return segments
    frame_ms = duration_ms / T
    i = 0
    while i < T:
        if not mask[i]:
            i += 1
            continue
        j = i
        peak = 0.0
        while j < T and mask[j]:
            peak = max(peak, float(pooled[j]))
            j += 1
        segments.append(CamSegment(start_ms=i * frame_ms, end_ms=j * frame_ms, peak=peak))
        i = j
    return segments


def _extract_segments(
    cam_tf: torch.Tensor, duration_ms: float, threshold: float
) -> list[CamSegment]:
    pooled, mask_t = _pool_and_mask(cam_tf, threshold)
    return _segments_from_mask(mask_t.tolist(), pooled, duration_ms)


def _build_axes(duration_ms: float) -> tuple[list[float], list[float]]:
    t = [i * duration_ms / HEATMAP_T for i in range(HEATMAP_T)]
    f = [i * (SAMPLE_RATE / 2) / HEATMAP_F for i in range(HEATMAP_F)]
    return t, f


def explain_model(
    model_key: ExplainModelKey, ctx: _AdapterCtx, waveform: list[float]
) -> ModelCAM:
    cam_src = _compute_cam(ctx, waveform)
    cam_tf = _resize_and_orient(cam_src)
    duration_ms = 1000.0 * len(waveform) / SAMPLE_RATE
    threshold = _THRESHOLDS[model_key]
    segments = _extract_segments(cam_tf, duration_ms, threshold)
    times, freqs = _build_axes(duration_ms)
    return ModelCAM(
        model_key=model_key,
        frame_times_ms=times,
        freq_hz=freqs,
        heatmap=cam_tf.tolist(),
        threshold=threshold,
        salient_segments=segments,
    )


@dataclass(slots=True)
class CamMasks:
    """Time-domain masked copies of the input for the faithfulness check.

    `retain` is the audio under the above-threshold Grad-CAM time region;
    `delete` is its complement. `coverage_pct` is the fraction of the clip
    kept by `retain`.

    Masking mode matters for the encoder:

    * ``"splice"`` (default) drops the masked samples and concatenates the
      kept speech — no silence is injected. This is the right choice for
      ReDimNet / ECAPA, which pool statistics over the WHOLE waveform: zeroing
      a region turns it into silence that shifts the pooled embedding
      regardless of content, and biases retain (mostly silence at low
      coverage) far harder than delete.
    * ``"zero"`` keeps full length and zeroes the masked region. Faithful to
      "0 out the rest", but confounded for global-pooling encoders.
    """

    retain: list[float]
    delete: list[float]
    coverage_pct: float
    threshold: float
    mode: str = "splice"


def _raised_cosine_envelope(
    mask: torch.Tensor, n_samples: int, fade_samples: int
) -> torch.Tensor:
    """Upsample a per-frame 0/1 mask to a sample-rate gain envelope, then
    smooth every 0↔1 transition with a raised-cosine ramp so the masked
    waveform has no step discontinuities (clicks) that would themselves
    perturb the model and confound the faithfulness result."""
    T = int(mask.numel())
    if T == 0 or n_samples <= 0:
        return torch.zeros(max(0, n_samples), dtype=torch.float32)
    frame_vals = mask.to(torch.float32)
    # Nearest-neighbour frame → sample expansion.
    idx = (torch.arange(n_samples) * T // n_samples).clamp(max=T - 1)
    env = frame_vals[idx].clone()
    if fade_samples <= 1:
        return env
    edges = (env[1:] - env[:-1]).nonzero(as_tuple=False).flatten().tolist()
    half = fade_samples // 2
    for e in edges:
        rising = bool(env[e + 1] > env[e])
        start = max(0, e - half)
        end = min(n_samples, e + half + 1)
        steps = end - start
        if steps <= 1:
            continue
        ramp = 0.5 - 0.5 * torch.cos(torch.linspace(0.0, math.pi, steps))
        env[start:end] = ramp if rising else (1.0 - ramp)
    return env


def _sample_mask(mask: torch.Tensor, n_samples: int) -> torch.Tensor:
    """Nearest-neighbour expand a per-frame boolean mask to per-sample."""
    T = int(mask.numel())
    if T == 0 or n_samples <= 0:
        return torch.zeros(max(0, n_samples), dtype=torch.bool)
    idx = (torch.arange(n_samples) * T // n_samples).clamp(max=T - 1)
    return mask[idx]


def _splice(w: torch.Tensor, keep: torch.Tensor, fade_samples: int) -> list[float]:
    """Drop the masked samples and concatenate the kept runs, with a short
    raised-cosine fade on each run's edges so the joins don't click. Returns
    a (shorter) waveform of only the kept audio — no silence injected."""
    if not bool(keep.any()):
        return []
    wf = w.clone()
    if fade_samples > 1:
        boundaries = (keep[1:].int() - keep[:-1].int())
        starts = (boundaries == 1).nonzero(as_tuple=False).flatten() + 1
        ends = (boundaries == -1).nonzero(as_tuple=False).flatten() + 1
        run_starts = ([0] if keep[0] else []) + starts.tolist()
        run_ends = ends.tolist() + ([keep.numel()] if keep[-1] else [])
        for s, e in zip(run_starts, run_ends):
            f = min(fade_samples, (e - s) // 2)
            if f <= 0:
                continue
            ramp = 0.5 - 0.5 * torch.cos(torch.linspace(0.0, math.pi, f))
            wf[s : s + f] *= ramp
            wf[e - f : e] *= ramp.flip(0)
    return wf[keep].tolist()


def build_cam_masks(
    ctx: _AdapterCtx,
    waveform: list[float],
    threshold: float,
    sample_rate: int = SAMPLE_RATE,
    fade_ms: float = 5.0,
    mode: str = "splice",
) -> CamMasks:
    """Compute the Grad-CAM for `ctx`'s model, then carve the input into
    retain (salient) and delete (salient-removed) waveforms in the time
    domain. Frequency is collapsed out — the model consumes raw audio, so a
    time-domain occlusion keeps real speech going in and avoids the spectral
    artifacts an STFT-domain mask + ISTFT would inject.

    See `CamMasks` for the ``"splice"`` vs ``"zero"`` trade-off."""
    cam_src = _compute_cam(ctx, waveform)
    cam_tf = _resize_and_orient(cam_src)
    _, mask = _pool_and_mask(cam_tf, threshold)
    w = torch.tensor(waveform, dtype=torch.float32)
    fade_samples = int(fade_ms / 1000.0 * sample_rate)

    if mode == "zero":
        env = _raised_cosine_envelope(mask, w.numel(), fade_samples)
        retain = (w * env).tolist()
        delete = (w * (1.0 - env)).tolist()
    else:
        keep = _sample_mask(mask, w.numel())
        retain = _splice(w, keep, fade_samples)
        delete = _splice(w, ~keep, fade_samples)

    coverage_pct = float(mask.to(torch.float32).mean().item()) * 100.0 if mask.numel() else 0.0
    return CamMasks(
        retain=retain, delete=delete, coverage_pct=coverage_pct, threshold=threshold, mode=mode
    )


# -----------------------------------------------------------------------------
# Fixed-coverage masking (faithfulness panel) — top-k frames + random baseline
# -----------------------------------------------------------------------------

def _topk_frame_mask(pooled: torch.Tensor, k: int) -> torch.Tensor:
    """Boolean mask selecting the k highest-saliency time frames."""
    mask = torch.zeros_like(pooled, dtype=torch.bool)
    if k > 0 and pooled.numel():
        mask[torch.topk(pooled, min(k, pooled.numel())).indices] = True
    return mask


def random_frame_mask(n_frames: int, k: int, seed: int) -> torch.Tensor:
    """A seeded random selection of k frames — the fairness baseline: deleting
    any k frames hurts a global-pooling speaker encoder a little, so the
    question is whether the CAM's k frames beat a random k."""
    import random as _random

    rng = _random.Random(seed)
    mask = torch.zeros(n_frames, dtype=torch.bool)
    for i in rng.sample(range(n_frames), min(k, n_frames)):
        mask[i] = True
    return mask


def splice_by_frame_mask(
    waveform: torch.Tensor | list[float], frame_mask: torch.Tensor, sample_rate: int, fade_ms: float = 5.0
) -> tuple[list[float], list[float]]:
    """Splice retain (kept frames) and delete (complement) from a frame mask."""
    w = waveform if isinstance(waveform, torch.Tensor) else torch.tensor(waveform, dtype=torch.float32)
    fade = int(fade_ms / 1000.0 * sample_rate)
    keep = _sample_mask(frame_mask, w.numel())
    return _splice(w, keep, fade), _splice(w, ~keep, fade)


@dataclass(slots=True)
class CamTopkMasks:
    retain: list[float]
    delete: list[float]
    segments: list[CamSegment]
    coverage_pct: float
    n_frames: int
    k: int


def cam_topk_masks(
    ctx: _AdapterCtx,
    waveform: list[float],
    coverage: float,
    duration_ms: float,
    sample_rate: int = SAMPLE_RATE,
    fade_ms: float = 5.0,
) -> CamTopkMasks:
    """Keep the top-`coverage` fraction of frames by Grad-CAM saliency (not a
    fixed threshold) so every clip/layer keeps the SAME amount — the protocol
    cam_layer_sweep.py uses, which doesn't swing with clip length the way a
    threshold does. Splices the kept speech into `retain` (rest → `delete`).

    Pools per-frame saliency by MEAN over frequency (total attention the frame
    received) — the principled frame-importance for top-k, and what
    cam_layer_sweep.py validated. The threshold display bands use max pooling,
    but that's a separate visualisation concern."""
    cam_tf = _resize_and_orient(_compute_cam(ctx, waveform))
    pooled = cam_tf.mean(dim=1)
    T = int(pooled.numel())
    k = max(1, round(coverage * T))
    mask = _topk_frame_mask(pooled, k)
    retain, delete = splice_by_frame_mask(waveform, mask, sample_rate, fade_ms)
    segments = _segments_from_mask(mask.tolist(), pooled, duration_ms)
    return CamTopkMasks(
        retain=retain, delete=delete, segments=segments,
        coverage_pct=100.0 * k / T if T else 0.0, n_frames=T, k=k,
    )


def resolve_redimnet_layer(encoder_model: torch.nn.Module, name: str | None) -> torch.nn.Module:
    """Resolve the Grad-CAM target layer from a config name. ``"backbone"`` /
    empty → the backbone output (time-only). Any other value is a dotted
    submodule path under the backbone (e.g. ``"stage5.6"``) carrying a real
    time×frequency map. Unknown names fall back to the backbone with a warning."""
    backbone = encoder_model.backbone
    if not name or name == "backbone":
        return backbone
    try:
        return backbone.get_submodule(name)
    except AttributeError:
        logger.warning("CAM_REDIMNET_LAYER %r not found on backbone; using backbone output", name)
        return backbone


def build_adapters(
    detector_model: torch.nn.Module | None,
    redimnet_model: torch.nn.Module | None,
    ecapa_model: object | None,
    redimnet_centroid: list[float] | None = None,
    ecapa_centroid: list[float] | None = None,
    redimnet_layer: str | None = None,
) -> dict[ExplainModelKey, _AdapterCtx]:
    out: dict[ExplainModelKey, _AdapterCtx] = {}
    if detector_model is not None:
        out["aasist"] = _aasist_adapter(detector_model)
    if redimnet_model is not None:
        c = torch.tensor(redimnet_centroid, dtype=torch.float32) if redimnet_centroid else None
        layer = resolve_redimnet_layer(redimnet_model, redimnet_layer or settings.cam_redimnet_layer)
        out["redimnet_b5"] = _redimnet_adapter(redimnet_model, c, target_layer=layer)
    if ecapa_model is not None:
        c = torch.tensor(ecapa_centroid, dtype=torch.float32) if ecapa_centroid else None
        out["ecapa_voxceleb"] = _ecapa_adapter(ecapa_model, c)
    return out
