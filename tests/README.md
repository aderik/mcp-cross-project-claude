# Test scripts

Two tests. Run from the repo root.

```bash
node tests/transport-large.mjs   # Transport-layer chunking (no claude CLI, no cost)
bash tests/e2e-mcp.sh             # Pair + question end-to-end via MCP tools (real claude -p)
```

The integration test (`e2e-mcp.sh`) requires the `claude` CLI on PATH and
costs a small amount of API credit per run for the spawned `claude -p` that
answers the question.

The test uses two scratch project dirs under `/tmp/e2e-bridge/`, simulating
two machines via loopback. It uses the internal `BRIDGE_PAIR_HOST` /
`BRIDGE_PAIR_PORT` env-vars to bypass mDNS for pairing on loopback (mDNS over
loopback is flaky on most setups). In real cross-machine use, mDNS handles
peer discovery automatically.
