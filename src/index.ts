#!/usr/bin/env node
import { serve } from "./serve.js";
import { log } from "./util.js";

function usage(): never {
  console.error(
    `Usage: mcp-cross-project-claude [serve]

  Run the bridge as an MCP stdio server. \`serve\` is the default (and only)
  subcommand. Pairing, peer status, and unpair are exposed as MCP tools on
  the running server — they are not separate CLI commands. The local AI
  client calls these tools at the user's direction.

  Tools exposed over MCP:
    ask_cross_project(question)   Ask the paired peer.
    start_pairing()               Show a PIN; wait for the other side.
    complete_pairing(pin)         Use a PIN from the other side.
    unpair_peer()                 Forget the paired peer.
    peer_status()                 Inspect identity and pairing state.

  Operational env vars (all optional):
    STATE_DIR, LISTEN_PORT, LISTEN_HOST, NO_MDNS, PEER_HOST, PEER_PORT,
    SESSION_TIMEOUT_MS, CLAUDE_TIMEOUT_MS, CLAUDE_BIN, ALLOWED_TOOLS, MODEL,
    MAX_BUDGET_USD, MAX_CONCURRENT_QUESTIONS.
`
  );
  process.exit(2);
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (argv.includes("--help") || argv.includes("-h") || argv[0] === "help") usage();

  const first = argv[0];
  if (first && first !== "serve") {
    console.error(`Unknown subcommand: ${first}`);
    usage();
  }

  await serve();
}

main().catch((err) => {
  log("error", err instanceof Error ? err.message : String(err));
  process.exit(1);
});
