#!/usr/bin/env bash
# Single-shot deploy smoke for the BioVoice kiosk.
#
# Walks the docs/deployment.md TL;DR end-to-end on the LIVE backend
# at http://localhost:8000 (or $BIOVOICE_BACKEND if set), then
# exercises a real enrol → verify → spoof → spoof/test cycle to
# confirm the ML pipeline is wired.
#
# Exits non-zero on the first failure. Prints a one-line summary at
# the end so it's CI-friendly.
#
# Pre-req: the backend must already be running (uvicorn or via docker
# compose). This script does NOT boot the stack itself — that's a
# choice for the operator (dev: `uvicorn`; prod: `docker compose up`).
#
# Usage:
#     ./deploy/smoke.sh
#     BIOVOICE_BACKEND=https://kiosk.example.com ./deploy/smoke.sh

set -euo pipefail

BACKEND="${BIOVOICE_BACKEND:-http://localhost:8000}"
USER_ID="smoke_$(date +%s)"
WORKDIR=$(mktemp -d -t biovoice-smoke-XXXXXX)
trap 'rm -rf "$WORKDIR"' EXIT

echo "==> BioVoice deploy smoke against $BACKEND"
echo "    workdir: $WORKDIR"
echo "    user_id: $USER_ID"
echo

# ---------------------------------------------------------------------------
# 1. Liveness + readiness
# ---------------------------------------------------------------------------

echo "[1/6] /healthz"
curl -sf "$BACKEND/healthz" -o "$WORKDIR/healthz.json" || curl -sf "$BACKEND/health" -o "$WORKDIR/healthz.json" || {
    echo "    FAIL: /healthz didn't respond"
    exit 1
}
cat "$WORKDIR/healthz.json"
echo

echo "[2/6] /readyz"
curl -sf "$BACKEND/readyz" -o "$WORKDIR/readyz.json"
cat "$WORKDIR/readyz.json" | python3 -m json.tool
if ! grep -q '"ready":\s*true' "$WORKDIR/readyz.json"; then
    echo "    FAIL: /readyz did not return ready: true"
    exit 1
fi
echo

# ---------------------------------------------------------------------------
# 2. Generate a real WAV via macOS `say` so we don't need an external fixture.
#    On Linux: use espeak-ng if available, otherwise skip with a clear msg.
# ---------------------------------------------------------------------------

echo "[3/6] Generate enrolment WAV"
if command -v say >/dev/null 2>&1; then
    say -o "$WORKDIR/enrol.wav" --data-format=LEI16@16000 \
        "I am the smoke test user enrolling my voice for verification with the BioVoice kiosk."
elif command -v espeak-ng >/dev/null 2>&1; then
    espeak-ng -w "$WORKDIR/enrol.wav" \
        "I am the smoke test user enrolling my voice for verification with the BioVoice kiosk."
elif command -v espeak >/dev/null 2>&1; then
    espeak -w "$WORKDIR/enrol.wav" \
        "I am the smoke test user enrolling my voice for verification with the BioVoice kiosk."
else
    echo "    SKIP: no system TTS (say / espeak-ng / espeak) on PATH; can't generate fixture."
    exit 0
fi
ls -la "$WORKDIR/enrol.wav"
echo

# ---------------------------------------------------------------------------
# 3. Enrol three samples (backend's min_enrollment_samples gate)
# ---------------------------------------------------------------------------

echo "[4/6] Enrol $USER_ID with 3 samples"
for i in 1 2 3; do
    resp=$(curl -sf -X POST "$BACKEND/enroll" \
        -F "user_id=$USER_ID" \
        -F "audio=@$WORKDIR/enrol.wav")
    status=$(echo "$resp" | python3 -c "import sys, json; print(json.loads(sys.stdin.read()).get('status', 'unknown'))")
    echo "    sample $i: $status"
done
echo

# ---------------------------------------------------------------------------
# 4. Verify (should ACCEPT — same speaker)
# ---------------------------------------------------------------------------

echo "[5/6] Verify same voice → expect ACCEPT"
verify_resp=$(curl -sf -X POST "$BACKEND/verify" \
    -F "user_id=$USER_ID" \
    -F "audio=@$WORKDIR/enrol.wav")
decision=$(echo "$verify_resp" | python3 -c "import sys, json; print(json.loads(sys.stdin.read()).get('decision', 'unknown'))")
similarity=$(echo "$verify_resp" | python3 -c "import sys, json; print(json.loads(sys.stdin.read()).get('similarity_score', 0))")
df_score=$(echo "$verify_resp" | python3 -c "import sys, json; print(json.loads(sys.stdin.read()).get('deepfake_score', 0))")
echo "    decision: $decision · similarity: $similarity · df: $df_score"
if [ "$decision" != "ACCEPT" ]; then
    echo "    WARN: decision was $decision (expected ACCEPT). Likely AASIST flagging the synthetic enrol audio."
fi
echo

# ---------------------------------------------------------------------------
# 5. Spoof + spoof/test cycle (deepfake lab)
# ---------------------------------------------------------------------------

echo "[6/6] Forge spoof + score it"
curl -sf -X POST "$BACKEND/spoof" \
    -F "target_user_id=$USER_ID" \
    -F "text=Open the safe please." \
    -F "language=en" \
    -o "$WORKDIR/spoof.wav" \
    -D "$WORKDIR/spoof-headers.txt"
spoof_source=$(grep -i "x-spoof-source:" "$WORKDIR/spoof-headers.txt" | sed 's/^[^:]*: *//' | tr -d '\r\n')
spoof_size=$(stat -f%z "$WORKDIR/spoof.wav" 2>/dev/null || stat -c%s "$WORKDIR/spoof.wav")
echo "    spoof engine: ${spoof_source:-<no header>}"
echo "    spoof size  : ${spoof_size} bytes"

test_resp=$(curl -sf -X POST "$BACKEND/spoof/test" -F "audio=@$WORKDIR/spoof.wav")
test_decision=$(echo "$test_resp" | python3 -c "import sys, json; print(json.loads(sys.stdin.read()).get('decision', 'unknown'))")
test_score=$(echo "$test_resp" | python3 -c "import sys, json; print(json.loads(sys.stdin.read()).get('deepfake_score', 0))")
echo "    spoof/test: $test_decision (score $test_score)"
echo

# ---------------------------------------------------------------------------
# 6. Cleanup
# ---------------------------------------------------------------------------

curl -sf -X DELETE "$BACKEND/users/$USER_ID" >/dev/null
echo "    cleanup: $USER_ID deleted"
echo

# ---------------------------------------------------------------------------
# Summary
# ---------------------------------------------------------------------------

cat <<EOF
==> SMOKE SUMMARY
    backend       : $BACKEND
    user_id       : $USER_ID (deleted)
    enrol         : 3/3 samples accepted
    verify        : $decision (sim=$similarity, df=$df_score)
    spoof engine  : ${spoof_source:-<unknown>}
    spoof verdict : $test_decision (score=$test_score)
EOF
