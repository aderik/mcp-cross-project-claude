#!/usr/bin/env node
import { serve } from "./serve.js";
import { pairReceive, pairSend } from "./pair.js";
import { clearPairedPeer, getPairedPeer, ourKeypair, ourLabel } from "./state.js";
import { fingerprint, log } from "./util.js";
import { shutdownMdns } from "./mdns.js";

function usage(): never {
  console.error(
    `Usage:
  mcp-cross-project-claude [serve]
      Run the bridge as an MCP stdio server. Default subcommand.
      Project dir is process.cwd(). Identity comes from the persistent
      state file (~/.config/mcp-cross-project-claude/state.json or
      \$STATE_DIR/state.json).
      Optional env: LISTEN_PORT, LISTEN_HOST, NO_MDNS=1, PEER_HOST,
                    PEER_PORT, SESSION_TIMEOUT_MS, CLAUDE_TIMEOUT_MS,
                    CLAUDE_BIN, ALLOWED_TOOLS, MODEL, MAX_BUDGET_USD,
                    MAX_CONCURRENT_QUESTIONS.

  mcp-cross-project-claude pair-receive [--no-mdns]
      Show a one-time PIN and wait for one pairing attempt from a peer.
      Refuses if a peer is already paired.

  mcp-cross-project-claude pair-send --peer-label <l> [--pin XXXX]
                                     [--host H --port N] [--no-mdns]
      Discover the peer labelled <l> via mDNS (or use --host/--port), enter
      the PIN, complete pairing. Refuses if a peer is already paired.

  mcp-cross-project-claude peers
      Show our identity and the paired peer, if any.

  mcp-cross-project-claude unpair
      Remove the paired peer.

  mcp-cross-project-claude help
      Show this help.
`
  );
  process.exit(2);
}

function getFlag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  if (i < 0) return undefined;
  return args[i + 1];
}
function hasFlag(args: string[], name: string): boolean {
  return args.includes(name);
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);

  // Help flags work as either a top-level subcommand or an option.
  if (argv.includes("--help") || argv.includes("-h") || argv[0] === "help") usage();

  const first = argv[0];
  const sub = first && !first.startsWith("--") ? first : "serve";
  const args = sub === first ? argv.slice(1) : argv;

  if (sub === "serve") {
    await serve();
    return;
  }

  if (sub === "pair-receive") {
    const useMdns = !hasFlag(args, "--no-mdns") && process.env.NO_MDNS !== "1";
    try {
      await pairReceive({ useMdns });
    } finally {
      shutdownMdns();
    }
    return;
  }

  if (sub === "pair-send") {
    const peerLabel = getFlag(args, "--peer-label");
    if (!peerLabel) {
      console.error("pair-send: --peer-label <label> required");
      process.exit(2);
    }
    const pin = getFlag(args, "--pin");
    const host = getFlag(args, "--host");
    const portStr = getFlag(args, "--port");
    const port = portStr ? Number(portStr) : undefined;
    const useMdns = !hasFlag(args, "--no-mdns") && process.env.NO_MDNS !== "1";
    try {
      await pairSend({ peerLabel, pin, host, port, useMdns });
    } finally {
      shutdownMdns();
    }
    return;
  }

  if (sub === "peers") {
    const kp = ourKeypair();
    console.log(`Our label:       ${ourLabel()}`);
    console.log(`Our fingerprint: ${fingerprint(kp.publicKey)}`);
    const peer = getPairedPeer();
    if (!peer) {
      console.log("Paired peer:     (none)");
    } else {
      console.log(`Paired peer:     ${peer.label} (fp=${peer.fingerprint}, paired=${peer.pairedAt})`);
    }
    return;
  }

  if (sub === "unpair") {
    const removed = clearPairedPeer();
    if (removed) {
      console.log("Removed paired peer.");
    } else {
      console.error("No paired peer to remove.");
      process.exit(1);
    }
    return;
  }

  console.error(`Unknown subcommand: ${sub}`);
  usage();
}

main().catch((err) => {
  log("error", err instanceof Error ? err.message : String(err));
  process.exit(1);
});
