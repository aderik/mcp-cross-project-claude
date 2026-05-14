# @aderik/mcp-cross-project-claude

A LAN bridge that lets one Claude Code session ask questions to a **read-only**
Claude Code agent running in a different project — on the same machine or on
a different machine on the same network. The calling session only sees the
**text answer**; none of the target project's files enter its context.

This is useful when you are migrating between two codebases and want one
session to remain blind to the other's implementation while still being able
to ask factual questions about it. Each side of the migration runs its own
bridge; the two bridges talk to each other over an encrypted Noise channel.

```
┌──────────────────────────┐                 LAN                ┌──────────────────────────┐
│  AI client (NEW project) │                                    │  AI client (OLD project) │
│   stdio MCP ↕            │                                    │   stdio MCP ↕            │
│  bridge ─── ask_legacy ──┼── Noise IK encrypted TCP frame ───►│  bridge ── claude -p ─►  │
│                          │◄─────────────── answer ────────────│   (read-only, ephemeral) │
└──────────────────────────┘                                    └──────────────────────────┘
```

**The calling side never sends tools, files, or context — only the question
string. The receiving side answers with its own tools (Read, Glob, Grep) on
its own files. Control stays local on each side.**

## How it works

Each bridge is a single process per project with four roles:

1. **MCP stdio server** for the local AI client (one tool, name configurable
   via `TOOL_NAME`).
2. **Network listener** — incoming peer questions arrive over TCP; Noise IK
   handshake authenticates the peer against the local "paired peers" list.
3. **Network client** — when the local tool is invoked, the bridge looks up
   the paired peer, discovers it via mDNS (or `PEER_HOST` fallback), and
   opens an encrypted Noise IK channel.
4. **Answering engine** — when an authenticated peer asks a question, the
   bridge spawns a fresh, ephemeral `claude -p` inside the local project,
   with read-only tools and the configured answer posture.

Same machine is the degenerate case: two bridges on different loopback ports.
No separate code path.

## Install

Drop the example snippet into the calling project's `.mcp.json`. `npx -y`
resolves and caches the package on first use.

```json
{
  "mcpServers": {
    "ask-legacy": {
      "command": "npx",
      "args": ["-y", "@aderik/mcp-cross-project-claude", "serve"],
      "env": {
        "PROJECT_DIR": "/absolute/path/to/this/project",
        "PROJECT_LABEL": "new-accelerate",
        "TOOL_NAME": "ask_legacy",
        "PEER_LABEL": "legacy-accelerate",
        "POSTURE_PRESET": "new"
      }
    }
  }
}
```

Prerequisites on every participating machine: Node ≥ 18 and the `claude` CLI
on `PATH`.

## Pairing (one-time, per peer)

Pairing establishes mutual trust between two bridges. The receiving side
shows a 4-digit PIN; the sending side enters it. SPAKE-style mixing (Noise
`XXpsk0`) means the PIN is never sent in cleartext, and both sides learn each
other's long-term public key for future sessions.

**Step 1**, on the OLD machine:

```bash
npx -y @aderik/mcp-cross-project-claude pair-receive --label legacy-accelerate
```

Output:

```
=========================================================
  Pairing PIN:  4729
=========================================================
  Our label:    legacy-accelerate
  Listening:    0.0.0.0:54213
  mDNS:         _mcp-bridge-pair._tcp.local
  Window:       60s (single attempt)

On the OTHER machine, run:
  npx -y @aderik/mcp-cross-project-claude pair-send legacy-accelerate --pin 4729
```

**Step 2**, on the NEW machine (within 60 seconds):

```bash
npx -y @aderik/mcp-cross-project-claude pair-send \
  --our-label new-accelerate \
  --peer-label legacy-accelerate \
  --pin 4729
```

Both sides print `Pairing succeeded.` with the peer's fingerprint, and persist
the peer in `~/.config/mcp-cross-project-claude/state.json` (mode 0600).

**Manual hostname fallback** if mDNS is blocked: add `--no-mdns --host
<receiver-ip> --port <port-shown-on-receiver>` to the `pair-send` command.

Pairings are persistent across restarts. Revoke with:

```bash
npx -y @aderik/mcp-cross-project-claude unpair legacy-accelerate
```

List with `... peers`.

## Security model — what you actually get

After pairing:

- Each session uses Noise `IK` (X25519, ChaCha20-Poly1305) with both sides'
  long-term static keys. Forward-secret per session via ephemeral keys.
- A connection from an unknown public key is rejected without any peer
  interaction — the responder closes the socket as soon as the handshake's
  initiator-static does not match a paired peer.
- mDNS advertisements include a fingerprint of the static public key. The
  calling side cross-checks the fingerprint against the paired peer before
  connecting, so an attacker that hijacks the label on the LAN cannot get
  the bridge to dial into them.

During pairing:

- The PIN never leaves the local machine. It seeds a 32-byte PSK via HKDF;
  that PSK is mixed into the `XXpsk0` handshake.
- The pairing window is 60 seconds and accepts exactly one attempt; on any
  handshake failure the listener closes.
- An eavesdropper who captures the pairing handshake can, in principle,
  offline-bruteforce the 4-digit PIN (~10⁴ guesses) against the captured
  data and learn the PIN. They cannot derive the session keys from this —
  those depend on ephemeral ECDH exchanges they did not participate in. By
  the time they crack the PIN, it has been burned. They also cannot replay
  a session because the responder rejects unknown peer public keys.
- We use vetted primitives only: `noise-handshake` (Noise framework, Mathias
  Buus / Hypercore), Node stdlib `crypto` for HKDF and randomness. No custom
  crypto.

## Environment variables

| Variable             | Required | Default            | Purpose                                                                       |
|----------------------|----------|--------------------|-------------------------------------------------------------------------------|
| `PROJECT_DIR`        | yes      | —                  | Absolute path to the project this bridge serves and answers questions about.  |
| `PROJECT_LABEL`      | yes      | —                  | Identity advertised on mDNS and exchanged at pairing time.                    |
| `PEER_LABEL`         | yes      | —                  | Which paired peer the local tool should query.                                |
| `TOOL_NAME`          | no       | `ask_peer`         | The MCP tool name exposed to the local AI client.                             |
| `POSTURE_PRESET`     | no       | (none)             | `legacy` (strict factual) or `new` (design context allowed). Bundled.         |
| `POSTURE_FILE`       | no       | (none)             | Path to a custom Markdown posture. Overrides `POSTURE_PRESET`.                |
| `LISTEN_PORT`        | no       | `0` (ephemeral)    | TCP port for incoming peer sessions.                                          |
| `LISTEN_HOST`        | no       | `0.0.0.0`          | Bind interface.                                                               |
| `NO_MDNS`            | no       | (off)              | Set to `1` to disable mDNS advertise/discover.                                |
| `PEER_HOST`          | no       | (mDNS)             | Manual peer host. Required when `NO_MDNS=1`.                                  |
| `PEER_PORT`          | no       | (mDNS)             | Manual peer port. Required when `NO_MDNS=1`.                                  |
| `SESSION_TIMEOUT_MS` | no       | `30000`            | Per-frame timeout on Noise handshake and request/response.                    |
| `CLAUDE_TIMEOUT_MS`  | no       | `180000`           | Per-question hard timeout on the spawned `claude -p`.                         |
| `CLAUDE_BIN`         | no       | `claude`           | Path to the Claude Code CLI binary.                                           |
| `ALLOWED_TOOLS`      | no       | `Read,Grep,Glob`   | Forwarded verbatim to `claude --allowedTools`. Keep read-only.                |
| `MODEL`              | no       | (Claude default)   | Override the spawned session's model.                                         |
| `MAX_BUDGET_USD`     | no       | (no cap)           | Per-call spend cap. Forwarded to `claude --max-budget-usd`.                   |
| `STATE_DIR`          | no       | XDG config dir     | Override location of the persisted state file.                                |

## Tests / verification

Run all of these against a paired pair of bridges (one on each side).

### (a) End-to-end cross-direction query

In the NEW-project session, ask the AI: *"Use `ask_legacy`. Question: which
file defines the legacy User entity, and what columns does its table have?"*

Expected: a text answer citing files in the legacy project. The calling
session never sees those files.

Symmetrically with `ask_new` from the OLD-project session.

### (b) No recursion

The spawned `claude -p` runs with `--strict-mcp-config` and no `--mcp-config`,
so it loads zero MCP servers. To verify: ask the receiving bridge to ask the
peer something like *"List your available tools."* The spawned subagent will
list only `Read, Grep, Glob` — no `ask_*` tool. The bridge also sets
`CROSS_PROJECT_BRIDGE_DEPTH=1` in the spawn env, and refuses to start as a
bridge when it sees that flag in its own env — second line of defence.

### (c) Read-only enforcement

Ask through the bridge: *"Add a comment `// hello` to the first PHP file you
find."* The spawned subagent reports it cannot edit (`Edit` and `Write` are
not in `ALLOWED_TOOLS`). Verify with `git status` in `PROJECT_DIR` on the
receiving side — should be unchanged.

### (d) Pairing rejects a wrong PIN

Start `pair-receive` on side A. On side B run `pair-send ... --pin 0000` (or
any wrong PIN). Both sides see `Pairing handshake did not complete` (the
Noise `XXpsk0` handshake fails authenticated-decryption when the PSK is
wrong). Side A burns the window after one attempt — try a second attempt
with the right PIN and it is refused; re-issue from scratch.

### (e) Wire traffic is encrypted

Capture a paired session with:

```bash
sudo tcpdump -i lo -nn -A 'tcp port <session-port>'
```

The question and answer must not appear as cleartext in the dump. You will
see length-prefixed binary payloads only.

### (f) Manual hostname fallback

Set `NO_MDNS=1`, `PEER_HOST=<ip>`, `PEER_PORT=<port>` on the calling side
and verify the question still routes (without any mDNS advertise/browse
traffic on the LAN).

## Limitations

- **Network requirement**: both bridges must reach each other over TCP. The
  receiving side must accept incoming on its `LISTEN_PORT`. Firewalls,
  Tailscale, ZeroTier, etc., are out of scope.
- **`--bare` is deliberately NOT used** when spawning `claude -p`. `--bare`
  skips OAuth and the keychain and requires `ANTHROPIC_API_KEY`; on a Max
  plan that breaks auth. The trade-off is that the spawned session loads
  the user's CLAUDE.md and hooks — usually desirable (it knows the project's
  conventions), but if you want a fully hermetic spawn, fork the engine to
  add `--bare` plus an explicit auth path.
- **CLAUDE.md is loaded** in the spawned session — intentional, see above.
- **No streaming**: the bridge returns the full text once `claude -p` exits.
- **mDNS over loopback can be flaky** depending on OS and Avahi config. When
  testing both bridges on the same machine, prefer `NO_MDNS=1` with
  `PEER_HOST=127.0.0.1` and an explicit `LISTEN_PORT` + `PEER_PORT`.
- **PIN entropy**: 4 digits. The security argument relies on single-use +
  60s window + rejection of unknown peer keys, not on the PIN's entropy
  itself. See *Security model* above.

## Development

```bash
git clone https://github.com/aderik/mcp-cross-project-claude.git
cd mcp-cross-project-claude
npm install
npm run build
```

## License

MIT — see [`LICENSE`](LICENSE).
