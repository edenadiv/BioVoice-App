# Discussion + limitations (F8.6)

## What works

- **Production-grade decision pipeline.** The full enrol → trim → embed → AASIST → sub-classifier → decide path runs in well under the 2 s budget on commodity hardware. The decision logic mirrors the SDD's tree exactly: deepfake gate first, similarity gate second.
- **Defensible per-axis sub-classifier.** F4 replaces the seeded-jitter placeholder with `AcousticProbe`. In heuristic mode the four axes are direct functions of acoustic properties (HNR, spectral flatness, F0 variance) — every axis varies with the actual recording, and the formulas are interpretable. The trained-head upgrade path lands as soon as the operator runs `scripts/train_sub_classifier.py` on a labelled corpus; the runtime swaps modes automatically.
- **HTTPS-aware session model.** Cookies are HttpOnly + Secure + SameSite=Strict, gated by F2.2 brute-force defence and F2.1 rolling expiry + rotation. JS code in the kiosk cannot read the session token; the surface for a compromised script is reduced to the in-flight tab's session.
- **Operator surface.** F6 admin routes (delete, audit, threshold tuning) are gated by a dedicated API key with rotation policy, distinct from end-user authentication.
- **Production-deployment artifacts.** Multi-stage Dockerfile, compose stack, nginx TLS+HSTS config, backup/restore scripts, deployment guide, and a written Postgres migration plan all check in. A fresh engineer can follow `docs/deployment.md` end-to-end.
- **Hebrew RTL + mobile responsiveness.** i18n-keyed chrome strings, `<html dir="rtl">`-driven layout mirroring, Heebo Hebrew font, three-breakpoint responsive layout that linearises the kiosk on phones.

## Limitations

### 1. Sub-classifier training data

The most honest constraint: high-quality per-axis labels for the four AcousticProbe axes require expert annotation. We document the labelling schema and the proxy-label fallback (`build_proxy_labels.py`, deferred to F8 follow-up), but until a labelled corpus exists the production deployment runs in **heuristic mode**. That mode is real, audio-derived, and varies with input — but it is not a learned model and its calibration constants come from a small TIMIT-style sample, not the cyber directorate's actual usage population.

Mitigation: the trained-head upgrade is one shell command (`train_sub_classifier.py …`) once the labelled corpus exists. The runtime detects the heads file and switches modes automatically.

### 2. AASIST is the deepfake-detection ceiling

The kiosk's deepfake defence is whatever AASIST detects. The published AASIST EER on ASVspoof2019 LA is ≈ 0.83 % — strong on the attacks in the training set, weaker on out-of-distribution attacks (recent neural vocoders, controlled-pitch TTS). We track the F5-TTS / XTTS / ElevenLabs detection rates explicitly in F8.3 because that's the relevant frontier; ElevenLabs typically scores lowest because it is specifically tuned to evade contemporary anti-spoofing.

Mitigation paths (post-Δ-1):

- Fine-tune AASIST on a corpus that includes the latest TTS systems.
- Replace the single-model gate with an ensemble (AASIST + RawNet + a CQCC-based classifier) and require all to agree.
- Add a challenge-response phrase (the operator picks a fresh phrase each verification; the user repeats it). This is the architectural change that breaks pre-recorded replay attacks definitively, at the cost of UX friction.

### 3. Postgres migration is documented, not done

F7.1 ships as a written plan with effort estimate (~3 engineer-days), not a working `PostgresStore`. SQLite remains the backing store at the tagged release. For single-instance kiosks under ~10k enrolled users this is fine; multi-instance HA + the audit-log retention policy will need the migration.

### 4. Per-screen i18n string extraction is partial

F5.2 extracts the chrome strings (sidebar nav, common buttons, key error messages). Extracting per-screen literals across `screens.jsx`, `console.jsx`, `console-ext.jsx`, `more-screens.jsx` is mechanical follow-up work — the i18n + RTL infrastructure handles it as soon as the keys are wired. The Hebrew strings themselves are functional placeholders pending native-speaker review before sign-off.

### 5. Multi-user EER is unverified

F8.5 requires recruiting ≥ 20 volunteers + IRB / data-protection review. The protocol is written; the numbers aren't. Until they are, every EER claim in this paper draws from VoxCeleb1-O — a single-language, well-curated corpus that will systematically over-state real-world performance.

### 6. The pentest is unbooked

F9.4 is gated by an external pentest provider. Until the report comes back, we cannot claim "no outstanding High / Critical findings" for the milestone-close gate.

### 7. Real-microphone variance is the unknown unknown

Every result reported on VoxCeleb1-O uses microphone-equalised studio recordings. The actual kiosk records via a customer-supplied microphone in a customer-supplied acoustic environment. The F3.3 sample-quality gate catches the worst cases, but degradation between studio EER and kiosk EER is the dominant residual risk and only the multi-user study (F8.5) will measure it.

## Future work

- **Replace heuristic mode with trained heads.** Once the labelled corpus exists, the swap is operational, not architectural.
- **Challenge-response phrases.** UX cost vs. replay-attack defence trade-off is for the deployment team to evaluate; the architecture supports it (server picks a phrase, sends to client, client records, server verifies the phrase before running the verification pipeline).
- **Federated enrolment.** Currently enrolment data lives on the kiosk's SQLite. A multi-kiosk deployment for the same identity pool needs centralised enrolment with eventual consistency. The F7.1 Postgres migration is the precondition.
- **On-device inference for Edge deployments.** If a deployment cannot accept the latency of round-tripping to a backend, port ReDimNet + AASIST to ONNX Runtime + WebAssembly. ReDimNet-B5 is small enough; AASIST is the open question.
- **Anti-replay via watermark detection.** Some TTS systems embed audible watermarks; detecting them is a cheap, narrow defence layer to add.
- **Continuous re-enrolment.** Voice changes seasonally (a cold, fatigue). Auto-update the centroid with high-confidence verifications — guarded by the deepfake gate to prevent attack-driven drift.

## Comparison with prior work

Two systems in the same problem space:

| System | Strengths | Where BioVoice differs |
|---|---|---|
| Microsoft Speaker Recognition API | Cloud-hosted, mature, well-tuned. | Closed source, sends voice off-prem. BioVoice is fully self-hosted. |
| Pindrop Phone Authentication | Real call-centre deployments at scale. | Not designed for in-person kiosk; pricing model rules out the directorate's deployment budget. |

BioVoice's distinguishing claim is **fully self-hosted, single-tenant, observable by the operator**. The audit log + threshold tuning surface make it a system the directorate's compliance team can sign off on; the cloud APIs are not.
