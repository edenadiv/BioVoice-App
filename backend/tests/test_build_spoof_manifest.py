"""Tests for scripts/build_spoof_manifest.py — the make_spoof_eval -> training
CSV bridge. Hermetic: no torch, no model weights."""

from __future__ import annotations

import sys
from pathlib import Path

from .conftest import make_wav

BACKEND_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(BACKEND_ROOT / "scripts"))

from build_spoof_manifest import AXIS_NAMES, build_rows, parse_protocol  # noqa: E402


def _make_eval_dir(tmp_path: Path) -> Path:
    eval_dir = tmp_path / "eval"
    audio = eval_dir / "audio"
    audio.mkdir(parents=True)
    (audio / "B1.wav").write_bytes(make_wav(0.8, frequency=220.0))
    (audio / "S1.wav").write_bytes(make_wav(0.8, waveform="noise", seed=1))
    (eval_dir / "protocol.txt").write_text("spk B1 - - bonafide\nspk S1 - - spoof\n")
    return eval_dir


def test_parse_protocol(tmp_path: Path):
    p = tmp_path / "protocol.txt"
    p.write_text("spk U1 - - bonafide\nspk U2 - - spoof\nshort line\n")
    assert parse_protocol(p) == [("U1", 1), ("U2", 0)]


def test_build_rows_shape_and_columns(tmp_path: Path):
    rows = build_rows(
        _make_eval_dir(tmp_path),
        bonafide_anchor=0.9, spoof_anchor=0.15, feature_weight=0.5,
    )
    assert len(rows) == 2
    assert set(rows[0].keys()) == {"path", *AXIS_NAMES}
    for row in rows:
        for axis in AXIS_NAMES:
            assert 0.0 <= float(row[axis]) <= 1.0


def test_bonafide_labels_exceed_spoof(tmp_path: Path):
    rows = build_rows(
        _make_eval_dir(tmp_path),
        bonafide_anchor=0.9, spoof_anchor=0.15, feature_weight=0.5,
    )
    by = {Path(r["path"]).stem: r for r in rows}
    for axis in AXIS_NAMES:
        assert float(by["B1"][axis]) > float(by["S1"][axis])


def test_missing_audio_is_skipped(tmp_path: Path):
    eval_dir = _make_eval_dir(tmp_path)
    eval_dir.joinpath("protocol.txt").write_text(
        "spk B1 - - bonafide\nspk GHOST - - spoof\n"
    )
    rows = build_rows(
        eval_dir, bonafide_anchor=0.9, spoof_anchor=0.15, feature_weight=0.5
    )
    assert [Path(r["path"]).stem for r in rows] == ["B1"]
