"""Grad-CAM attribution for the explain tab. WeSpeaker is ONNX → excluded."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Callable

import torch
import torch.nn.functional as F

from app.core.config import settings
from app.schemas import CamSegment, ExplainModelKey, ModelCAM

SAMPLE_RATE = 16000
HEATMAP_T = 200
HEATMAP_F = 64


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
    encoder_model: torch.nn.Module, centroid: torch.Tensor | None = None
) -> _AdapterCtx:
    target_layer = encoder_model.backbone

    def prep(wav: torch.Tensor) -> torch.Tensor:
        return wav.unsqueeze(0)

    def forward(x: torch.Tensor) -> torch.Tensor:
        emb = encoder_model(x)
        return _cosine_or_norm(emb, centroid)

    return _AdapterCtx(encoder_model, target_layer, prep, forward)


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


def _extract_segments(
    cam_tf: torch.Tensor, duration_ms: float, threshold: float
) -> list[CamSegment]:
    pooled = cam_tf.mean(dim=1)
    mask = (pooled > threshold).tolist()
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
        segments.append(
            CamSegment(
                start_ms=i * frame_ms,
                end_ms=j * frame_ms,
                peak=peak,
            )
        )
        i = j
    return segments


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


def build_adapters(
    detector_model: torch.nn.Module | None,
    redimnet_model: torch.nn.Module | None,
    ecapa_model: object | None,
    redimnet_centroid: list[float] | None = None,
    ecapa_centroid: list[float] | None = None,
) -> dict[ExplainModelKey, _AdapterCtx]:
    out: dict[ExplainModelKey, _AdapterCtx] = {}
    if detector_model is not None:
        out["aasist"] = _aasist_adapter(detector_model)
    if redimnet_model is not None:
        c = torch.tensor(redimnet_centroid, dtype=torch.float32) if redimnet_centroid else None
        out["redimnet_b5"] = _redimnet_adapter(redimnet_model, c)
    if ecapa_model is not None:
        c = torch.tensor(ecapa_centroid, dtype=torch.float32) if ecapa_centroid else None
        out["ecapa_voxceleb"] = _ecapa_adapter(ecapa_model, c)
    return out
