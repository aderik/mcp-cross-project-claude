#!/usr/bin/env bash
# End-to-end: pair two bridges on loopback, route a question through MCP
# stdio → encrypted Noise channel → claude -p, verify the answer came back
# and no files were modified. Also: wrong-PIN rejected; pair-receive refuses
# when already paired.

set -u
REPO_DIR="${REPO_DIR:-$(cd "$(dirname "$0")/.." && pwd)}"
WORKDIR="${WORKDIR:-/tmp/e2e-bridge}"
BIN=(node "$REPO_DIR/dist/index.js")

STATE_A="$WORKDIR/state-a"
STATE_B="$WORKDIR/state-b"
PROJECT_A="$WORKDIR/project-a"
PROJECT_B="$WORKDIR/project-b"

rm -rf "$STATE_A" "$STATE_B" "$WORKDIR"/*.log "$WORKDIR"/wire-*.bin
mkdir -p "$PROJECT_A" "$PROJECT_B/src/Entity"
if [[ ! -d "$PROJECT_A/.git" ]]; then
  ( cd "$PROJECT_A" && git init -q . \
      && echo "<?php // legacy User entity, columns: id, email, created_at" > User.php \
      && echo "Project A." > README.md \
      && git add -A && git commit -q -m init )
fi
if [[ ! -d "$PROJECT_B/.git" ]]; then
  cat > "$PROJECT_B/src/Entity/User.php" <<'PHP'
<?php
namespace App\Entity;
class User {
    public int $id;
    public string $emailAddress;
}
PHP
  ( cd "$PROJECT_B" && git init -q . \
      && echo "Project B." > README.md \
      && git add -A && git commit -q -m init )
fi

echo "==> Step 1: pair-receive on side A (in $PROJECT_A)"
( cd "$PROJECT_A" && STATE_DIR="$STATE_A" "${BIN[@]}" pair-receive --no-mdns ) \
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
PEER_LABEL=$(grep "Our label:" "$WORKDIR/recv.log" | awk '{print $3}')
echo "    PIN=$PIN PORT=$PORT peer-label=$PEER_LABEL"

echo "==> Step 2 (test d): pair-send with WRONG pin"
WRONG=$(printf '%04d' $(( (PIN + 1234) % 10000 )))
( cd "$PROJECT_B" && STATE_DIR="$STATE_B" "${BIN[@]}" pair-send \
    --peer-label "$PEER_LABEL" --pin "$WRONG" \
    --host 127.0.0.1 --port "$PORT" --no-mdns ) \
  > "$WORKDIR/send-wrong.log" 2>&1
WRONG_RC=$?
[[ $WRONG_RC -eq 0 ]] && { echo "FAIL(d): wrong PIN accepted"; exit 1; }
echo "    wrong PIN rejected (rc=$WRONG_RC) ✓"
wait $RECV_PID 2>/dev/null || true

echo "==> Step 3: clean pair-receive + pair-send"
( cd "$PROJECT_A" && STATE_DIR="$STATE_A" "${BIN[@]}" pair-receive --no-mdns ) \
  > "$WORKDIR/recv.log" 2>&1 &
RECV_PID=$!
for _ in $(seq 1 100); do
  grep -q "Pairing PIN" "$WORKDIR/recv.log" 2>/dev/null && break
  sleep 0.1
done
PIN=$(grep "Pairing PIN" "$WORKDIR/recv.log" | grep -oE '[0-9]{4}' | head -1)
PORT=$(grep "Listening:" "$WORKDIR/recv.log" | grep -oE ':[0-9]+' | tr -d :)
PEER_LABEL=$(grep "Our label:" "$WORKDIR/recv.log" | awk '{print $3}')
( cd "$PROJECT_B" && STATE_DIR="$STATE_B" "${BIN[@]}" pair-send \
    --peer-label "$PEER_LABEL" --pin "$PIN" \
    --host 127.0.0.1 --port "$PORT" --no-mdns ) \
  > "$WORKDIR/send.log" 2>&1
SEND_RC=$?
wait $RECV_PID
RECV_RC=$?
if [[ $SEND_RC -ne 0 || $RECV_RC -ne 0 ]]; then
  echo "FAIL: pairing rc=$SEND_RC/$RECV_RC"; cat "$WORKDIR/send.log" "$WORKDIR/recv.log"; exit 1
fi
echo "    pairing succeeded ✓"

echo "==> Step 4: refuse-if-paired"
( cd "$PROJECT_A" && STATE_DIR="$STATE_A" "${BIN[@]}" pair-receive --no-mdns ) \
  > "$WORKDIR/recv-refuse.log" 2>&1
REFUSE_RC=$?
if [[ $REFUSE_RC -eq 0 ]]; then
  echo "FAIL: pair-receive accepted when already paired"; exit 1
fi
grep -q "Already paired" "$WORKDIR/recv-refuse.log" || \
  { echo "FAIL: missing 'Already paired' message"; cat "$WORKDIR/recv-refuse.log"; exit 1; }
echo "    pair-receive refused when already paired ✓"

echo "==> Step 5: peers listing"
STATE_DIR="$STATE_A" "${BIN[@]}" peers
STATE_DIR="$STATE_B" "${BIN[@]}" peers

echo "==> Step 6: start serve A (the answerer) in $PROJECT_A"
( cd "$PROJECT_A" && STATE_DIR="$STATE_A" \
    LISTEN_PORT=53991 PEER_HOST=127.0.0.1 PEER_PORT=53992 \
    NO_MDNS=1 CLAUDE_TIMEOUT_MS=180000 \
    "${BIN[@]}" serve ) > "$WORKDIR/serve-a.log" 2>&1 &
SERVE_A_PID=$!
sleep 1
if ! kill -0 $SERVE_A_PID 2>/dev/null; then
  echo "FAIL: serve A died"; cat "$WORKDIR/serve-a.log"; exit 1
fi

echo "==> Step 7 (test a): drive side B via MCP stdio"
REPO_DIR="$REPO_DIR" WORKDIR="$WORKDIR" \
  BRIDGE_CWD="$PROJECT_B" BRIDGE_STATE_DIR="$STATE_B" \
  BRIDGE_LISTEN_PORT=53992 BRIDGE_PEER_PORT=53991 \
  node "$REPO_DIR/tests/drive-mcp.mjs" \
  "Which file defines the User entity in this project, and what is its email field called? Be very brief." \
  > "$WORKDIR/driver.log" 2>&1
DRIVER_RC=$?
sed -n '/=== ANSWER ===/,$p' "$WORKDIR/driver.log"

echo "==> Step 8 (test c): git status of both project dirs"
A_STATUS=$(cd "$PROJECT_A" && git status --porcelain)
B_STATUS=$(cd "$PROJECT_B" && git status --porcelain)
if [[ -n "$A_STATUS" || -n "$B_STATUS" ]]; then
  echo "FAIL(c): files were modified"; exit 1
fi
echo "    both project dirs clean ✓"

kill $SERVE_A_PID 2>/dev/null
wait $SERVE_A_PID 2>/dev/null || true
echo "==> Done. Driver rc=$DRIVER_RC"
exit $DRIVER_RC
