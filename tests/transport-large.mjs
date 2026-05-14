// Test (B1): the application-layer transport handles payloads larger than
// the Noise per-cipher-message limit (65535 bytes). The 4-byte FramedSocket
// header allows a single application payload to span many Noise segments;
// SecureChannel.send/recv must transparently chunk and reassemble.
//
// We set up two SecureChannels back-to-back over loopback TCP, send a
// 1 MiB random payload from the initiator, and assert the responder
// receives exactly the same bytes. Then we round-trip a second payload in
// the reverse direction.

import { createServer, createConnection } from "node:net";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { randomBytes } from "node:crypto";
import { generateKeyPair } from "noise-handshake/dh.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_DIR = process.env.REPO_DIR ?? resolve(__dirname, "..");
const transport = await import(`${REPO_DIR}/dist/transport.js`);
const { FramedSocket, sessionInitiator, sessionResponder } = transport;

function toBuf(u8) {
  return Buffer.isBuffer(u8) ? u8 : Buffer.from(u8);
}

function toKp(raw) {
  return { publicKey: toBuf(raw.publicKey), secretKey: toBuf(raw.secretKey) };
}

const kpServer = toKp(generateKeyPair());
const kpClient = toKp(generateKeyPair());

const server = createServer();
await new Promise((res) => server.listen(0, "127.0.0.1", res));
const port = server.address().port;

const serverDone = new Promise((resolveP, rejectP) => {
  server.once("connection", async (sock) => {
    try {
      const framed = new FramedSocket(sock);
      const ch = await sessionResponder(framed, kpServer, 5_000);
      // 1) Read large payload from initiator.
      const got = await ch.recv(15_000);
      // 2) Echo it back, plus an extra small payload to verify nonce ordering.
      ch.send(got);
      ch.send(Buffer.from("ack"));
      ch.close();
      resolveP(got.length);
    } catch (err) {
      rejectP(err);
    }
  });
});

const sock = createConnection({ host: "127.0.0.1", port });
await new Promise((res, rej) => {
  sock.once("connect", res);
  sock.once("error", rej);
});
const framed = new FramedSocket(sock);
const ch = await sessionInitiator(framed, kpClient, kpServer.publicKey, 5_000);

const SIZE = 1024 * 1024 + 7; // 1 MiB + change (spans many Noise segments)
const payload = randomBytes(SIZE);

console.log(`sending ${SIZE} bytes...`);
ch.send(payload);
const echoed = await ch.recv(15_000);
const tail = await ch.recv(5_000);
ch.close();
server.close();

const echoEqual = echoed.length === SIZE && echoed.equals(payload);
const tailEqual = tail.toString("utf8") === "ack";

const serverGot = await serverDone;
const serverSawAll = serverGot === SIZE;

console.log(`responder got ${serverGot} bytes (expected ${SIZE}): ${serverSawAll ? "✓" : "✗"}`);
console.log(`initiator got echo back: ${echoEqual ? "✓" : "✗"}`);
console.log(`initiator got trailing 'ack' frame: ${tailEqual ? "✓" : "✗"}`);

if (!serverSawAll || !echoEqual || !tailEqual) {
  process.exit(1);
}
console.log("transport-large: PASS");
