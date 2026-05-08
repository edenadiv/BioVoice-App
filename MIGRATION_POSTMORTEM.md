# Prototype migration — postmortem

> **Audience:** Eden + Yoav. Recap of why the original kiosk prototype was deleted and re-introduced incorrectly, and what to watch for next time.

## Timeline

1. **Day 0** — Cloned repo. Repo had a polished React prototype shipped via Babel-in-browser (`<script type="text/babel">`). It was wired into the legacy `app.jsx` entry point, alongside a half-built TypeScript scaffold (`App.tsx` + `components/`).
2. **PR #5 (foundation, Phase 0 cleanup)** — Reading the SDD figures (PDF §5) as the design brief, I deleted the prototype as "leftover code" (commit `8cdb1d6`). New design system + state machine + stub screens replaced it. **This was the wrong call.**
3. **PR #6 (Verification Result + backend)** — Backend extensions (`decision_reason`, `stage_breakdown`, `analysis_details`, `/me/verifications/{result_id}`, decision-logic alignment with SDD §2.5) and a polished VerifyResultScreen. These backend changes are still useful and stay.
4. **User correction** — Pointed at `BioVoice.zip` containing the prototype: "THIS IS THE UI WE SHOULD HAVE."
5. **Re-introduction (this branch, `feat/eden-screen-polish`)** — Restored all 7 prototype files, converted Babel-globals → ES modules, restored 1920×1080 stage chrome in `index.html`, repointed `main.tsx`. **Build passed but the app crashed at runtime** — silent blank stage.
6. **Fix** — `<Chrome>` was used cross-file but wasn't exported. Added the export and the corresponding imports.

## Root cause

The original prototype shared scope across files via `<script>` tags in non-module mode and `Object.assign(window, {...})` exports. Every component defined at top level was implicitly global.

When I converted to ES modules, I drove the export list off the `Object.assign(window, {...})` block at the bottom of each file. **`screens.jsx` defined `Chrome` as an internal helper — it was never in the explicit export block** because the original code didn't need to export it (globals took care of cross-file access). I missed the implicit dependency.

`Chrome` is used in:
- `screens.jsx` (8 sites) — fine, internal
- `console.jsx:250` — broken
- `more-screens.jsx:122, 364, 538` — broken

Result: `ConsoleScreen` (the default expert view) threw `ReferenceError: Chrome is not defined` on first render. The entire React tree errored out and `<div id="root">` stayed empty. The static gradient + grid backdrop in `index.html` was the only thing visible.

## What `tsc -b` and Vite missed

- **TypeScript** with `allowJs: true` doesn't type-check unbound JSX identifiers in `.jsx` files. `<Chrome>` is treated as a runtime symbol.
- **Vite** didn't fail at transform time either — JSX compiles to `React.createElement(Chrome, ...)`, where `Chrome` is just a free variable resolved at runtime.
- Only the browser's runtime hit the `ReferenceError`.

The lesson: **build green ≠ app works**. Headless smoke (`puppeteer.goto + console capture`) catches this in seconds.

## Fix

```diff
 // screens.jsx
-export {
+export {
+  Chrome,
   WelcomeScreen, EnrollScreen, ProcessingScreen, VerifyScreen, DeepfakeScreen, ExplainScreen,
 };

 // console.jsx
+import { Chrome } from "./screens.jsx";

 // more-screens.jsx
+import { Chrome } from "./screens.jsx";
```

## Why didn't I catch it earlier?

I shipped on a `npm run build` exit code only. The build is a structural correctness check — it does not exercise the actual rendered DOM. For a port of a non-trivial prototype, that's table stakes; for original work it's table stakes plus a screenshot in the PR.

## Standing rule for the rest of this milestone

For any frontend PR that touches > ~50 lines or that replaces a screen, **before pushing**:

1. `npm run build` — structural.
2. **Headless render check** — `puppeteer` (or equivalent) loads the page, captures `pageerror`, asserts none.
3. Attach a screenshot to the PR.

This was already in `Plan.md` §7 ("UI PRs require a screenshot in the description"); I didn't enforce it. Locking it in now.

## What's still ahead

- The prototype runs on **mock data**: `PROFILES` is a hardcoded array in `app.jsx`, `runVerification` mutates local state with random scores, `useSyntheticAudio` is a fallback when mic permission is denied. The real FastAPI backend (extended in PR #6) is **not wired in yet**.
- Live wiring is the next chunk: replace `PROFILES` with `GET /users`, `runVerification` with `POST /me/verify`, the enrollment flow with real `POST /enroll`, the deepfake lab with `/me/spoof`, the verify overlay with the new `/me/verifications/{result_id}`.
- TCAV remains out of scope per `Plan.md` §3.
