#!/usr/bin/env bash
# Test (a), (c), (d), (f): pair two bridges on loopback, route a question
# through MCP stdio → encrypted Noise channel → claude -p, verify the answer
# came back, no files were modified, wrong PIN is rejected, and PEER_HOST
# fallback path is used throughout (no mDNS).

set -u
REPO_DIR="${REPO_DIR:-$(cd "$(dirname "$0")/.." && pwd)}"
WORKDIR="${WORKDIR:-/tmp/e2e-bridge}"
BIN_ARGS=(node "$REPO_DIR/dist/index.js")

STATE_A="$WORKDIR/state-a"
STATE_B="$WORKDIR/state-b"
LEGACY="$WORKDIR/legacy-project"
NEW="$WORKDIR/new-project"

rm -rf "$STATE_A" "$STATE_B" "$WORKDIR/recv.log" "$WORKDIR/send.log" \
       "$WORKDIR/send-wrong.log" "$WORKDIR/serve-a.log" "$WORKDIR/driver.log"
mkdir -p "$LEGACY" "$NEW/src/Entity"
if [[ ! -d "$LEGACY/.git" ]]; then
  ( cd "$LEGACY" && git init -q . && echo "<?php // legacy User entity, columns: id, email, created_at" > User.php && echo "Legacy." > README.md && git add -A && git commit -q -m init )
fi
if [[ ! -d "$NEW/.git" ]]; then
  cat > "$NEW/src/Entity/User.php" <<'PHP'
<?php
namespace App\Entity;
class User {
    public int $id;
    public string $emailAddress;
}
PHP
  ( cd "$NEW" && git init -q . && echo "New Symfony project." > README.md && git add -A && git commit -q -m init )
fi

echo "==> Step 1: pair-receive on side A"
STATE_DIR="$STATE_A" "${BIN_ARGS[@]}" pair-receive --label legacy-accelerate --no-mdns \
  > "$WORKDIR/recv.log" 2>&1 &
RECV_PID=$!
for _ in $(seq 1 100); do
  grep -q "Pairing PIN" "$WORKDIR/recv.log" 2>/dev/null && break
  sleep 0.1
done
if ! grep -q "Pairing PIN" "$WORKDIR/recv.log"; then
  echo "FAIL: pair-receive did not print PIN"; cat "$WORKDIR/recv.log"; kill $RECV_PID 2>/dev/null; exit 1
fi
PIN=$(grep "Pairing PIN" "$WORKDIR/recv.log" | grep -oE '[0-9]{4}' | head -1)
PORT=$(grep "Listening:" "$WORKDIR/recv.log" | grep -oE ':[0-9]+' | tr -d :)
echo "    PIN=$PIN PORT=$PORT"

echo "==> Step 2 (test d): pair-send with WRONG pin"
WRONG=$(printf '%04d' $(( (PIN + 1234) % 10000 )))
STATE_DIR="$STATE_B" "${BIN_ARGS[@]}" pair-send \
  --our-label new-accelerate --peer-label legacy-accelerate \
  --pin "$WRONG" --host 127.0.0.1 --port "$PORT" --no-mdns \
  > "$WORKDIR/send-wrong.log" 2>&1
WRONG_RC=$?
if [[ $WRONG_RC -eq 0 ]]; then
  echo "FAIL(d): wrong PIN was accepted!"; exit 1
fi
echo "    wrong PIN rejected (rc=$WRONG_RC) ✓"
wait $RECV_PID 2>/dev/null || true

echo "==> Step 3: clean pair-receive + pair-send"
STATE_DIR="$STATE_A" "${BIN_ARGS[@]}" pair-receive --label legacy-accelerate --no-mdns \
  > "$WORKDIR/recv.log" 2>&1 &
RECV_PID=$!
for _ in $(seq 1 100); do
  grep -q "Pairing PIN" "$WORKDIR/recv.log" 2>/dev/null && break
  sleep 0.1
done
PIN=$(grep "Pairing PIN" "$WORKDIR/recv.log" | grep -oE '[0-9]{4}' | head -1)
PORT=$(grep "Listening:" "$WORKDIR/recv.log" | grep -oE ':[0-9]+' | tr -d :)
STATE_DIR="$STATE_B" "${BIN_ARGS[@]}" pair-send \
  --our-label new-accelerate --peer-label legacy-accelerate \
  --pin "$PIN" --host 127.0.0.1 --port "$PORT" --no-mdns \
  > "$WORKDIR/send.log" 2>&1
SEND_RC=$?
wait $RECV_PID
RECV_RC=$?
if [[ $SEND_RC -ne 0 || $RECV_RC -ne 0 ]]; then
  echo "FAIL: pairing rc=$SEND_RC/$RECV_RC"; cat "$WORKDIR/send.log" "$WORKDIR/recv.log"; exit 1
fi
echo "    pairing succeeded ✓"

echo "==> Step 4: list paired peers"
STATE_DIR="$STATE_A" "${BIN_ARGS[@]}" peers
STATE_DIR="$STATE_B" "${BIN_ARGS[@]}" peers

echo "==> Step 5: start serve A (the answerer)"
STATE_DIR="$STATE_A" PROJECT_DIR="$LEGACY" \
  PROJECT_LABEL=legacy-accelerate PEER_LABEL=new-accelerate \
  LISTEN_PORT=53991 PEER_HOST=127.0.0.1 PEER_PORT=53992 \
  NO_MDNS=1 POSTURE_PRESET=legacy TOOL_NAME=ask_new \
  CLAUDE_TIMEOUT_MS=180000 \
  "${BIN_ARGS[@]}" serve > "$WORKDIR/serve-a.log" 2>&1 &
SERVE_A_PID=$!
sleep 1
if ! kill -0 $SERVE_A_PID 2>/dev/null; then
  echo "FAIL: serve A died"; cat "$WORKDIR/serve-a.log"; exit 1
fi

echo "==> Step 6 (test a): drive side B via MCP stdio"
REPO_DIR="$REPO_DIR" WORKDIR="$WORKDIR" \
  node "$REPO_DIR/tests/drive-mcp.mjs" \
  "Which file defines the User entity in this project, and what is its email field called? Be very brief." \
  > "$WORKDIR/driver.log" 2>&1
DRIVER_RC=$?
echo "--- driver answer ---"
sed -n '/=== ANSWER ===/,$p' "$WORKDIR/driver.log"

echo "==> Step 7 (test c): git status of both project dirs"
LEGACY_STATUS=$(cd "$LEGACY" && git status --porcelain)
NEW_STATUS=$(cd "$NEW" && git status --porcelain)
if [[ -n "$LEGACY_STATUS" || -n "$NEW_STATUS" ]]; then
  echo "FAIL(c): files were modified"; exit 1
fi
echo "    both project dirs clean ✓"

kill $SERVE_A_PID 2>/dev/null
wait $SERVE_A_PID 2>/dev/null || true
echo "==> Done. Driver rc=$DRIVER_RC"
exit $DRIVER_RC
