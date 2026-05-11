# Packaging design — Web + PWA + Desktop installer

> **Status**: design approved 2026-05-12
> **Releases**: v1.1.0 (W + PWA) → v1.2.0 (D bundled installer)
> **Author**: Claude pair with Eden Adiv

---

## Context

The kiosk currently exists as a local-dev experience: `pnpm dev` on the frontend, `uvicorn app.main:app` on the backend, and a `docker-compose.yml` for single-host staging. Three things are missing for v1.0 to feel like a real product:

1. **A web version** — a deployable Docker image, so a third party can run the kiosk on their own infra and reach it from any browser.
2. **A mobile-installable surface** — operator phone test, demo on a tablet, "show this to the supervisor on her iPhone" without an app-store review.
3. **A native desktop installer** — drop `.dmg` on a clean Mac, double-click, system runs offline.

The `Plan.md` for v1.0.3 already shipped real ML visualisations. With those in place, the natural next step is **packaging**: take the existing two-process app and emit deployable artefacts.

This spec covers all three deliverables. Implementation splits into two releases:

- **v1.1.0**: web image + PWA. ~1.5 engineer-days. Foundation for everything else.
- **v1.2.0**: desktop bundled installer. ~1–2 engineer-weeks. Highest technical risk.

---

## What's in the repo today

- `Dockerfile` — multi-stage Python build, ~1.4 GB runtime image with `[model]` extras.
- `docker-compose.yml` — three services (`backend`, `frontend` via nginx static, `nginx` TLS termination).
- `frontend/package.json` — React 18 + Vite 5 + Vitest 4. No `vite-plugin-pwa` yet.
- `backend/app/main.py` — pure API, no static-files mount.
- `backend/models/{aasist,redimnet_b5}.pt` — 1.2 MB + 30 MB. Small enough to embed in any installer.
- `frontend/src/lib/audio.ts:37-42` — MediaRecorder candidates include `audio/mp4;codecs=mp4a.40.2`, so iOS Safari recording works without further changes.

---

## Design

### Architecture (cross-cutting)

All three deliverables share **one React frontend codebase + one FastAPI backend codebase**. No forks. The differences are packaging only:

| Mode | Frontend served by | Backend reached at |
|---|---|---|
| Local dev | `vite` on :5173 | `uvicorn` on :8000 |
| Web image (W) | FastAPI static-files mount, port 8000 | same origin |
| PWA install | (cached service worker) → FastAPI | same origin (host of W) |
| Desktop bundled (D) | Tauri WebView, file:// | sidecar `biovoice-backend` on a free localhost port |

The single load-bearing refactor is **W's same-origin move**: drop `VITE_API_BASE_URL` and switch all `fetch()` calls to relative paths. Once that lands, the desktop sidecar inherits same-origin behaviour for free.

### W — Web Image (v1.1.0, ~1 day)

**Architecture**:

```
┌────────────────────── biovoice:1.1.0 ──────────────────────┐
│                                                            │
│  uvicorn → FastAPI                                         │
│   ├── /health, /readyz, /users, /verify, … (existing)      │
│   ├── /users/embeddings, /embed (v1.0.3)                   │
│   └── /  → mount static_files(frontend/dist)               │
│       └── unmatched non-API paths → index.html (SPA route) │
│                                                            │
│  /app/data       → SQLite + reference samples (volume)     │
│  /app/models     → aasist.pt + redimnet_b5.pt (baked in)   │
│                                                            │
└────────────────────────────────────────────────────────────┘
                          │
                          ▼
              port 8000 (HTTP — TLS handled
              by Caddy / fly.io / Cloud LB)
```

**Changes**:
1. `backend/app/main.py` — add `app.mount("/", StaticFiles(directory="frontend_dist", html=True))`. Use a custom catch-all route ordering: API routes first, static-files mount last with `html=True` for SPA fallback.
2. `frontend/src/lib/api.ts` — change `const API_BASE = import.meta.env.VITE_API_BASE_URL ?? "http://localhost:8000"` → `const API_BASE = import.meta.env.VITE_API_BASE_URL ?? ""`. Same-origin by default, env-overridable for local dev.
3. New top-level `Dockerfile`:
   - **Stage 1 (node:20-alpine)**: `corepack enable`, `pnpm install --frozen-lockfile`, `pnpm build`. Output: `/build/frontend/dist`.
   - **Stage 2 (python:3.12-slim)**: same as current `backend/Dockerfile` — `pip install -e ".[model]"`. Adds `/install` site-packages.
   - **Stage 3 (python:3.12-slim runtime)**: copy `/install` from stage 2, copy `frontend/dist` from stage 1 into `frontend_dist/`, copy `models/`. Single `CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]`.
4. Existing `backend/Dockerfile` and `docker-compose.yml` stay for the local-dev workflow but document the new top-level `Dockerfile` as the **deployable** image.
5. New `docs/deployment.md` (or rewrite the existing one) covering:
   - `docker build -t biovoice:1.1.0 .`
   - `fly deploy` from a `fly.toml` template
   - Render / Railway dashboards
   - Bare VPS with Caddy reverse proxy for TLS

**Verification**:
- `docker build` completes; image ≤ 1.5 GB.
- `docker run -p 8000:8000 biovoice:1.1.0` → `curl localhost:8000/health` returns `{"status":"ok"}`.
- Browser to `http://localhost:8000` shows the kiosk; enrol + verify work end-to-end.
- Existing test suites untouched: backend 112/112, frontend 47/47.
- New backend test: `GET /` returns HTML with `<div id="root">`; `GET /assets/index-*.js` returns JS.

### PWA — Installable web (v1.1.0, ~0.5 day)

**Goal**: kiosk installs to iPhone/iPad/Android home screen and Chrome/Edge desktop, indistinguishable from a native app shell.

**Changes**:
1. `frontend/package.json` — add `vite-plugin-pwa` (devDependency, ~50 KB on disk, 0 KB on the bundle).
2. `frontend/vite.config.ts` — wire `VitePWA({ registerType: 'autoUpdate', includeAssets: [...icons], manifest: {...} })`.
3. Manifest:
   ```json
   {
     "name": "BioVoice",
     "short_name": "BioVoice",
     "theme_color": "#04070d",
     "background_color": "#04070d",
     "display": "standalone",
     "start_url": "/",
     "icons": [
       { "src": "/icons/icon-192.png", "sizes": "192x192", "type": "image/png" },
       { "src": "/icons/icon-512.png", "sizes": "512x512", "type": "image/png" },
       { "src": "/icons/icon-maskable.png", "sizes": "512x512", "type": "image/png", "purpose": "maskable" }
     ]
   }
   ```
4. Single source SVG → 192/512/maskable PNGs, committed to `frontend/public/icons/`.
5. `frontend/index.html` — add `<link rel="manifest">`, `<meta name="theme-color">`, iOS `apple-touch-icon`, `apple-mobile-web-app-capable`, `apple-mobile-web-app-status-bar-style`.
6. Service worker: cache `index.html` + bundled JS/CSS + icons (Workbox precache). API routes (`/users`, `/verify`, `/embed`, etc.) bypass the cache (`NetworkOnly` strategy) — they need a live backend.

**Verification**:
- `pnpm build` produces `dist/sw.js` + `dist/manifest.webmanifest`.
- Lighthouse PWA audit ≥ 90 (`npx lighthouse http://localhost:8000 --only-categories=pwa`).
- Manual: install on iPhone (Share → Add to Home Screen), launch from icon, mic permission prompt fires correctly.
- Manual: same on Android Chrome (chrome menu → Install app).
- Service worker doesn't cache `/users/*`, `/verify`, `/embed`, etc. — confirmed via DevTools Network panel during a verify (cache miss).

### D — Desktop bundled installer (v1.2.0, ~1–2 weeks)

**Goal**: one downloadable per OS. Double-click to install. Double-click to launch. Works offline. ML inference happens locally.

**Architecture**:

```
┌─────────────────── BioVoice.app (macOS) ─────────────────┐
│                                                          │
│  Tauri shell (Rust)                                      │
│    ├── WebView loads bundled React UI (file://)          │
│    ├── on_app_start:                                     │
│    │     1. pick free port                               │
│    │     2. spawn sidecar: biovoice-backend --port=N     │
│    │     3. wait for /health                             │
│    │     4. inject port into window via JS               │
│    └── on_app_exit: kill sidecar                         │
│                                                          │
│  biovoice-backend (PyInstaller-frozen FastAPI)           │
│    ├── Embedded Python 3.12 + torch + deps (~700 MB)     │
│    ├── Resources: aasist.pt + redimnet_b5.pt             │
│    └── Listens on the port Tauri picked                  │
│                                                          │
│  Data (mutable, in user's app-data dir):                 │
│    ├── biovoice.db (SQLite)                              │
│    └── reference_samples/                                │
│                                                          │
└──────────────────────────────────────────────────────────┘
```

**Phases**:

- **D1 — Tauri scaffold** (~0.5 day):
  - `cargo install create-tauri-app` → `desktop/`. Picks the React + Vite preset.
  - WebView loads `http://localhost:8000` (assumes backend running outside).
  - `cargo tauri dev` opens the kiosk in a native window. Sanity check.

- **D2 — PyInstaller bundle** (~3 days, biggest risk):
  - New `backend/biovoice-backend.spec` driving PyInstaller.
  - Output: single executable `biovoice-backend` (~600–800 MB on macOS, includes torch + all wheels).
  - ML weights packaged via `--add-data 'models:models'` — accessible at runtime via `sys._MEIPASS / 'models'`.
  - The script is essentially a thin wrapper that re-runs `uvicorn.run(app, ...)`.
  - Build matrix: macOS arm64 (M-series), macOS x64 (Intel), Linux x64. Windows deferred to D5 (cross-build via GH Actions; can't build Windows binaries from a Mac).
  - Smoke: `./biovoice-backend --port 9000 &; curl localhost:9000/health` → `{"status":"ok"}`.

- **D3 — Tauri sidecar wiring** (~2 days):
  - Tauri's `tauri.conf.json` `bundle.externalBin` references `biovoice-backend`.
  - `src-tauri/src/main.rs`: on `setup`, spawn sidecar with `Command::sidecar("biovoice-backend").args(["--port", &port])`. Use `portpicker` Rust crate to pick a free port.
  - Wait-for-ready loop (poll `/health` for up to 30 s before showing window).
  - Register a Tauri command `get_backend_port() -> u16` so the frontend can read the port.
  - On window-close, send shutdown signal + `kill()` the sidecar (with a 5 s grace period).

- **D4 — Frontend platform shim** (~0.5 day):
  - New `frontend/src/lib/platform.ts`:
    ```ts
    export const isTauri = typeof (window as any).__TAURI__ !== "undefined";
    export async function getApiBase(): Promise<string> {
      if (!isTauri) return ""; // same-origin in browser/PWA
      const port = await invoke<number>("get_backend_port");
      return `http://localhost:${port}`;
    }
    ```
  - `lib/api.ts` — replace the const `API_BASE` with a lazy resolver. Resolve once at app boot, memoise.
  - Browser/PWA path stays untouched. Tauri path gets the sidecar's port.

- **D5 — Build pipeline** (~2 days):
  - `cargo tauri build` on macOS → `BioVoice-1.2.0_aarch64.dmg` + `_x64.dmg`.
  - GitHub Actions `desktop-build` workflow: matrix on `macos-latest`, `windows-latest`, `ubuntu-latest`. Runs on tag `v1.2.0+`. Artefacts uploaded to the release.
  - Linux output: `BioVoice-1.2.0.AppImage` + `.deb`.
  - Windows output: `BioVoice-1.2.0_x64.msi` (PyInstaller-built `biovoice-backend.exe` as the sidecar).
  - **Code signing skipped**. macOS Gatekeeper warning + Windows SmartScreen warning documented in `docs/installer.md` with the right-click-→-Open workaround.

- **D6 — Manual smoke** (~0.5 day):
  - Clean macOS user account. Mount the .dmg. Drag to Applications. Launch.
  - Sidecar starts within 30 s. Window shows kiosk.
  - Enrol new profile (3 samples) → success.
  - Verify against profile → ACCEPT.
  - Quit app → confirm sidecar process gone via `ps`.
  - Re-launch → SQLite + reference samples persist.
  - Doc the procedure in `docs/installer-smoke.md`.

**Verification (D)**:
- PyInstaller produces a runnable `biovoice-backend` on macOS arm64. `--port 9001 & curl localhost:9001/users` returns 200.
- `cargo tauri build` produces a signed-or-unsigned `.dmg`.
- Smoke procedure passes on a clean Mac account.
- Backend pytest still passes against the source code (PyInstaller doesn't change the source — just packages it).

### Out of scope (explicit, won't sneak in)

- Code signing for macOS/Windows ($99/yr Apple Developer + Windows EV cert). Documented warnings only.
- Auto-update mechanism. Operator downloads new installer manually.
- Capacitor / React Native / Flutter native apps. PWA is the chosen mobile path.
- Hosted deployment (Fly/Render/Railway/AWS) — I ship the Docker image; the operator deploys it.
- Postgres migration (still SQLite — fine for kiosk).
- Multi-instance hosting / load balancer / Redis. Single container.
- Auto-update for the desktop app.
- Trained sub-classifier heads, XTTS spoof generation, multi-speaker volunteer study (carried from prior plans).

---

## Risk register

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| PyInstaller can't bundle torch cleanly on macOS arm64 | Medium | High | Allocate full day for D2 spike. Fall back to `nuitka` if PyInstaller fails. Document the workaround. |
| Tauri sidecar lifecycle leaks process on hard-quit | Low | Medium | Trap signals in Rust setup; document `pkill biovoice-backend` recovery. |
| Windows + Linux cross-build via GH Actions hits unexpected dep failures | Medium | Medium | Defer Windows + Linux to v1.2.1 if blocked at D5. macOS-only ship still satisfies the kiosk's intended deployment. |
| iOS PWA service worker races mic permission prompt | Low | Low | Service worker only caches static assets; mic permission flow is unchanged from the existing code path. |
| Bundle size > 90 KB after vite-plugin-pwa adds Workbox | Low | Low | Monitor; current budget is 90 KB gzipped, current size 80.71 KB. Workbox adds ~5 KB. |

---

## Effort summary

| Release | Phase | Effort |
|---|---|---|
| **v1.1.0** | W (web image) | 1 day |
| | PWA (manifest + SW + icons) | 0.5 day |
| | **subtotal** | **1.5 days** |
| **v1.2.0** | D1 (Tauri scaffold) | 0.5 day |
| | D2 (PyInstaller bundle) | 3 days |
| | D3 (sidecar wiring) | 2 days |
| | D4 (frontend shim) | 0.5 day |
| | D5 (build pipeline) | 2 days |
| | D6 (smoke + docs) | 0.5 day |
| | **subtotal** | **~8.5 days (~2 weeks)** |

Two releases, ~2.5 weeks of work end-to-end. v1.1.0 ships in days; v1.2.0 ships when D2's PyInstaller spike succeeds.

---

## Critical files (v1.1.0)

### Backend
- `backend/app/main.py` — add static mount + SPA fallback
- `Dockerfile` (new top-level, replaces the backend-only one as the deploy image)
- `backend/tests/test_static_mount.py` — new

### Frontend
- `frontend/src/lib/api.ts` — `API_BASE` default → empty string
- `frontend/vite.config.ts` — `vite-plugin-pwa` wire-up
- `frontend/package.json` — add `vite-plugin-pwa` devDep
- `frontend/index.html` — manifest + iOS metas
- `frontend/public/icons/{icon-192,icon-512,icon-maskable}.png` — new
- `frontend/public/icons/source.svg` — single source for icon generation

### Docs
- `Plan.md` — overwrite with v1.1.0 plan
- `docs/deployment.md` — rewrite for the new single-image deploy
- `docs/pwa-install.md` — new (iOS + Android Add-to-Home-Screen instructions)
- `CHANGELOG.md` — v1.1.0 entry
- `docs/audit-v1.0.md` — v1.1.0 footer

## Critical files (v1.2.0)

### Desktop
- `desktop/` (new top-level dir) — Tauri scaffold (`Cargo.toml`, `src-tauri/`, `tauri.conf.json`)
- `desktop/src-tauri/src/main.rs` — sidecar lifecycle
- `frontend/src/lib/platform.ts` — Tauri detection + port resolver
- `frontend/src/lib/api.ts` — lazy `getApiBase()`

### Backend
- `backend/biovoice-backend.spec` (new) — PyInstaller spec
- `backend/biovoice_backend_entry.py` (new) — minimal `uvicorn.run` wrapper

### CI
- `.github/workflows/desktop-build.yml` — matrix build for macOS / Windows / Linux

### Docs
- `Plan.md` — overwrite with v1.2.0 plan when v1.1.0 ships
- `docs/installer.md` — installer install + Gatekeeper / SmartScreen warnings
- `docs/installer-smoke.md` — manual smoke procedure
