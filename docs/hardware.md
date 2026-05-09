# Hardware runbook

> Procurement + setup guide for a single-kiosk BioVoice deployment. Operator-driven, controlled physical environment. The kiosk runs offline once the Docker image + model weights are baked in.

## Recommended target

### Mac mini M2 (Apple silicon)

| Spec | Minimum | Recommended |
|---|---|---|
| Chip | M2 (8-core CPU) | M2 / M3 (10-core CPU) |
| RAM | 16 GB | 16 GB+ |
| SSD | 256 GB | 512 GB |
| Power | Wall outlet + UPS (5 min runtime min) | Same |

**Pros**: macOS ships `say` (system TTS for the spoof fallback), low cold-start time, silent fanless operation, native arm64 Docker support.

**Cons**: Higher per-unit cost than Intel NUC. Apple silicon containers must be built `--platform=linux/arm64`.

### Intel NUC (or equivalent x86_64 mini-PC)

| Spec | Minimum | Recommended |
|---|---|---|
| CPU | i5-12xxx or AMD Ryzen 5 5xxx | i7-13xxx or Ryzen 7 7xxx |
| RAM | 16 GB DDR4/DDR5 | 32 GB DDR5 |
| SSD | 256 GB NVMe | 512 GB NVMe |
| OS | Ubuntu 22.04 LTS or Debian 12 | Same |
| Power | Wall outlet + UPS (5 min runtime min) | Same |

**Pros**: Lower per-unit cost (~$500), upgradable, x86_64 broadens hardware-compatibility envelope.

**Cons**: Need to install `espeak-ng` for the spoof fallback (`apt-get install -y espeak-ng`).

## Peripherals

### Microphone (most important)

The backend's quality gate enforces **SNR ≥ 10 dB** on every enrolment sample. Built-in laptop mics typically score 5–8 dB in a normal-noise office. Plan for a real mic.

| Mic | Pattern | Why | ~$ |
|---|---|---|---|
| Blue Yeti | Cardioid, multi-pattern | Forgiving placement, good off-axis rejection, USB plug-and-play | $130 |
| Audio-Technica AT2020USB+ | Cardioid | Cleaner sound than Yeti, slightly less forgiving placement | $170 |
| Shure MV7 | Cardioid + USB/XLR | Broadcast-grade; expensive but professional | $250 |

Avoid cheap omnidirectional mics — they pick up too much room noise.

### Display

Any HDMI display the OS supports. Touchscreen optional — the kiosk works with a mouse + keyboard. If touchscreen, target 1080p+ and verify both Chrome's and Safari's pointer-event support on your hardware.

### UPS

A 5-minute runtime minimum protects against:
- Brown-outs corrupting the SQLite database (we use WAL mode but a hard power-cut mid-write can still lose the last few seconds of data).
- Cold-start on power restore burning operator time during enrolment.

APC Back-UPS BE600M1 (~$80) or equivalent.

### Network

Optional. The kiosk runs offline once:
- Backend container has the model weights mounted/baked
- Frontend Vite bundle is served by nginx (no CDN dependency)

If the kiosk is online for remote operator support, lock the firewall down to the operator's source IP and revisit `docs/remaining_work.md` G8 (operator-auth re-introduction).

## Cold-start timing

Measured on the recommended Mac mini M2 (16 GB RAM, macOS 14.2):

| Stage | Wall time |
|---|---|
| `docker compose up -d` → containers running | ~8 s |
| First `/readyz` returns `ready: true` | ~12 s |
| First `/verify` call (lazy weight load) | ~3.5 s (subsequent verifies: 400–500 ms) |

The lazy weight-load on first verify is intentional — it keeps boot time fast at the cost of one slow first request. If your operator workflow can't accept that, add a `warmup` script that POSTs a 1-sec WAV to `/verify` immediately after `/readyz` flips green.

To re-measure on your hardware:

```bash
time docker compose up -d
until curl -sf https://localhost/readyz | grep -q ready; do sleep 1; done
echo "ready"
time curl -X POST -F "user_id=warmup_user" -F "audio=@/path/to/3sec.wav" https://localhost/api/verify
```

## Disk-space planning

| Per profile (3–5 enrolment samples) | ~15–25 MB |
|---|---|
| 100 enrolled profiles | ~2 GB |
| 1,000 enrolled profiles | ~25 GB |
| 10,000 enrolled profiles | ~250 GB |

The 256 GB SSD recommendation comfortably handles the ~1,000 active-profile design point. Beyond that, plan for the v1.1 Postgres migration + an external samples store.

## First-boot setup

1. Provision the host OS (macOS / Ubuntu 22.04).
2. Install Docker:
   - macOS: Docker Desktop or `brew install --cask docker`
   - Linux: `curl -fsSL https://get.docker.com | sh`
3. Clone the repo + run `docker compose up -d --build` per `docs/deployment.md`.
4. Plug in the USB microphone. Open `https://localhost/` in Chrome / Safari / Firefox.
5. Grant microphone permission when prompted.
6. Walk the operator-guide enrolment flow with a test user.

## Maintenance

- **Daily**: cron `deploy/backup.sh` at 02:30 local time (see `docs/deployment.md`).
- **Weekly**: check `/api/metrics/summary` (also visible in the Console panel) for unexpected throughput drops.
- **Monthly**: rotate the TLS cert if running Let's Encrypt (auto-renewal via certbot).
- **On-demand**: pull updates from `main` + `docker compose up -d --build` to redeploy.

## Known issues

- **macOS `say` voices score as genuine** in the deepfake lab — see `docs/operator-guide.md` and `docs/benchmarks.md`. XTTS-v2 (planned for v1.1) lifts this.
- **Cold first-verify** is ~3.5 s on M2 hardware. Subsequent verifies are <500 ms.
- **No GPU acceleration** — both ReDimNet and AASIST run CPU-only. Throughput is ~2 verifies/sec on the recommended hardware. Sufficient for a single-operator kiosk; not for high-volume API serving.
