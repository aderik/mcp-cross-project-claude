import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { createServer } from "node:net";
import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import { advertise, findPeerByFingerprint, localIPv4s, SERVICE_TYPE_SESSION, shutdownMdns } from "./mdns.js";
import {
  clearPairedPeer,
  findPeerByPublicKey,
  getPairedPeer,
  ourKeypair,
  ourLabel,
  updatePairedPeerLastSeen,
} from "./state.js";
import { FramedSocket, sessionInitiator, sessionResponder } from "./transport.js";
import type {
  AnswerFrame,
  AskRequest,
  InboundRequest,
  PongResponse,
  ProgressFrame,
  SecureChannel,
  TerminalFrame,
} from "./transport.js";
import { defaultLogFile, runClaudeQuestion } from "./engine.js";
import { Semaphore } from "./semaphore.js";
import { fingerprint, log, tryConnect } from "./util.js";
import { AlreadyPairedError, runPairSend, startPairReceive } from "./pair.js";
import type { PairReceiveSession } from "./pair.js";

export const TOOL_ASK = "ask_cross_project";
export const TOOL_START_PAIRING = "start_pairing";
export const TOOL_COMPLETE_PAIRING = "complete_pairing";
export const TOOL_UNPAIR = "unpair_peer";
export const TOOL_PEER_STATUS = "peer_status";
export const TOOL_PING_PEER = "ping_peer";

export const BRIDGE_VERSION = "0.4.4";

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
  /** Upper bound (ms) that an asker-requested timeout can request from us. */
  maxClaudeTimeoutMs: number;
  claudeBin: string;
  allowedTools: string;
  model?: string;
  maxBudgetUsd?: string;
  depth: number;
  maxConcurrent: number;
  logFile: string;
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
    claudeTimeoutMs: Number(process.env.CLAUDE_TIMEOUT_MS ?? 1_800_000),
    maxClaudeTimeoutMs: Number(process.env.MAX_CLAUDE_TIMEOUT_MS ?? 3_600_000),
    claudeBin: process.env.CLAUDE_BIN ?? "claude",
    allowedTools: process.env.ALLOWED_TOOLS ?? "Read,Grep,Glob",
    model: process.env.MODEL,
    maxBudgetUsd: process.env.MAX_BUDGET_USD,
    depth: Number(process.env.CROSS_PROJECT_BRIDGE_DEPTH ?? 0),
    maxConcurrent: Math.max(1, Number(process.env.MAX_CONCURRENT_QUESTIONS ?? 3)),
    logFile: process.env.LOG_FILE && process.env.LOG_FILE.length > 0 ? process.env.LOG_FILE : defaultLogFile(),
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
      version: BRIDGE_VERSION,
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
          `current conversation. Be specific in your question. For deep / domain-knowledge ` +
          `queries that may take many minutes, pass a higher \`timeout_ms\`.`,
        inputSchema: {
          type: "object",
          properties: {
            question: { type: "string", description: "Self-contained, specific question." },
            timeout_ms: {
              type: "number",
              description:
                "Optional override (milliseconds) for the spawned claude -p on the peer. " +
                "Receiver clamps to its own safety max. Use higher values for deep, multi-file " +
                "domain questions; lower for quick lookups.",
            },
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
          `Return this bridge's identity (label, fingerprint, version, hostname, LAN IPs, ` +
          `listen port, mDNS state) and the paired peer if any. Useful to check whether ` +
          `pairing is set up and to gather diagnostic info before troubleshooting.`,
        inputSchema: { type: "object", properties: {}, additionalProperties: false },
      },
      {
        name: TOOL_PING_PEER,
        description:
          `Quick liveness check: open an encrypted session to the paired peer and exchange ` +
          `a ping/pong frame (no claude-p spawn, no API cost). Returns peer label, ` +
          `fingerprint, version, and round-trip latency. Errors if peer is unreachable, ` +
          `the handshake fails, or no peer is paired.`,
        inputSchema: { type: "object", properties: {}, additionalProperties: false },
      },
    ],
  }));

  mcp.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    const name = request.params.name;
    const args = request.params.arguments ?? {};
    try {
      if (name === TOOL_ASK) {
        const question = (args as { question?: unknown }).question;
        if (typeof question !== "string" || !question.trim()) {
          return errOut("`question` must be a non-empty string.");
        }
        const reqTimeout = (args as { timeout_ms?: unknown }).timeout_ms;
        const timeoutMs = typeof reqTimeout === "number" && reqTimeout > 0 ? reqTimeout : undefined;
        const progressToken = extra._meta?.progressToken;
        const sendProgress =
          progressToken !== undefined
            ? async (progress: number, message: string): Promise<void> => {
                try {
                  await extra.sendNotification({
                    method: "notifications/progress",
                    params: { progressToken, progress, message },
                  });
                } catch {
                  // notifications are best-effort
                }
              }
            : undefined;
        const answer = await askPeer(question, cfg, { timeoutMs, sendProgress });
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
              our_version: BRIDGE_VERSION,
              our_hostname: hostname(),
              our_ipv4: localIPv4s(),
              our_listen_port: actualPort,
              our_mdns: cfg.useMdns,
              paired: peer
                ? {
                    label: peer.label,
                    fingerprint: peer.fingerprint,
                    paired_at: peer.pairedAt,
                    peer_version: peer.peerVersion ?? "(unknown — run ping_peer)",
                    last_seen_at: peer.lastSeenAt ?? "(never)",
                  }
                : null,
              pairing_in_progress: pendingPair !== null,
            },
            null,
            2
          )
        );
      }
      if (name === TOOL_PING_PEER) {
        const result = await pingPeer(cfg);
        return okOut(JSON.stringify(result, null, 2));
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
      `maxConcurrent=${cfg.maxConcurrent} log=${cfg.logFile} depth=${cfg.depth}`
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
  let req: InboundRequest;
  try {
    req = JSON.parse(reqRaw.toString("utf8")) as InboundRequest;
    if (req.type === "ping") {
      // Liveness check — answer with our identity + version, no claude-p spawn.
      const pong: PongResponse = {
        type: "pong",
        id: req.id,
        label: ourLabel(),
        fingerprint: fingerprint(ourKeypair().publicKey),
        version: BRIDGE_VERSION,
      };
      channel.send(Buffer.from(JSON.stringify(pong), "utf8"));
      channel.close();
      log("info", `[${peer.label}] ping ok`);
      return;
    }
    if (req.type !== "ask" || typeof req.question !== "string") {
      throw new Error("Malformed request");
    }
  } catch (err) {
    log("warn", `Bad request from ${peer.label}: ${(err as Error).message}`);
    channel.close();
    return;
  }
  log("info", `[${peer.label}] q=${req.id} (${req.question.slice(0, 80).replace(/\s+/g, " ")}${req.question.length > 80 ? "…" : ""})`);

  // Pick the effective claude-p timeout: asker's request if provided, capped
  // by our local safety bound. Otherwise our own configured default.
  const requested = typeof req.timeout_ms === "number" && req.timeout_ms > 0 ? req.timeout_ms : undefined;
  const effectiveTimeout = Math.min(requested ?? cfg.claudeTimeoutMs, cfg.maxClaudeTimeoutMs);

  // If the asker opted in, stream progress frames over the same channel.
  let progressSeq = 0;
  const wantsProgress = req.wants_progress === true;
  const onEvent = wantsProgress
    ? (summary: string, elapsedMs: number): void => {
        const frame: ProgressFrame = {
          type: "progress",
          id: req.id,
          seq: ++progressSeq,
          message: summary,
          elapsed_ms: elapsedMs,
        };
        try {
          channel.send(Buffer.from(JSON.stringify(frame), "utf8"));
        } catch (err) {
          log("warn", `[${peer.label}] failed to send progress: ${(err as Error).message}`);
        }
      }
    : undefined;

  let resp: TerminalFrame;
  try {
    await semaphore.acquire(cfg.sessionTimeoutMs);
    try {
      const answer = await runClaudeQuestion(req.question, {
        projectDir: cfg.projectDir,
        allowedTools: cfg.allowedTools,
        timeoutMs: effectiveTimeout,
        claudeBin: cfg.claudeBin,
        model: cfg.model,
        maxBudgetUsd: cfg.maxBudgetUsd,
        depth: cfg.depth,
        logFile: cfg.logFile,
        peerLabel: peer.label,
        questionId: req.id,
        onEvent,
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

// ---------- Outgoing: ping the paired peer ----------

async function pingPeer(cfg: ServeConfig): Promise<{
  peer_label: string;
  peer_fingerprint: string;
  peer_version: string;
  latency_ms: number;
  remote_host: string;
  remote_port: number;
  discovery: "fixed" | "mdns";
}> {
  const peer = getPairedPeer();
  if (!peer) {
    throw new Error("No paired peer. Use start_pairing / complete_pairing first.");
  }
  let candidates: string[];
  let port: number;
  let discovery: "fixed" | "mdns";
  if (cfg.peerHost && cfg.peerPort) {
    candidates = [cfg.peerHost];
    port = cfg.peerPort;
    discovery = "fixed";
  } else {
    if (!cfg.useMdns) {
      throw new Error("No PEER_HOST/PEER_PORT set and mDNS disabled — cannot route ping.");
    }
    const discovered = await findPeerByFingerprint(SERVICE_TYPE_SESSION, peer.fingerprint, 5_000);
    candidates = discovered.addresses.length > 0 ? discovered.addresses : [discovered.host];
    port = discovered.port;
    discovery = "mdns";
  }
  const start = Date.now();
  const socket = await tryConnect(candidates, port);
  const framed = new FramedSocket(socket);
  const kp = ourKeypair();
  const peerStatic = Buffer.from(peer.publicKey, "base64");
  const channel = await sessionInitiator(framed, kp, peerStatic, cfg.sessionTimeoutMs);
  try {
    const id = randomUUID();
    channel.send(Buffer.from(JSON.stringify({ type: "ping", id }), "utf8"));
    const raw = await channel.recv(cfg.sessionTimeoutMs);
    const pong = JSON.parse(raw.toString("utf8")) as PongResponse;
    if (pong.type !== "pong" || pong.id !== id) {
      throw new Error("Peer returned malformed pong");
    }
    const latency = Date.now() - start;
    updatePairedPeerLastSeen(pong.version);
    const remoteHost =
      (socket.remoteAddress ?? "").startsWith("::ffff:")
        ? (socket.remoteAddress ?? "").slice(7)
        : socket.remoteAddress ?? "?";
    return {
      peer_label: pong.label,
      peer_fingerprint: pong.fingerprint,
      peer_version: pong.version,
      latency_ms: latency,
      remote_host: remoteHost,
      remote_port: socket.remotePort ?? port,
      discovery,
    };
  } finally {
    channel.close();
  }
}

// ---------- Outgoing: local AI asked us, we ask the peer ----------

async function askPeer(
  question: string,
  cfg: ServeConfig,
  opts: {
    timeoutMs?: number;
    sendProgress?: (progress: number, message: string) => Promise<void>;
  }
): Promise<string> {
  const peer = getPairedPeer();
  if (!peer) {
    throw new Error("No paired peer. Use start_pairing on one side and complete_pairing on the other.");
  }
  let candidates: string[];
  let port: number;
  if (cfg.peerHost && cfg.peerPort) {
    candidates = [cfg.peerHost];
    port = cfg.peerPort;
  } else {
    if (!cfg.useMdns) {
      throw new Error("No PEER_HOST/PEER_PORT set and mDNS disabled — cannot route question.");
    }
    const discovered = await findPeerByFingerprint(SERVICE_TYPE_SESSION, peer.fingerprint, 5_000);
    candidates =
      discovered.addresses.length > 0 ? discovered.addresses : [discovered.host];
    port = discovered.port;
  }
  const socket = await tryConnect(candidates, port);
  const framed = new FramedSocket(socket);
  const kp = ourKeypair();
  const peerStatic = Buffer.from(peer.publicKey, "base64");
  const channel = await sessionInitiator(framed, kp, peerStatic, cfg.sessionTimeoutMs);

  const effectiveTimeout = opts.timeoutMs ?? cfg.claudeTimeoutMs;
  const wantsProgress = !!opts.sendProgress;

  const req: AskRequest = {
    type: "ask",
    id: randomUUID(),
    question,
    timeout_ms: opts.timeoutMs,
    wants_progress: wantsProgress,
  };
  channel.send(Buffer.from(JSON.stringify(req), "utf8"));

  // Read frames in a loop until a terminal (ok/err) frame arrives. Progress
  // frames are forwarded as MCP notifications. Total wait is bounded by
  // sessionTimeoutMs + effectiveTimeout — the same overall ceiling as before.
  const deadline = Date.now() + cfg.sessionTimeoutMs + effectiveTimeout;
  try {
    while (true) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        throw new Error(
          `Peer did not produce a final answer within ${cfg.sessionTimeoutMs + effectiveTimeout}ms`
        );
      }
      const frameRaw = await channel.recv(remaining);
      const frame = JSON.parse(frameRaw.toString("utf8")) as AnswerFrame;
      if (frame.type === "progress") {
        if (opts.sendProgress) {
          await opts.sendProgress(frame.seq, frame.message);
        }
        continue;
      }
      if (frame.type === "err") {
        throw new Error(`Peer answered with error: ${frame.message}`);
      }
      if (frame.type === "ok") {
        return frame.answer;
      }
      throw new Error(`Unknown frame type from peer: ${(frame as { type?: string }).type}`);
    }
  } finally {
    channel.close();
  }
}
