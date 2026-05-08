# QA matrix + acceptance criteria (F9)

## TL;DR

| Phase | Deliverable | Status |
|---|---|---|
| F9.1 | Cross-browser test matrix | Scaffolding + checklist; manual run pending |
| F9.2 | WCAG 2.1 AA accessibility audit | axe-core scan procedure + manual checklist |
| F9.3 | Performance regression suite | Lighthouse CI config + bundle-size budget |
| F9.4 | Penetration test | Scope + RoE document; external provider booking pending |
| F9.5 | Final acceptance with real speakers | Protocol + sign-off template; volunteer recruitment pending |

## F9.1 — Cross-browser test matrix

### Targets

| Browser | Version floor | Why |
|---|---|---|
| Chrome (desktop) | 120 | AudioWorklet stable, F2.5 cookie semantics |
| Safari (desktop) | 17 | Same |
| Firefox (desktop) | 122 | Same |
| Mobile Safari (iOS) | 17 | Phone deployment |
| Mobile Chrome (Android) | 120 | Phone deployment |

### 12-step QA protocol

Run on every browser × every viewport.

1. Boot backend + frontend on `localhost`. `/readyz` returns 200.
2. Open `https://localhost/`. The kiosk renders without console errors.
3. Switch language to Hebrew via the sidebar switcher. Sidebar nav labels flip; layout mirrors.
4. Switch back to English. Layout returns to LTR.
5. Open the Profiles page. Empty-state copy renders correctly.
6. Enrol `qa_user` with three samples. Each sample shows a quality dot.
7. Verify as `qa_user` with their own voice → ACCEPT inside p95 ≤ 2 s.
8. Verify as `qa_user` with a different voice → REJECT.
9. Verify with deliberate microphone-muted recording → 400 "no speech detected".
10. Open DeepfakeLab, generate a clone, test it → DEEPFAKE.
11. Activity feed shows three events; counters match.
12. Devtools: no `pageerror`, no failed network requests, no deprecation warnings.

### Reproducibility scaffolding

Playwright config (`playwright.config.ts`, to be authored in this branch's follow-up) targets the five browsers. Each test step from the protocol becomes one `test.step()`; failing steps emit a screenshot + trace under `frontend/test-results/`.

```bash
cd frontend
npm install -D @playwright/test
npx playwright install --with-deps
npx playwright test --project=chromium --project=webkit --project=firefox
```

### Sign-off

- [ ] All 12 steps pass on Chrome desktop @ 1920×1080
- [ ] All 12 steps pass on Safari desktop @ 1440×900
- [ ] All 12 steps pass on Firefox desktop @ 1920×1080
- [ ] All 12 steps pass on Mobile Safari (iPhone 14 Pro)
- [ ] All 12 steps pass on Mobile Chrome (Pixel 7)
- [ ] Hebrew run passes on at least one desktop + one mobile browser

## F9.2 — Accessibility (WCAG 2.1 AA)

### Automated scan

```bash
cd frontend
npm install -D @axe-core/playwright
# In a Playwright test:
import AxeBuilder from "@axe-core/playwright";
const results = await new AxeBuilder({ page }).analyze();
expect(results.violations).toEqual([]);
```

Scan every screen the user can reach without an admin key:

- Console
- Profiles
- DeepfakeLab
- Settings
- Welcome / Enrol / Verify / Result overlays

### Manual pass

1. **Keyboard-only walkthrough** — disconnect the mouse. Tab + Shift-Tab + Enter + Esc reach and operate every interactive element. Visible focus ring on every focusable element.
2. **Screen reader** — VoiceOver on macOS + NVDA on Windows. Every state change announces ("Recording started", "Verified", "Access denied"). Decorative SVG icons have `aria-hidden="true"`; functional icons have an accessible name.
3. **Colour contrast** — every text/background pair clears 4.5:1 (body) or 3:1 (large + UI). Run Chrome DevTools' colour-contrast checker against the design tokens in `frontend/src/styles/`.
4. **Reduced motion** — set `prefers-reduced-motion: reduce` in the OS. The kiosk's waveform animations + pulsing dots collapse to static (already wired in `responsive.css`).

### Sign-off

- [ ] axe-core: zero serious or critical violations on every screen
- [ ] Keyboard-only walkthrough completes the 12-step QA protocol
- [ ] Screen reader announces every decision + every error
- [ ] Colour contrast clears AA on every text element
- [ ] Reduced-motion mode is visually correct

## F9.3 — Performance regression suite

### Lighthouse CI

`.github/workflows/lighthouse.yml` (to be authored) runs on every PR and posts a comment with the deltas vs. main. Budget:

| Metric | Budget | Action on breach |
|---|---|---|
| LCP | < 2.0 s | Fail PR |
| CLS | < 0.10 | Fail PR |
| INP (replaces FID) | < 200 ms | Fail PR |
| Bundle size (gzipped) | < 350 KB | Fail PR |
| Backend p95 verify latency | < 2.0 s | Fail PR |

### Local measurement

```bash
cd frontend
npm run build
npx serve dist &
npx lighthouse http://localhost:3000 --view
```

### Continuous baseline

Persist a baseline JSON on every release tag — `docs/perf/baseline-<tag>.json` — so a regression hunter can diff against the most recent green release. Baseline file gets updated by the release script.

## F9.4 — Penetration test

### Scope (also in `docs/deployment.md`)

- `/auth/login` — F2.2 brute-force gate, F2.5 cookie semantics, password-spray, response-timing oracle.
- `/auth/refresh` — token rotation race, replay of old token after rotation.
- `/auth/session DELETE` — CSRF (despite SameSite=Strict; verify the cookie cannot be forged from a sibling origin).
- `/admin/*` (F6) — admin-key bypass, IDOR on user delete, threshold-update race, audit-log tamper attempts.
- `/me/*` — cookie theft via XSS in any rendered user input, IDOR across enrolled users.
- File-upload paths (`/enroll`, `/verify`, `/me/spoof`) — multipart parser exploits, path-traversal in the filename, oversized payloads, malicious WAV files.
- TLS — A+ on SSL Labs (the default `deploy/nginx.conf` aims for this).

### Rules of Engagement

- Time window: scoped 5 business days.
- Targets: one staging URL, isolated from production.
- Out of scope: physical attacks on the kiosk hardware, social-engineering attacks against the operator, attacks against upstream providers (Anthropic, AWS, etc.).
- Reporting: STIX format preferred; CVSS 3.1 scores on every finding.

### Sign-off

- [ ] Pentest report attached
- [ ] Zero outstanding Critical or High findings
- [ ] Mediums + Lows triaged with target fix dates
- [ ] Re-test scheduled at 30 days

## F9.5 — Final acceptance with real speakers

### Protocol

Per the multi-user enrolment study (F8.5) but applied as a final acceptance gate rather than a research benchmark:

1. Recruit 5 native Hebrew + 5 native English speakers.
2. Each enrols with three samples on the kiosk.
3. Each verifies on a separate day.
4. Each attempts to spoof another via DeepfakeLab.
5. Verbal feedback captured in `docs/qa-feedback.md`.

### Pass criteria

- 10 / 10 successful enrolments (no quality-gate rejections after one retry).
- 10 / 10 successful own-voice verifications.
- 0 / 10 successful spoof attacks (the DEEPFAKE gate fires every time).
- Hebrew-speaking operator can use the kiosk end-to-end without an English fallback.
- Average time-to-verify (enrolment-onwards) ≤ 30 s.

### Sign-off

- [ ] 10 enrolments × 10 verifications captured
- [ ] DeepfakeLab attack defended in 10 / 10 trials
- [ ] Hebrew flow signed off by a native speaker
- [ ] Verbal feedback summarised in `docs/qa-feedback.md`
- [ ] No P0 / P1 blockers outstanding

## Milestone-close gate

The full system milestone closes only when **every box above is checked**. Current state at the tagged release:

- F9.1: scaffolding + checklist landed; manual cross-browser runs pending.
- F9.2: scan procedure + checklist landed; runs pending.
- F9.3: budget + Lighthouse plan landed; CI workflow pending.
- F9.4: scope + RoE landed; pentest provider booking pending (project-lead action).
- F9.5: protocol + sign-off template landed; volunteer recruitment pending (same project-lead action that gates F8.5).
