import { createServer, createConnection } from "node:net";
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { addPeer, ourKeypair } from "./state.js";
import { advertise, findPeerByLabel, SERVICE_TYPE_PAIR } from "./mdns.js";
import { FramedSocket, pairInitiator, pairResponder } from "./transport.js";
import { log, pinToPsk, randomPin, fingerprint } from "./util.js";

const PAIR_HANDSHAKE_TIMEOUT_MS = 10_000;
const PAIR_WINDOW_MS = 60_000;
const PAIR_DEFAULT_PORT = 0; // ephemeral

/**
 * Run on the receiving side. Displays a PIN, opens a listener that accepts
 * exactly ONE pairing attempt, runs XXpsk0 handshake, on success exchanges
 * labels and persists the peer. Single-use PIN.
 */
export async function pairReceive(opts: { ourLabel: string; useMdns: boolean; bindHost?: string }): Promise<void> {
  const pin = randomPin();
  const psk = pinToPsk(pin);
  const kp = ourKeypair();
  const ourFp = fingerprint(kp.publicKey);

  const server = createServer();
  await new Promise<void>((res) => {
    server.listen({ port: PAIR_DEFAULT_PORT, host: opts.bindHost ?? "0.0.0.0" }, res);
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
        label: opts.ourLabel,
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
  console.log(`  Our label:    ${opts.ourLabel}`);
  console.log(`  Listening:    ${addr.address}:${port}`);
  console.log(`  mDNS:         ${opts.useMdns ? `_${SERVICE_TYPE_PAIR}._tcp.local` : "disabled"}`);
  console.log(`  Window:       ${PAIR_WINDOW_MS / 1000}s (single attempt)`);
  console.log("");
  console.log("On the OTHER machine, run:");
  console.log(`  npx -y @aderik/mcp-cross-project-claude pair-send ${opts.ourLabel} --pin ${pin}`);
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
        // Exchange labels over the encrypted channel.
        // Responder receives the initiator's label payload first, then sends ours.
        const peerPayloadRaw = await channel.recv(PAIR_HANDSHAKE_TIMEOUT_MS);
        const peerPayload = JSON.parse(peerPayloadRaw.toString("utf8")) as { label: string };
        if (!peerPayload.label || typeof peerPayload.label !== "string") {
          throw new Error("Peer sent invalid label payload");
        }
        channel.send(Buffer.from(JSON.stringify({ label: opts.ourLabel }), "utf8"));
        const peerEntry = addPeer(peerPayload.label, channel.remoteStatic);
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
 * Run on the sending side. Discovers the receiver via mDNS (or uses --host),
 * prompts for PIN if not provided, runs XXpsk0 as initiator, on success
 * exchanges labels and persists the peer.
 */
export async function pairSend(opts: {
  ourLabel: string;
  peerLabel: string;
  pin?: string;
  host?: string;
  port?: number;
  useMdns: boolean;
}): Promise<void> {
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

  channel.send(Buffer.from(JSON.stringify({ label: opts.ourLabel }), "utf8"));
  const peerPayloadRaw = await channel.recv(PAIR_HANDSHAKE_TIMEOUT_MS);
  const peerPayload = JSON.parse(peerPayloadRaw.toString("utf8")) as { label: string };
  if (!peerPayload.label || typeof peerPayload.label !== "string") {
    throw new Error("Peer sent invalid label payload");
  }
  if (peerPayload.label !== opts.peerLabel) {
    log("warn", `Peer claimed label "${peerPayload.label}" but we expected "${opts.peerLabel}". Using the claimed label.`);
  }
  const peerEntry = addPeer(peerPayload.label, channel.remoteStatic);
  channel.close();
  console.log("");
  console.log("Pairing succeeded.");
  console.log(`  Peer label:        ${peerEntry.label}`);
  console.log(`  Peer fingerprint:  ${peerEntry.fingerprint}`);
}
