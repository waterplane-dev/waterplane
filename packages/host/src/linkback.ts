/**
 * Desktop link-back push: this desktop's Tailscale link was down and is up again.
 *
 * Signal: `tailscale status --json` → `Self.Online`, polled every 60 s. It is the control-plane
 * view of this node ("peers can reach me"), which is what the phone needs; it goes false when the
 * desktop loses its internet (the usual DNS outage) because the node stops reaching the
 * coordination server. A failed or missing CLI is UNKNOWN: it neither starts an outage nor ends
 * one, and never fires.
 *
 * One push per outage, on the offline → online edge, only when the outage lasted ≥ `MIN_OFFLINE_MS`.
 * Nothing is sent while offline: the push is the edge itself, sent once online. Per-kind
 * notification prefs apply through `notify` (kind `link.back`, default ON).
 */
import { execFile } from "node:child_process";
import { hostName, tailscaleBin } from "./net.js";
import type { Notify } from "./notifytypes.js";

export const LINK_POLL_MS = 60_000;
export const LINK_MIN_OFFLINE_MS = 2 * 60_000;
const STATUS_TIMEOUT_MS = 8_000;

/** `null` = unknown (CLI missing, failed, unparsable). */
export type LinkReading = boolean | null;
export interface LinkState { offlineSince: number | null }

export function linkStep(state: LinkState, reading: LinkReading, now: number, minOfflineMs = LINK_MIN_OFFLINE_MS): { state: LinkState; offlineMs: number | null } {
  if (reading === null) return { state, offlineMs: null };
  if (!reading) return { state: { offlineSince: state.offlineSince ?? now }, offlineMs: null };
  if (state.offlineSince === null) return { state, offlineMs: null };
  const offlineMs = now - state.offlineSince;
  return { state: { offlineSince: null }, offlineMs: offlineMs >= minOfflineMs ? offlineMs : null };
}

export function linkBackText(host: string): { title: string; body: string } {
  return { title: `${host} is back`, body: `${host} is reachable again` };
}

export function parseSelfOnline(stdout: string): LinkReading {
  try {
    const v = (JSON.parse(stdout) as { Self?: { Online?: unknown } })?.Self?.Online;
    return typeof v === "boolean" ? v : null;
  } catch { return null; }
}

async function readSelfOnline(): Promise<LinkReading> {
  try {
    const bin = await tailscaleBin();
    if (!bin) return null;
    const out = await new Promise<string>((res, rej) =>
      execFile(bin, ["status", "--json"], { timeout: STATUS_TIMEOUT_MS, maxBuffer: 8 * 1024 * 1024 }, (e, so) => (e ? rej(e) : res(so))));
    return parseSelfOnline(out);
  } catch { return null; }
}

export interface LinkBackDeps {
  notify: Notify;
  read?: () => Promise<LinkReading>;
  now?: () => number;
  label?: () => string;
  everyMs?: number;
  minOfflineMs?: number;
}

export function createLinkBack(deps: LinkBackDeps): { check(): Promise<void>; start(): () => void } {
  const read = deps.read ?? readSelfOnline;
  const now = deps.now ?? Date.now;
  let state: LinkState = { offlineSince: null };
  let busy = false;
  async function check(): Promise<void> {
    if (busy) return;
    busy = true;
    try {
      const step = linkStep(state, await read(), now(), deps.minOfflineMs);
      state = step.state;
      if (step.offlineMs !== null) {
        const hostLabel = (deps.label ?? hostName)();
        deps.notify("link.back", { ...linkBackText(hostLabel), tag: "link.back", linkBack: { hostLabel, offlineMs: step.offlineMs } });
      }
    } finally { busy = false; }
  }
  return {
    check,
    start() {
      const t = setInterval(() => { void check(); }, deps.everyMs ?? LINK_POLL_MS);
      t.unref?.();
      return () => clearInterval(t);
    },
  };
}
