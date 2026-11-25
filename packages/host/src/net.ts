import { createSocket } from "node:dgram";
import { access, constants } from "node:fs/promises";
import { hostname, networkInterfaces } from "node:os";
import type { TLSSocket } from "node:tls";
import { envName } from "@waterplane/shared";
import { RUNNING_IN_WSL } from "./branddirs.js";
import { execFileP } from "./proc.js";
import { isLoopbackName, noteFrontDoors, unknownDoor, unverifiedName } from "./origin.js";


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
  "tailscale-funnel-request", "tailscale-user-login", "tailscale-user-name", "tailscale-user-profile-pic", "tailscale-headers-info",
];

/** Whether the request carries a proxy header (came through `tailscale serve`/Funnel) — the one implementation. */
export function isProxied(headers: Record<string, unknown> | undefined): boolean {
  return PROXY_HEADERS.some((h) => headers?.[h] !== undefined);
}

/** Whether a `Host` header names this machine itself (port and brackets stripped); absent counts as local. */
export function hostHeaderIsLocal(h: string | string[] | undefined): boolean {
  const raw = Array.isArray(h) ? h[0] : h;
  if (!raw) return true;
  let host = raw.trim().toLowerCase();
  if (host.startsWith("[")) host = host.slice(1, host.indexOf("]") === -1 ? undefined : host.indexOf("]"));
  else if (host.split(":").length === 2) host = host.split(":")[0];
  if (!host) return true;
  return isLoopbackName(host);
}

/**
 * Why this request is not a process on THIS desktop, or null when it is: the
 * socket peer is loopback AND no proxy header is present. The gate of every
 * local-process-only route (`/api/hook`, `/api/plugin/:id/hook`,
 * `/api/shell/open`) and the first two tests of `agentCallerRefusal`.
 * Loopback alone is not enough — see `PROXY_HEADERS`.
 */
export function localProcessRefusal(remoteAddress: string | undefined, headers: Readonly<Record<string, string | string[] | undefined>>): string | null {
  if (peerKind(remoteAddress) !== "loopback") return "local only — this route answers a process on this desktop";
  if (isProxied(headers)) return "local only — a proxied request is not a process on this desktop";
  // A front proxy that forgets its headers makes every remote caller loopback; a local process
  // names this machine in Host, a request relayed for a tailnet name does not.
  if (!hostHeaderIsLocal(headers.host)) return "local only — a request named for another host is not a process on this desktop";
  // …and a page under a name the LAN answers for may call loopback by address: only `Origin` says so.
  if (unverifiedName(headers, "loopback") !== null) return "local only — a page under a name the network can fake is not a process on this desktop";
  return null;
}

/**
 * The trust tier of a REQUEST, not just its socket: a loopback socket carrying
 * a proxy header came through `tailscale serve` from another tailnet device,
 * so it is `tailscale` — gated when "gate Tailscale" is on, which before this
 * never applied to anyone using the https address. Only ever a DOWNGRADE from
 * loopback (a local process adding the header loses its exemption, nothing
 * more), and never touches a non-loopback peer.
 *
 * A loopback or tailnet request under a name only the local network vouches for (`unverifiedName`) is
 * `unknown`: the address is real, but the page asking may be anybody's. It needs a token and can never
 * manage auth, like a Wi-Fi client. Again only ever a downgrade. The token gate (`server/http.ts`,
 * `server/wsops.ts`) asks this; `localProcessRefusal` keeps its own stricter test.
 */
export function requestPeerKind(remoteAddress: string | undefined | null, headers: Readonly<Record<string, string | string[] | undefined>>): PeerKind {
  const kind = peerKind(remoteAddress);
  // `tailscale funnel` traffic comes through the same serve proxy, but from the
  // PUBLIC internet; the proxy marks it with `Tailscale-Funnel-Request` (and a
  // tailnet request never carries it). Treat it as public: always needs a
  // token, can never manage auth. A local process adding it only loses trust.
  if (kind === "loopback" && headers["tailscale-funnel-request"] !== undefined) return "public";
  if ((kind === "loopback" || kind === "tailscale") && unverifiedName(headers, kind) !== null) return "unknown";
  if (kind === "loopback" && (isProxied(headers) || !hostHeaderIsLocal(headers.host))) return "tailscale";
  return kind;
}

/**
 * The name in this request that made it `unknown` (`requestPeerKind`), host part only, or null when
 * no name did: the request is what its address says. A Funnel request is public first.
 */
export function unprovenName(remoteAddress: string | undefined | null, headers: Readonly<Record<string, string | string[] | undefined>>): string | null {
  const kind = peerKind(remoteAddress);
  if (kind !== "loopback" && kind !== "tailscale") return null;
  const raw = requestPeerKind(remoteAddress, headers) === "unknown" ? unverifiedName(headers, kind) : null;
  return raw === null ? null : raw.toLowerCase().replace(/^[a-z][a-z0-9+.-]*:\/\//, "").replace(/:\d+$/, "");
}

const namesSaid = new Set<string>();
/**
 * The log line for a request refused only because of the name it came under, once per name (a handful
 * at most: the origin gate has already refused every name that is not ours). Null when there is
 * nothing to say.
 */
export function unverifiedNameLine(remoteAddress: string | undefined | null, headers: Readonly<Record<string, string | string[] | undefined>>): string | null {
  const kind = peerKind(remoteAddress);
  const name = kind === "loopback" || kind === "tailscale" ? unverifiedName(headers, kind)?.toLowerCase() ?? null : null;
  if (name === null || namesSaid.size >= 20 || namesSaid.has(name)) return null;
  namesSaid.add(name);
  return `a request under ${JSON.stringify(name)} needs the password or a device token: another device on the network can answer for that name. ` +
    `Open this desktop by its Tailscale address, or as localhost on the desktop itself; for a reverse proxy with a certificate, list its https origin in ${envName("ALLOWED_ORIGINS")}.`;
}

/**
 * Whether this request came over the host's own TLS listener (`lantls.ts`). A fact about the
 * channel, never about the caller: peer kind stays what `requestPeerKind` says, so an encrypted
 * socket from the Wi-Fi is `lan`, gated like a plain one. `tailscale serve` terminates TLS in front
 * of us, so a request through it is a plain socket here, and rightly reads false.
 */
export function isEncryptedSocket(socket: object): boolean {
  return (socket as { encrypted?: boolean }).encrypted === true;
}

/** The SNI each handshake on a listener of ours asked for, as `noteTlsServerName` judged it. */
const serverNames = new WeakMap<object, string>();

/**
 * Remember the name a finished handshake asked for. Called once per connection, by the TLS listener
 * that serves a browser certificate, and never again: a renegotiation does not rename a socket.
 *
 * A TLS 1.2 resumption is remembered as nameless: no certificate is picked there and what OpenSSL then
 * reports has been the resumed session's name, not this hello's (on node 26 it is nothing at all). In
 * TLS 1.3 the name is always this hello's, and it resumes no session made under another name. Every
 * browser speaks 1.3.
 */
export function noteTlsServerName(socket: TLSSocket): void {
  if (serverNames.has(socket)) return;
  const name = socket.servername as string | false | null | undefined;
  serverNames.set(socket, name && (socket.getProtocol() === "TLSv1.3" || socket.isSessionReused() === false) ? name : "");
}

/** The server name of this socket's handshake; null on a plain socket, with no SNI, and on any listener that does not note it. */
export function tlsServerName(socket: object | undefined): string | null {
  return socket && isEncryptedSocket(socket) ? serverNames.get(socket) || null : null;
}

/** This desktop's name as a person would call it: the OS hostname, minus the
 *  `.local` mDNS suffix macOS appends. */
export function hostName(): string {
  return hostname().replace(/\.local$/i, "") || "desktop";
}

/** Interfaces a phone on the same Wi-Fi can never reach: VM and container
 *  bridges (OrbStack/UTM `bridge*` + `vmenet*`, Docker, libvirt, VirtualBox,
 *  VMware) and tunnels. Offering their addresses as a LAN link is a dead chip. */
const VIRTUAL_IFACE = /^(bridge|vmenet|vmnet|vboxnet|docker|br-|veth|virbr|utun|tun|tap|wg|zt|cni|flannel|lxc|lxd)/i;

export function lanIpsFrom(ifaces: ReturnType<typeof networkInterfaces>): string[] {
  const out: string[] = [];
  for (const [name, addrs] of Object.entries(ifaces)) {
    if (VIRTUAL_IFACE.test(name)) continue;
    for (const a of addrs ?? []) {
      if (a.family === "IPv4" && !a.internal && !a.address.startsWith("100.")) out.push(a.address);
    }
  }
  return out;
}

export function lanIps(): string[] {
  return lanIpsFrom(networkInterfaces());
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
    return bundled;
  } catch { /* not a Mac GUI install */ }

  // WSL with mirrored networking: Tailscale runs on Windows, and its CLI is reachable through
  // interop as `tailscale.exe` — on the Windows PATH WSL appends, else at its install path.
  if (RUNNING_IN_WSL) {
    let p = "";
    try { p = (await execFileP("/bin/sh", ["-c", "command -v tailscale.exe"])).stdout.trim(); } catch { /* Windows PATH not appended */ }
    const win = "/mnt/c/Program Files/Tailscale/tailscale.exe";
    if (!p) { try { await access(win, constants.X_OK); p = win; } catch { /* no Windows Tailscale */ } }
    // Found is not runnable: with WSL interop off, `command -v` and X_OK still pass and every .exe
    // then dies with "Exec format error". A CLI that cannot be run is no CLI (the doctor's
    // `wsl-interop` row says why).
    if (p && (await windowsExeRuns(p))) return p;
  }

  return null;
}

/** Whether a Windows `.exe` actually RUNS from here, remembered a minute per path (interop can come back without a restart). */
const exeRuns = new Map<string, { ok: boolean; at: number }>();
async function windowsExeRuns(p: string): Promise<boolean> {
  const seen = exeRuns.get(p);
  if (seen && Date.now() - seen.at < 60_000) return seen.ok;
  const ok = await execFileP(p, ["version"], { timeout: 5000 }).then(() => true, () => false);
  exeRuns.set(p, { ok, at: Date.now() });
  return ok;
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
    const { stdout } = await execFileP(bin, ["status", "--json"]);
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
  return (await serveFrontDoors(port)).usable;
}

/**
 * Every https front door of `port`: the `usable` one, and the `shadowed` one (or null each). A door
 * whose `Host` reads like a plain dial of the plain listener (`serve --https=8770` for a daemon on
 * 8770, or the bare 443 for a daemon on 80) cannot be told from a page dialing straight, which is
 * the one request `origin.ts` `hostProof` refuses a name for. Handing that URL out would lock out
 * whoever follows it, so it is not advertised; the doctor says why.
 */
export async function serveFrontDoors(port: number): Promise<{ usable: string | null; shadowed: string | null }> {
  const bin = await tailscaleBin();
  if (!bin) return { usable: null, shadowed: null };
  try {
    const { stdout } = await execFileP(bin, ["serve", "status", "--json"]);
    return sortFrontDoors(stdout, port);
  } catch { return { usable: null, shadowed: null }; /* no tailnet / CLI failed */ }
}

interface ServeNode { TCP?: Record<string, { TCPForward?: string }>; Web?: Record<string, { Handlers?: Record<string, { Proxy?: string }> }> }

/**
 * Every port `tailscale serve` hands to our `port` on, from `serve status --json`: https, http and raw
 * TCP doors, those of a foreground `serve` and of Services included. Null when it cannot be read.
 */
export function serveDoorPorts(statusJson: string, port: number): number[] | null {
  let cfg: (ServeNode & { Foreground?: Record<string, ServeNode>; Services?: Record<string, ServeNode> }) | null;
  try { cfg = JSON.parse(statusJson); } catch { return null; }
  if (!cfg || typeof cfg !== "object" || Array.isArray(cfg)) return null;
  const out = new Set<number>();
  const tail = (s: string) => Number(s.slice(s.lastIndexOf(":") + 1));
  for (const node of [cfg, ...Object.values(cfg.Foreground ?? {}), ...Object.values(cfg.Services ?? {})]) {
    for (const [hostPort, entry] of Object.entries(node?.Web ?? {})) {
      for (const h of Object.values(entry?.Handlers ?? {})) {
        let target: URL;
        try { target = new URL(h?.Proxy ?? ""); } catch { continue; }
        if (Number(target.port || (target.protocol === "https:" ? 443 : 80)) === port) out.add(tail(hostPort));
      }
    }
    for (const [p, h] of Object.entries(node?.TCP ?? {})) if (h?.TCPForward && tail(h.TCPForward) === port) out.add(Number(p));
  }
  return [...out];
}

/** The serve config's doors to `port`, or null: no CLI, no answer, not readable. */
export async function readDoorPorts(port: number): Promise<number[] | null> {
  const bin = await tailscaleBin();
  if (!bin) return null;
  return execFileP(bin, ["serve", "status", "--json"], { timeout: 3000 }).then(({ stdout }) => serveDoorPorts(stdout, port), () => null);
}

const DOORS_AGAIN_MS = 10_000;
let doorsReadAt = 0;
let doorsReading: Promise<void> | null = null;
/**
 * Read the doors again, if this loopback request names one we do not know: `tailscale serve` may have
 * been run since. Null: nothing to wait for. At most one reading per `DOORS_AGAIN_MS`, shared by whoever
 * waits; one that fails leaves what is known.
 */
export function learnFrontDoors(remoteAddress: string | undefined, headers: Readonly<Record<string, string | string[] | undefined>>, port: number, read = readDoorPorts, now = Date.now()): Promise<void> | null {
  const host = Array.isArray(headers.host) ? headers.host[0] : headers.host;
  if (peerKind(remoteAddress) !== "loopback" || !unknownDoor(host)) return null;
  if (doorsReading) return doorsReading;
  if (now - doorsReadAt < DOORS_AGAIN_MS) return null;
  doorsReadAt = now;
  doorsReading = read(port).then((ports) => { if (ports) noteFrontDoors(ports); }, () => { /* unread: as before */ }).finally(() => { doorsReading = null; });
  return doorsReading;
}

/** `tailscale serve status --json` sorted into the two kinds of door for `port` (see `serveFrontDoors`). */
export function sortFrontDoors(statusJson: string, port: number): { usable: string | null; shadowed: string | null } {
  const out: { usable: string | null; shadowed: string | null } = { usable: null, shadowed: null };
  try {
    const cfg = JSON.parse(statusJson) as {
      Web?: Record<string, { Handlers?: Record<string, { Proxy?: string }> }>;
    };
    for (const [hostPort, entry] of Object.entries(cfg.Web ?? {})) {
      for (const h of Object.values(entry.Handlers ?? {})) {
        if (!h.Proxy) continue;
        let target: URL;
        try { target = new URL(h.Proxy); } catch { continue; }
        // `new URL` drops a default port: `http://127.0.0.1:80` has none.
        if (Number(target.port || (target.protocol === "https:" ? 443 : 80)) !== port) continue;
        // ":443" is the bare https URL; any other port has to be shown.
        const url = hostPort.endsWith(":443") ? `https://${hostPort.slice(0, -4)}` : `https://${hostPort}`;
        // The port a browser spells in `Host`: none for 443, which reads as 80.
        const spelled = hostPort.endsWith(":443") ? 80 : Number(hostPort.slice(hostPort.lastIndexOf(":") + 1));
        if (spelled === port) out.shadowed ??= url;
        else out.usable ??= url;
      }
    }
  } catch { /* unparseable */ }
  return out;
}
