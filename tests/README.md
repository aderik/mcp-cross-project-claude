# End-to-end test scripts

Three integration tests that exercise the bridge with real `claude -p` and
real network traffic over loopback, plus one transport-only unit test for
the chunking of large payloads. The integration tests cost a small amount of
API credit; the transport test costs nothing.

Prerequisites: `node`, `claude` CLI authenticated, repo built (`npm run
build`).

Run from the repo root, in this order:

```bash
bash tests/e2e-pair-and-ask.sh           # pair + question A → B
bash tests/e2e-recursion-and-wire.sh     # no recursion, no cleartext on wire
bash tests/e2e-reverse.sh                # question B → A
node  tests/transport-large.mjs          # >64KB payload round-trips intact
```

The integration scripts work in two scratch project dirs under
`/tmp/e2e-bridge/`, simulating two machines via loopback. They all use
`NO_MDNS=1` + `PEER_HOST`/`PEER_PORT` — that path also exercises the manual
hostname fallback. mDNS itself is harder to test on a single machine
(loopback multicast is flaky on most setups).
