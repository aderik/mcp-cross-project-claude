// Drive the bridge's MCP stdio interface as a minimal client.
//
// Two modes:
//   1) Single call:   drive-mcp.mjs <tool> '<json-args>'
//   2) Sequence:      drive-mcp.mjs --seq '[{"tool":"start_pairing"},...]'
//
// The bridge process is spawned for the duration of the command and killed at
// the end. Bridge process env can be overridden via these vars (test only):
//   BRIDGE_CWD, BRIDGE_STATE_DIR, BRIDGE_LISTEN_PORT, BRIDGE_PEER_HOST,
//   BRIDGE_PEER_PORT, BRIDGE_PAIR_HOST, BRIDGE_PAIR_PORT, NO_MDNS,
//   CLAUDE_TIMEOUT_MS, REPO_DIR, WORKDIR, READY_HOLD_MS.
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_DIR = process.env.REPO_DIR ?? resolve(__dirname, "..");
const WORKDIR = process.env.WORKDIR ?? "/tmp/e2e-bridge";

const argv = process.argv.slice(2);
let calls;
if (argv[0] === "--seq") {
  calls = JSON.parse(argv[1]);
} else {
  calls = [{ tool: argv[0], args: argv[1] ? JSON.parse(argv[1]) : {} }];
}
if (!calls.length || !calls[0].tool) {
  console.error("usage: drive-mcp.mjs <tool> [<json-args>]  OR  drive-mcp.mjs --seq '[...]'");
  process.exit(2);
}

const BRIDGE_CWD = process.env.BRIDGE_CWD ?? `${WORKDIR}/project-b`;
const env = {
  ...process.env,
  STATE_DIR: process.env.BRIDGE_STATE_DIR ?? `${WORKDIR}/state-b`,
  LISTEN_PORT: process.env.BRIDGE_LISTEN_PORT ?? "53992",
  PEER_HOST: process.env.BRIDGE_PEER_HOST ?? "127.0.0.1",
  PEER_PORT: process.env.BRIDGE_PEER_PORT ?? "53991",
  BRIDGE_PAIR_HOST: process.env.BRIDGE_PAIR_HOST ?? "",
  BRIDGE_PAIR_PORT: process.env.BRIDGE_PAIR_PORT ?? "",
  NO_MDNS: process.env.NO_MDNS ?? "1",
  CLAUDE_TIMEOUT_MS: process.env.CLAUDE_TIMEOUT_MS ?? "180000",
};

const proc = spawn("node", [`${REPO_DIR}/dist/index.js`, "serve"], {
  cwd: BRIDGE_CWD,
  env,
  stdio: ["pipe", "pipe", "inherit"],
});

let outBuf = "";
const pending = new Map();
let nextId = 1;

proc.stdout.on("data", (chunk) => {
  outBuf += chunk.toString();
  let nl;
  while ((nl = outBuf.indexOf("\n")) >= 0) {
    const line = outBuf.slice(0, nl);
    outBuf = outBuf.slice(nl + 1);
    if (!line.trim()) continue;
    try {
      const msg = JSON.parse(line);
      if (msg.id !== undefined && pending.has(msg.id)) {
        const { resolve, reject } = pending.get(msg.id);
        pending.delete(msg.id);
        if (msg.error) reject(new Error(JSON.stringify(msg.error)));
        else resolve(msg.result);
      }
    } catch {
      console.error("non-JSON line from bridge stdout:", line);
    }
  }
});

function send(method, params) {
  const id = nextId++;
  proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
  });
}
function notify(method, params) {
  proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n");
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  try {
    await send("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "e2e-driver", version: "1.0" },
    });
    notify("notifications/initialized");
    for (const call of calls) {
      if (call.sleepMs) {
        await sleep(call.sleepMs);
        continue;
      }
      const result = await send("tools/call", { name: call.tool, arguments: call.args ?? {} });
      console.log("=== RESULT", call.tool, "===");
      console.log(JSON.stringify(result, null, 2));
      // If the text content parses as JSON, also print it unescaped on its
      // own line. Makes simple bash-grep parsing of structured tool output
      // possible without unescaping.
      const text = result?.content?.[0]?.text;
      if (typeof text === "string") {
        try {
          const inner = JSON.parse(text);
          console.log("=== PARSED", call.tool, "===");
          console.log(JSON.stringify(inner, null, 2));
        } catch {
          // text wasn't structured; that's fine
        }
      }
    }
    const holdMs = Number(process.env.READY_HOLD_MS ?? 0);
    if (holdMs > 0) await sleep(holdMs);
  } catch (err) {
    console.error("DRIVER ERROR:", err.message);
    process.exitCode = 1;
  } finally {
    proc.kill("SIGTERM");
  }
})();
