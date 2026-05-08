#!/usr/bin/env python3
"""Latency probe for the verification endpoint.

Posts N WAV recordings against a running backend and prints p50/p95 timings
plus the per-stage breakdown returned in each VerificationResponse.

Usage:
    python -m backend.scripts.bench_verify --user alice --wav path/to/sample.wav --runs 10
    # or:
    cd backend && .venv/bin/python scripts/bench_verify.py --user alice --wav sample.wav

The user must already be enrolled (3 samples) and a session must be active.
The script does NOT enrol or log in — it just probes /me/verify.
"""

from __future__ import annotations

import argparse
import json
import statistics
import sys
import time
from pathlib import Path
from urllib import error, request


def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser()
    p.add_argument("--base-url", default="http://localhost:8000")
    p.add_argument("--user", required=True, help="User ID (already enrolled, with active session)")
    p.add_argument("--token", required=True, help="Session token from /auth/login")
    p.add_argument("--wav", required=True, type=Path, help="Path to a WAV file to verify")
    p.add_argument("--runs", type=int, default=10)
    return p.parse_args()


def post_verify(base_url: str, token: str, wav_bytes: bytes, filename: str) -> tuple[float, dict]:
    boundary = "----biovoice-bench"
    body = (
        f"--{boundary}\r\n"
        f'Content-Disposition: form-data; name="audio"; filename="{filename}"\r\n'
        "Content-Type: audio/wav\r\n\r\n"
    ).encode("utf-8") + wav_bytes + f"\r\n--{boundary}--\r\n".encode("utf-8")

    req = request.Request(
        f"{base_url}/me/verify",
        data=body,
        headers={
            "Content-Type": f"multipart/form-data; boundary={boundary}",
            "Authorization": f"Bearer {token}",
            "Content-Length": str(len(body)),
        },
        method="POST",
    )

    t0 = time.perf_counter()
    try:
        with request.urlopen(req, timeout=10) as resp:
            payload = json.loads(resp.read().decode("utf-8"))
    except error.HTTPError as exc:  # pragma: no cover
        sys.stderr.write(f"HTTP {exc.code}: {exc.read().decode('utf-8')}\n")
        raise
    elapsed_ms = (time.perf_counter() - t0) * 1000.0
    return elapsed_ms, payload


def main() -> int:
    args = parse_args()
    wav_bytes = args.wav.read_bytes()
    filename = args.wav.name

    wall_times: list[float] = []
    stage_totals: dict[str, list[float]] = {}

    for run in range(args.runs):
        elapsed, payload = post_verify(args.base_url, args.token, wav_bytes, filename)
        wall_times.append(elapsed)
        breakdown = payload.get("stage_breakdown", {})
        for key, value in breakdown.items():
            stage_totals.setdefault(key, []).append(float(value))

        sys.stdout.write(
            f"  run {run + 1:2d}: wall={elapsed:7.1f} ms  decision={payload.get('decision'):8s}  "
            f"server_total={breakdown.get('total_ms', 0.0):.1f} ms\n"
        )

    sys.stdout.write("\n=== Wall-clock latency (client) ===\n")
    sys.stdout.write(f"  p50: {statistics.median(wall_times):7.1f} ms\n")
    sys.stdout.write(f"  p95: {percentile(wall_times, 0.95):7.1f} ms\n")
    sys.stdout.write(f"  max: {max(wall_times):7.1f} ms\n")

    sys.stdout.write("\n=== Server stage breakdown (mean ms) ===\n")
    for key in ("load_ms", "resample_ms", "normalize_ms", "embed_ms", "detect_ms", "total_ms"):
        values = stage_totals.get(key, [])
        if not values:
            continue
        sys.stdout.write(f"  {key:14s}: mean={statistics.mean(values):7.2f} ms  p95={percentile(values, 0.95):7.2f} ms\n")

    sys.stdout.write("\nSDD §1.5 budget: end-to-end < 2000 ms.\n")
    return 0


def percentile(values: list[float], q: float) -> float:
    if not values:
        return 0.0
    ordered = sorted(values)
    k = (len(ordered) - 1) * q
    f = int(k)
    c = min(f + 1, len(ordered) - 1)
    if f == c:
        return ordered[f]
    return ordered[f] + (ordered[c] - ordered[f]) * (k - f)


if __name__ == "__main__":
    sys.exit(main())
