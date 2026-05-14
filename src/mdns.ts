import { Bonjour } from "bonjour-service";
import type { Service } from "bonjour-service";

export const SERVICE_TYPE_SESSION = "mcp-bridge"; // _mcp-bridge._tcp.local
export const SERVICE_TYPE_PAIR = "mcp-bridge-pair"; // _mcp-bridge-pair._tcp.local

export interface AdvertOptions {
  serviceType: typeof SERVICE_TYPE_SESSION | typeof SERVICE_TYPE_PAIR;
  label: string;
  fingerprint: string;
  port: number;
}

let bonjourInstance: Bonjour | null = null;
function bonjour(): Bonjour {
  if (!bonjourInstance) {
    try {
      bonjourInstance = new Bonjour();
    } catch (err) {
      throw new Error(`Failed to initialise mDNS (multicast disabled?): ${(err as Error).message}`);
    }
  }
  return bonjourInstance;
}

export function advertise(opts: AdvertOptions): { stop: () => void } {
  const svc = bonjour().publish({
    name: `${opts.label}@${opts.fingerprint.slice(0, 8)}`,
    type: opts.serviceType,
    protocol: "tcp",
    port: opts.port,
    txt: {
      label: opts.label,
      fp: opts.fingerprint,
      v: "1",
    },
  });
  return {
    stop(): void {
      try {
        if (typeof svc.stop === "function") svc.stop(() => {});
      } catch {
        // ignore
      }
    },
  };
}

export interface DiscoveredPeer {
  label: string;
  fingerprint: string;
  host: string;
  port: number;
  addresses: string[];
}

function serviceToPeer(s: Service): DiscoveredPeer | null {
  const txt = (s.txt ?? {}) as Record<string, string>;
  const label = txt.label;
  const fp = txt.fp;
  if (!label || !fp) return null;
  return {
    label,
    fingerprint: fp,
    host: s.host,
    port: s.port,
    addresses: s.addresses ?? [],
  };
}

/**
 * Browse for a peer with a matching predicate, with a timeout. Used for both
 * pairing (match by label, since fingerprint isn't known yet) and session
 * routing (match by fingerprint, which is the stable identity).
 */
function findPeer(
  serviceType: typeof SERVICE_TYPE_SESSION | typeof SERVICE_TYPE_PAIR,
  match: (p: DiscoveredPeer) => boolean,
  description: string,
  timeoutMs: number
): Promise<DiscoveredPeer> {
  return new Promise<DiscoveredPeer>((resolve, reject) => {
    const browser = bonjour().find({ type: serviceType, protocol: "tcp" });
    const timer = setTimeout(() => {
      browser.stop();
      reject(new Error(`mDNS: did not find ${description} within ${timeoutMs}ms`));
    }, timeoutMs);
    const onUp = (s: Service): void => {
      const peer = serviceToPeer(s);
      if (peer && match(peer)) {
        clearTimeout(timer);
        browser.stop();
        resolve(peer);
      }
    };
    browser.on("up", onUp);
    for (const s of browser.services) {
      const peer = serviceToPeer(s);
      if (peer && match(peer)) {
        clearTimeout(timer);
        browser.stop();
        resolve(peer);
        return;
      }
    }
  });
}

export function findPeerByLabel(
  serviceType: typeof SERVICE_TYPE_SESSION | typeof SERVICE_TYPE_PAIR,
  label: string,
  timeoutMs: number
): Promise<DiscoveredPeer> {
  return findPeer(serviceType, (p) => p.label === label, `peer labelled "${label}"`, timeoutMs);
}

export function findPeerByFingerprint(
  serviceType: typeof SERVICE_TYPE_SESSION | typeof SERVICE_TYPE_PAIR,
  fingerprint: string,
  timeoutMs: number
): Promise<DiscoveredPeer> {
  return findPeer(
    serviceType,
    (p) => p.fingerprint === fingerprint,
    `peer with fingerprint ${fingerprint}`,
    timeoutMs
  );
}

export function shutdownMdns(): void {
  if (bonjourInstance) {
    try {
      bonjourInstance.destroy();
    } catch {
      // ignore
    }
    bonjourInstance = null;
  }
}
