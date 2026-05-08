#!/usr/bin/env bash
# E2.1 — Download XTTS-v2 weights into the project root's `XTTS-v2/` dir.
#
# Settings (`backend/app/core/config.py:xtts_model_path`) expects the model at
# <project_root>/XTTS-v2/. We pull from the official Coqui release on Hugging
# Face. After this script, install the Python deps:
#
#     .venv/bin/pip install 'TTS>=0.22,<0.23'
#
# If TTS won't install on your Python version (Python 3.13+ is unsupported by
# the upstream package today), set BIOVOICE_FALLBACK_SPOOF=1 instead — the
# `/me/spoof` endpoint will serve `backend/data/fallback_spoof.wav` so the lab
# demo still works.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
DEST="${REPO_ROOT}/XTTS-v2"
HF_REPO="coqui/XTTS-v2"
HF_BASE="https://huggingface.co/${HF_REPO}/resolve/main"

mkdir -p "${DEST}"

cd "${DEST}"

# Files we need; vocab + speakers come along when present so multi-speaker
# inference works out of the box.
FILES=(
  "config.json"
  "model.pth"
  "vocab.json"
  "speakers_xtts.pth"
  "dvae.pth"
  "mel_stats.pth"
  "hash.md5"
)

for f in "${FILES[@]}"; do
  if [[ -f "${f}" ]]; then
    echo "✓ ${f} already present, skipping"
    continue
  fi
  echo "↓ Downloading ${f}…"
  if ! curl -fsSL --retry 3 -o "${f}" "${HF_BASE}/${f}"; then
    if [[ "${f}" == "speakers_xtts.pth" || "${f}" == "dvae.pth" || "${f}" == "mel_stats.pth" || "${f}" == "hash.md5" ]]; then
      echo "  (optional file ${f} unavailable — XTTS will run without it)"
      rm -f "${f}"
      continue
    fi
    echo "  ERROR: required file ${f} could not be downloaded from ${HF_BASE}/${f}" >&2
    exit 1
  fi
done

echo
echo "XTTS-v2 weights ready at ${DEST}"
echo "Next: .venv/bin/pip install 'TTS>=0.22,<0.23'"
