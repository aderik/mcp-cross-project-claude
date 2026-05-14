import { createConnection, createServer } from "node:net";
import { getPairedPeer, ourKeypair, ourLabel, setPairedPeer } from "./state.js";
import type { PairedPeer } from "./state.js";
import { advertise, findAnyPeer, SERVICE_TYPE_PAIR } from "./mdns.js";
import { FramedSocket, pairInitiator, pairResponder } from "./transport.js";
import { fingerprint, pinToPsk, randomPin } from "./util.js";

const PAIR_HANDSHAKE_TIMEOUT_MS = 10_000;
const PAIR_WINDOW_MS = 60_000;

export class AlreadyPairedError extends Error {
  constructor(public readonly peer: PairedPeer) {
    super(
      `Already paired with "${peer.label}" (fp=${peer.fingerprint}). ` +
        `Call unpair_peer first.`
    );
    this.name = "AlreadyPairedError";
  }
}

function refuseIfAlreadyPaired(): void {
  const existing = getPairedPeer();
  if (existing) throw new AlreadyPairedError(existing);
}

export interface PairReceiveSession {
  pin: string;
  label: string;
  host: string;
  port: number;
  expiresAt: Date;
  /** Resolves when pairing completes; rejects on timeout or handshake error. */
  completion: Promise<PairedPeer>;
  /** Cancel the session early. Safe to call after completion. */
  cancel(): void;
}

/**
 * Opens a pairing listener (single-use, 60s window) and returns immediately
 * with a session handle. The handshake runs in the background; await
 * `session.completion` to know the outcome.
 */
export async function startPairReceive(opts: {
  useMdns: boolean;
  bindHost?: string;
}): Promise<PairReceiveSession> {
  refuseIfAlreadyPaired();
  const label = ourLabel();
  const pin = randomPin();
  const psk = pinToPsk(pin);
  const kp = ourKeypair();
  const ourFp = fingerprint(kp.publicKey);

  const server = createServer();
  await new Promise<void>((res) => {
    server.listen({ port: 0, host: opts.bindHost ?? "0.0.0.0" }, res);
  });
  const addr = server.address();
  if (!addr || typeof addr === "string") {
    server.close();
    throw new Error("Failed to bind pairing listener");
  }
  const port = addr.port;
  const host = addr.address;

  let advert: { stop: () => void } | null = null;
  if (opts.useMdns) {
    try {
      advert = advertise({
        serviceType: SERVICE_TYPE_PAIR,
        label,
        fingerprint: ourFp,
        port,
      });
    } catch {
      // mDNS failure here means the asker likely can't discover us either.
      // Pairing will time out cleanly via the 60s window.
    }
  }

  let attempted = false;
  let externalCancel: (() => void) | null = null;

  const completion = new Promise<PairedPeer>((resolveP, rejectP) => {
    const overallTimer = setTimeout(() => {
      cleanup();
      rejectP(new Error("Pairing window expired (no peer attempted within 60s)"));
    }, PAIR_WINDOW_MS);

    const cleanup = (): void => {
      clearTimeout(overallTimer);
      try {
        server.close();
      } catch {
        // ignore
      }
      if (advert) advert.stop();
    };

    externalCancel = () => {
      cleanup();
      rejectP(new Error("Pairing cancelled"));
    };

    server.on("connection", async (socket) => {
      if (attempted) {
        socket.destroy();
        return;
      }
      attempted = true;
      const framed = new FramedSocket(socket);
      try {
        const channel = await pairResponder(framed, kp, psk, PAIR_HANDSHAKE_TIMEOUT_MS);
        const peerPayloadRaw = await channel.recv(PAIR_HANDSHAKE_TIMEOUT_MS);
        const peerPayload = JSON.parse(peerPayloadRaw.toString("utf8")) as { label: string };
        if (!peerPayload.label || typeof peerPayload.label !== "string") {
          throw new Error("Peer sent invalid label payload");
        }
        channel.send(Buffer.from(JSON.stringify({ label }), "utf8"));
        const peerEntry = setPairedPeer(peerPayload.label, channel.remoteStatic);
        channel.close();
        cleanup();
        resolveP(peerEntry);
      } catch (err) {
        socket.destroy();
        cleanup();
        rejectP(new Error(`Pairing failed: ${(err as Error).message}`));
      }
    });
  });

  return {
    pin,
    label,
    host,
    port,
    expiresAt: new Date(Date.now() + PAIR_WINDOW_MS),
    completion,
    cancel(): void {
      if (externalCancel) externalCancel();
    },
  };
}

/**
 * Sender side. Auto-discovers an active pair-advertisement on the LAN
 * (mDNS only — there is no host/port flag exposed to users), runs the
 * XXpsk0 handshake with the PIN-derived PSK, persists the peer on success.
 *
 * The host/port parameters are NOT exposed via the MCP tool; they exist
 * solely to let tests bypass mDNS on loopback.
 */
export async function runPairSend(opts: {
  pin: string;
  useMdns: boolean;
  host?: string;
  port?: number;
}): Promise<PairedPeer> {
  refuseIfAlreadyPaired();
  if (!/^\d{4}$/.test(opts.pin)) {
    throw new Error("PIN must be exactly 4 digits");
  }

  let host = opts.host;
  let port = opts.port;
  if (!host || !port) {
    if (!opts.useMdns) {
      throw new Error(
        "mDNS disabled and no explicit host/port. Pairing requires mDNS to find the other bridge."
      );
    }
    const discovered = await findAnyPeer(SERVICE_TYPE_PAIR, 10_000);
    host = discovered.addresses[0] ?? discovered.host;
    port = discovered.port;
  }

  const psk = pinToPsk(opts.pin);
  const kp = ourKeypair();
  const label = ourLabel();

  const socket = createConnection({ host, port });
  await new Promise<void>((res, rej) => {
    socket.once("connect", () => res());
    socket.once("error", (err) => rej(err));
  });
  const framed = new FramedSocket(socket);
  const channel = await pairInitiator(framed, kp, psk, PAIR_HANDSHAKE_TIMEOUT_MS);

  channel.send(Buffer.from(JSON.stringify({ label }), "utf8"));
  const peerPayloadRaw = await channel.recv(PAIR_HANDSHAKE_TIMEOUT_MS);
  const peerPayload = JSON.parse(peerPayloadRaw.toString("utf8")) as { label: string };
  if (!peerPayload.label || typeof peerPayload.label !== "string") {
    channel.close();
    throw new Error("Peer sent invalid label payload");
  }
  const peerEntry = setPairedPeer(peerPayload.label, channel.remoteStatic);
  channel.close();
  return peerEntry;
}
