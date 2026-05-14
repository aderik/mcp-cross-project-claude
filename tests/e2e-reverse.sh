#!/usr/bin/env bash
# Reverse-direction end-to-end: bridge in project-a asks bridge in project-b.
# Re-uses paired state from e2e-pair-and-ask.sh.

set -u
REPO_DIR="${REPO_DIR:-$(cd "$(dirname "$0")/.." && pwd)}"
WORKDIR="${WORKDIR:-/tmp/e2e-bridge}"
BIN=(node "$REPO_DIR/dist/index.js")

STATE_A="$WORKDIR/state-a"
STATE_B="$WORKDIR/state-b"
PROJECT_A="$WORKDIR/project-a"
PROJECT_B="$WORKDIR/project-b"

echo "==> Start serve B (in $PROJECT_B) as listener on 53992"
( cd "$PROJECT_B" && STATE_DIR="$STATE_B" \
    LISTEN_PORT=53992 PEER_HOST=127.0.0.1 PEER_PORT=53991 \
    NO_MDNS=1 CLAUDE_TIMEOUT_MS=180000 \
    "${BIN[@]}" serve ) > "$WORKDIR/serve-b-listener.log" 2>&1 &
SERVE_B_PID=$!
sleep 1

echo "==> Drive bridge A (in $PROJECT_A) via MCP stdio"
REPO_DIR="$REPO_DIR" WORKDIR="$WORKDIR" \
  BRIDGE_CWD="$PROJECT_A" BRIDGE_STATE_DIR="$STATE_A" \
  BRIDGE_LISTEN_PORT=53991 BRIDGE_PEER_PORT=53992 \
  node "$REPO_DIR/tests/drive-mcp.mjs" \
  "Which file defines the User entity in this project, and what is its email-related field called? Be very brief." \
  > "$WORKDIR/driver-reverse.log" 2>&1
RC=$?
sed -n '/=== ANSWER ===/,$p' "$WORKDIR/driver-reverse.log"

kill $SERVE_B_PID 2>/dev/null
wait 2>/dev/null || true
exit $RC
