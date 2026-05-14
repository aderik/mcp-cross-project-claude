import { Socket } from "node:net";
import Noise from "noise-handshake";
import Cipher from "noise-handshake/cipher.js";
import type { StaticKeypair } from "./state.js";
import { ensureBuffer } from "./util.js";

// noise-handshake is CommonJS without types. Declare what we use.
interface NoiseHandshake {
  s: { publicKey: Uint8Array; secretKey: Uint8Array };
  e: { publicKey: Uint8Array; secretKey: Uint8Array } | null;
  rs: Uint8Array | null;
  tx: Uint8Array;
  rx: Uint8Array;
  complete: boolean;
  initialise(prologue: Uint8Array, remoteStatic?: Uint8Array): void;
  send(payload?: Uint8Array): Uint8Array;
  recv(buf: Uint8Array): Uint8Array;
}
interface NoiseCtor {
  new (pattern: string, initiator: boolean, staticKeypair?: { publicKey: Uint8Array; secretKey: Uint8Array }, opts?: { psk?: Uint8Array }): NoiseHandshake;
}
interface CipherCtor {
  new (key: Uint8Array): { encrypt(plaintext: Uint8Array, ad?: Uint8Array): Uint8Array; decrypt(ciphertext: Uint8Array, ad?: Uint8Array): Uint8Array };
}
const NoiseClass = Noise as unknown as NoiseCtor;
const CipherClass = Cipher as unknown as CipherCtor;

export const PROLOGUE_PAIR = Buffer.from("mcp-cross-project-claude/pair/v1");
export const PROLOGUE_SESSION = Buffer.from("mcp-cross-project-claude/session/v1");

// ---------- Framing on the wire ----------
// Each message on the socket is: 2-byte big-endian length, then `length` bytes.
// Used for both handshake messages and post-handshake encrypted frames.

export class FramedSocket {
  private buf: Buffer = Buffer.alloc(0);
  private waiters: Array<{ resolve: (b: Buffer) => void; reject: (e: Error) => void; timer: NodeJS.Timeout | null }> = [];
  private closed = false;
  private error: Error | null = null;

  constructor(public readonly socket: Socket) {
    socket.on("data", (chunk: Buffer) => {
      this.buf = Buffer.concat([this.buf, chunk]);
      this.drain();
    });
    socket.on("close", () => {
      this.closed = true;
      this.error = this.error ?? new Error("socket closed");
      for (const w of this.waiters) {
        if (w.timer) clearTimeout(w.timer);
        w.reject(this.error);
      }
      this.waiters = [];
    });
    socket.on("error", (err: Error) => {
      this.error = err;
    });
  }

  private drain(): void {
    while (this.waiters.length > 0 && this.buf.length >= 2) {
      const len = this.buf.readUInt16BE(0);
      if (this.buf.length < 2 + len) return;
      const frame = this.buf.subarray(2, 2 + len);
      this.buf = this.buf.subarray(2 + len);
      const w = this.waiters.shift()!;
      if (w.timer) clearTimeout(w.timer);
      w.resolve(Buffer.from(frame));
    }
  }

  send(frame: Buffer | Uint8Array): void {
    const b = ensureBuffer(frame);
    if (b.length > 65535) throw new Error(`Frame too large: ${b.length} bytes`);
    const header = Buffer.alloc(2);
    header.writeUInt16BE(b.length, 0);
    this.socket.write(Buffer.concat([header, b]));
  }

  recv(timeoutMs: number): Promise<Buffer> {
    if (this.closed) return Promise.reject(this.error ?? new Error("socket closed"));
    return new Promise<Buffer>((resolve, reject) => {
      const w = {
        resolve,
        reject,
        timer: null as NodeJS.Timeout | null,
      };
      w.timer = setTimeout(() => {
        const i = this.waiters.indexOf(w);
        if (i >= 0) this.waiters.splice(i, 1);
        reject(new Error(`Frame read timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      this.waiters.push(w);
      this.drain();
    });
  }

  close(): void {
    this.socket.end();
  }
}

// ---------- Handshakes ----------

export interface SecureChannel {
  framed: FramedSocket;
  txCipher: { encrypt(p: Uint8Array): Uint8Array };
  rxCipher: { decrypt(c: Uint8Array): Uint8Array };
  remoteStatic: Buffer;
  send(payload: Buffer): void;
  recv(timeoutMs: number): Promise<Buffer>;
  close(): void;
}

function wrap(framed: FramedSocket, hs: NoiseHandshake): SecureChannel {
  const txCipher = new CipherClass(hs.tx);
  const rxCipher = new CipherClass(hs.rx);
  const remoteStatic = ensureBuffer(hs.rs!);
  return {
    framed,
    txCipher,
    rxCipher,
    remoteStatic,
    send(payload: Buffer): void {
      const ct = txCipher.encrypt(payload);
      framed.send(ct);
    },
    async recv(timeoutMs: number): Promise<Buffer> {
      const ct = await framed.recv(timeoutMs);
      const pt = rxCipher.decrypt(ct);
      return ensureBuffer(pt);
    },
    close(): void {
      framed.close();
    },
  };
}

/**
 * XXpsk0 pairing handshake. Initiator (sender) and responder (receiver) both
 * supply their long-term static keypair and the same PIN-derived PSK. After
 * three messages both sides have each other's static public key, and a
 * shared transport-cipher pair.
 *
 * Eavesdropper analysis: the PSK is mixed into the handshake hash before
 * anything else; an attacker can offline-bruteforce the PIN against captured
 * traffic, but cannot derive the ephemeral-ECDH-based session keys without
 * actively having been the peer.
 */
export async function pairInitiator(
  framed: FramedSocket,
  staticKeypair: StaticKeypair,
  psk: Buffer,
  timeoutMs: number
): Promise<SecureChannel> {
  const hs = new NoiseClass("XXpsk0", true, { publicKey: staticKeypair.publicKey, secretKey: staticKeypair.secretKey }, { psk });
  hs.initialise(PROLOGUE_PAIR);
  // XX message 1 (-> e)
  framed.send(Buffer.from(hs.send()));
  // XX message 2 (<- e, ee, s, es)
  hs.recv(await framed.recv(timeoutMs));
  // XX message 3 (-> s, se)
  framed.send(Buffer.from(hs.send()));
  if (!hs.complete) throw new Error("Pairing handshake did not complete");
  return wrap(framed, hs);
}

export async function pairResponder(
  framed: FramedSocket,
  staticKeypair: StaticKeypair,
  psk: Buffer,
  timeoutMs: number
): Promise<SecureChannel> {
  const hs = new NoiseClass("XXpsk0", false, { publicKey: staticKeypair.publicKey, secretKey: staticKeypair.secretKey }, { psk });
  hs.initialise(PROLOGUE_PAIR);
  hs.recv(await framed.recv(timeoutMs));
  framed.send(Buffer.from(hs.send()));
  hs.recv(await framed.recv(timeoutMs));
  if (!hs.complete) throw new Error("Pairing handshake did not complete");
  return wrap(framed, hs);
}

/**
 * IK session handshake. Initiator already knows the responder's static public
 * key (cached from a prior pairing); responder verifies that the static
 * public key the initiator reveals during the handshake matches one of the
 * paired peers.
 */
export async function sessionInitiator(
  framed: FramedSocket,
  staticKeypair: StaticKeypair,
  remoteStatic: Buffer,
  timeoutMs: number
): Promise<SecureChannel> {
  const hs = new NoiseClass("IK", true, { publicKey: staticKeypair.publicKey, secretKey: staticKeypair.secretKey });
  hs.initialise(PROLOGUE_SESSION, remoteStatic);
  // IK message 1 (-> e, es, s, ss)
  framed.send(Buffer.from(hs.send()));
  // IK message 2 (<- e, ee, se)
  hs.recv(await framed.recv(timeoutMs));
  if (!hs.complete) throw new Error("Session handshake did not complete");
  return wrap(framed, hs);
}

export async function sessionResponder(
  framed: FramedSocket,
  staticKeypair: StaticKeypair,
  timeoutMs: number
): Promise<SecureChannel> {
  const hs = new NoiseClass("IK", false, { publicKey: staticKeypair.publicKey, secretKey: staticKeypair.secretKey });
  hs.initialise(PROLOGUE_SESSION);
  hs.recv(await framed.recv(timeoutMs));
  framed.send(Buffer.from(hs.send()));
  if (!hs.complete) throw new Error("Session handshake did not complete");
  return wrap(framed, hs);
}

// ---------- Application payloads ----------

export interface AskRequest {
  type: "ask";
  id: string;
  question: string;
  asker_label: string;
}

export type AskResponse =
  | { type: "ok"; id: string; answer: string }
  | { type: "err"; id: string; message: string };

export interface PairExchange {
  label: string;
  // The static public key is implicit in the Noise handshake (peer.rs), so we
  // do not include it in the application payload — that would be redundant
  // and a potential desync source. We only exchange the label.
}
