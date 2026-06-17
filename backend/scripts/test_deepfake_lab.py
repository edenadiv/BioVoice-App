"""Smoke-test the DeepfakeLab "generate a clone" flow against a live backend.

Mirrors what the DeepfakeLab page does when an operator picks an enrolled
user and clicks "Generate":

1. `GET /spoof/engines` -- confirm a cloning engine (default: F5-TTS) is
   available.
2. `GET /users` -- pick the first enrolled user (or use --user).
3. `POST /spoof` with that user as `target_user_id` -- the service uses all
   of that user's saved enrollment samples as the voice reference.
4. Save the returned WAV next to this script's output directory.

Usage (with the backend running on :8000):

    ..\\.venv\\Scripts\\python.exe backend\\scripts\\test_deepfake_lab.py
    ..\\.venv\\Scripts\\python.exe backend\\scripts\\test_deepfake_lab.py --user yoav --engine f5 \\
        --text "This is a cloned voice test." --out clone.wav
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

import httpx

DEFAULT_TEXT = "This is a test of the voice cloning pipeline after the torchcodec fix."


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--base-url", default="http://127.0.0.1:8000")
    parser.add_argument("--user", default=None, help="target_user_id (default: first enrolled user)")
    parser.add_argument("--engine", default=None, help="cloning engine id (default: backend default, e.g. f5)")
    parser.add_argument("--language", default="en")
    parser.add_argument("--text", default=DEFAULT_TEXT)
    parser.add_argument("--out", default="deepfake_lab_clone.wav", help="output WAV path")
    parser.add_argument("--timeout", type=float, default=300.0, help="request timeout in seconds")
    args = parser.parse_args()

    client = httpx.Client(base_url=args.base_url, timeout=args.timeout)

    # 1. Engines -------------------------------------------------------------
    engines_resp = client.get("/spoof/engines")
    engines_resp.raise_for_status()
    engines = engines_resp.json()
    print("Engines:")
    for engine in engines["engines"]:
        print(f"  - {engine['id']}: available={engine['available']} ({engine['label']})")
    print(f"Default engine: {engines['default_engine']}")

    engine_id = args.engine or engines["default_engine"]
    chosen = next((e for e in engines["engines"] if e["id"] == engine_id), None)
    if chosen is None:
        print(f"ERROR: engine '{engine_id}' not found", file=sys.stderr)
        return 1
    if not chosen["available"]:
        print(f"ERROR: engine '{engine_id}' is not available on this backend", file=sys.stderr)
        return 1

    # 2. Pick a user -----------------------------------------------------------
    if args.user:
        target_user_id = args.user
    else:
        users_resp = client.get("/users")
        users_resp.raise_for_status()
        users = users_resp.json()
        if not users:
            print("ERROR: no enrolled users found. Enrol a user first.", file=sys.stderr)
            return 1
        target_user_id = users[0]["user_id"]
    print(f"Target user: {target_user_id}")

    # 3. Generate the clone ------------------------------------------------
    print(f"Generating clone with engine='{engine_id}', language='{args.language}'...")
    print(f"Text: {args.text!r}")
    spoof_resp = client.post(
        "/spoof",
        data={
            "target_user_id": target_user_id,
            "text": args.text,
            "language": args.language,
            "engine": engine_id,
        },
    )
    if spoof_resp.status_code != 200:
        print(f"ERROR: /spoof returned {spoof_resp.status_code}: {spoof_resp.text}", file=sys.stderr)
        return 1

    out_path = Path(args.out)
    out_path.write_bytes(spoof_resp.content)
    print(f"Saved clone to: {out_path.resolve()} ({len(spoof_resp.content)} bytes)")
    print(f"X-Spoof-Source: {spoof_resp.headers.get('x-spoof-source')}")
    print(f"X-Spoof-Engine: {spoof_resp.headers.get('x-spoof-engine')}")
    print(f"X-Spoof-Voice:  {spoof_resp.headers.get('x-spoof-voice')}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
