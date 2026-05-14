import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { createServer, createConnection } from "node:net";
import { randomUUID } from "node:crypto";
import { advertise, findPeerByFingerprint, SERVICE_TYPE_SESSION, shutdownMdns } from "./mdns.js";
import {
  findPeerByPublicKey,
  getPairedPeer,
  ourKeypair,
  ourLabel,
} from "./state.js";
import { FramedSocket, sessionInitiator, sessionResponder } from "./transport.js";
import type { AskRequest, AskResponse, SecureChannel } from "./transport.js";
import { runClaudeQuestion } from "./engine.js";
import { Semaphore } from "./semaphore.js";
import { fingerprint, log } from "./util.js";

export const TOOL_NAME = "ask_cross_project";

interface ServeConfig {
  projectDir: string;
  listenPort: number;
  listenHost: string;
  useMdns: boolean;
  peerHost?: string;
  peerPort?: number;
  sessionTimeoutMs: number;
  claudeTimeoutMs: number;
  claudeBin: string;
  allowedTools: string;
  model?: string;
  maxBudgetUsd?: string;
  depth: number;
  maxConcurrent: number;
}

function readConfig(): ServeConfig {
  return {
    projectDir: process.cwd(),
    listenPort: Number(process.env.LISTEN_PORT ?? 0),
    listenHost: process.env.LISTEN_HOST ?? "0.0.0.0",
    useMdns: process.env.NO_MDNS !== "1",
    peerHost: process.env.PEER_HOST,
    peerPort: process.env.PEER_PORT ? Number(process.env.PEER_PORT) : undefined,
    sessionTimeoutMs: Number(process.env.SESSION_TIMEOUT_MS ?? 30_000),
    claudeTimeoutMs: Number(process.env.CLAUDE_TIMEOUT_MS ?? 180_000),
    claudeBin: process.env.CLAUDE_BIN ?? "claude",
    allowedTools: process.env.ALLOWED_TOOLS ?? "Read,Grep,Glob",
    model: process.env.MODEL,
    maxBudgetUsd: process.env.MAX_BUDGET_USD,
    depth: Number(process.env.CROSS_PROJECT_BRIDGE_DEPTH ?? 0),
    maxConcurrent: Math.max(1, Number(process.env.MAX_CONCURRENT_QUESTIONS ?? 3)),
  };
}

export async function serve(): Promise<void> {
  const cfg = readConfig();
  if (cfg.depth >= 1) {
    throw new Error(
      `Cross-project bridge recursion detected (CROSS_PROJECT_BRIDGE_DEPTH=${cfg.depth}). ` +
        `Refusing to start. This bridge process must not run inside a spawned claude -p session.`
    );
  }

  const kp = ourKeypair();
  const label = ourLabel();
  const ourFp = fingerprint(kp.publicKey);
  const peer = getPairedPeer();
  const semaphore = new Semaphore(cfg.maxConcurrent);

  // ---------- TCP listener (incoming peer questions) ----------
  const tcpServer = createServer();
  tcpServer.on("connection", (socket) => {
    handleIncoming(socket, cfg, semaphore).catch((err) => {
      log("warn", `Incoming session ended with error: ${(err as Error).message}`);
    });
  });
  await new Promise<void>((res) => {
    tcpServer.listen({ port: cfg.listenPort, host: cfg.listenHost }, res);
  });
  const addr = tcpServer.address();
  if (!addr || typeof addr === "string") {
    throw new Error("Failed to bind TCP listener");
  }
  const actualPort = addr.port;

  // ---------- mDNS advertise ----------
  let advert: { stop: () => void } | null = null;
  if (cfg.useMdns) {
    try {
      advert = advertise({
        serviceType: SERVICE_TYPE_SESSION,
        label,
        fingerprint: ourFp,
        port: actualPort,
      });
    } catch (err) {
      log("warn", `mDNS advertise failed (continuing without): ${(err as Error).message}`);
    }
  }

  // ---------- MCP stdio server (local AI client) ----------
  const mcp = new Server(
    {
      name: `cross-project-claude:${label}`,
      version: "0.3.0",
    },
    { capabilities: { tools: {} } }
  );

  mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: TOOL_NAME,
        description:
          `Ask a question to a read-only Claude Code agent running in a paired project on ` +
          `another machine (or another directory on this machine). The agent can read its own ` +
          `project files and answer in text, but cannot modify them and cannot see anything in ` +
          `the calling project. Use this to gather factual context from another project without ` +
          `pulling its source into the current conversation. Be specific in your question.`,
        inputSchema: {
          type: "object",
          properties: {
            question: {
              type: "string",
              description: "The question to ask the paired peer. Self-contained and specific.",
            },
          },
          required: ["question"],
          additionalProperties: false,
        },
      },
    ],
  }));

  mcp.setRequestHandler(CallToolRequestSchema, async (request) => {
    if (request.params.name !== TOOL_NAME) {
      return { content: [{ type: "text", text: `Unknown tool: ${request.params.name}` }], isError: true };
    }
    const args = request.params.arguments ?? {};
    const question = (args as { question?: unknown }).question;
    if (typeof question !== "string" || !question.trim()) {
      return { content: [{ type: "text", text: "`question` must be a non-empty string." }], isError: true };
    }
    try {
      const answer = await askPeer(question, cfg);
      return { content: [{ type: "text", text: answer }] };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { content: [{ type: "text", text: `Bridge error: ${msg}` }], isError: true };
    }
  });

  const stdioTransport = new StdioServerTransport();
  await mcp.connect(stdioTransport);

  log(
    "info",
    `ready. label=${label} cwd=${cfg.projectDir} ` +
      `peer=${peer ? `${peer.label} (fp=${peer.fingerprint})` : "(unpaired)"} ` +
      `listen=${addr.address}:${actualPort} fp=${ourFp} ` +
      `mdns=${cfg.useMdns ? "on" : "off"} allowedTools=[${cfg.allowedTools}] ` +
      `maxConcurrent=${cfg.maxConcurrent} depth=${cfg.depth}`
  );

  const shutdown = (): void => {
    if (advert) advert.stop();
    shutdownMdns();
    tcpServer.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

// ---------- Incoming: peer asks us a question ----------

async function handleIncoming(
  socket: import("node:net").Socket,
  cfg: ServeConfig,
  semaphore: Semaphore
): Promise<void> {
  const framed = new FramedSocket(socket);
  const kp = ourKeypair();
  let channel: SecureChannel;
  try {
    channel = await sessionResponder(framed, kp, cfg.sessionTimeoutMs);
  } catch (err) {
    log("warn", `Incoming handshake failed: ${(err as Error).message}`);
    socket.destroy();
    return;
  }
  const peer = findPeerByPublicKey(channel.remoteStatic);
  if (!peer) {
    log("warn", `Incoming connection from unknown public key fp=${fingerprint(channel.remoteStatic)} — closing`);
    channel.close();
    return;
  }
  let reqRaw: Buffer;
  try {
    reqRaw = await channel.recv(cfg.sessionTimeoutMs);
  } catch (err) {
    log("warn", `Failed to read request from ${peer.label}: ${(err as Error).message}`);
    channel.close();
    return;
  }
  let req: AskRequest;
  try {
    req = JSON.parse(reqRaw.toString("utf8")) as AskRequest;
    if (req.type !== "ask" || typeof req.question !== "string") {
      throw new Error("Malformed request");
    }
  } catch (err) {
    log("warn", `Bad request from ${peer.label}: ${(err as Error).message}`);
    channel.close();
    return;
  }
  log("info", `[${peer.label}] q=${req.id} (${req.question.slice(0, 80).replace(/\s+/g, " ")}${req.question.length > 80 ? "…" : ""})`);

  let resp: AskResponse;
  try {
    await semaphore.acquire(cfg.sessionTimeoutMs);
    try {
      const answer = await runClaudeQuestion(req.question, {
        projectDir: cfg.projectDir,
        allowedTools: cfg.allowedTools,
        timeoutMs: cfg.claudeTimeoutMs,
        claudeBin: cfg.claudeBin,
        model: cfg.model,
        maxBudgetUsd: cfg.maxBudgetUsd,
        depth: cfg.depth,
      });
      resp = { type: "ok", id: req.id, answer };
      log("info", `[${peer.label}] a=${req.id} (${answer.length} chars)`);
    } finally {
      semaphore.release();
    }
  } catch (err) {
    resp = { type: "err", id: req.id, message: (err as Error).message };
    log("warn", `[${peer.label}] error answering ${req.id}: ${resp.message}`);
  }
  channel.send(Buffer.from(JSON.stringify(resp), "utf8"));
  channel.close();
}

// ---------- Outgoing: local AI asked us, we ask the peer ----------

async function askPeer(question: string, cfg: ServeConfig): Promise<string> {
  const peer = getPairedPeer();
  if (!peer) {
    throw new Error("No paired peer. Run `pair-receive` on one side and `pair-send` on the other.");
  }
  let host = cfg.peerHost;
  let port = cfg.peerPort;
  if (!host || !port) {
    if (!cfg.useMdns) {
      throw new Error("No PEER_HOST/PEER_PORT set and mDNS disabled — cannot route question.");
    }
    const discovered = await findPeerByFingerprint(SERVICE_TYPE_SESSION, peer.fingerprint, 5_000);
    host = discovered.addresses[0] ?? discovered.host;
    port = discovered.port;
  }
  const socket = createConnection({ host, port });
  await new Promise<void>((res, rej) => {
    socket.once("connect", () => res());
    socket.once("error", (err) => rej(err));
  });
  const framed = new FramedSocket(socket);
  const kp = ourKeypair();
  const peerStatic = Buffer.from(peer.publicKey, "base64");
  const channel = await sessionInitiator(framed, kp, peerStatic, cfg.sessionTimeoutMs);
  const req: AskRequest = {
    type: "ask",
    id: randomUUID(),
    question,
  };
  channel.send(Buffer.from(JSON.stringify(req), "utf8"));
  const respRaw = await channel.recv(cfg.sessionTimeoutMs + cfg.claudeTimeoutMs);
  channel.close();
  const resp = JSON.parse(respRaw.toString("utf8")) as AskResponse;
  if (resp.type === "err") {
    throw new Error(`Peer answered with error: ${resp.message}`);
  }
  return resp.answer;
}
