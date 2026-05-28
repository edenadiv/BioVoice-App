"""Tests for scripts/make_validation_reports.py orchestration — discovery,
index writing, and the no-inputs no-op. Hermetic: never runs a benchmark."""

from __future__ import annotations

import json
import sys
from pathlib import Path
from types import SimpleNamespace

BACKEND_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(BACKEND_ROOT / "scripts"))

import make_validation_reports as mvr  # noqa: E402


def _args(**over) -> SimpleNamespace:
    base = dict(
        spoof_eval=None, spoof_dataset_name="spoof_x",
        voxceleb_pairs=None, voxceleb_audio_root=None, voxceleb_dataset_name="vox",
    )
    base.update(over)
    return SimpleNamespace(**base)


def test_discover_jobs_skips_absent(tmp_path: Path):
    assert mvr.discover_jobs(_args(spoof_eval=tmp_path / "nope")) == []


def test_discover_jobs_finds_spoof(tmp_path: Path):
    eval_dir = tmp_path / "eval"
    (eval_dir / "audio").mkdir(parents=True)
    (eval_dir / "protocol.txt").write_text("spk U1 - - bonafide\n")
    jobs = mvr.discover_jobs(_args(spoof_eval=eval_dir))
    assert len(jobs) == 1
    assert jobs[0]["name"] == "spoof_x"
    assert "--asvspoof-dir" in jobs[0]["args"]


def test_discover_jobs_finds_voxceleb(tmp_path: Path):
    pairs = tmp_path / "pairs.txt"
    pairs.write_text("1 a.wav b.wav\n")
    root = tmp_path / "vox"
    root.mkdir()
    jobs = mvr.discover_jobs(_args(voxceleb_pairs=pairs, voxceleb_audio_root=root))
    assert len(jobs) == 1
    assert jobs[0]["name"] == "vox"
    assert "--pairs" in jobs[0]["args"]


def test_append_index_creates_and_appends(tmp_path: Path):
    mvr.append_index(tmp_path, {"dataset": "a", "stamp": "s1"})
    mvr.append_index(tmp_path, {"dataset": "b", "stamp": "s2"})
    rows = json.loads((tmp_path / "index.json").read_text())
    assert [r["dataset"] for r in rows] == ["a", "b"]


def test_main_no_inputs_is_noop(tmp_path: Path, monkeypatch):
    monkeypatch.setattr(sys, "argv", ["prog", "--out", str(tmp_path)])
    assert mvr.main() == 0
    assert not (tmp_path / "index.json").exists()
