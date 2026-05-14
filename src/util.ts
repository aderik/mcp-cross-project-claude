import { createHash, hkdfSync, randomBytes } from "node:crypto";
import { createConnection, type Socket } from "node:net";

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

/**
 * Try to TCP-connect to each host in order; return the first successful
 * socket. Used to iterate over candidate addresses pulled from mDNS, since
 * a single advertisement may include several IPs and only some are
 * reachable from the asker.
 */
export async function tryConnect(
  hosts: string[],
  port: number,
  perAttemptTimeoutMs = 2000
): Promise<Socket> {
  if (hosts.length === 0) {
    throw new Error("tryConnect: no candidate hosts");
  }
  const errors: string[] = [];
  for (const host of hosts) {
    try {
      const socket = createConnection({ host, port });
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          socket.destroy();
          reject(new Error(`timeout after ${perAttemptTimeoutMs}ms`));
        }, perAttemptTimeoutMs);
        socket.once("connect", () => {
          clearTimeout(timer);
          resolve();
        });
        socket.once("error", (err) => {
          clearTimeout(timer);
          socket.destroy();
          reject(err);
        });
      });
      return socket;
    } catch (err) {
      errors.push(`${host}: ${(err as Error).message}`);
    }
  }
  throw new Error(
    `Could not connect to ${hosts.join(", ")} on port ${port}. Tried: ${errors.join("; ")}`
  );
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
