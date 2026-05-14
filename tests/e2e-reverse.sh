#!/usr/bin/env bash
# Test (a) in the OTHER direction: bridge in legacy-project asks bridge in new-project.
# Assumes pairing was done by e2e-pair-and-ask.sh.

set -u
REPO_DIR="${REPO_DIR:-$(cd "$(dirname "$0")/.." && pwd)}"
WORKDIR="${WORKDIR:-/tmp/e2e-bridge}"
BIN_ARGS=(node "$REPO_DIR/dist/index.js")

STATE_A="$WORKDIR/state-a"
STATE_B="$WORKDIR/state-b"

echo "==> Start serve B (new-accelerate) as listener on 53992"
STATE_DIR="$STATE_B" PROJECT_DIR="$WORKDIR/new-project" \
  PROJECT_LABEL=new-accelerate PEER_LABEL=legacy-accelerate \
  LISTEN_PORT=53992 PEER_HOST=127.0.0.1 PEER_PORT=53991 \
  NO_MDNS=1 POSTURE_PRESET=new TOOL_NAME=ask_legacy \
  CLAUDE_TIMEOUT_MS=180000 \
  "${BIN_ARGS[@]}" serve > "$WORKDIR/serve-b-listener.log" 2>&1 &
SERVE_B_PID=$!
sleep 1

echo "==> Drive bridge A through MCP stdio (it asks the NEW side)"
DRIVER_STATE_DIR="$STATE_A" \
DRIVER_PROJECT_DIR="$WORKDIR/legacy-project" \
DRIVER_PROJECT_LABEL=legacy-accelerate \
DRIVER_PEER_LABEL=new-accelerate \
DRIVER_TOOL_NAME=ask_new \
DRIVER_POSTURE_PRESET=legacy \
DRIVER_LISTEN_PORT=53991 \
DRIVER_PEER_PORT=53992 \
REPO_DIR="$REPO_DIR" WORKDIR="$WORKDIR" \
  node "$REPO_DIR/tests/drive-mcp.mjs" \
  "Which file defines the User entity in this NEW project, and what is its email-related field called? Be very brief." \
  > "$WORKDIR/driver-reverse.log" 2>&1
RC=$?
sed -n '/=== ANSWER ===/,$p' "$WORKDIR/driver-reverse.log"

kill $SERVE_B_PID 2>/dev/null
wait 2>/dev/null || true
exit $RC
