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

// 4-byte big-endian length prefix; hard cap protects against a malicious peer
// sending a frame that would exhaust memory before we can decrypt it.
const FRAME_HEADER_BYTES = 4;
export const MAX_FRAME_BYTES = 16 * 1024 * 1024; // 16 MiB
// Noise specifies a hard max of 65535 bytes per encrypted message (incl. tag).
const NOISE_MAX_CIPHERTEXT = 65535;
const POLY1305_TAG_BYTES = 16;
const NOISE_MAX_PLAINTEXT = NOISE_MAX_CIPHERTEXT - POLY1305_TAG_BYTES; // 65519

// ---------- Framing on the wire ----------

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
    while (this.waiters.length > 0 && this.buf.length >= FRAME_HEADER_BYTES) {
      const len = this.buf.readUInt32BE(0);
      if (len > MAX_FRAME_BYTES) {
        const err = new Error(`Frame length ${len} exceeds maximum ${MAX_FRAME_BYTES}`);
        this.error = err;
        for (const w of this.waiters) {
          if (w.timer) clearTimeout(w.timer);
          w.reject(err);
        }
        this.waiters = [];
        this.socket.destroy();
        return;
      }
      if (this.buf.length < FRAME_HEADER_BYTES + len) return;
      const frame = this.buf.subarray(FRAME_HEADER_BYTES, FRAME_HEADER_BYTES + len);
      this.buf = this.buf.subarray(FRAME_HEADER_BYTES + len);
      const w = this.waiters.shift()!;
      if (w.timer) clearTimeout(w.timer);
      w.resolve(Buffer.from(frame));
    }
  }

  send(frame: Buffer | Uint8Array): void {
    const b = ensureBuffer(frame);
    if (b.length > MAX_FRAME_BYTES) throw new Error(`Frame too large: ${b.length} > ${MAX_FRAME_BYTES}`);
    const header = Buffer.alloc(FRAME_HEADER_BYTES);
    header.writeUInt32BE(b.length, 0);
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
  remoteStatic: Buffer;
  send(payload: Buffer): void;
  recv(timeoutMs: number): Promise<Buffer>;
  close(): void;
}

interface ChannelCipher {
  encrypt(p: Uint8Array): Uint8Array;
  decrypt(c: Uint8Array): Uint8Array;
}

function wrap(framed: FramedSocket, hs: NoiseHandshake): SecureChannel {
  const txCipher: ChannelCipher = new CipherClass(hs.tx);
  const rxCipher: ChannelCipher = new CipherClass(hs.rx);
  const remoteStatic = ensureBuffer(hs.rs!);
  return {
    remoteStatic,

    // Application payloads can exceed Noise's 65535-byte ciphertext limit.
    // Chunk into NOISE_MAX_PLAINTEXT-sized pieces, encrypt each separately
    // (each piece consumes one nonce), concatenate, and wrap in one framed
    // message on the wire. The receiver splits at NOISE_MAX_CIPHERTEXT
    // boundaries; every chunk except the last is exactly that size, so no
    // per-chunk length needed.
    send(payload: Buffer): void {
      const parts: Buffer[] = [];
      if (payload.length === 0) {
        parts.push(Buffer.from(txCipher.encrypt(payload)));
      } else {
        for (let i = 0; i < payload.length; i += NOISE_MAX_PLAINTEXT) {
          const piece = payload.subarray(i, Math.min(i + NOISE_MAX_PLAINTEXT, payload.length));
          parts.push(Buffer.from(txCipher.encrypt(piece)));
        }
      }
      const combined = Buffer.concat(parts);
      framed.send(combined);
    },

    async recv(timeoutMs: number): Promise<Buffer> {
      const combined = await framed.recv(timeoutMs);
      if (combined.length === 0) {
        // Should not happen; recv always returns at least the empty-chunk tag.
        return Buffer.alloc(0);
      }
      const parts: Buffer[] = [];
      let offset = 0;
      while (offset < combined.length) {
        const remaining = combined.length - offset;
        const take = Math.min(NOISE_MAX_CIPHERTEXT, remaining);
        const slice = combined.subarray(offset, offset + take);
        parts.push(Buffer.from(rxCipher.decrypt(slice)));
        offset += take;
      }
      return Buffer.concat(parts);
    },

    close(): void {
      framed.close();
    },
  };
}

/**
 * XXpsk0 pairing handshake (mutual exchange of static keys, PSK mixed in
 * at the start). After three messages both sides know each other's static
 * pubkey via `hs.rs` and share transport ciphers.
 */
export async function pairInitiator(
  framed: FramedSocket,
  staticKeypair: StaticKeypair,
  psk: Buffer,
  timeoutMs: number
): Promise<SecureChannel> {
  const hs = new NoiseClass("XXpsk0", true, { publicKey: staticKeypair.publicKey, secretKey: staticKeypair.secretKey }, { psk });
  hs.initialise(PROLOGUE_PAIR);
  framed.send(Buffer.from(hs.send()));
  hs.recv(await framed.recv(timeoutMs));
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
 * IK session handshake. Initiator already knows the responder's static
 * public key (cached from a prior pairing); responder verifies that the
 * static the initiator reveals during the handshake matches a paired peer.
 */
export async function sessionInitiator(
  framed: FramedSocket,
  staticKeypair: StaticKeypair,
  remoteStatic: Buffer,
  timeoutMs: number
): Promise<SecureChannel> {
  const hs = new NoiseClass("IK", true, { publicKey: staticKeypair.publicKey, secretKey: staticKeypair.secretKey });
  hs.initialise(PROLOGUE_SESSION, remoteStatic);
  framed.send(Buffer.from(hs.send()));
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
  /** Optional per-call timeout for the spawned claude -p on the receiving side.
   * Receiver clamps to its own MAX_CLAUDE_TIMEOUT_MS for safety. */
  timeout_ms?: number;
  /** If true, the receiver may emit intermittent ProgressFrame messages before
   * the terminal AskOk/AskErr. Asker indicates support; older receivers without
   * this field send only ok/err and the asker handles both. */
  wants_progress?: boolean;
}

export interface ProgressFrame {
  type: "progress";
  id: string;
  /** Monotonically increasing per-call sequence number. */
  seq: number;
  /** Short human-readable summary line (e.g. "tool_use Grep(pattern=foo)"). */
  message: string;
  /** Milliseconds since the receiver spawned claude -p. */
  elapsed_ms: number;
}

export type TerminalFrame =
  | { type: "ok"; id: string; answer: string }
  | { type: "err"; id: string; message: string };

export type AnswerFrame = ProgressFrame | TerminalFrame;
