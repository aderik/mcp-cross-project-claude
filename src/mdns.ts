import { Bonjour } from "bonjour-service";
import type { Service } from "bonjour-service";
import { networkInterfaces } from "node:os";

/**
 * Routable IPv4 addresses for this machine. Excludes loopback and link-local
 * (169.254/16). Used as a TXT-record fallback when avahi/bonjour-service
 * fail to publish A records correctly.
 */
export function localIPv4s(): string[] {
  const result: string[] = [];
  const ifaces = networkInterfaces();
  for (const name of Object.keys(ifaces)) {
    for (const iface of ifaces[name] ?? []) {
      if (iface.family !== "IPv4") continue;
      if (iface.internal) continue;
      if (iface.address.startsWith("169.254.")) continue;
      result.push(iface.address);
    }
  }
  return result;
}

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
  // Embed our own IPv4 addresses in the TXT record so peers can connect
  // directly even if the responder's A records don't make it across (some
  // avahi configurations only publish AAAA link-local). The asker will
  // try each address in order.
  const ips = localIPv4s().join(",");
  const svc = bonjour().publish({
    name: `${opts.label}@${opts.fingerprint.slice(0, 8)}`,
    type: opts.serviceType,
    protocol: "tcp",
    port: opts.port,
    txt: {
      label: opts.label,
      fp: opts.fingerprint,
      v: "1",
      ips,
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
  // Prefer IPs from TXT (robust against bonjour-service / avahi quirks in
  // populating A records). Fall back to bonjour's discovered addresses,
  // then to the hostname.
  const txtIps = (txt.ips ?? "")
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);
  const addresses =
    txtIps.length > 0 ? txtIps : s.addresses && s.addresses.length > 0 ? s.addresses : [];
  return {
    label,
    fingerprint: fp,
    host: s.host,
    port: s.port,
    addresses,
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

/**
 * Return the first peer advertising the given service type, regardless of
 * label or fingerprint. Used during pairing-send: the asker has no peer
 * identity to match on yet — they just look for whoever is currently in
 * pairing mode.
 */
export function findAnyPeer(
  serviceType: typeof SERVICE_TYPE_SESSION | typeof SERVICE_TYPE_PAIR,
  timeoutMs: number
): Promise<DiscoveredPeer> {
  return findPeer(serviceType, () => true, `any peer of type _${serviceType}._tcp`, timeoutMs);
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
