# End-to-end test scripts

These scripts exercise the bridge with **real** `claude -p` invocations and
real network traffic (over loopback). They are not unit tests; expect each
question to cost a small amount of API credit on the receiving side.

Prerequisites: `node`, `claude` CLI authenticated, this package built
(`npm run build` at the repo root).

The scripts create two scratch project directories under `/tmp/e2e-bridge/`
to simulate two machines. Run them in order:

1. `e2e-pair-and-ask.sh` — pairs two bridges and routes one question through
   MCP stdio → encrypted Noise channel → `claude -p`. Verifies (a) end-to-end
   query works, (c) read-only enforcement (git status), (d) wrong-PIN
   rejection.
2. `e2e-recursion-and-wire.sh` — through a tee-proxy that logs wire bytes:
   verifies (b) no bridge tool leaks into the spawned subagent and Bash is
   blocked, (e) wire bytes are encrypted (no readable cleartext).
3. `e2e-reverse.sh` — same as (1) but the other direction (legacy bridge
   asks the new bridge).

All three scripts use `NO_MDNS=1` + `PEER_HOST`/`PEER_PORT` — implicitly
also verifying (f), the manual hostname fallback.

mDNS itself is harder to test on a single machine (loopback multicast is
flaky). On a real two-machine setup, drop `NO_MDNS=1` and the scripts
discover the peer over the LAN.
