from __future__ import annotations

import pytest

torch = pytest.importorskip("torch")

from app.services import explain as ex


def test_extract_segments_finds_contiguous_runs():
    cam_tf = torch.zeros(10, 4)
    cam_tf[2:5, :] = 0.9
    cam_tf[7:8, :] = 0.9
    segs = ex._extract_segments(cam_tf, duration_ms=1000.0, threshold=0.5)
    assert len(segs) == 2
    assert segs[0].start_ms == pytest.approx(200.0)
    assert segs[0].end_ms == pytest.approx(500.0)
    assert segs[0].peak == pytest.approx(0.9)
    assert segs[1].start_ms == pytest.approx(700.0)
    assert segs[1].end_ms == pytest.approx(800.0)


def test_extract_segments_empty_when_all_below_threshold():
    cam_tf = torch.full((10, 4), 0.2)
    assert ex._extract_segments(cam_tf, 1000.0, threshold=0.5) == []


def test_resize_tiles_1d_cam_across_frequency():
    cam_1d = torch.linspace(0, 1, 50).unsqueeze(0)
    out = ex._resize_and_orient(cam_1d)
    assert out.shape == (ex.HEATMAP_T, ex.HEATMAP_F)
    assert out.std(dim=1).max().item() < 1e-3


def test_resize_keeps_2d_cam_oriented_as_time_freq():
    cam_2d = torch.rand(8, 30)
    out = ex._resize_and_orient(cam_2d)
    assert out.shape == (ex.HEATMAP_T, ex.HEATMAP_F)


def test_build_axes_lengths_match_heatmap_shape():
    t, f = ex._build_axes(duration_ms=2000.0)
    assert len(t) == ex.HEATMAP_T
    assert len(f) == ex.HEATMAP_F
    assert t[0] == 0.0
    assert f[0] == 0.0


class _ToyConvModel(torch.nn.Module):
    def __init__(self):
        super().__init__()
        self.conv = torch.nn.Conv1d(1, 4, kernel_size=5, padding=2)
        self.fc = torch.nn.Linear(4, 8)

    def forward(self, x):
        h = self.conv(x.unsqueeze(1))
        emb = h.mean(dim=-1)
        return self.fc(emb)


def test_compute_cam_runs_end_to_end_on_toy_model():
    model = _ToyConvModel()
    ctx = ex._AdapterCtx(
        model=model,
        target_layer=model.conv,
        waveform_to_input=lambda w: w.unsqueeze(0),
        forward_target=lambda x: model(x).norm(dim=-1),
    )
    waveform = [0.1 * (i % 7) for i in range(800)]
    cam = ex._compute_cam(ctx, waveform)
    if cam.ndim == 1:
        cam = cam.unsqueeze(0)
    assert torch.isfinite(cam).all()
    assert cam.min().item() >= 0.0
    assert cam.max().item() <= 1.0 + 1e-6


class _ToyRedim(torch.nn.Module):
    def __init__(self):
        super().__init__()
        self.backbone = torch.nn.Sequential(torch.nn.Conv1d(1, 4, 3, padding=1))

    def forward(self, x):
        return self.backbone(x.unsqueeze(1)).mean(-1)


def test_resolve_redimnet_layer_backbone_and_submodule():
    toy = _ToyRedim()
    assert ex.resolve_redimnet_layer(toy, "backbone") is toy.backbone
    assert ex.resolve_redimnet_layer(toy, None) is toy.backbone
    assert ex.resolve_redimnet_layer(toy, "0") is toy.backbone[0]
    # Unknown path falls back to the backbone instead of raising.
    assert ex.resolve_redimnet_layer(toy, "does.not.exist") is toy.backbone


def test_build_adapters_honours_configured_redimnet_layer():
    toy = _ToyRedim()
    adapters = ex.build_adapters(None, toy, None, redimnet_layer="0")
    assert adapters["redimnet_b5"].target_layer is toy.backbone[0]


def test_pool_and_mask_thresholds_per_frame():
    cam_tf = torch.zeros(6, 4)
    cam_tf[1:3, :] = 0.8
    pooled, mask = ex._pool_and_mask(cam_tf, threshold=0.5)
    assert pooled.shape == (6,)
    assert mask.tolist() == [False, True, True, False, False, False]


def test_raised_cosine_envelope_is_smooth_and_bounded():
    mask = torch.tensor([False, True, True, False])
    env = ex._raised_cosine_envelope(mask, n_samples=400, fade_samples=40)
    assert env.shape == (400,)
    assert env.min().item() >= 0.0
    assert env.max().item() <= 1.0 + 1e-6
    # Core of the salient region (frames 1–2 → samples ~100–300) reaches full gain.
    assert env[200].item() == pytest.approx(1.0, abs=1e-3)
    # Edges with no fade requested would be a step; the ramp keeps |Δ| small.
    assert (env[1:] - env[:-1]).abs().max().item() < 0.2


def _toy_ctx() -> "ex._AdapterCtx":
    model = _ToyConvModel()
    return ex._AdapterCtx(
        model=model,
        target_layer=model.conv,
        waveform_to_input=lambda w: w.unsqueeze(0),
        forward_target=lambda x: model(x).norm(dim=-1),
    )


def test_build_cam_masks_splice_partitions_the_clip():
    """Default (splice) mode drops masked samples and concatenates the kept
    speech — no silence injected — so retain + delete partition the clip."""
    waveform = [0.2 * ((i % 11) - 5) for i in range(1600)]
    masks = ex.build_cam_masks(_toy_ctx(), waveform, threshold=0.4, sample_rate=16000)

    assert masks.mode == "splice"
    assert 0.0 <= masks.coverage_pct <= 100.0
    # No silence padding: the two parts together account for the whole clip.
    assert len(masks.retain) + len(masks.delete) == len(waveform)
    # retain length tracks coverage.
    assert len(masks.retain) == pytest.approx(masks.coverage_pct / 100.0 * len(waveform), abs=2)


def test_cam_topk_masks_fixed_coverage_and_partition():
    """Fixed-coverage masking keeps ~coverage of the frames as top-k salient,
    splices retain + delete to partition the clip, and emits playable bands."""
    waveform = [0.2 * ((i % 11) - 5) for i in range(1600)]
    masks = ex.cam_topk_masks(_toy_ctx(), waveform, coverage=0.30, duration_ms=100.0, sample_rate=16000)

    assert masks.n_frames == ex.HEATMAP_T
    assert masks.k == round(0.30 * ex.HEATMAP_T)
    assert masks.coverage_pct == pytest.approx(30.0, abs=1.0)
    assert len(masks.retain) + len(masks.delete) == len(waveform)
    assert len(masks.segments) >= 1
    assert all(s.end_ms > s.start_ms for s in masks.segments)


def test_random_frame_mask_is_seeded_and_sized():
    a = ex.random_frame_mask(200, 60, seed=0)
    b = ex.random_frame_mask(200, 60, seed=0)
    c = ex.random_frame_mask(200, 60, seed=1)
    assert int(a.sum()) == 60
    assert torch.equal(a, b)          # deterministic per seed
    assert not torch.equal(a, c)      # varies across seeds


def test_build_cam_masks_zero_mode_reconstructs_input():
    """zero mode keeps full length: retain·env + delete·(1-env) == input."""
    waveform = [0.2 * ((i % 11) - 5) for i in range(1600)]
    masks = ex.build_cam_masks(_toy_ctx(), waveform, threshold=0.4, sample_rate=16000, mode="zero")

    assert len(masks.retain) == len(waveform) == len(masks.delete)
    recon = [r + d for r, d in zip(masks.retain, masks.delete)]
    for original, rebuilt in zip(waveform, recon):
        assert rebuilt == pytest.approx(original, abs=1e-4)
