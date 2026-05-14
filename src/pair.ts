import { createServer, createConnection } from "node:net";
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { getPairedPeer, ourKeypair, ourLabel, setPairedPeer } from "./state.js";
import { advertise, findPeerByLabel, SERVICE_TYPE_PAIR } from "./mdns.js";
import { FramedSocket, pairInitiator, pairResponder } from "./transport.js";
import { fingerprint, log, pinToPsk, randomPin } from "./util.js";

const PAIR_HANDSHAKE_TIMEOUT_MS = 10_000;
const PAIR_WINDOW_MS = 60_000;

function refuseIfAlreadyPaired(): void {
  const existing = getPairedPeer();
  if (existing) {
    throw new Error(
      `Already paired with "${existing.label}" (fp=${existing.fingerprint}). Run \`unpair\` first.`
    );
  }
}

/**
 * Receiver: shows a one-time PIN and waits for one pairing attempt. On
 * success, persists the peer. Single-use PIN; the window closes after the
 * first attempt regardless of outcome.
 */
export async function pairReceive(opts: { useMdns: boolean; bindHost?: string }): Promise<void> {
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
    throw new Error("Failed to bind pairing listener");
  }
  const port = addr.port;

  let advert: { stop: () => void } | null = null;
  if (opts.useMdns) {
    try {
      advert = advertise({
        serviceType: SERVICE_TYPE_PAIR,
        label,
        fingerprint: ourFp,
        port,
      });
    } catch (err) {
      log("warn", `mDNS advertise failed (continuing without): ${(err as Error).message}`);
    }
  }

  console.log("");
  console.log("=========================================================");
  console.log(`  Pairing PIN:  ${pin}`);
  console.log("=========================================================");
  console.log(`  Our label:    ${label}`);
  console.log(`  Our fp:       ${ourFp}`);
  console.log(`  Listening:    ${addr.address}:${port}`);
  console.log(`  mDNS:         ${opts.useMdns ? `_${SERVICE_TYPE_PAIR}._tcp.local` : "disabled"}`);
  console.log(`  Window:       ${PAIR_WINDOW_MS / 1000}s (single attempt)`);
  console.log("");
  console.log("On the OTHER machine, run:");
  console.log(`  npx -y mcp-cross-project-claude pair-send --peer-label ${label} --pin ${pin}`);
  console.log("");

  let attempted = false;
  const done = new Promise<void>((resolveP, rejectP) => {
    const overallTimer = setTimeout(() => {
      cleanup();
      rejectP(new Error("Pairing window expired (no peer attempted within 60s)"));
    }, PAIR_WINDOW_MS);

    const cleanup = (): void => {
      clearTimeout(overallTimer);
      server.close();
      if (advert) advert.stop();
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
        console.log("");
        console.log("Pairing succeeded.");
        console.log(`  Peer label:        ${peerEntry.label}`);
        console.log(`  Peer fingerprint:  ${peerEntry.fingerprint}`);
        resolveP();
      } catch (err) {
        socket.destroy();
        cleanup();
        rejectP(new Error(`Pairing failed: ${(err as Error).message}`));
      }
    });
  });

  await done;
}

/**
 * Sender: discovers the receiver (or connects to --host/--port), runs the
 * XXpsk0 handshake with PIN-derived PSK, persists the peer on success.
 * Hard-errors if the receiver claims a different label than --peer-label.
 */
export async function pairSend(opts: {
  peerLabel: string;
  pin?: string;
  host?: string;
  port?: number;
  useMdns: boolean;
}): Promise<void> {
  refuseIfAlreadyPaired();
  const label = ourLabel();

  let host = opts.host;
  let port = opts.port;
  if (!host || !port) {
    if (!opts.useMdns) {
      throw new Error("Without mDNS, --host and --port are required");
    }
    const peer = await findPeerByLabel(SERVICE_TYPE_PAIR, opts.peerLabel, 10_000);
    host = peer.addresses[0] ?? peer.host;
    port = peer.port;
    console.log(`Discovered peer "${peer.label}" at ${host}:${port} (fp=${peer.fingerprint})`);
  }

  let pin = opts.pin;
  if (!pin) {
    const rl = createInterface({ input: stdin, output: stdout });
    pin = (await rl.question("Enter pairing PIN (4 digits): ")).trim();
    rl.close();
  }
  if (!/^\d{4}$/.test(pin)) {
    throw new Error("PIN must be exactly 4 digits");
  }
  const psk = pinToPsk(pin);
  const kp = ourKeypair();

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
    throw new Error("Peer sent invalid label payload");
  }
  if (peerPayload.label !== opts.peerLabel) {
    channel.close();
    throw new Error(
      `Label mismatch: expected "${opts.peerLabel}" but the peer at ${host}:${port} ` +
        `identifies as "${peerPayload.label}". Refusing to pair — another machine may ` +
        `be impersonating the label.`
    );
  }
  const peerEntry = setPairedPeer(peerPayload.label, channel.remoteStatic);
  channel.close();
  console.log("");
  console.log("Pairing succeeded.");
  console.log(`  Peer label:        ${peerEntry.label}`);
  console.log(`  Peer fingerprint:  ${peerEntry.fingerprint}`);
}
