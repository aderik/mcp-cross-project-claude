#!/usr/bin/env bash
# End-to-end via MCP tools: pair two bridges and run a question through.
#
# Two bridges are spawned, each driven through its OWN MCP stdio:
#  - Driver B: start_pairing → holds the bridge alive long enough for A to
#    complete pairing AND for the answer round-trip.
#  - Driver A: complete_pairing(pin) → ask_cross_project(question).
#
# Loopback uses BRIDGE_PAIR_HOST/BRIDGE_PAIR_PORT (internal test-only env
# overrides) to bypass mDNS for pairing. The session path uses PEER_HOST/PEER_PORT.

set -u
REPO_DIR="${REPO_DIR:-$(cd "$(dirname "$0")/.." && pwd)}"
WORKDIR="${WORKDIR:-/tmp/e2e-bridge}"

STATE_A="$WORKDIR/state-a"
STATE_B="$WORKDIR/state-b"
PROJECT_A="$WORKDIR/project-a"
PROJECT_B="$WORKDIR/project-b"

rm -rf "$STATE_A" "$STATE_B" "$WORKDIR"/*.log
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

DRIVER_B_LOG="$WORKDIR/driver-b.log"
DRIVER_A_LOG="$WORKDIR/driver-a.log"

echo "==> Start driver B (bridge in $PROJECT_B; calls start_pairing; holds 180s)"
(
  BRIDGE_CWD="$PROJECT_B" \
  BRIDGE_STATE_DIR="$STATE_B" \
  BRIDGE_LISTEN_PORT=53992 \
  BRIDGE_PEER_PORT=53991 \
  READY_HOLD_MS=180000 \
  NO_MDNS=1 \
  REPO_DIR="$REPO_DIR" WORKDIR="$WORKDIR" \
  node "$REPO_DIR/tests/drive-mcp.mjs" start_pairing '{}'
) > "$DRIVER_B_LOG" 2>&1 &
DRIVER_B_PID=$!

# Wait for the start_pairing result to appear in driver-b.log
for _ in $(seq 1 100); do
  grep -q '"pin"' "$DRIVER_B_LOG" 2>/dev/null && break
  sleep 0.1
done
if ! grep -q '"pin"' "$DRIVER_B_LOG"; then
  echo "FAIL: driver B never produced a PIN"
  cat "$DRIVER_B_LOG"
  kill $DRIVER_B_PID 2>/dev/null
  exit 1
fi
PIN=$(grep -oE '"pin": "[0-9]{4}"' "$DRIVER_B_LOG" | grep -oE '[0-9]{4}' | head -1)
PAIR_PORT=$(grep -oE '"port": [0-9]+' "$DRIVER_B_LOG" | grep -oE '[0-9]+$' | head -1)
echo "    PIN=$PIN  pair-port=$PAIR_PORT"

echo "==> Run driver A: complete_pairing + peer_status + ask_cross_project"
(
  BRIDGE_CWD="$PROJECT_A" \
  BRIDGE_STATE_DIR="$STATE_A" \
  BRIDGE_LISTEN_PORT=53991 \
  BRIDGE_PEER_PORT=53992 \
  BRIDGE_PAIR_HOST=127.0.0.1 \
  BRIDGE_PAIR_PORT="$PAIR_PORT" \
  NO_MDNS=1 \
  REPO_DIR="$REPO_DIR" WORKDIR="$WORKDIR" \
  node "$REPO_DIR/tests/drive-mcp.mjs" --seq "[
    {\"tool\":\"complete_pairing\",\"args\":{\"pin\":\"$PIN\"}},
    {\"tool\":\"peer_status\"},
    {\"tool\":\"ask_cross_project\",\"args\":{\"question\":\"Which file defines the User entity in this project, and what is its email field called? Be very brief.\"}}
  ]"
) > "$DRIVER_A_LOG" 2>&1
DRIVER_A_RC=$?

echo "--- driver A output ---"
cat "$DRIVER_A_LOG"

echo "==> Stop driver B"
kill $DRIVER_B_PID 2>/dev/null
wait $DRIVER_B_PID 2>/dev/null

echo "==> Verify read-only: git status on both project dirs"
A_STATUS=$(cd "$PROJECT_A" && git status --porcelain)
B_STATUS=$(cd "$PROJECT_B" && git status --porcelain)
if [[ -n "$A_STATUS" || -n "$B_STATUS" ]]; then
  echo "FAIL: files modified in $A_STATUS$B_STATUS"
  exit 1
fi
echo "    both project dirs clean ✓"

echo "==> Verify the answer mentions User.php and email"
if grep -qiE 'User\.php' "$DRIVER_A_LOG" && grep -qiE 'email' "$DRIVER_A_LOG"; then
  echo "    answer cites User.php + email ✓"
else
  echo "FAIL: answer did not reference the legacy User.php / email field"
  exit 1
fi

exit $DRIVER_A_RC
