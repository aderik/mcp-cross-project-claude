#!/usr/bin/env node
import { serve } from "./serve.js";
import { pairReceive, pairSend } from "./pair.js";
import { listPeers, removePeer, ourKeypair } from "./state.js";
import { fingerprint, log } from "./util.js";
import { shutdownMdns } from "./mdns.js";

function usage(): never {
  console.error(
    `Usage:
  mcp-cross-project-claude [serve]
      Run the bridge as an MCP stdio server. Default subcommand.
      Required env: PROJECT_DIR, PROJECT_LABEL, PEER_LABEL.
      Optional env: TOOL_NAME, POSTURE_FILE | POSTURE_PRESET, LISTEN_PORT,
                    LISTEN_HOST, NO_MDNS=1, PEER_HOST, PEER_PORT,
                    SESSION_TIMEOUT_MS, CLAUDE_TIMEOUT_MS, CLAUDE_BIN,
                    ALLOWED_TOOLS, MODEL, MAX_BUDGET_USD.

  mcp-cross-project-claude pair-receive --label <our-label> [--no-mdns]
      Show a one-time PIN and wait for one pairing attempt from a peer.

  mcp-cross-project-claude pair-send --our-label <l> --peer-label <l>
                                     [--pin XXXX] [--host H --port N] [--no-mdns]
      Discover the peer via mDNS (or use --host/--port), enter the PIN,
      complete pairing.

  mcp-cross-project-claude peers
      List paired peers and our own fingerprint.

  mcp-cross-project-claude unpair <label>
      Remove a paired peer.
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
  const sub = argv[0] && !argv[0].startsWith("--") ? argv[0] : "serve";
  const args = sub === argv[0] ? argv.slice(1) : argv;

  if (sub === "serve") {
    await serve();
    return; // serve never returns under normal operation
  }

  if (sub === "pair-receive") {
    const ourLabel = getFlag(args, "--label") ?? process.env.PROJECT_LABEL;
    if (!ourLabel) {
      console.error("pair-receive: --label or PROJECT_LABEL env required");
      process.exit(2);
    }
    const useMdns = !hasFlag(args, "--no-mdns") && process.env.NO_MDNS !== "1";
    try {
      await pairReceive({ ourLabel, useMdns });
    } finally {
      shutdownMdns();
    }
    return;
  }

  if (sub === "pair-send") {
    const ourLabel = getFlag(args, "--our-label") ?? process.env.PROJECT_LABEL;
    const peerLabel = getFlag(args, "--peer-label") ?? getFlag(args, "--label") ?? process.env.PEER_LABEL;
    if (!ourLabel) {
      console.error("pair-send: --our-label or PROJECT_LABEL env required");
      process.exit(2);
    }
    if (!peerLabel) {
      console.error("pair-send: --peer-label or PEER_LABEL env required");
      process.exit(2);
    }
    const pin = getFlag(args, "--pin");
    const host = getFlag(args, "--host");
    const portStr = getFlag(args, "--port");
    const port = portStr ? Number(portStr) : undefined;
    const useMdns = !hasFlag(args, "--no-mdns") && process.env.NO_MDNS !== "1";
    try {
      await pairSend({ ourLabel, peerLabel, pin, host, port, useMdns });
    } finally {
      shutdownMdns();
    }
    return;
  }

  if (sub === "peers") {
    const kp = ourKeypair();
    console.log(`Our fingerprint: ${fingerprint(kp.publicKey)}`);
    const peers = listPeers();
    if (peers.length === 0) {
      console.log("(no paired peers)");
      return;
    }
    for (const p of peers) {
      console.log(`  ${p.label.padEnd(30)} fp=${p.fingerprint}  paired=${p.pairedAt}`);
    }
    return;
  }

  if (sub === "unpair") {
    const label = args[0];
    if (!label) {
      console.error("unpair: <label> required");
      process.exit(2);
    }
    const removed = removePeer(label);
    if (removed) {
      console.log(`Removed peer: ${label}`);
    } else {
      console.error(`No peer with label "${label}"`);
      process.exit(1);
    }
    return;
  }

  if (sub === "--help" || sub === "-h" || sub === "help") {
    usage();
  }

  console.error(`Unknown subcommand: ${sub}`);
  usage();
}

main().catch((err) => {
  log("error", err instanceof Error ? err.message : String(err));
  process.exit(1);
});
