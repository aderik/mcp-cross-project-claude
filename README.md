# mcp-cross-project-claude

An encrypted LAN bridge that lets an AI session in one project ask read-only
questions to a Claude Code agent running in another project — on the same
machine or another machine on the same network. The calling session only ever
sees the answer text; none of the other project's files enter its context.

```
┌──────────────────────────┐                  LAN                ┌──────────────────────────┐
│  AI client (project A)   │                                     │  Bridge (project B)      │
│   stdio MCP ↕            │                                     │  ↕ spawns claude -p in B │
│  Bridge (project A) ─────┼── Noise IK / ChaCha20-Poly1305 ────►│   read-only, ephemeral   │
│                          │◄────────────── answer text ─────────│                          │
└──────────────────────────┘                                     └──────────────────────────┘
```

Only the **question string** crosses the boundary. The receiving side answers
with its own `Read`/`Grep`/`Glob` on its own files; tool control stays local
on each side.

## Install

Drop this snippet into the calling project's `.mcp.json` — or register it at
user scope so it's available in every project:

```json
{
  "mcpServers": {
    "cross-project": {
      "command": "npx",
      "args": ["-y", "mcp-cross-project-claude"]
    }
  }
}
```

Or via the Claude Code CLI:

```bash
claude mcp add cross-project --scope user -- npx -y mcp-cross-project-claude
```

Prerequisites on each participating machine: Node ≥ 18 and the `claude` CLI
authenticated on `PATH`.

That's it for installation. Pairing happens through MCP tools — see below.

## Pairing — entirely through MCP tools

A bridge can be paired with **exactly one** peer at a time. Both sides of the
pairing happen via tool calls inside Claude Code; no terminal commands.

**On machine A**, ask your Claude:

> "Start pairing mode."

Your Claude calls `start_pairing` and gets a 4-digit PIN. It will read the
PIN aloud (or display it). The pairing window is 60 seconds.

**On machine B**, within 60 seconds, ask your Claude:

> "Pair with PIN 4729."

Your Claude calls `complete_pairing(pin: "4729")`. The bridge auto-discovers
the receiver via mDNS on the LAN and completes the Noise XXpsk0 handshake.
Both sides print "paired" with the peer's fingerprint.

After this, ask anything cross-project:

> "Ask the other project: what is the canonical email field on the User
> entity?"

Your Claude calls `ask_cross_project(question: "…")`.

## MCP tools

| Tool                    | Args                            | What it does                                                          |
|-------------------------|---------------------------------|-----------------------------------------------------------------------|
| `ask_cross_project`     | `question: string`              | Ask the paired peer a question. Returns text.                          |
| `start_pairing`         | —                               | Put this bridge in pairing mode; returns the PIN and 60s window.       |
| `complete_pairing`      | `pin: string` (4 digits)        | Discover and pair with a bridge that has just called `start_pairing`.  |
| `unpair_peer`           | —                               | Forget the paired peer.                                                |
| `peer_status`           | —                               | Return our identity (label + fingerprint) and paired peer if any.      |

The PIN is the only piece of input the human types — no labels, no hostnames,
no ports.

## How it works

Each bridge is a single process per project with four roles:

1. **MCP stdio server** for the local AI client. Exposes the five tools above.
2. **TCP listener** for incoming peer questions. Authenticates each peer with
   a Noise `IK` handshake against the long-term public key stored at pairing
   time; unknown public keys are dropped.
3. **Network client** when `ask_cross_project` is called. Looks up the paired
   peer's fingerprint via mDNS.
4. **Answering engine**. For each authenticated incoming question, spawns a
   fresh, ephemeral `claude -p` in the bridge's `cwd`.

Identity (label, X25519 keypair, paired peer) lives in
`~/.config/mcp-cross-project-claude/state.json`. One state per machine by
default — pair once, use from any project on that machine.

If you want **per-project pairings** (different peer per codebase), override
`STATE_DIR` in the project's `.mcp.json` `env` block. Each project sets its
own path; the bridge then has independent state for each.

## Environment variables (operational, all optional)

| Variable                    | Default            | Purpose                                                              |
|-----------------------------|--------------------|----------------------------------------------------------------------|
| `STATE_DIR`                 | XDG config dir     | Override state file location. Set per-project for isolated pairings. |
| `LISTEN_PORT`               | `0` (ephemeral)    | TCP port for incoming peer sessions.                                 |
| `LISTEN_HOST`               | `0.0.0.0`          | Bind interface.                                                      |
| `NO_MDNS`                   | (off)              | Set to `1` to disable mDNS advertise/discover.                       |
| `PEER_HOST`                 | (mDNS)             | Manual peer host. Required when `NO_MDNS=1`.                         |
| `PEER_PORT`                 | (mDNS)             | Manual peer port. Required when `NO_MDNS=1`.                         |
| `SESSION_TIMEOUT_MS`        | `30000`            | Per-frame timeout on Noise handshake and request/response.           |
| `CLAUDE_TIMEOUT_MS`         | `180000`           | Per-question hard timeout on the spawned `claude -p`.                |
| `CLAUDE_BIN`                | `claude`           | Path to the Claude Code CLI binary.                                  |
| `ALLOWED_TOOLS`             | `Read,Grep,Glob`   | Forwarded to `claude --allowedTools`. Keep read-only.                |
| `MODEL`                     | (Claude default)   | Override the spawned session's model.                                |
| `MAX_BUDGET_USD`            | (no cap)           | Per-call spend cap. Forwarded to `claude --max-budget-usd`.          |
| `MAX_CONCURRENT_QUESTIONS`  | `3`                | Cap on simultaneous `claude -p` spawns answered by this bridge.      |

## Security model

After pairing:

- Sessions use Noise `IK` (X25519, ChaCha20-Poly1305) with both sides'
  long-term static keys. Forward-secret per session via ephemeral keys.
- A connection from an unknown public key is dropped: the responder closes
  the socket as soon as the initiator-static does not match the paired peer.
- Session routing on mDNS uses the **fingerprint** in TXT records, not the
  label. A label-impersonating advertisement with a different fingerprint is
  ignored.

At pairing time:

- The PIN never leaves the local machine. It seeds a 32-byte PSK via HKDF;
  that PSK is mixed into the `XXpsk0` handshake.
- The pairing window is 60 seconds and accepts exactly one attempt.
- An eavesdropper who captures the pairing handshake can, in principle,
  offline-bruteforce the 4-digit PIN. They cannot derive session keys (those
  depend on ephemeral ECDH they did not participate in), and by the time
  they crack it, it has been burned. Replaying against a paired bridge
  doesn't work either — the responder rejects unknown peer public keys.
- Vetted primitives only: `noise-handshake` (Noise framework, Mathias Buus /
  Hypercore), Node stdlib `crypto` for HKDF and randomness. No custom crypto.

## Spawned `claude -p` flags

```
claude -p \
  --strict-mcp-config \
  --output-format text \
  --allowedTools <ALLOWED_TOOLS>
```

- `--strict-mcp-config` without `--mcp-config` ⇒ zero MCP servers loaded
  inside the spawn. Primary recursion guard.
- `--allowedTools "Read,Grep,Glob"` ⇒ no `Edit`, `Write`, `Bash` etc.
- `CROSS_PROJECT_BRIDGE_DEPTH=1` is bumped in the spawn env. A bridge that
  sees `>= 1` in its own env refuses to start.

`--bare` is deliberately **not** used: it skips OAuth and the keychain and
requires `ANTHROPIC_API_KEY`, which breaks Max-plan auth. Non-bare keeps the
project's `CLAUDE.md` in scope, which is the right place for any project-
specific answering posture or constraints.

## Verification

```bash
node tests/transport-large.mjs   # Transport chunking, no claude CLI needed
bash tests/e2e-mcp.sh             # Full pairing + question via MCP tools
```

The integration test uses two scratch project dirs under `/tmp/e2e-bridge/`
and drives both bridges through their respective MCP stdio interfaces. See
`tests/README.md`.

## Limitations

- **Local-network only.** TCP, mDNS. Firewalls / Tailscale / ZeroTier are
  out of scope; if the receiver's `LISTEN_PORT` isn't reachable from the
  asker, sessions won't work.
- **No streaming.** The bridge returns the full text once `claude -p` exits.
- **PIN entropy is 4 digits.** Security relies on single-use + 60s window +
  rejection of unknown peer keys, not on the PIN's entropy.

## Development

```bash
git clone https://github.com/aderik/mcp-cross-project-claude.git
cd mcp-cross-project-claude
npm install
npm run build
```

## License

MIT — see [`LICENSE`](LICENSE).
