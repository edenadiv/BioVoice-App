# QA matrix + acceptance criteria

## TL;DR

| Phase | Deliverable | Status |
|---|---|---|
| Cross-browser checks | Manual protocol per browser | Checklist below; manual runs pending |
| Accessibility (WCAG 2.1 AA) | axe-core scan + manual checklist | Automated `axe.spec.ts` green on 3 screens; manual pass pending |
| Performance regression | Lighthouse CI + bundle-size budget | CI wired; bundle ~70 KB gzipped |
| Penetration test | Scope + RoE | Out-of-scope after auth strip — kiosk has no public-internet attack surface |
| Final acceptance with speakers | Volunteer protocol | Recruitment pending |

## Real-model integration test (HF2)

`backend/tests/test_real_models_integration.py` loads the production ReDimNet B5 + AASIST checkpoints and runs an end-to-end enrol → verify cycle. This is the only test in the suite that exercises the real ML; everything else uses `HashEncoder` + `StubDetector` from `tests/conftest.py`.

```bash
# Default fast suite (skips slow):
.venv/bin/pytest -q -m "not slow"

# Real-model integration suite (requires backend/models/{aasist,redimnet_b5}.pt):
.venv/bin/pytest -m slow -v
```

Auto-skips when:
- `backend/models/aasist.pt` or `redimnet_b5.pt` missing
- `torch` / `torchaudio` not installed (need `pip install -e ".[model]"`)
- No system TTS binary (`say` on macOS, `espeak-ng` on Linux)

CI runs this in the `backend-integration` job; weights restored from a cache key `model-weights-v1.0`. Initially `continue-on-error: true` until the operator uploads a release artefact with the weights — the job will skip-and-pass without weights, won't false-positive a regression.

## Cross-browser test matrix

### Targets

| Browser | Version floor | Why |
|---|---|---|
| Chrome (desktop) | 120 | AudioWorklet stable |
| Safari (desktop) | 17 | Same |
| Firefox (desktop) | 122 | Same |
| Mobile Safari (iOS) | 17 | Phone deployment |
| Mobile Chrome (Android) | 120 | Phone deployment |

### 10-step QA protocol

Run on every browser × every viewport.

1. Boot backend + frontend on `localhost`. `/readyz` returns 200.
2. Open `http://localhost:5173/`. The kiosk renders without console errors.
3. Sidebar lists exactly three nav items: Console, Deepfake Lab, Profiles.
4. Open Profiles. Empty-state copy renders correctly.
5. Click "+ ENROLL NEW" → enrol `qa_user` with three samples. Each accepted sample fills a green dot. Modal closes after the third sample. Profile row appears with `3/3 samples`.
6. Open Console → click `qa_user` → Run verification → speak into mic → ACCEPT inside p95 ≤ 2 s.
7. Have a different speaker run verification against `qa_user` → REJECT.
8. Verify with deliberate microphone-muted recording → 400 "no speech detected".
9. Open DeepfakeLab → target `qa_user` → "Forge & test attack" → DEEPFAKE.
10. Activity feed shows the verification events; counters match. Devtools: no `pageerror`, no failed network requests.

### Sign-off

- [ ] All 10 steps pass on Chrome desktop @ 1920×1080
- [ ] All 10 steps pass on Safari desktop @ 1440×900
- [ ] All 10 steps pass on Firefox desktop @ 1920×1080
- [ ] All 10 steps pass on Mobile Safari (iPhone 14 Pro)
- [ ] All 10 steps pass on Mobile Chrome (Pixel 7)

## Accessibility (WCAG 2.1 AA)

### Automated scan

`frontend/tests/e2e/axe.spec.ts` runs `@axe-core/playwright` against the three operator screens (Console, DeepfakeLab, Profiles) and asserts zero `serious` or `moderate` violations. Runs in CI on every PR.

### Manual pass

1. **Keyboard-only walkthrough** — disconnect the mouse. Tab + Shift-Tab + Enter + Esc reach and operate every interactive element. Visible focus ring on every focusable element.
2. **Screen reader** — VoiceOver on macOS + NVDA on Windows. Every state change announces ("Recording started", "Verified", "Access denied"). Decorative SVG icons have `aria-hidden="true"`; functional icons have an accessible name.
3. **Colour contrast** — every text/background pair clears 4.5:1 (body) or 3:1 (large + UI). Run Chrome DevTools' colour-contrast checker against the design tokens in `frontend/src/styles/`.
4. **Reduced motion** — set `prefers-reduced-motion: reduce` in the OS. The kiosk's waveform animations + pulsing dots collapse to static (already wired in `responsive.css`).

### Sign-off

- [x] axe-core: zero serious/moderate violations on Console / DeepfakeLab / Profiles (CI-gated)
- [ ] Keyboard-only walkthrough completes the 10-step QA protocol
- [ ] Screen reader announces every decision + every error
- [ ] Colour contrast clears AA on every text element
- [ ] Reduced-motion mode is visually correct

## Performance regression suite

### Lighthouse CI

`.github/workflows/lighthouse.yml` runs on every PR and posts a comment with the deltas vs. main. Budget:

| Metric | Budget | Action on breach |
|---|---|---|
| LCP | < 2.0 s | Fail PR |
| CLS | < 0.10 | Fail PR |
| INP | < 200 ms | Fail PR |
| Bundle size (gzipped) | < 350 KB | Fail PR |
| Backend p95 verify latency | < 2.0 s | Fail PR |

Current bundle: ~70 KB gzipped (after the i18n + auth strip).

### Local measurement

```bash
cd frontend
npm run build
npx serve dist &
npx lighthouse http://localhost:3000 --view
```

## Final acceptance with real speakers

### Protocol

1. Recruit 10 speakers.
2. Each enrols with three samples on the kiosk.
3. Each verifies on a separate day.
4. Each attempts to spoof another via DeepfakeLab.
5. Verbal feedback captured in `docs/qa-feedback.md`.

### Pass criteria

- 10 / 10 successful enrolments (no quality-gate rejections after one retry).
- 10 / 10 successful own-voice verifications.
- 0 / 10 successful spoof attacks (the DEEPFAKE gate fires every time).
- Average time-to-verify (enrolment-onwards) ≤ 30 s.

### Sign-off

- [ ] 10 enrolments × 10 verifications captured
- [ ] DeepfakeLab attack defended in 10 / 10 trials
- [ ] Verbal feedback summarised in `docs/qa-feedback.md`
- [ ] No P0 / P1 blockers outstanding
