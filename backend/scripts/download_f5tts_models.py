"""Pre-download F5-TTS model weights and the Vocos vocoder from HuggingFace.

Run once after `pip install -r requirements.txt` so the first clone request
doesn't stall on a network download:

    python backend/scripts/download_f5tts_models.py

Downloads to the default HuggingFace cache (~/.cache/huggingface/hub/).
Set HF_HOME or HUGGINGFACE_HUB_CACHE to change the location.
"""

from __future__ import annotations

import sys

print("Importing f5-tts (this may take a moment on first run)...")

import sys
import types

# Apply the same speechbrain LazyModule workaround used by the app.
try:
    from speechbrain.utils.importutils import LazyModule
    for name, module in list(sys.modules.items()):
        if isinstance(module, LazyModule):
            sys.modules[name] = types.ModuleType(name)
except ImportError:
    pass

try:
    from f5_tts.api import F5TTS
except ImportError:
    print("ERROR: f5-tts is not installed. Run: pip install -r backend/requirements.txt")
    sys.exit(1)

print("Downloading F5TTS_v1_Base weights + Vocos vocoder from HuggingFace...")
print("(~500 MB total — will be skipped on subsequent runs if already cached)\n")

try:
    model = F5TTS(model="F5TTS_v1_Base")
    print("\nDone. F5-TTS models are cached and ready.")
except Exception as exc:
    print(f"\nERROR during download: {exc}")
    print("Check your internet connection and try again.")
    sys.exit(1)
