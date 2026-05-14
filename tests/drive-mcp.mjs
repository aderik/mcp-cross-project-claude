// Drive the bridge's MCP stdio interface as a minimal client.
// Sends initialize, then tools/call ask_cross_project with the question.
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_DIR = process.env.REPO_DIR ?? resolve(__dirname, "..");
const WORKDIR = process.env.WORKDIR ?? "/tmp/e2e-bridge";

const [, , question] = process.argv;
if (!question) {
  console.error("usage: drive-mcp.mjs <question>");
  process.exit(2);
}

const TOOL_NAME = "ask_cross_project";

// Identity (label, peer) lives in STATE_DIR. The bridge uses cwd as
// project dir, so we run it from BRIDGE_CWD.
const BRIDGE_CWD = process.env.BRIDGE_CWD ?? `${WORKDIR}/project-b`;
const env = {
  ...process.env,
  STATE_DIR: process.env.BRIDGE_STATE_DIR ?? `${WORKDIR}/state-b`,
  LISTEN_PORT: process.env.BRIDGE_LISTEN_PORT ?? "53992",
  PEER_HOST: process.env.BRIDGE_PEER_HOST ?? "127.0.0.1",
  PEER_PORT: process.env.BRIDGE_PEER_PORT ?? "53991",
  NO_MDNS: "1",
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

(async () => {
  try {
    await send("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "e2e-driver", version: "1.0" },
    });
    notify("notifications/initialized");
    const tools = await send("tools/list", {});
    console.error("tools:", JSON.stringify(tools.tools.map((t) => t.name)));
    const result = await send("tools/call", { name: TOOL_NAME, arguments: { question } });
    console.log("=== ANSWER ===");
    console.log(JSON.stringify(result, null, 2));
  } catch (err) {
    console.error("DRIVER ERROR:", err.message);
    process.exitCode = 1;
  } finally {
    proc.kill("SIGTERM");
  }
})();
