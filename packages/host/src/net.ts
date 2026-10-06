import { createSocket } from "node:dgram";
import { access, constants } from "node:fs/promises";
import { hostname, networkInterfaces } from "node:os";
import { execFileP } from "./proc.js";


/**
 * Find the local Tailscale IPv4 (100.64.0.0/10 CGNAT range) if present.
 * Mirrors the trick the Python drop server uses: enumerate interfaces and
 * also probe via a dummy UDP "connect" to a tailnet-reachable address.
 */
/**
 * All non-internal LAN IPv4s of this host (excludes loopback and the Tailscale
 * 100.64/10 range). These are the addresses the phone can hit directly on the
 * same WiFi — `http://<lanIp>:8770` — to bypass the Tailscale tunnel entirely.
 */
export type PeerKind = "loopback" | "tailscale" | "lan" | "public" | "unknown";

/**
 * Classify a socket's remote address into the trust tiers the auth gate uses.
 * Strips the IPv4-mapped-IPv6 prefix. loopback = this machine; tailscale =
 * 100.64/10 CGNAT; lan = RFC1918 private; anything else public/unknown.
 */
export function peerKind(addr: string | undefined | null): PeerKind {
  if (!addr) return "unknown";
  const ip = addr.replace(/^::ffff:/, "");
  if (ip === "127.0.0.1" || ip === "::1" || ip.startsWith("127.")) return "loopback";
  const p = ip.split(".").map(Number);
  if (p.length === 4 && p.every((n) => Number.isFinite(n))) {
    if (p[0] === 100 && p[1] >= 64 && p[1] <= 127) return "tailscale";
    if (p[0] === 10 || (p[0] === 192 && p[1] === 168) || (p[0] === 172 && p[1] >= 16 && p[1] <= 31)) return "lan";
    return "public";
  }
  return "unknown";
}

/**
 * The headers a reverse proxy adds — the ONE list. `tailscale serve` terminates
 * HTTPS and forwards to 127.0.0.1, so every tailnet request it carries arrives
 * from LOOPBACK; these headers are what tell it apart from a process on this
 * desktop. A local curl, a hook, the `$BROWSER` shim sends none of them.
 */
export const PROXY_HEADERS: readonly string[] = [
  "x-forwarded-for", "x-forwarded-host", "x-forwarded-proto", "x-real-ip", "forwarded", "via",
  "tailscale-user-login", "tailscale-user-name", "tailscale-user-profile-pic", "tailscale-headers-info",
];

/**
 * Why this request is not a process on THIS desktop, or null when it is: the
 * socket peer is loopback AND no proxy header is present. The gate of every
 * local-process-only route (`/api/hook`, `/api/plugin/:id/hook`,
 * `/api/shell/open`) and the first two tests of `agentCallerRefusal`.
 * Loopback alone is not enough — see `PROXY_HEADERS`.
 */
export function localProcessRefusal(remoteAddress: string | undefined, headers: Readonly<Record<string, string | string[] | undefined>>): string | null {
  if (peerKind(remoteAddress) !== "loopback") return "local only — this route answers a process on this desktop";
  if (PROXY_HEADERS.some((h) => headers[h] !== undefined)) return "local only — a proxied request is not a process on this desktop";
  return null;
}

/** This desktop's name as a person would call it: the OS hostname, minus the
 *  `.local` mDNS suffix macOS appends. */
export function hostName(): string {
  return hostname().replace(/\.local$/i, "") || "desktop";
}

export function lanIps(): string[] {
  const out: string[] = [];
  for (const addrs of Object.values(networkInterfaces())) {
    for (const a of addrs ?? []) {
      if (a.family === "IPv4" && !a.internal && !a.address.startsWith("100.")) out.push(a.address);
    }
  }
  return out;
}

export async function tailscaleIp(): Promise<string | null> {
  const candidates = new Set<string>();

  for (const addrs of Object.values(networkInterfaces())) {
    for (const a of addrs ?? []) {
      if (a.family === "IPv4") candidates.add(a.address);
    }
  }

  // Dummy connect — getsockname() reveals the source IP the OS would route
  // a tailnet packet from, even when interface enumeration misses it.
  await new Promise<void>((resolve) => {
    const s = createSocket("udp4");
    const done = () => {
      try { s.close(); } catch { /* already closed */ }
      resolve();
    };
    s.once("error", done);
    try {
      s.connect(1, "100.100.100.100", () => {
        try {
          const { address } = s.address();
          if (address) candidates.add(address);
        } catch { /* no-op */ }
        done();
      });
    } catch {
      done();
    }
    setTimeout(done, 150);
  });

  for (const ip of candidates) {
    if (!ip.startsWith("100.")) continue;
    const second = Number(ip.split(".")[1]);
    if (second >= 64 && second <= 127 && !ip.startsWith("100.127.")) return ip;
  }
  return null;
}

/**
 * Resolve a usable `tailscale` CLI invocation. On macOS the GUI/App-Store app
 * ships the CLI inside its bundle and does NOT put it on PATH, so the bare
 * `tailscale …` command we suggest fails with `command not found`. Prefer a
 * PATH hit, then the known bundle location; return null if neither exists.
 * The returned string is a shell-ready path (quoted if it contains spaces).
 */
export async function tailscaleBin(): Promise<string | null> {
  try {
    const { stdout } = await execFileP("/bin/sh", ["-c", "command -v tailscale"]);
    const p = stdout.trim();
    if (p) return p;
  } catch { /* not on PATH */ }

  const bundled = "/Applications/Tailscale.app/Contents/MacOS/Tailscale";
  try {
    await access(bundled, constants.X_OK);
    return `"${bundled}"`;
  } catch { /* not a Mac GUI install */ }

  return null;
}

/**
 * MagicDNS FQDN of this host (e.g. `mac.tailnet.ts.net`), read from
 * `tailscale status --json` → Self.DNSName. This is the name a
 * `tailscale serve --https=443` cert is issued for, so it's the HTTPS base URL
 * the phone should use to get a secure context (Web Push / service worker).
 * Null if no tailscale CLI or not on a tailnet.
 */
export async function tailscaleDnsName(): Promise<string | null> {
  const bin = await tailscaleBin();
  if (!bin) return null;
  try {
    const { stdout } = await execFileP("/bin/sh", ["-c", `${bin} status --json`]);
    const dns = JSON.parse(stdout)?.Self?.DNSName as string | undefined;
    if (dns) return dns.replace(/\.$/, "");   // strip the trailing root-zone dot
  } catch { /* no tailnet / CLI failed */ }
  return null;
}

/**
 * The HTTPS URL `tailscale serve` fronts a local port with, or null.
 *
 * Keyed on the PROXY TARGET, not on a substring of the status text: the target
 * (`http://127.0.0.1:8770`) contains the port number too, so a naive match read
 * "we are fronted" from any serve config at all — and then reported the bare
 * `https://<name>`, silently assuming the listener is on 443. That is wrong
 * whenever 443 already serves something else, and it sent the phone's
 * Connection shortcut to a different app entirely.
 */
export async function serveHttpsUrl(port: number): Promise<string | null> {
  const bin = await tailscaleBin();
  if (!bin) return null;
  try {
    const { stdout } = await execFileP("/bin/sh", ["-c", `${bin} serve status --json`]);
    const cfg = JSON.parse(stdout) as {
      Web?: Record<string, { Handlers?: Record<string, { Proxy?: string }> }>;
    };
    for (const [hostPort, entry] of Object.entries(cfg.Web ?? {})) {
      for (const h of Object.values(entry.Handlers ?? {})) {
        if (!h.Proxy) continue;
        let target: URL;
        try { target = new URL(h.Proxy); } catch { continue; }
        if (Number(target.port) !== port) continue;
        // ":443" is the bare https URL; any other port has to be shown.
        return hostPort.endsWith(":443") ? `https://${hostPort.slice(0, -4)}` : `https://${hostPort}`;
      }
    }
  } catch { /* no tailnet / CLI failed / unparseable */ }
  return null;
}
