import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { createServer, createConnection } from "node:net";
import { randomUUID } from "node:crypto";
import { existsSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { advertise, findPeerByLabel, SERVICE_TYPE_SESSION, shutdownMdns } from "./mdns.js";
import { findPeerByLabel as findPairedPeerByLabel, findPeerByPublicKey, ourKeypair } from "./state.js";
import { FramedSocket, sessionInitiator, sessionResponder } from "./transport.js";
import type { AskRequest, AskResponse, SecureChannel } from "./transport.js";
import { resolvePosture, runClaudeQuestion } from "./engine.js";
import { fingerprint, log } from "./util.js";

interface ServeConfig {
  projectDir: string;
  projectLabel: string;
  toolName: string;
  peerLabel: string;
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
}

function readConfig(): ServeConfig {
  const required = (name: string): string => {
    const v = process.env[name];
    if (!v || v.length === 0) throw new Error(`${name} env var is required`);
    return v;
  };
  const PROJECT_DIR = resolve(required("PROJECT_DIR"));
  if (!existsSync(PROJECT_DIR) || !statSync(PROJECT_DIR).isDirectory()) {
    throw new Error(`PROJECT_DIR does not exist or is not a directory: ${PROJECT_DIR}`);
  }
  return {
    projectDir: PROJECT_DIR,
    projectLabel: required("PROJECT_LABEL"),
    toolName: process.env.TOOL_NAME ?? "ask_peer",
    peerLabel: required("PEER_LABEL"),
    listenPort: Number(process.env.LISTEN_PORT ?? 0),
    listenHost: process.env.LISTEN_HOST ?? "0.0.0.0",
    useMdns: process.env.NO_MDNS !== "1",
    peerHost: process.env.PEER_HOST,
    peerPort: process.env.PEER_PORT ? Number(process.env.PEER_PORT) : undefined,
    sessionTimeoutMs: Number(process.env.SESSION_TIMEOUT_MS ?? 30_000),
    claudeTimeoutMs: Number(process.env.CLAUDE_TIMEOUT_MS ?? process.env.TIMEOUT_MS ?? 180_000),
    claudeBin: process.env.CLAUDE_BIN ?? "claude",
    allowedTools: process.env.ALLOWED_TOOLS ?? "Read,Grep,Glob",
    model: process.env.MODEL,
    maxBudgetUsd: process.env.MAX_BUDGET_USD,
    depth: Number(process.env.CROSS_PROJECT_BRIDGE_DEPTH ?? 0),
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

  const { posture, source: postureSource } = resolvePosture();
  const kp = ourKeypair();
  const ourFp = fingerprint(kp.publicKey);

  // ---------- TCP listener (incoming peer questions) ----------
  const tcpServer = createServer();
  tcpServer.on("connection", (socket) => {
    handleIncoming(socket, cfg, posture).catch((err) => {
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
        label: cfg.projectLabel,
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
      name: `cross-project-claude:${cfg.projectLabel}`,
      version: "0.2.0",
    },
    { capabilities: { tools: {} } }
  );

  mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: cfg.toolName,
        description:
          `Ask a question to a read-only Claude Code agent running on a peer machine that hosts ` +
          `the "${cfg.peerLabel}" project. The peer answers in text only; it can read its own ` +
          `project files but cannot modify them, and cannot see anything in this project. Use ` +
          `this to gather factual context from the other side of a migration without pulling ` +
          `that project's source into the current conversation. Be specific in your question.`,
        inputSchema: {
          type: "object",
          properties: {
            question: {
              type: "string",
              description: "The question to ask the peer. Self-contained and specific.",
            },
          },
          required: ["question"],
          additionalProperties: false,
        },
      },
    ],
  }));

  mcp.setRequestHandler(CallToolRequestSchema, async (request) => {
    if (request.params.name !== cfg.toolName) {
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
    `ready. project=${cfg.projectLabel} dir=${cfg.projectDir} tool=${cfg.toolName} ` +
      `peer=${cfg.peerLabel} listen=${addr.address}:${actualPort} fp=${ourFp} ` +
      `mdns=${cfg.useMdns ? "on" : "off"} posture=${postureSource} ` +
      `allowedTools=[${cfg.allowedTools}] depth=${cfg.depth}`
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
  posture: string | null
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
  // Authenticate: peer's revealed static must be in our paired-peers list.
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
    const answer = await runClaudeQuestion(req.question, {
      projectDir: cfg.projectDir,
      posture,
      allowedTools: cfg.allowedTools,
      timeoutMs: cfg.claudeTimeoutMs,
      claudeBin: cfg.claudeBin,
      model: cfg.model,
      maxBudgetUsd: cfg.maxBudgetUsd,
      depth: cfg.depth,
    });
    resp = { type: "ok", id: req.id, answer };
    log("info", `[${peer.label}] a=${req.id} (${answer.length} chars)`);
  } catch (err) {
    resp = { type: "err", id: req.id, message: (err as Error).message };
    log("warn", `[${peer.label}] error answering ${req.id}: ${resp.message}`);
  }
  channel.send(Buffer.from(JSON.stringify(resp), "utf8"));
  channel.close();
}

// ---------- Outgoing: local AI asked us, we ask the peer ----------

async function askPeer(question: string, cfg: ServeConfig): Promise<string> {
  const peer = findPairedPeerByLabel(cfg.peerLabel);
  if (!peer) {
    throw new Error(
      `No paired peer with label "${cfg.peerLabel}". Run pair-send/pair-receive on both ends first.`
    );
  }
  let host = cfg.peerHost;
  let port = cfg.peerPort;
  if (!host || !port) {
    if (!cfg.useMdns) {
      throw new Error("No PEER_HOST/PEER_PORT set and mDNS disabled — cannot route question");
    }
    const discovered = await findPeerByLabel(SERVICE_TYPE_SESSION, cfg.peerLabel, 5_000);
    host = discovered.addresses[0] ?? discovered.host;
    port = discovered.port;
    if (discovered.fingerprint !== peer.fingerprint) {
      throw new Error(
        `mDNS advertisement for "${cfg.peerLabel}" has fingerprint ${discovered.fingerprint} ` +
          `but the paired peer has fingerprint ${peer.fingerprint}. Refusing to connect — ` +
          `another machine may be claiming this label.`
      );
    }
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
    asker_label: cfg.projectLabel,
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
