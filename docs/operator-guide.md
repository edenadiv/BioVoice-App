# Operator guide — BioVoice kiosk

A single page that walks you from a fresh checkout to a working
voice-verification round-trip.

## Boot the stack

You'll want two terminals.

**Terminal 1 — backend.** From the repo root:

```bash
cd backend
.venv/bin/uvicorn app.main:app --reload --host 0.0.0.0 --port 8000
```

Wait for `Uvicorn running on http://0.0.0.0:8000`. Sanity-check:

```bash
curl http://localhost:8000/readyz
```

You want `{"ready": true, ...}`.

**Terminal 2 — frontend.** From the repo root:

```bash
cd frontend
npm run dev
```

Open `http://localhost:5173`.

## The three screens

The sidebar has three nav items:

| Screen | What it does |
|---|---|
| **Console** | Run a verification against an enrolled profile. Activity feed of every recent verification. |
| **Deepfake Lab** | Forge a clone of an enrolled voice (XTTS) → score it against the AASIST detector. |
| **Profiles** | Enrol a new voice. Delete an existing one. See per-profile verify counts. |

Settings + Admin are intentionally absent — this is a single-purpose operator surface.

## Enrol a new profile

1. Sidebar → **Profiles**.
2. Click **+ ENROLL NEW**.
3. Type a user ID — `2–32 chars, lowercase letters / digits / `_` / `-`. The ✓ valid hint appears once it matches.
4. **Pick a microphone** from the dropdown (or stick with browser default). The first time, click "Enable labels" if device names are blank — this triggers a one-time mic permission probe so the browser will reveal device labels.
5. Add samples — two ways, mix freely:
   - **Record**: press **START RECORDING** → speak for as long as you like → press **STOP**. There's no time limit; the modal shows a live waveform, level meter, and elapsed timer.
   - **Upload**: press **UPLOAD AUDIO** → pick one or more files (.wav/.mp3/.m4a/.ogg/.flac). Each file is decoded in-browser to 16 kHz mono WAV before posting.
6. Each sample posts to `/enroll`. Backend scores it on SNR / clipping / speech ratio. The captured-samples list shows the verdict — green check ✓ for accepted, red × for rejected with the reason inline.
7. Once **3 samples are accepted**, the **DONE** button enables. Press it whenever you're satisfied — there's no upper cap. More samples = better verification accuracy.

If a sample fails the quality gate, just record/upload another. The backend keeps the good ones.

## Verify a profile

1. Sidebar → **Console**.
2. Click the profile chip you want to verify against (you'll see one chip per enrolled user).
3. Click **Run verification** (or press `V`).
4. The verify overlay opens. Press the record button → speak for 3 seconds.
5. The backend returns one of:
   - **ACCEPT** — speaker matches the enrolled embedding above the similarity threshold.
   - **REJECT** — no match; the speaker is someone else (or the audio was too noisy).
   - **DEEPFAKE** — AASIST flagged the audio as synthetic.
6. The result panel shows the similarity score, the deepfake score, and the per-stage timing breakdown.

The verification lands in the activity feed at the bottom of the Console.

## Forge a deepfake (Deepfake Lab)

1. Sidebar → **Deepfake Lab**.
2. Pick a target profile from the list. (You need at least one enrolled profile.)
3. Optional: change the spoken text. Default is "Open the door, please."
4. Click **Forge & test attack**.
5. The backend uses XTTS to synthesise a clone of that profile's voice speaking the text, then runs the synthesised audio through the deepfake detector.
6. The result panel shows the verdict (`GENUINE` or `FAKE`) and the four sub-axis scores.

**Engine choice:**
- If XTTS is installed (Py 3.11/3.12 venv only — see [README §Spoof generation](../backend/README.md)), the lab uses voice-cloning XTTS conditioned on the target's enrolled samples. Real cloning attack.
- Otherwise it falls back to the system's text-to-speech (`say` on macOS, `espeak-ng` on Linux). The `X-Spoof-Source` header on the response says which engine ran.

**AASIST limitation:** the bundled AASIST checkpoint is trained on certain TTS systems (mostly older Tacotron + WaveNet variants) and doesn't reliably catch macOS Siri-quality `say` output — those samples often score 0.95+ ("genuine"). XTTS-v2 cloning artefacts and most known attacks WILL register. To benchmark detection on a wider attack surface, retrain AASIST on a dataset that includes modern TTS (out of scope for this kiosk).

## Delete a profile

1. Sidebar → **Profiles**.
2. Hover the profile card → top-right `×` button.
3. Confirm the prompt.
4. The backend soft-deletes the row (moved to `deleted_users` for audit). The profile disappears from the list.

There's no undelete in the UI. To recover a profile you re-enrol it from scratch.

## When something looks wrong

| Symptom | First thing to check |
|---|---|
| `/readyz` returns 503 | Backend log — usually weights weren't loaded. `pip install -e ".[model]"` then restart uvicorn. |
| Modal won't open | Browser devtools console for a JS error. CORS misconfig will show as a network failure. |
| "Microphone access denied" | Browser permission. macOS Safari needs a separate Settings → Websites → Microphone allow. |
| All verifications come back REJECT | Mic input is probably noisy. Check the SNR in the enrol panel; re-enrol in a quieter room. |
| All verifications come back ACCEPT regardless of speaker | Threshold might be too low. Edit `similarity_threshold` in `backend/app/core/config.py` (default 0.75) and restart uvicorn. |
