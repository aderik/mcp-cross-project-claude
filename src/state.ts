import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
// noise-handshake's dh module exposes X25519 keypair generation (sodium-universal underneath).
// We use it directly so our long-term static key matches the curve used by the handshake.
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
}

export interface State {
  version: 1;
  static: { publicKey: string; secretKey: string };
  peers: PairedPeer[];
}

function defaultStateDir(): string {
  // XDG-style: $XDG_CONFIG_HOME or ~/.config
  const xdg = process.env.XDG_CONFIG_HOME;
  if (xdg && xdg.length > 0) return join(xdg, "mcp-cross-project-claude");
  return join(homedir(), ".config", "mcp-cross-project-claude");
}

export function statePath(): string {
  const override = process.env.STATE_DIR;
  const dir = override && override.length > 0 ? override : defaultStateDir();
  return join(dir, "state.json");
}

function readOrInit(): State {
  const path = statePath();
  if (!existsSync(path)) {
    const kp = generateKeyPair() as { publicKey: Uint8Array; secretKey: Uint8Array };
    const initial: State = {
      version: 1,
      static: {
        publicKey: ensureBuffer(kp.publicKey).toString("base64"),
        secretKey: ensureBuffer(kp.secretKey).toString("base64"),
      },
      peers: [],
    };
    writeState(initial);
    return initial;
  }
  const txt = readFileSync(path, "utf8");
  const parsed = JSON.parse(txt) as State;
  if (parsed.version !== 1) {
    throw new Error(`Unsupported state file version: ${parsed.version}`);
  }
  return parsed;
}

export function writeState(s: State): void {
  const path = statePath();
  const dir = dirname(path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileSync(path, JSON.stringify(s, null, 2), { mode: 0o600 });
  try {
    chmodSync(path, 0o600);
  } catch {
    // best-effort; non-fatal on filesystems that don't support chmod
  }
}

export function loadState(): State {
  return readOrInit();
}

export function ourKeypair(): StaticKeypair {
  const s = loadState();
  return {
    publicKey: Buffer.from(s.static.publicKey, "base64"),
    secretKey: Buffer.from(s.static.secretKey, "base64"),
  };
}

export function listPeers(): PairedPeer[] {
  return loadState().peers;
}

export function findPeerByLabel(label: string): PairedPeer | undefined {
  return listPeers().find((p) => p.label === label);
}

export function findPeerByPublicKey(pub: Buffer): PairedPeer | undefined {
  const b64 = pub.toString("base64");
  return listPeers().find((p) => p.publicKey === b64);
}

export function addPeer(label: string, publicKey: Buffer): PairedPeer {
  const s = loadState();
  const existing = s.peers.findIndex((p) => p.label === label);
  const entry: PairedPeer = {
    label,
    publicKey: publicKey.toString("base64"),
    fingerprint: fingerprint(publicKey),
    pairedAt: new Date().toISOString(),
  };
  if (existing >= 0) {
    s.peers[existing] = entry;
  } else {
    s.peers.push(entry);
  }
  writeState(s);
  return entry;
}

export function removePeer(label: string): boolean {
  const s = loadState();
  const before = s.peers.length;
  s.peers = s.peers.filter((p) => p.label !== label);
  writeState(s);
  return s.peers.length !== before;
}
