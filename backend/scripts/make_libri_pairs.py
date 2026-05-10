"""Build a VoxCeleb-format trial-pair file from LibriSpeech test-clean.

LibriSpeech replaces VoxCeleb1-O for the v1.0.2 benchmark (no
registration). This generates a `pairs.txt` in the format
`<label> <wav1> <wav2>` per line, ready for `bench_eer_voxceleb.py`.

Pair-construction rules:
  * Per speaker, generate `--positives-per-speaker` same-speaker pairs
    (random utterance pairs from that speaker's pool).
  * For each positive, generate one same-count negative pair (this
    speaker's utterance vs a random other speaker's utterance).
  * Net: 2 * pos_per_speaker * n_speakers trial pairs.

Default: 100 positives × 40 speakers × 2 = 8000 trials. Plenty for an
EER curve; ~10-15 min on M2 with the bench script's embedding cache.

Usage:
    python scripts/make_libri_pairs.py \\
        --root ~/data/librispeech/LibriSpeech/test-clean \\
        --out  ~/data/librispeech/pairs.txt \\
        --positives-per-speaker 100 \\
        --seed 42

The `--root` directory should be the standard LibriSpeech layout:
  test-clean/{speaker_id}/{book_id}/{utt_id}.flac
"""

from __future__ import annotations

import argparse
import random
from pathlib import Path


def collect_speaker_utterances(root: Path) -> dict[str, list[str]]:
    """Return {speaker_id: [relative_audio_paths]}."""
    out: dict[str, list[str]] = {}
    for speaker_dir in sorted(p for p in root.iterdir() if p.is_dir()):
        utts = sorted(speaker_dir.rglob("*.flac"))
        if not utts:
            continue
        out[speaker_dir.name] = [str(u.relative_to(root)) for u in utts]
    return out


def build_pairs(
    speakers: dict[str, list[str]],
    positives_per_speaker: int,
    seed: int,
) -> list[tuple[int, str, str]]:
    rng = random.Random(seed)
    speaker_ids = list(speakers.keys())
    pairs: list[tuple[int, str, str]] = []

    for spk in speaker_ids:
        utts = speakers[spk]
        if len(utts) < 2:
            continue

        # Positives: same speaker, two distinct utterances.
        for _ in range(positives_per_speaker):
            a, b = rng.sample(utts, 2)
            pairs.append((1, a, b))

        # Negatives: same count. One utterance from this speaker + one
        # from a randomly chosen DIFFERENT speaker.
        other_ids = [s for s in speaker_ids if s != spk]
        for _ in range(positives_per_speaker):
            a = rng.choice(utts)
            other_spk = rng.choice(other_ids)
            b = rng.choice(speakers[other_spk])
            pairs.append((0, a, b))

    rng.shuffle(pairs)
    return pairs


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--root", type=Path, required=True,
                        help="LibriSpeech test-clean root (contains speaker_id/ subdirs).")
    parser.add_argument("--out", type=Path, required=True,
                        help="Output pairs file (VoxCeleb format: `<label> <wav1> <wav2>`).")
    parser.add_argument("--positives-per-speaker", type=int, default=100,
                        help="Positive same-speaker pairs per speaker. Same number of negatives generated.")
    parser.add_argument("--seed", type=int, default=42)
    args = parser.parse_args()

    if not args.root.exists():
        raise SystemExit(f"--root {args.root} does not exist. Did you unpack test-clean.tar.gz?")

    speakers = collect_speaker_utterances(args.root)
    if not speakers:
        raise SystemExit(f"No speakers found under {args.root}; expected speaker_id/book_id/*.flac layout.")

    print(f"speakers: {len(speakers)}")
    print(f"utterances total: {sum(len(v) for v in speakers.values())}")

    pairs = build_pairs(speakers, args.positives_per_speaker, args.seed)
    print(f"pairs generated: {len(pairs)}")

    args.out.parent.mkdir(parents=True, exist_ok=True)
    with args.out.open("w") as f:
        for label, a, b in pairs:
            f.write(f"{label} {a} {b}\n")
    print(f"wrote {args.out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
