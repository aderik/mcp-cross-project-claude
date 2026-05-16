import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { randomBytes } from "node:crypto";
import { generateKeyPair } from "noise-handshake/dh.js";
import { ensureBuffer, fingerprint } from "./util.js";

export interface StaticKeypair {
  publicKey: Buffer;
  secretKey: Buffer;
}

export interface PairedPeer {
  label: string;
  publicKey: string; // base64
  fingerprint: string;
  pairedAt: string;
  /** Bridge version reported by the peer on its most recent pong. */
  peerVersion?: string;
  /** ISO timestamp of the last successful ping/pong with this peer. */
  lastSeenAt?: string;
}

interface StateV2 {
  version: 2;
  label: string;
  static: { publicKey: string; secretKey: string };
  peer: PairedPeer | null;
}

// Tolerated when reading from disk; converted on first load.
interface StateV1 {
  version: 1;
  static: { publicKey: string; secretKey: string };
  peers: PairedPeer[];
}

type AnyState = StateV1 | StateV2;

function safeSlug(s: string): string {
  return s.replace(/[^a-zA-Z0-9_-]+/g, "-").replace(/^-+|-+$/g, "") || "bridge";
}

/**
 * Default state dir is shared across all projects on this machine: one
 * identity, one paired peer, usable from any cwd where the bridge runs.
 * Override with the STATE_DIR env-var to scope state per-project if you
 * need isolation (e.g., separate pairings for separate codebases).
 */
function defaultStateDir(): string {
  const xdg = process.env.XDG_CONFIG_HOME;
  const base = xdg && xdg.length > 0 ? xdg : join(homedir(), ".config");
  return join(base, "mcp-cross-project-claude");
}

export function statePath(): string {
  const override = process.env.STATE_DIR;
  const dir = override && override.length > 0 ? override : defaultStateDir();
  return join(dir, "state.json");
}

function shortRandomSuffix(): string {
  return randomBytes(2).toString("hex"); // 4 hex chars
}

function freshLabel(): string {
  // Basename of cwd at first init + 4-hex random suffix. Persistent thereafter.
  const safe = safeSlug(basename(process.cwd()) || "bridge");
  return `${safe}-${shortRandomSuffix()}`;
}

function initialState(): StateV2 {
  const kp = generateKeyPair() as { publicKey: Uint8Array; secretKey: Uint8Array };
  return {
    version: 2,
    label: freshLabel(),
    static: {
      publicKey: ensureBuffer(kp.publicKey).toString("base64"),
      secretKey: ensureBuffer(kp.secretKey).toString("base64"),
    },
    peer: null,
  };
}

function migrate(s: AnyState): StateV2 {
  if (s.version === 2) return s;
  if (s.version === 1) {
    return {
      version: 2,
      label: freshLabel(),
      static: s.static,
      peer: s.peers.length > 0 ? s.peers[0] : null,
    };
  }
  throw new Error(`Unsupported state file version: ${(s as { version: unknown }).version}`);
}

function readOrInit(): StateV2 {
  const path = statePath();
  if (!existsSync(path)) {
    const fresh = initialState();
    writeState(fresh);
    return fresh;
  }
  const txt = readFileSync(path, "utf8");
  const parsed = JSON.parse(txt) as AnyState;
  const migrated = migrate(parsed);
  if (parsed.version !== migrated.version) {
    writeState(migrated);
  }
  return migrated;
}

export function writeState(s: StateV2): void {
  const path = statePath();
  const dir = dirname(path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileSync(path, JSON.stringify(s, null, 2), { mode: 0o600 });
  try {
    chmodSync(path, 0o600);
  } catch {
    // best-effort
  }
}

export function loadState(): StateV2 {
  return readOrInit();
}

export function ourLabel(): string {
  return loadState().label;
}

export function ourKeypair(): StaticKeypair {
  const s = loadState();
  return {
    publicKey: Buffer.from(s.static.publicKey, "base64"),
    secretKey: Buffer.from(s.static.secretKey, "base64"),
  };
}

export function getPairedPeer(): PairedPeer | null {
  return loadState().peer;
}

export function setPairedPeer(label: string, publicKey: Buffer): PairedPeer {
  const s = loadState();
  if (s.peer !== null) {
    throw new Error(
      `Already paired with "${s.peer.label}" (fp=${s.peer.fingerprint}). Run \`unpair\` first.`
    );
  }
  const entry: PairedPeer = {
    label,
    publicKey: publicKey.toString("base64"),
    fingerprint: fingerprint(publicKey),
    pairedAt: new Date().toISOString(),
  };
  s.peer = entry;
  writeState(s);
  return entry;
}

export function clearPairedPeer(): boolean {
  const s = loadState();
  if (s.peer === null) return false;
  s.peer = null;
  writeState(s);
  return true;
}

export function updatePairedPeerLastSeen(version: string): void {
  const s = loadState();
  if (s.peer === null) return;
  s.peer.peerVersion = version;
  s.peer.lastSeenAt = new Date().toISOString();
  writeState(s);
}

export function findPeerByPublicKey(pub: Buffer): PairedPeer | null {
  const peer = getPairedPeer();
  if (!peer) return null;
  return peer.publicKey === pub.toString("base64") ? peer : null;
}
