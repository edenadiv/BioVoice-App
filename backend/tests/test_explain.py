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
