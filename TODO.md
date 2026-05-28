# BioVoice — Future Work

Tracked backlog of planned improvements. The **Deployment & Infrastructure** items remain open; the **Models & Detection** and **Testing & Validation** items below are implemented.

## Deployment & Infrastructure

- [ ] **Deploy the frontend to Vercel** — get the React/Vite SPA live on Vercel as a public website.
- [ ] **Deploy the backend / API to Vercel** — stand up the FastAPI backend.
  - ⚠️ **Compatibility flag:** the backend runs heavy ML inference (PyTorch + ReDimNet B5 + AASIST, ~353 MB of bundled model weights, ~400 ms CPU inference per request). Vercel's serverless functions have tight limits on bundle size (~250 MB unzipped), execution time, and have no persistent process / warm model cache — so this backend likely **does not fit Vercel's serverless model**. Confirm before committing; a container host (Fly.io, Render, Railway, Google Cloud Run, or a plain VM) is probably the right target instead.
- [ ] **Connect to a Cloud SQL database** — migrate from the current local SQLite store to a managed Cloud SQL (Postgres) instance. (See existing `docs/postgres_migration.md` for the storage-migration playbook.)
- [ ] **Add user authentication (OAuth)** — introduce user accounts and protect the currently-unauthenticated API surface with an OAuth login flow.

## Models & Detection

- [x] **Improve AASIST** — improve the AASIST anti-spoofing model (accuracy / robustness of deepfake detection).
- [x] **Deepfake generation against a target voice** — generate synthetic speech targeting a specific enrolled voice, then **filter out / discard candidates that don't actually match the target**. Prefer generating many candidates and keeping only the close matches.
- [x] **Embed Grad-CAM heat zones into the vector space** — after producing a Grad-CAM overlay, take the highlighted heat zones, embed them, and render them inside the existing vector-space visualization (the Dashboard embedding-constellation component) so we can see how close those regions sit to the speaker.

## Testing & Validation

- [x] **Add comprehensive tests + validation reports** — expand test coverage substantially, generate validation reports, and save them in the new `/reports` directory.
