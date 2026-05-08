# Backend

FastAPI backend scaffold for the web version of BioVoice.

Current responsibilities:

- Audio upload and preprocessing
- Enrollment
- Verification
- Deepfake detection
- Result persistence

Implementation entrypoint:

- `app/main.py`

The backend currently uses in-memory storage and a feature-based speaker embedding placeholder so the web flow can be built before the final persistence and model-serving layer is added.

Installation:

- Base backend plus local model stack: `python -m pip install -e .[model] --no-build-isolation`
- Add spoof-generation support (XTTS): `python -m pip install -e .[model,spoof] --no-build-isolation`

Notes:

- The `spoof` extra depends on `TTS`, which is currently expected to work on Python 3.11 or 3.12.
- On Python 3.13, install the backend without `spoof` unless `TTS` publishes compatible builds.
