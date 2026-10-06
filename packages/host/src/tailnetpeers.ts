/**
 * Finding another waterplane daemon on the tailnet, for the phone's "Add a
 * desktop": `tailscale status --json` names the peers, each online one is
 * probed on the waterplane port with `GET /api/health` (short timeout,
 * parallel, capped), and those that answer as a daemon are listed.
 *
 * `GET /api/tailnet/peers` is READ-ONLY and answers only the trusted paths
 * (loopback / Tailscale — `server/http.ts`); a LAN or public peer is refused
 * before this runs. It spends nothing and writes nothing. A probe is a plain
 * GET with no credentials: a 401 carrying `authRequired` is still a daemon (one
 * with a password), so it is listed as `gated`, never dropped.
 */
import { BRAND, type TailnetPeer, type TailnetPeersResponse } from "@waterplane/shared";
import { tailscaleBin } from "./net.js";
import { execFileP } from "./proc.js";


/** Most peers probed in one pass; a tailnet of hundreds must not become a scan. */
export const DISCOVER_MAX_PEERS = 40;
export const DISCOVER_TIMEOUT_MS = 1500;
const DEFAULT_PORT = 8770;

export interface StatusPeer { name: string; ip: string; os: string }

const isTailnetV4 = (ip: string): boolean => {
  const p = ip.split(".").map(Number);
  return p.length === 4 && p.every((n) => Number.isInteger(n) && n >= 0 && n < 256) && p[0] === 100 && p[1]! >= 64 && p[1]! <= 127;
};

/** `tailscale status --json` → the ONLINE peers with a tailnet IPv4. Self is
 *  not a peer. Pure: a fixture in, rows out; anything malformed is skipped. */
export function parseTailnetStatus(json: unknown): StatusPeer[] {
  const peers = (json as { Peer?: unknown } | null)?.Peer;
  if (!peers || typeof peers !== "object") return [];
  const out: StatusPeer[] = [];
  for (const p of Object.values(peers as Record<string, unknown>)) {
    const r = p as { Online?: unknown; HostName?: unknown; DNSName?: unknown; TailscaleIPs?: unknown; OS?: unknown } | null;
    if (!r || r.Online !== true) continue;
    const ips = Array.isArray(r.TailscaleIPs) ? r.TailscaleIPs.filter((x): x is string => typeof x === "string") : [];
    const ip = ips.find(isTailnetV4);
    if (!ip) continue;
    const dns = typeof r.DNSName === "string" ? r.DNSName.split(".")[0] : "";
    const name = (typeof r.HostName === "string" && r.HostName) || dns || ip;
    out.push({ name, ip, os: typeof r.OS === "string" ? r.OS : "" });
  }
  return out;
}

/** The answer of one `/api/health` probe: a daemon, a daemon behind a password, or neither. */
export function healthKind(status: number, body: unknown): "open" | "gated" | null {
  const b = body as { ok?: unknown; protocol?: unknown; authRequired?: unknown } | null;
  if (status === 200 && b && b.ok === true && typeof b.protocol === "number") return "open";
  if (status === 401 && b && b.authRequired === true) return "gated";
  return null;
}

export interface DiscoverDeps {
  /** Raw `tailscale status --json` text, or null when there is no tailscale. */
  status(): Promise<string | null>;
  probe(ip: string, port: number): Promise<"open" | "gated" | null>;
}

async function realStatus(): Promise<string | null> {
  const bin = await tailscaleBin();
  if (!bin) return null;
  try {
    const { stdout } = await execFileP("/bin/sh", ["-c", `${bin} status --json`], { maxBuffer: 8 * 1024 * 1024, timeout: 5000 });
    return stdout;
  } catch { return null; }
}

async function realProbe(ip: string, port: number): Promise<"open" | "gated" | null> {
  const ctl = new AbortController();
  const fuse = setTimeout(() => ctl.abort(), DISCOVER_TIMEOUT_MS);
  try {
    const r = await fetch(`http://${ip}:${port}/api/health`, { signal: ctl.signal });
    let body: unknown = null;
    try { body = await r.json(); } catch { /* not JSON: not a daemon */ }
    return healthKind(r.status, body);
  } catch { return null; } finally { clearTimeout(fuse); }
}

export const realDiscoverDeps: DiscoverDeps = { status: realStatus, probe: realProbe };

/** Probe every online peer on `ports` (this daemon's own port, then 8770). */
export async function discoverTailnetPeers(ports: number[], deps: DiscoverDeps = realDiscoverDeps): Promise<TailnetPeersResponse> {
  const raw = await deps.status();
  if (raw === null) {
    return { ok: true, peers: [], note: "Tailscale is not installed on this desktop, so it cannot list the tailnet. Type the new desktop's address instead." };
  }
  let parsed: unknown = null;
  try { parsed = JSON.parse(raw); } catch { /* an unreadable status lists nobody */ }
  const all = parseTailnetStatus(parsed);
  const asked = all.slice(0, DISCOVER_MAX_PEERS);
  const list = [...new Set(ports.filter((p) => Number.isInteger(p) && p > 0 && p < 65536).concat(DEFAULT_PORT))];
  const hits = await Promise.all(asked.map(async (p): Promise<TailnetPeer | null> => {
    const answers = await Promise.all(list.map(async (port) => ({ port, k: await deps.probe(p.ip, port) })));
    const hit = answers.find((a) => a.k !== null);
    return hit ? { name: p.name, addr: `${p.ip}:${hit.port}`, os: p.os, gated: hit.k === "gated" } : null;
  }));
  const peers = hits.filter((x): x is TailnetPeer => x !== null);
  if (peers.length > 0) return { ok: true, peers };
  const more = all.length > asked.length ? ` (only the first ${DISCOVER_MAX_PEERS} of ${all.length} were asked)` : "";
  return {
    ok: true, peers: [],
    note: all.length === 0
      ? "No other device is online on this tailnet right now."
      : `${all.length} other device${all.length === 1 ? " is" : "s are"} online on the tailnet, but none answered as a ${BRAND.name} desktop${more}. Is the daemon running there?`,
  };
}
