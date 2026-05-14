import { createHash, hkdfSync, randomBytes } from "node:crypto";

export function log(level: "info" | "warn" | "error", msg: string): void {
  // stderr only; stdout is the MCP transport.
  process.stderr.write(`[mcp-cross-project-claude] ${level}: ${msg}\n`);
}

export function die(msg: string): never {
  log("error", msg);
  process.exit(1);
}

export function randomPin(): string {
  // 4 random digits, 0000-9999.
  const n = randomBytes(2).readUInt16BE(0) % 10000;
  return n.toString().padStart(4, "0");
}

export function pinToPsk(pin: string): Buffer {
  // HKDF-SHA256 of the PIN to a 32-byte PSK. Domain-separated by info string.
  const ikm = Buffer.from(pin, "utf8");
  const salt = Buffer.alloc(0);
  const info = Buffer.from("mcp-cross-project-claude/pair-psk-v1");
  const out = hkdfSync("sha256", ikm, salt, info, 32);
  return Buffer.from(out as ArrayBuffer);
}

export function fingerprint(pub: Buffer): string {
  const h = createHash("sha256").update(pub).digest("hex");
  return h.slice(0, 16);
}

export function ensureBuffer(b: Uint8Array | Buffer): Buffer {
  return Buffer.isBuffer(b) ? b : Buffer.from(b);
}

export function timeoutPromise<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`Timeout: ${label} did not complete within ${ms}ms`)), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      }
    );
  });
}
