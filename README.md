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

## How it works

Each bridge runs as a single process per project, with four roles:

1. **MCP stdio server** for the local AI client. Exposes one tool:
   `ask_cross_project(question: string)`.
2. **TCP listener** for incoming peer questions. Authenticates each peer with
   a Noise IK handshake against the long-term public key stored at pairing
   time; unknown public keys are dropped.
3. **Network client** when the local tool is invoked. Looks up the paired
   peer's fingerprint in mDNS (or uses `PEER_HOST`/`PEER_PORT`).
4. **Answering engine**. For each authenticated incoming question, spawns a
   fresh, ephemeral `claude -p` in the bridge's `cwd`.

Identity (label, long-term keypair, paired peer) lives in a per-project state
file under `~/.config/mcp-cross-project-claude/<basename-of-cwd>-<sha8-of-cwd>/state.json`.
The path is keyed by absolute `cwd` so each project gets its own identity,
keypair, and paired peer — even when the bridge is registered at user-scope
in Claude Code and shared across all your projects. Override with `STATE_DIR`
if you want a different path or to share state across project dirs.

## Install

Drop this snippet into the calling project's `.mcp.json`:

```json
{
  "mcpServers": {
    "cross-project": {
      "command": "npx",
      "args": ["-y", "mcp-cross-project-claude", "serve"]
    }
  }
}
```

That's it. The project dir is whatever `cwd` the AI client launches the
bridge in (Claude Code, Cursor, etc. set this to the project root). On
first run the bridge generates a stable label and X25519 keypair into the
state file.

Prerequisites on each participating machine: Node ≥ 18 and the `claude` CLI
authenticated on `PATH`.

## Pairing

A bridge can be paired with **exactly one** peer at a time. Pairing is a
one-time, human-confirmed exchange of long-term public keys, bound by a
PIN-derived PSK (Noise `XXpsk0`).

On the **receiving** machine:

```bash
cd /path/to/project-A
npx -y mcp-cross-project-claude pair-receive
```

Sample output:

```
=========================================================
  Pairing PIN:  4729
=========================================================
  Our label:    project-A-3f2a
  Our fp:       7c2a91d4...
  Listening:    0.0.0.0:54213
  mDNS:         _mcp-bridge-pair._tcp.local
  Window:       60s (single attempt)

On the OTHER machine, run:
  npx -y mcp-cross-project-claude pair-send --peer-label project-A-3f2a --pin 4729
```

On the **sending** machine, within 60 seconds:

```bash
cd /path/to/project-B
npx -y mcp-cross-project-claude pair-send --peer-label project-A-3f2a --pin 4729
```

Both sides print `Pairing succeeded` and persist the peer's public key,
fingerprint, and label. From that point on, the two `serve` processes can
talk and the `.mcp.json` snippet above is enough on both sides.

If mDNS is blocked, add `--no-mdns --host <ip> --port <port>` to `pair-send`.
The receiver prints the port it bound.

`pair-receive` and `pair-send` both refuse if a peer is already paired —
run `unpair` first.

## Commands

| Subcommand     | Purpose                                                       |
|----------------|---------------------------------------------------------------|
| `serve`        | Default. MCP stdio server + TCP listener.                     |
| `pair-receive` | Show PIN, wait for one pairing attempt.                       |
| `pair-send`    | Connect to a peer's pairing listener and complete pairing.    |
| `peers`        | Print our label + fingerprint and the paired peer.            |
| `unpair`       | Remove the paired peer.                                       |
| `help`         | Show usage.                                                   |

## Environment variables (operational only)

| Variable                    | Default            | Purpose                                                              |
|-----------------------------|--------------------|----------------------------------------------------------------------|
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
| `STATE_DIR`                 | per-cwd subdir     | Override location of the persisted state file. Default is keyed by absolute cwd. |

## Security model

After pairing:

- Sessions use Noise `IK` (X25519, ChaCha20-Poly1305) with both sides'
  long-term static keys. Forward-secret per session via ephemeral keys.
- A connection from an unknown public key is dropped: the responder closes
  the socket as soon as the initiator-static does not match the paired peer.
- Session routing on mDNS uses the **fingerprint** in TXT records — labels
  are cosmetic. A label-impersonating advertisement with a different
  fingerprint is ignored.

At pairing time:

- The PIN never leaves the local machine. It seeds a 32-byte PSK via HKDF;
  that PSK is mixed into the `XXpsk0` handshake.
- The pairing window is 60 seconds and accepts exactly one attempt.
- An eavesdropper who captures the pairing handshake can, in principle,
  offline-bruteforce the 4-digit PIN. They cannot derive session keys (those
  depend on ephemeral ECDH they did not participate in), and by the time
  they crack it, it has been burned. They also cannot replay against a
  paired bridge because the responder rejects unknown peer public keys.
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
project's `CLAUDE.md` in scope, which is exactly the right place for any
project-specific answering posture or constraints.

## Verification

Scripts under `tests/` (require a real `claude` CLI; each question costs a
small amount of API credit). Run from the repo root:

```bash
bash tests/e2e-pair-and-ask.sh
bash tests/e2e-recursion-and-wire.sh
bash tests/e2e-reverse.sh
node tests/transport-large.mjs
```

They verify, in order: pairing, a question end-to-end, wrong-PIN rejection,
that the spawned subagent has no bridge tool, that `Bash`/`Edit`/`Write` are
blocked, that wire bytes contain no readable cleartext, that the reverse
direction also works, and that the transport layer handles application
payloads above the Noise 64KB-cipher limit (large-payload chunking).

## Limitations

- **Local-network only.** TCP. The receiving side must accept incoming on
  its `LISTEN_PORT`. Firewalls, Tailscale, ZeroTier, etc., are out of scope.
- **mDNS over loopback can be flaky**; for two bridges on the same machine
  prefer `NO_MDNS=1` + `PEER_HOST=127.0.0.1` + explicit `LISTEN_PORT`/`PEER_PORT`.
- **No streaming.** The bridge returns the full text once `claude -p` exits.
- **PIN entropy is 4 digits.** Security relies on single-use + 60s window +
  rejection of unknown peer keys, not on the PIN's entropy itself.

## Development

```bash
git clone https://github.com/aderik/mcp-cross-project-claude.git
cd mcp-cross-project-claude
npm install
npm run build
```

## License

MIT — see [`LICENSE`](LICENSE).
