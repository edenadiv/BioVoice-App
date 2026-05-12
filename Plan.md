# BioVoice — Web Image + PWA Plan (v1.1.0)

> **Status**: drafted 2026-05-12 · supervisor-driven · branch `main`
> **Supersedes**: the v1.0.3 visualisations plan (closed; V0–V6 shipped at tag `v1.0.3`).
> **Goal**: produce a single Docker image deployable to any cloud (FastAPI serves both API + the built React UI), and make the kiosk installable as a Progressive Web App from any browser.
> **Design spec**: [`docs/superpowers/specs/2026-05-12-packaging-design.md`](docs/superpowers/specs/2026-05-12-packaging-design.md). Covers v1.1.0 (this plan) + v1.2.0 (desktop bundled installer, follow-up plan).

---

## Context

After v1.0.3, the kiosk renders real ML data end-to-end but only ships as a local-dev experience: `pnpm dev` + `uvicorn` on two ports, `docker-compose.yml` for single-host staging only. The user-facing ask is "create the native installer. i want also web version and also app". The packaging spec decomposed that into three deliverables — the web image and the PWA-installable surface land in v1.1.0; the desktop bundled installer ships in v1.2.0 because PyInstaller bundling of torch is the only ~2-week effort in the stack.

This plan covers v1.1.0 only.

### What's in the repo today

- `Dockerfile` (root) and `backend/Dockerfile` — currently only the backend builds; image ~1.4 GB with `[model]` extras.
- `docker-compose.yml` — three services (`backend`, `frontend` via nginx static, `nginx` TLS).
- `frontend/src/lib/api.ts:18` — `const API_BASE = import.meta.env.VITE_API_BASE_URL ?? "http://localhost:8000";` — the same-origin refactor target.
- `backend/app/main.py` — pure API, no static-files mount.
- `backend/models/{aasist.pt, redimnet_b5.pt}` — 1.2 MB + 30 MB. Baked into the image.
- `frontend/src/lib/audio.ts:37-42` — MediaRecorder candidates include `audio/mp4`, so iOS Safari recording works untouched.

---

## Design

### P1 — Backend serves built React (same-origin)

**Change**: drop the two-port architecture for production. FastAPI on :8000 handles both API routes AND the built React UI.

- `backend/app/main.py` — after `app.include_router(router)`, add a `StaticFiles` mount at `/` with `html=True` (SPA fallback for unmatched non-API paths). The mount points at `/app/frontend_dist` inside the container. Mount only when the directory exists so local-dev (`uvicorn` without `pnpm build`) still works.
- The static mount sits AFTER all `@router` routes, so registered API routes always win. SPA fallback only catches paths that aren't API routes AND aren't real static files.
- `frontend/src/lib/api.ts:18` — change default to empty string. `fetch("/users/embeddings", …)` becomes same-origin. Local dev keeps working: set `VITE_API_BASE_URL=http://localhost:8000` in `frontend/.env.local` (documented in deployment.md).
- New test `backend/tests/test_static_mount.py` (3 cases): index returns HTML when `frontend_dist` exists; SPA fallback works on unknown paths; without `frontend_dist`, mount is absent and routes still 404 normally.

### P2 — Top-level multi-stage Dockerfile

**Change**: replace the backend-only `Dockerfile` with a 3-stage image that builds the frontend, installs the backend, and runs the unified server.

```
stage 1 (node:20-alpine)
  ├── enable corepack, pnpm install --frozen-lockfile
  ├── pnpm build → /build/dist
stage 2 (python:3.12-slim)
  ├── apt: build-essential, libsndfile1, git
  ├── pip install -e ".[model]" → /install site-packages
stage 3 (python:3.12-slim runtime)
  ├── COPY --from=stage1 /build/dist /app/frontend_dist
  ├── COPY --from=stage2 /install /usr/local
  ├── COPY backend/app /app/app
  ├── COPY backend/models /app/models   ← weights baked in
  ├── CMD ["uvicorn","app.main:app","--host","0.0.0.0","--port","8000"]
```

- Image target: ≤ 1.5 GB. Current backend-only is 1.4 GB; adding the bundled `dist/` adds ~270 KB unzipped, negligible.
- Keep `backend/Dockerfile` for the legacy compose stack; document the top-level `Dockerfile` as the new deploy target.
- `.dockerignore` updated to prevent test fixtures + node_modules + venvs from inflating the build context.

### P3 — PWA install surface

**Change**: turn the web app into a Progressive Web App so iPhone/iPad/Android/desktop browsers can "Add to Home Screen".

- `frontend/package.json` — add `vite-plugin-pwa` (devDependency).
- `frontend/vite.config.ts` — register the plugin:
  ```ts
  VitePWA({
    registerType: 'autoUpdate',
    includeAssets: ['icons/*'],
    manifest: { /* see below */ },
    workbox: {
      navigateFallback: '/index.html',
      // API routes always hit the network — they need a live backend.
      navigateFallbackDenylist: [/^\/users/, /^\/verify/, /^\/embed/, /^\/identify/, /^\/spoof/, /^\/results/, /^\/metrics/, /^\/readyz/, /^\/health/, /^\/enroll/],
    },
  })
  ```
- Manifest:
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
- Icons: a single `frontend/public/icons/source.svg` (generated from the existing kiosk colour palette), plus the three rasterised PNGs committed alongside.
- `frontend/index.html` — add `<link rel="manifest">`, `<meta name="theme-color" content="#04070d">`, iOS bits: `<link rel="apple-touch-icon" href="/icons/icon-192.png">`, `<meta name="apple-mobile-web-app-capable" content="yes">`, `<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">`.
- Lighthouse PWA audit ≥ 90 as the verification.

### P4 — Deployment docs + release notes

- Rewrite `docs/deployment.md`:
  - **Fly.io**: `fly launch --image biovoice:1.1.0 --internal-port 8000`. Auto-TLS on `*.fly.dev`. Volume mount for `/app/data`.
  - **Render**: Web Service from this repo. `dockerfilePath: ./Dockerfile`. Disk for `/app/data`.
  - **Railway**: similar pattern.
  - **VPS + Caddy**: docker run + Caddyfile reverse-proxy with auto-Let's-Encrypt. Documented snippet.
  - Persistent volumes: `/app/data` (SQLite + reference samples). `/app/models` is baked into the image, not mounted.
- New `docs/pwa-install.md`:
  - iPhone: Safari → Share → Add to Home Screen.
  - Android Chrome: menu → Install app.
  - Desktop Chrome / Edge: install icon in URL bar.
  - Note: install requires HTTPS (or localhost). Kiosk via plain http on a LAN won't be installable.
- `CHANGELOG.md` v1.1.0 entry.
- `docs/audit-v1.0.md` v1.1.0 footer.
- `docs/remaining_work.md` — strike "no hosted deployment" item.

---

## Phases

### Phase P0 — Sync this plan to repo `Plan.md`
Already done; this file IS Plan.md.

### Phase P1 — Backend static mount + same-origin refactor (~3h)
- `backend/app/main.py` — register the static mount.
- `frontend/src/lib/api.ts` — change `API_BASE` default to `""`.
- `backend/tests/test_static_mount.py` — new (3 cases).
- `pytest -q -m "not slow"` green.
- `pnpm vitest run` green.

### Phase P2 — Top-level Dockerfile (~3h)
- New 3-stage `Dockerfile` at the repo root (replaces the existing backend-only one as the deploy target).
- `.dockerignore` updates.
- `docker build -t biovoice:1.1.0 .` completes; image ≤ 1.5 GB.
- `docker run -p 8000:8000 biovoice:1.1.0` → `curl localhost:8000/health` returns `ok`.
- Browser to `http://localhost:8000` → kiosk renders + verify works against the embedded backend.

### Phase P3 — PWA assets (~3h)
- Install `vite-plugin-pwa`.
- Generate icons from the source SVG; commit the three PNGs.
- Wire `vite.config.ts` + `index.html`.
- `pnpm build` produces `dist/sw.js` + `dist/manifest.webmanifest`.
- Lighthouse PWA audit ≥ 90 against the running container.

### Phase P4 — Docs + release notes (~2h)
- `docs/deployment.md` rewrite.
- `docs/pwa-install.md` new.
- `CHANGELOG.md` v1.1.0 entry.
- `docs/audit-v1.0.md` v1.1.0 footer.

### Phase P5 — Release v1.1.0 (~1h)
- Full test sweep: backend `pytest -q -m "not slow"`, frontend `pnpm vitest run`, frontend `pnpm build`.
- Docker build smoke.
- `git tag -a v1.1.0 -m "Web image + installable PWA"` + push.

---

## Critical files

### Backend
- `backend/app/main.py` — modify (add static mount)
- `backend/tests/test_static_mount.py` — new

### Frontend
- `frontend/src/lib/api.ts` — modify (`API_BASE` default → empty)
- `frontend/vite.config.ts` — modify (`VitePWA` plugin)
- `frontend/package.json` — modify (add `vite-plugin-pwa` devDep)
- `frontend/index.html` — modify (manifest + iOS metas)
- `frontend/public/icons/source.svg` — new
- `frontend/public/icons/{icon-192,icon-512,icon-maskable}.png` — new

### Repo root
- `Dockerfile` — modify (new 3-stage that builds frontend + backend together)
- `.dockerignore` — modify

### Docs
- `Plan.md` — overwrite (this file)
- `docs/deployment.md` — rewrite
- `docs/pwa-install.md` — new
- `docs/remaining_work.md` — modify (mark hosted-deploy item closed)
- `docs/audit-v1.0.md` — modify (v1.1.0 footer)
- `CHANGELOG.md` — modify (v1.1.0 entry)

---

## Verification (run before tagging v1.1.0)

1. **Backend tests**: `pytest -q -m "not slow"` → all green (existing 112 + 3 new = 115).
2. **Frontend tests**: `pnpm vitest run` → all green (currently 47).
3. **Frontend build**: `pnpm build` produces `dist/sw.js` + `dist/manifest.webmanifest`. Bundle ≤ 90 KB gzipped main chunk.
4. **Docker build**: `docker build -t biovoice:1.1.0 .` exits 0; image ≤ 1.5 GB.
5. **Docker smoke**: `docker run -p 8000:8000 biovoice:1.1.0` → `curl localhost:8000/health` returns 200; browser to `http://localhost:8000` shows kiosk.
6. **PWA score**: `lighthouse --only-categories=pwa` ≥ 90 against the running container.
7. **Tag**: `git tag v1.1.0` + push.

---

## Out of scope

- Code signing for desktop installers — v1.2.0
- PyInstaller-bundled Python backend — v1.2.0
- Tauri desktop wrapper — v1.2.0
- Capacitor / native mobile — explicitly chose PWA
- Hosted deployment — operator deploys the image
- Postgres migration — SQLite is fine
- Multi-instance / Redis / load balancer — single container

---

## Effort summary

| Phase | What | Engineer-hours |
|---|---|---|
| P0 | Sync plan | 0.2 |
| P1 | Backend static mount | 3 |
| P2 | Top-level Dockerfile | 3 |
| P3 | PWA assets | 3 |
| P4 | Deploy + PWA docs | 2 |
| P5 | Release v1.1.0 | 1 |
| **Total** | | **~12 hours (~1.5 days)** |

Critical path: P1 (everything else builds on the same-origin refactor).
