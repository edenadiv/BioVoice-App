"""Build a self-contained anti-spoofing evaluation set.

Replaces gated ASVspoof 2019 LA (which needs Edinburgh DataShare
registration) with a balanced set of:
  * Real (bonafide) audio: random LibriSpeech utterances.
  * Synthetic (spoof) audio: TTS clones of the same texts, generated
    from `say` (macOS) or `espeak-ng` (Linux). Multiple voices used to
    diversify the spoof distribution.

Outputs a directory layout that matches what bench_spoof_detection.py
expects:
  <out>/audio/{utt_id}.wav    # mixed real + spoof, all WAV at 16 kHz
  <out>/protocol.txt          # ASVspoof format: `<spk> <utt_id> - - <bonafide|spoof>`

Caveats (be honest with the supervisor):
  * Spoofs are macOS / espeak TTS, NOT modern voice-cloning attacks
    (XTTS / ElevenLabs). AASIST may not catch them well — same
    documented limitation as the operator-guide notes.
  * The transcripts for the spoofs are fabricated short phrases, not
    parallel transcripts of the LibriSpeech reals (LibriSpeech ships
    text but the eval doesn't condition on it).
  * Numbers from this set are not directly comparable to the published
    ASVspoof 2019 LA baselines (different spoof distribution). They
    are an honest measurement of THIS detector against THIS attack
    distribution.

Usage:
    python scripts/make_spoof_eval.py \\
        --libri-root ~/data/librispeech/LibriSpeech/test-clean \\
        --out ~/data/spoof_eval \\
        --n-real 300 --n-spoof 300 --seed 42
"""

from __future__ import annotations

import argparse
import random
import shutil
import subprocess
import wave
from pathlib import Path

import numpy as np


_SPOOF_TEXTS = [
    "Open the safe please, this is the supervisor speaking.",
    "Authorise the wire transfer for two million dollars.",
    "I have lost my access card, please disable the security gate.",
    "The system needs to be rebooted, run the maintenance script now.",
    "Confirm the deletion of all backups in the secure storage.",
    "Grant administrator privileges to the new contractor account.",
    "Reset all passwords and send them to my personal email.",
    "Disable the alarm in the server room for the next two hours.",
    "Move the funds to the offshore account before close of business.",
    "Approve the deployment of the experimental binary to production.",
    "Tell the security team to stand down for tonight's exercise.",
    "Issue a temporary access badge to the consultant in lobby three.",
    "Bypass the audit log for the next four hours of operations.",
    "Forward the encrypted file from yesterday's call to my colleague.",
    "Schedule an emergency board meeting in the next thirty minutes.",
    "Open the secondary firewall port for the partner integration.",
    "Suspend two-factor authentication for my account for testing.",
    "Allow remote desktop access to the operations workstation.",
    "Cancel the third-party security audit scheduled for next week.",
    "Provision the requested machine learning compute cluster now.",
]


def _system_tts() -> tuple[str, str] | None:
    """Return ('say'|'espeak', binary_path) or None if no TTS available."""
    say = shutil.which("say")
    if say:
        return ("say", say)
    for binary in ("espeak-ng", "espeak"):
        path = shutil.which(binary)
        if path:
            return ("espeak", path)
    return None


def _say_voices() -> list[str]:
    """A handful of macOS `say` voices to diversify the spoof set.
    Mix of natural-ish (Allison, Samantha, Tom) + clearly synthetic
    (Trinoids, Zarvox, Fred) so the eval covers the AASIST score range."""
    return ["Allison", "Samantha", "Tom", "Daniel", "Trinoids", "Zarvox", "Fred", "Bahh"]


def synth_with_say(binary: str, voice: str, text: str, out_path: Path) -> None:
    cmd = [binary, "-v", voice, "-o", str(out_path), "--data-format", "LEI16@16000", text]
    subprocess.run(cmd, check=True, capture_output=True)


def synth_with_espeak(binary: str, text: str, out_path: Path) -> None:
    subprocess.run([binary, "-w", str(out_path), text], check=True, capture_output=True)


def _flac_to_wav(src: Path, dst: Path) -> None:
    """LibriSpeech ships FLAC; bench_spoof_detection.load_audio handles
    both, but the protocol assumes a single extension. Convert to WAV
    for consistency."""
    import soundfile as sf
    samples, sr = sf.read(str(src), dtype="float32", always_2d=False)
    if samples.ndim > 1:
        samples = samples.mean(axis=1)
    samples_i16 = np.clip(samples * 32767.0, -32768, 32767).astype(np.int16)
    with wave.open(str(dst), "wb") as h:
        h.setnchannels(1)
        h.setsampwidth(2)
        h.setframerate(int(sr))
        h.writeframes(samples_i16.tobytes())


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--libri-root", type=Path, required=True,
                        help="LibriSpeech test-clean root directory.")
    parser.add_argument("--out", type=Path, required=True,
                        help="Output directory (will contain audio/ + protocol.txt).")
    parser.add_argument("--n-real", type=int, default=300,
                        help="Number of bonafide samples drawn from LibriSpeech.")
    parser.add_argument("--n-spoof", type=int, default=300,
                        help="Number of spoof samples to synthesise.")
    parser.add_argument("--seed", type=int, default=42)
    args = parser.parse_args()

    if not args.libri_root.exists():
        raise SystemExit(f"--libri-root {args.libri_root} does not exist.")

    rng = random.Random(args.seed)
    audio_dir = args.out / "audio"
    audio_dir.mkdir(parents=True, exist_ok=True)
    protocol_lines: list[str] = []

    # ---- Bonafide samples (from LibriSpeech) ----
    flacs = list(args.libri_root.rglob("*.flac"))
    if len(flacs) < args.n_real:
        raise SystemExit(f"Only {len(flacs)} FLACs found; need ≥ {args.n_real}.")
    rng.shuffle(flacs)
    print(f"Selecting {args.n_real} bonafide LibriSpeech samples...")
    for i, src in enumerate(flacs[: args.n_real]):
        utt_id = f"LIBRI_BONAFIDE_{i:04d}"
        spk = src.parts[-3]  # speaker_id from path
        dst = audio_dir / f"{utt_id}.wav"
        _flac_to_wav(src, dst)
        protocol_lines.append(f"{spk} {utt_id} - - bonafide")
    print(f"  done: {args.n_real} bonafide WAVs")

    # ---- Spoof samples (TTS) ----
    tts = _system_tts()
    if tts is None:
        raise SystemExit("No TTS binary on PATH (need `say` on macOS or `espeak-ng` on Linux).")
    engine, binary = tts
    voices = _say_voices() if engine == "say" else ["espeak"]

    print(f"Synthesizing {args.n_spoof} spoof samples via {engine} ({len(voices)} voices)...")
    for i in range(args.n_spoof):
        utt_id = f"TTS_SPOOF_{i:04d}"
        text = rng.choice(_SPOOF_TEXTS)
        voice = rng.choice(voices)
        dst = audio_dir / f"{utt_id}.wav"
        if engine == "say":
            synth_with_say(binary, voice, text, dst)
        else:
            synth_with_espeak(binary, text, dst)
        protocol_lines.append(f"TTS_{voice} {utt_id} - - spoof")
        if (i + 1) % 50 == 0:
            print(f"  spoof {i + 1}/{args.n_spoof}")
    print(f"  done: {args.n_spoof} spoof WAVs")

    # Shuffle protocol for good measure (not strictly required).
    rng.shuffle(protocol_lines)
    protocol_path = args.out / "protocol.txt"
    protocol_path.write_text("\n".join(protocol_lines) + "\n")
    print(f"\nWrote {protocol_path} ({len(protocol_lines)} lines)")
    print(f"Audio under {audio_dir}")

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
