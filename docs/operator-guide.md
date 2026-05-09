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
4. Click **Record sample 1 / 3** and speak for the full 3 seconds.
5. The backend scores the sample on SNR / clipping / speech ratio. If it passes, the dot fills green and the next sample button enables.
6. Repeat for samples 2 + 3. After the third accepted sample, the modal closes and the new profile appears in the list with `3/3 samples`.

If a sample fails the quality gate, the dot stays empty and the inline `LAST SAMPLE QUALITY` panel tells you why (low SNR, too much silence, clipping). Try again — the backend hasn't lost the previous good samples.

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

XTTS isn't bundled — if you haven't installed the `[model]` extra (`pip install -e ".[model]"`), the lab returns a 503 and explains what's missing.

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
