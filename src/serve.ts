import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { createServer, createConnection } from "node:net";
import { randomUUID } from "node:crypto";
import { advertise, findPeerByFingerprint, SERVICE_TYPE_SESSION, shutdownMdns } from "./mdns.js";
import {
  clearPairedPeer,
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
import { AlreadyPairedError, runPairSend, startPairReceive } from "./pair.js";
import type { PairReceiveSession } from "./pair.js";

export const TOOL_ASK = "ask_cross_project";
export const TOOL_START_PAIRING = "start_pairing";
export const TOOL_COMPLETE_PAIRING = "complete_pairing";
export const TOOL_UNPAIR = "unpair_peer";
export const TOOL_PEER_STATUS = "peer_status";

interface ServeConfig {
  projectDir: string;
  listenPort: number;
  listenHost: string;
  useMdns: boolean;
  peerHost?: string;
  peerPort?: number;
  pairHost?: string;
  pairPort?: number;
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
    // Internal test-only overrides: bypass mDNS during pair-send.
    pairHost: process.env.BRIDGE_PAIR_HOST,
    pairPort: process.env.BRIDGE_PAIR_PORT ? Number(process.env.BRIDGE_PAIR_PORT) : undefined,
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
  const ourFp = fingerprint(kp.publicKey);
  const semaphore = new Semaphore(cfg.maxConcurrent);
  let pendingPair: PairReceiveSession | null = null;

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
        label: ourLabel(),
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
      name: `cross-project-claude:${ourLabel()}`,
      version: "0.4.0",
    },
    { capabilities: { tools: {} } }
  );

  mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: TOOL_ASK,
        description:
          `Ask a question to a read-only Claude Code agent running in a paired project ` +
          `on another machine. The agent can read its own project files and answer in text, ` +
          `but cannot modify them and cannot see anything in this project. Use this to ` +
          `gather factual context from another project without pulling its source into the ` +
          `current conversation. Be specific in your question.`,
        inputSchema: {
          type: "object",
          properties: {
            question: { type: "string", description: "Self-contained, specific question." },
          },
          required: ["question"],
          additionalProperties: false,
        },
      },
      {
        name: TOOL_START_PAIRING,
        description:
          `Put this bridge into pairing mode and return a 4-digit PIN. Read the PIN to the ` +
          `user and tell them to give it to the AI on the other machine, which will call ` +
          `complete_pairing(pin). The pairing window is 60 seconds and accepts one attempt. ` +
          `Refuses if a peer is already paired (call unpair_peer first).`,
        inputSchema: { type: "object", properties: {}, additionalProperties: false },
      },
      {
        name: TOOL_COMPLETE_PAIRING,
        description:
          `Complete pairing using a PIN obtained from the other machine's start_pairing call. ` +
          `Auto-discovers the peer on the LAN via mDNS. The PIN is the only input needed. ` +
          `Refuses if this bridge is already paired.`,
        inputSchema: {
          type: "object",
          properties: {
            pin: { type: "string", description: "The 4-digit PIN from the other side's start_pairing." },
          },
          required: ["pin"],
          additionalProperties: false,
        },
      },
      {
        name: TOOL_UNPAIR,
        description:
          `Forget the currently paired peer. After this, ask_cross_project will fail until a ` +
          `new pairing is completed. Run before re-pairing if a peer was already set.`,
        inputSchema: { type: "object", properties: {}, additionalProperties: false },
      },
      {
        name: TOOL_PEER_STATUS,
        description:
          `Return this bridge's identity and the paired peer (if any). Useful to check ` +
          `whether pairing is set up before asking a cross-project question.`,
        inputSchema: { type: "object", properties: {}, additionalProperties: false },
      },
    ],
  }));

  mcp.setRequestHandler(CallToolRequestSchema, async (request) => {
    const name = request.params.name;
    const args = request.params.arguments ?? {};
    try {
      if (name === TOOL_ASK) {
        const question = (args as { question?: unknown }).question;
        if (typeof question !== "string" || !question.trim()) {
          return errOut("`question` must be a non-empty string.");
        }
        const answer = await askPeer(question, cfg);
        return okOut(answer);
      }
      if (name === TOOL_START_PAIRING) {
        if (pendingPair) {
          pendingPair.cancel();
          pendingPair = null;
        }
        const session = await startPairReceive({ useMdns: cfg.useMdns });
        pendingPair = session;
        session.completion.then(
          (peer) => {
            log("info", `pairing succeeded: peer=${peer.label} fp=${peer.fingerprint}`);
            pendingPair = null;
          },
          (err: Error) => {
            log("warn", `pairing did not complete: ${err.message}`);
            pendingPair = null;
          }
        );
        return okOut(
          JSON.stringify(
            {
              pin: session.pin,
              expires_in_seconds: 60,
              host: session.host,
              port: session.port,
              note:
                "Tell the user this PIN. On the other machine, the user asks their Claude to " +
                "complete_pairing with this PIN.",
            },
            null,
            2
          )
        );
      }
      if (name === TOOL_COMPLETE_PAIRING) {
        const pin = (args as { pin?: unknown }).pin;
        if (typeof pin !== "string" || !pin.trim()) {
          return errOut("`pin` must be a non-empty string.");
        }
        const peer = await runPairSend({
          pin: pin.trim(),
          useMdns: cfg.useMdns,
          host: cfg.pairHost,
          port: cfg.pairPort,
        });
        return okOut(
          JSON.stringify(
            {
              paired: true,
              peer_label: peer.label,
              peer_fingerprint: peer.fingerprint,
            },
            null,
            2
          )
        );
      }
      if (name === TOOL_UNPAIR) {
        if (pendingPair) {
          pendingPair.cancel();
          pendingPair = null;
        }
        const removed = clearPairedPeer();
        return okOut(removed ? "Unpaired." : "No paired peer to remove.");
      }
      if (name === TOOL_PEER_STATUS) {
        const peer = getPairedPeer();
        return okOut(
          JSON.stringify(
            {
              our_label: ourLabel(),
              our_fingerprint: ourFp,
              paired: peer
                ? {
                    label: peer.label,
                    fingerprint: peer.fingerprint,
                    paired_at: peer.pairedAt,
                  }
                : null,
              pairing_in_progress: pendingPair !== null,
            },
            null,
            2
          )
        );
      }
      return errOut(`Unknown tool: ${name}`);
    } catch (err) {
      if (err instanceof AlreadyPairedError) {
        return errOut(err.message);
      }
      return errOut(err instanceof Error ? err.message : String(err));
    }
  });

  const stdioTransport = new StdioServerTransport();
  await mcp.connect(stdioTransport);

  log(
    "info",
    `ready. label=${ourLabel()} cwd=${cfg.projectDir} ` +
      `peer=${getPairedPeer() ? `${getPairedPeer()!.label} (fp=${getPairedPeer()!.fingerprint})` : "(unpaired)"} ` +
      `listen=${addr.address}:${actualPort} fp=${ourFp} ` +
      `mdns=${cfg.useMdns ? "on" : "off"} allowedTools=[${cfg.allowedTools}] ` +
      `maxConcurrent=${cfg.maxConcurrent} depth=${cfg.depth}`
  );

  const shutdown = (): void => {
    if (pendingPair) pendingPair.cancel();
    if (advert) advert.stop();
    shutdownMdns();
    tcpServer.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

function okOut(text: string): { content: Array<{ type: "text"; text: string }>; isError?: false } {
  return { content: [{ type: "text", text }] };
}
function errOut(message: string): { content: Array<{ type: "text"; text: string }>; isError: true } {
  return { content: [{ type: "text", text: message }], isError: true };
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
    throw new Error("No paired peer. Use start_pairing on one side and complete_pairing on the other.");
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
  const req: AskRequest = { type: "ask", id: randomUUID(), question };
  channel.send(Buffer.from(JSON.stringify(req), "utf8"));
  const respRaw = await channel.recv(cfg.sessionTimeoutMs + cfg.claudeTimeoutMs);
  channel.close();
  const resp = JSON.parse(respRaw.toString("utf8")) as AskResponse;
  if (resp.type === "err") {
    throw new Error(`Peer answered with error: ${resp.message}`);
  }
  return resp.answer;
}
