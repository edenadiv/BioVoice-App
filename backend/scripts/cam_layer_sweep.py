"""Grad-CAM layer sweep — which ReDimNet layer's attribution is faithful?

The Identify tab's Grad-CAM hooks ``backbone`` output, where frequency is
folded into the channel axis — so the CAM is time-only and the heatmap's
frequency stripes are tiled (fake). This diagnostic sweeps candidate *inner*
layers (which still carry a real freq x time map) and ranks them by a
faithfulness test against a random-region baseline.

Protocol (fixed-coverage deletion/insertion): every layer keeps the SAME
fraction of the clip (``--coverage``). The layer only chooses *which* frames
— its top-k most-salient ones. We compare that to a random k of equal size:

* sufficiency margin = sim(retain top-k CAM) - sim(retain random k)
      -> does the CAM's chosen region carry MORE identity than a random one?
* necessity margin   = sim(delete random k) - sim(delete top-k CAM)
      -> does removing the CAM's region hurt MORE than removing a random one?

Both positive => that layer localises identity better than chance, and its
heatmap actually explains "why this person". The backbone (time-only) is
included as the baseline the app currently uses.

Usage (needs real ReDimNet weights + an enrolled speaker):

    python scripts/cam_layer_sweep.py --user-id idan1
    python scripts/cam_layer_sweep.py --user-id idan1 --query clip.wav --coverage 0.3

Run from backend/ with the project venv active.
"""

from __future__ import annotations

import argparse
import math
import random
from pathlib import Path

import torch

from app.core.config import Settings
from app.services.audio import AudioPayload, AudioService
from app.services.explain import (
    SAMPLE_RATE,
    _compute_cam,
    _redimnet_adapter,
    _resize_and_orient,
    _sample_mask,
    _splice,
)
from app.services.speaker_encoder import RedimNetSpeakerEncoder
from app.storage.sqlite_store import SQLiteStore

MIN_DURATION_S = 0.25
FADE_MS = 5.0


# -----------------------------------------------------------------------------
# Layer discovery
# -----------------------------------------------------------------------------

def discover_layers(backbone: torch.nn.Module, sample_input: torch.Tensor):
    """Forward once with hooks on every submodule and keep the LAST 2-D
    (B, C, F, T) layer of EACH stage — the natural per-stage Grad-CAM target,
    so every stage (incl. stage4) is tested, not just one per frequency. Plus
    the 1-D backbone baseline."""
    seen: dict[str, tuple[str, torch.nn.Module, int, int]] = {}
    order = {"n": 0}
    handles = []

    def make_hook(name: str, module: torch.nn.Module):
        def hook(_m, _inp, out):
            order["n"] += 1
            if isinstance(out, torch.Tensor) and out.ndim == 4 and out.shape[2] >= 2:
                stage = name.split(".")[0]  # e.g. "stage4" from "stage4.10"
                seen[stage] = (name, module, int(out.shape[2]), order["n"])
        return hook

    for name, module in backbone.named_modules():
        if name:
            handles.append(module.register_forward_hook(make_hook(name, module)))
    try:
        with torch.no_grad():
            backbone(sample_input)
    finally:
        for h in handles:
            h.remove()

    layers = sorted(seen.values(), key=lambda t: t[3])
    layers.append(("backbone (current, time-only)", backbone, 1, 10**9))
    return layers


# -----------------------------------------------------------------------------
# Saliency + masking
# -----------------------------------------------------------------------------

def _cam_pooled(model, layer, centroid_t, waveform) -> torch.Tensor:
    """Per-time-frame saliency (length T) for one target layer."""
    ctx = _redimnet_adapter(model, centroid_t, target_layer=layer)
    cam_tf = _resize_and_orient(_compute_cam(ctx, waveform))
    return cam_tf.mean(dim=1)


def _topk_mask(pooled: torch.Tensor, k: int) -> torch.Tensor:
    mask = torch.zeros_like(pooled, dtype=torch.bool)
    if k > 0:
        mask[torch.topk(pooled, min(k, pooled.numel())).indices] = True
    return mask


def _random_mask(n_frames: int, k: int, seed: int) -> torch.Tensor:
    rng = random.Random(seed)
    mask = torch.zeros(n_frames, dtype=torch.bool)
    for i in rng.sample(range(n_frames), min(k, n_frames)):
        mask[i] = True
    return mask


def _splice_pair(waveform_t: torch.Tensor, frame_mask: torch.Tensor, fade: int):
    keep = _sample_mask(frame_mask, waveform_t.numel())
    return _splice(waveform_t, keep, fade), _splice(waveform_t, ~keep, fade)


def _sim(encoder, centroid: list[float], waveform: list[float]) -> float:
    if len(waveform) < int(MIN_DURATION_S * SAMPLE_RATE):
        return float("nan")
    return float(encoder.cosine_similarity(centroid, encoder.embed(waveform)))


def clip_layer_scores(model, encoder, centroid, waveform, layers, coverage, seeds, fade):
    """suff/nec margins (vs random baseline) for every layer on one clip."""
    centroid_t = torch.tensor(centroid, dtype=torch.float32)
    waveform_t = torch.tensor(waveform, dtype=torch.float32)
    out: dict[str, tuple[float, float]] = {}
    for name, layer, _freq, _order in layers:
        try:
            pooled = _cam_pooled(model, layer, centroid_t, waveform)
        except Exception:  # noqa: BLE001 — diagnostic, keep sweeping
            continue
        T = pooled.numel()
        k = max(1, round(coverage * T))
        cam_ret, cam_del = _splice_pair(waveform_t, _topk_mask(pooled, k), fade)
        cam_ret_sim, cam_del_sim = _sim(encoder, centroid, cam_ret), _sim(encoder, centroid, cam_del)
        r_ret, r_del = [], []
        for seed in range(seeds):
            rr, rd = _splice_pair(waveform_t, _random_mask(T, k, seed), fade)
            r_ret.append(_sim(encoder, centroid, rr))
            r_del.append(_sim(encoder, centroid, rd))
        suff = cam_ret_sim - float(torch.tensor(r_ret).nanmean())
        nec = float(torch.tensor(r_del).nanmean()) - cam_del_sim
        out[name] = (suff, nec)
    return out


# -----------------------------------------------------------------------------
# Task gathering
# -----------------------------------------------------------------------------

def _read_ref_bytes(ref) -> bytes | None:
    data = getattr(ref, "audio_bytes", None)
    if data:
        return data
    path = Path(ref.file_path)
    return path.read_bytes() if path.exists() else None


_AUDIO_EXTS = (".m4a", ".wav", ".flac", ".mp3", ".ogg", ".aac")


def decode_audio_file(path: Path, audio: AudioService) -> list[float] | None:
    """Decode any audio file to a trimmed 16 kHz mono waveform. Uses PyAV
    (bundled ffmpeg) for compressed formats like VoxCeleb's .m4a, then the
    app's VAD trim so the embedding sees speech, not leading silence."""
    try:
        import av  # PyAV — decodes m4a/aac/etc. in-process

        container = av.open(str(path))
        stream = container.streams.audio[0]
        resampler = av.audio.resampler.AudioResampler(format="flt", layout="mono", rate=16000)
        chunks: list[list[float]] = []
        for frame in container.decode(stream):
            for rframe in resampler.resample(frame):
                chunks.append(rframe.to_ndarray().reshape(-1).tolist())
        container.close()
    except Exception:
        return None
    waveform = [s for chunk in chunks for s in chunk]
    if not waveform:
        return None
    try:
        trimmed, _ = audio.trim_to_voice(AudioPayload(waveform=waveform, sample_rate=16000))
        return trimmed.waveform
    except Exception:
        return waveform


def _normalize_vec(v: list[float]) -> list[float]:
    n = math.sqrt(sum(x * x for x in v))
    return [x / n for x in v] if n > 1e-8 else v


def build_centroid(encoder, waveforms: list[list[float]]) -> list[float]:
    embs = [_normalize_vec(encoder.embed(w)) for w in waveforms if w]
    embs = [e for e in embs if e]
    if not embs:
        return []
    dim = len(embs[0])
    avg = [sum(e[i] for e in embs) / len(embs) for i in range(dim)]
    return _normalize_vec(avg)


def gather_tasks_from_dir(audio_dir: Path, audio, encoder, max_speakers: int, enroll_clips: int, query_clips: int):
    """VoxCeleb-style layout: each top-level subdir is a speaker. Build a
    centroid from `enroll_clips` and test on the next `query_clips` (held out).
    Yields (label, centroid, waveform) per query clip."""
    speakers = sorted([d for d in audio_dir.iterdir() if d.is_dir()])[:max_speakers]
    for spk in speakers:
        clips = sorted(p for p in spk.rglob("*") if p.suffix.lower() in _AUDIO_EXTS)
        need = enroll_clips + query_clips
        if len(clips) < need:
            continue
        enroll_waves = [w for w in (decode_audio_file(c, audio) for c in clips[:enroll_clips]) if w]
        if len(enroll_waves) < max(1, enroll_clips // 2):
            continue
        centroid = build_centroid(encoder, enroll_waves)
        if not centroid:
            continue
        for c in clips[enroll_clips:need]:
            wav = decode_audio_file(c, audio)
            if wav:
                yield f"{spk.name}/{c.stem}", centroid, wav


def gather_tasks(store, audio, user_id: str | None, query: str | None, all_users: bool):
    """Yield (label, centroid, waveform) for each query clip to attribute."""
    if all_users:
        users = [u.user_id for u in store.list_users()]
    elif user_id:
        users = [user_id]
    else:
        raise SystemExit("Pass --user-id <id> or --all.")

    for uid in users:
        speaker = store.get_speaker(uid)
        if speaker is None or not speaker.embedding:
            continue
        if query and not all_users:
            sources = [(query, Path(query).read_bytes())]
        else:
            refs = sorted(store.list_reference_samples(uid), key=lambda s: s.created_at)
            sources = [(f"{uid}#{i}", _read_ref_bytes(r)) for i, r in enumerate(refs)]
        for label, raw in sources:
            if not raw:
                continue
            try:
                trimmed, _ = audio.trim_to_voice(audio.decode_wav(raw))
            except Exception:  # noqa: BLE001
                continue
            yield label, speaker.embedding, trimmed.waveform


# -----------------------------------------------------------------------------
# Main
# -----------------------------------------------------------------------------

def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--user-id", default=None, help="Enrolled speaker to attribute")
    parser.add_argument("--all", action="store_true", help="Aggregate over every enrolled speaker's samples")
    parser.add_argument("--query", default=None, help="WAV to attribute (single-user mode; default: enrolled sample)")
    parser.add_argument("--audio-dir", default=None, help="VoxCeleb-style dir (idXXXX/<session>/*.m4a) — sweep over many speakers")
    parser.add_argument("--max-speakers", type=int, default=15, help="Speakers to sample from --audio-dir")
    parser.add_argument("--enroll-clips", type=int, default=3, help="Clips per speaker used to build the centroid")
    parser.add_argument("--query-clips", type=int, default=3, help="Held-out clips per speaker to attribute")
    parser.add_argument("--coverage", type=float, default=0.30, help="Fraction of the clip each layer keeps (0-1)")
    parser.add_argument("--seeds", type=int, default=5, help="Random-baseline masks to average over")
    args = parser.parse_args()

    settings = Settings()
    encoder = RedimNetSpeakerEncoder(weights_path=settings.redimnet_weights_path)
    model = encoder.model
    audio = AudioService(target_sample_rate=settings.sample_rate)
    fade = int(FADE_MS / 1000.0 * SAMPLE_RATE)

    if args.audio_dir:
        tasks = list(gather_tasks_from_dir(
            Path(args.audio_dir).expanduser(), audio, encoder,
            args.max_speakers, args.enroll_clips, args.query_clips,
        ))
    else:
        store = SQLiteStore(
            database_path=settings.database_path,
            reference_samples_path=settings.reference_samples_path,
        )
        tasks = list(gather_tasks(store, audio, args.user_id, args.query, args.all))
    if not tasks:
        raise SystemExit("No clips to attribute (no enrolled samples found).")

    # Layer set is fixed by architecture — discover once on the first clip.
    first_wave = torch.tensor(tasks[0][2], dtype=torch.float32)
    x = model.spec(first_wave.unsqueeze(0))
    if x.ndim == 3:
        x = x.unsqueeze(1)
    layers = discover_layers(model.backbone, x)
    freq_of = {name: freq for name, _layer, freq, _o in layers}

    src = f"dir {args.audio_dir}" if args.audio_dir else ("ALL users" if args.all else (args.user_id or ""))
    print(f"\nClips: {len(tasks)}   coverage {args.coverage * 100:.0f}%   seeds {args.seeds}   {src}\n")

    agg: dict[str, list[tuple[float, float]]] = {name: [] for name, *_ in layers}
    for i, (label, centroid, waveform) in enumerate(tasks, 1):
        scores = clip_layer_scores(model, encoder, centroid, waveform, layers, args.coverage, args.seeds, fade)
        for name, sn in scores.items():
            agg[name].append(sn)
        print(f"  [{i}/{len(tasks)}] {label}", end="\r")
    print(" " * 40, end="\r")

    header = f"{'layer':<32}{'F':>4}{'suff_mean':>11}{'nec_mean':>11}{'score_mean':>12}{'score_std':>11}{'n':>4}"
    print(header)
    print("-" * len(header))
    rows = []
    for name, *_ in layers:
        vals = agg[name]
        if not vals:
            continue
        suff = torch.tensor([v[0] for v in vals])
        nec = torch.tensor([v[1] for v in vals])
        score = suff + nec
        mean, std = float(score.nanmean()), float(score.std()) if score.numel() > 1 else 0.0
        rows.append((name, freq_of[name], float(suff.nanmean()), float(nec.nanmean()), mean, std, score.numel()))
        print(f"{name:<32}{freq_of[name]:>4}{float(suff.nanmean()) * 100:>+11.1f}"
              f"{float(nec.nanmean()) * 100:>+11.1f}{mean * 100:>+12.1f}{std * 100:>11.1f}{score.numel():>4}")

    if rows:
        best = max(rows, key=lambda r: r[4])
        print("\n" + "=" * len(header))
        print(f"Most faithful layer: {best[0]}  (freq bins {best[1]}, "
              f"mean score {best[4] * 100:+.1f} +/- {best[5] * 100:.1f} pts over n={best[6]})")
        print("  suff>0 = CAM region carries more identity than a random region of equal size.")
        print("  nec>0  = removing the CAM region hurts more than removing a random region.")
        if best[4] <= 0:
            print("  WARNING: no layer beat random on average — none localises identity better than chance.")


if __name__ == "__main__":
    main()
