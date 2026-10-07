/**
 * The host tools' pure half — node-tested by `logic.test.mjs`: the one-line
 * host load, the `tailscale serve` command, and the list of ways to reach this
 * host. Each takes the welcome frame's facts (`ConnInfo`) and nothing else.
 */
import type { HostStat } from "@waterplane/shared";
import type { ConnInfo } from "../../sdk";

/** The desktop's CPU/memory load, as the toast says it. */
/** What the notifications screen says on a native shell with no background
 *  link and no push of its own (the iOS shell): the truth, not a switch. */
export const NO_BACKGROUND_ALERTS =
  "This app has no OS push and no background link — alerts show in the in-app feed while it is open.";

export function hostStatText(s: Pick<HostStat, "cpuPct" | "loadavg" | "cores" | "memTotal" | "memFree">): string {
  const gb = (b: number) => (b / 1e9).toFixed(1);
  const load = s.loadavg.map((n) => n.toFixed(2)).join("/");
  return `CPU ${s.cpuPct}% · load ${load} · ${s.cores} cores · mem ${gb(s.memTotal - s.memFree)}/${gb(s.memTotal)}G`;
}

/**
 * The HTTPS-enable command, shown as a copyable block when the context is
 * insecure. On a Mac GUI Tailscale install the CLI isn't on PATH, so the host
 * resolves the real binary path (bundle-internal) and it is spliced in — the
 * copied command then runs as-is instead of failing with `command not found:
 * tailscale`. 443 is the nice URL, but it is one slot on the whole machine — if
 * something else already serves there, `tailscale serve status` shows it and
 * any other free port works just as well (a secure context is about the scheme,
 * not the port).
 */
export function serveCmd(info: Pick<ConnInfo, "tailscaleBin" | "hostPort">): string {
  return `${info.tailscaleBin ?? "tailscale"} serve --bg --https=443 http://127.0.0.1:${info.hostPort}`;
}

export interface Endpoint { label: string; url: string; note: string }

/**
 * Reachable base URLs for this host — a one-tap way to hop the whole PWA to a
 * different path to the daemon: the HTTPS tailnet name (secure context → push
 * and install work), the raw Tailscale IP, or a LAN IP to bypass the tunnel on
 * the same WiFi. Tapping navigates the browser (new origin ⇒ full reload).
 */
export function endpoints(info: Pick<ConnInfo, "httpsUrl" | "tailscaleIp" | "lanIps" | "hostPort">): Endpoint[] {
  return [
    info.httpsUrl && { label: "Tailscale HTTPS", url: info.httpsUrl, note: "secure context — OS push, install & offline shell work" },
    info.tailscaleIp && { label: "Tailscale IP", url: `http://${info.tailscaleIp}:${info.hostPort}`, note: "over the tunnel, anywhere" },
    ...info.lanIps.map((ip) => ({ label: "LAN", url: `http://${ip}:${info.hostPort}`, note: "same WiFi — bypasses the tunnel" })),
  ].filter(Boolean) as Endpoint[];
}

/** A sign-in code as the clipboard gave it: the refusal to say, or null when it
 *  looks like a code. A code has no whitespace. */
export function loginCodeProblem(code: string): string | null {
  if (!code) return "phone clipboard is empty — copy the code from the sign-in page first";
  if (/\s/.test(code)) return "that does not look like a code — copy just the code and try again";
  return null;
}
