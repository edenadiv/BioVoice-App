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
