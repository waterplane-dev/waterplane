/**
 * Bidirectional throughput probe + connection diagnostics for the "why is the
 * file feature so slow" question. Three HTTP endpoints (see api.ts):
 *   GET  /api/speedtest/download?bytes=N  — host→phone: streams N random bytes.
 *   POST /api/speedtest/upload            — phone→host: drains + times the body.
 *   GET  /api/speedtest/debug             — connection introspection (optional).
 *
 * The debug pass is the actually-useful bit: it looks at HOW the phone reached
 * this host (the client IP the socket sees + the Host header it dialed) and, if
 * that client is a Tailscale peer, runs `tailscale ping` against it to report
 * whether THIS connection is a direct P2P path or relayed through a DERP server
 * — the usual cause of a slow same-WiFi transfer. It also surfaces the host's
 * LAN IPs so the phone can be told to hit `http://<lanIp>:8770` and skip the
 * tunnel. All shell probes are best-effort and independently guarded.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { randomFillSync } from "node:crypto";
import { lanIps, tailscaleBin, tailscaleIp } from "./net.js";
import { execFileP } from "./proc.js";


/** Ceiling on a single run so a stray/hostile request can't stream forever. */
const MAX_TEST_BYTES = 256 * 1024 * 1024; // 256 MB
const DEFAULT_BYTES = 8 * 1024 * 1024; //  8 MB

/**
 * A pre-filled random block reused for every download. Random (not zeros) so no
 * transparent compressor anywhere on the path can inflate the apparent rate.
 */
const CHUNK = Buffer.allocUnsafe(256 * 1024);
randomFillSync(CHUNK);

/** Stream `bytes` of incompressible data to the phone, honouring backpressure. */
export function serveDownload(res: ServerResponse, bytes: number): void {
  const total = Math.max(0, Math.min(Math.floor(bytes) || DEFAULT_BYTES, MAX_TEST_BYTES));
  res.writeHead(200, {
    "content-type": "application/octet-stream",
    "content-length": String(total),
    "cache-control": "no-store, no-cache, must-revalidate",
  });
  let sent = 0;
  const pump = (): void => {
    while (sent < total) {
      const n = Math.min(CHUNK.length, total - sent);
      const slice = n === CHUNK.length ? CHUNK : CHUNK.subarray(0, n);
      sent += n;
      if (!res.write(slice)) { res.once("drain", pump); return; } // paused: resume on drain
    }
    res.end();
  };
  pump();
}

/**
 * Drain the upload body, counting bytes and measuring the server-side wall time
 * from first to last byte (a cleaner throughput number than the client's, which
 * includes connection setup + the response round-trip). Capped at MAX_TEST_BYTES.
 */
export function drainUpload(req: IncomingMessage): Promise<{ bytes: number; ms: number }> {
  return new Promise((resolve, reject) => {
    let bytes = 0;
    let start = 0;
    req.on("data", (c: Buffer) => {
      if (!start) start = Date.now();
      bytes += c.length;
      if (bytes > MAX_TEST_BYTES) { req.destroy(); reject(new Error("payload too large")); }
    });
    req.on("end", () => resolve({ bytes, ms: start ? Date.now() - start : 0 }));
    req.on("error", reject);
  });
}

export type PathKind = "tailscale" | "lan" | "loopback" | "public" | "unknown";

export interface SpeedDebug {
  /** The client IP as the host's socket sees it (normalized, ::ffff: stripped). */
  clientIp: string;
  /** How that IP classifies — the headline signal for direct-vs-tunnel. */
  clientKind: PathKind;
  /** The address the phone actually dialed (Host header) — 100.x vs 192.168.x. */
  dialedHost: string;
  /** True when the phone reached us over the Tailscale tunnel (client is 100.x). */
  overTailscale: boolean;
  /** This host's LAN IPv4s — hit http://<ip>:8770 to bypass the tunnel. */
  lanIps: string[];
  /** This host's Tailscale IPv4, if any. */
  tailscaleIp: string | null;
  /** Whether a usable `tailscale` CLI was found on the host. */
  tailscaleCli: boolean;
  /** For a Tailscale client: is this exact connection direct or relayed? */
  route: "direct" | "derp" | "unknown";
  /** DERP region code when relayed (e.g. "fra"), else null. */
  derpRegion: string | null;
  /** Raw probe output, for the collapsible details view. */
  raw: { ping?: string; netcheck?: string; status?: string };
  /** One-line plain-English verdict for the UI to headline. */
  verdict: string;
}

function normIp(ip: string): string {
  return ip.replace(/^::ffff:/, "");
}

function classify(ip: string): PathKind {
  if (ip === "127.0.0.1" || ip === "::1" || ip.startsWith("127.")) return "loopback";
  const p = ip.split(".").map(Number);
  if (p.length === 4 && p[0] === 100 && p[1] >= 64 && p[1] <= 127) return "tailscale";
  if (p.length === 4 && (p[0] === 10 || (p[0] === 192 && p[1] === 168) || (p[0] === 172 && p[1] >= 16 && p[1] <= 31)))
    return "lan";
  if (p.length === 4) return "public";
  return "unknown";
}

const IPV4 = /^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/;

/** Run a tailscale subcommand via the resolved (possibly quoted) CLI path. */
async function ts(bin: string, args: string, timeout: number): Promise<string> {
  const { stdout } = await execFileP("/bin/sh", ["-c", `${bin} ${args}`], { timeout, maxBuffer: 1 << 20 });
  return stdout;
}

export async function collectDebug(req: IncomingMessage): Promise<SpeedDebug> {
  const clientIp = normIp(req.socket.remoteAddress || "");
  const clientKind = classify(clientIp);
  const dialedHost = (req.headers.host || "").split(":")[0] || "";
  const overTailscale = clientKind === "tailscale";

  const bin = await tailscaleBin();
  const [tsIp, raw] = await Promise.all([
    tailscaleIp().catch(() => null),
    (async () => {
      const out: SpeedDebug["raw"] = {};
      if (!bin) return out;
      // Ping the exact client peer to read THIS connection's current path.
      // --until-direct=false so it reports the live route instead of blocking
      // while it tries to upgrade to direct.
      if (overTailscale && IPV4.test(clientIp)) {
        out.ping = await ts(bin, `ping --c 3 --until-direct=false ${clientIp}`, 8000).catch((e) => `ping failed: ${e.message ?? e}`);
      }
      out.netcheck = await ts(bin, "netcheck", 12000).catch((e) => `netcheck failed: ${e.message ?? e}`);
      out.status = await ts(bin, "status", 8000).catch((e) => `status failed: ${e.message ?? e}`);
      return out;
    })(),
  ]);

  // Parse the ping output for the live route. Lines look like:
  //   "pong from host (100.x.y.z) via DERP(fra) in 31ms"  → relayed
  //   "pong from host (100.x.y.z) via 192.168.1.5:41641 in 2ms" → direct
  let route: SpeedDebug["route"] = "unknown";
  let derpRegion: string | null = null;
  if (raw.ping) {
    const derp = /via DERP\(([^)]+)\)/i.exec(raw.ping);
    if (derp) { route = "derp"; derpRegion = derp[1]; }
    else if (/via \d{1,3}(?:\.\d{1,3}){3}:\d+/i.test(raw.ping)) route = "direct";
  }

  const lan = lanIps();
  const hint = lan.length ? `http://${lan[0]}:8770` : "the host's LAN IP";
  let verdict: string;
  if (clientKind === "loopback") verdict = "Loopback — same machine. Not a network path.";
  else if (clientKind === "lan") verdict = `Direct LAN connection (${clientIp}) — not using the Tailscale tunnel. This is already the fast path.`;
  else if (clientKind === "tailscale" && route === "derp")
    verdict = `Relayed via DERP(${derpRegion}) — bytes detour through a Tailscale relay, THE usual cause of slow transfers. On the same WiFi, hit ${hint} to bypass the tunnel.`;
  else if (clientKind === "tailscale" && route === "direct")
    verdict = "Direct Tailscale (P2P) — the tunnel found a direct path, so this is about as fast as it gets over Tailscale.";
  else if (clientKind === "tailscale")
    verdict = `Over the Tailscale tunnel; route unknown (no ping result). If slow, try ${hint} on the same WiFi to compare.`;
  else verdict = `Connected from ${clientIp} (${clientKind}).`;

  return {
    clientIp, clientKind, dialedHost, overTailscale,
    lanIps: lan, tailscaleIp: tsIp, tailscaleCli: !!bin,
    route, derpRegion, raw, verdict,
  };
}
