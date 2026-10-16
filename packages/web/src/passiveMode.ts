/**
 * Passive device mode on the phone — the kids' phone (R-connection-011…014).
 *
 * **The host is the boundary; this is a courtesy.** A passive token is refused
 * on every route but the app-update path and on the socket (`host/passive.ts`),
 * so this module only decides which ONE screen to draw: the passive screen
 * (`PassiveScreen.tsx`: its apps, the last check, a small "Unlock") or the
 * whole app with an "Unlocked until HH:MM · Lock now" bar.
 *
 * The decision is `bootMode`, pure: the host's answer when there is one, the
 * remembered mark (`LS.passive`, set at a passive redeem and by every status
 * read) when there is not — so a cold start with the desktop out of reach opens
 * on the passive screen too, and never opens a socket that would be refused.
 */
import type { PassiveAuthFields, PullItem } from "@waterplane/shared";
import { isPassiveItem } from "@waterplane/shared";
import { LS, lsDel, lsGet, lsSet } from "./storage.ts";

export type BootMode = "passive" | "full";

/** Which screen: the host's word when it answered, else the remembered mark. */
export function bootMode(cachedPassive: boolean, status: PassiveAuthFields | null, now = Date.now()): BootMode {
  if (!status) return cachedPassive ? "passive" : "full";
  if (status.scope !== "passive") return "full";
  return status.unlockedUntil && status.unlockedUntil > now ? "full" : "passive";
}

export function cachedPassive(): boolean { return lsGet(LS.passive) === "1"; }

/** Remember what the host said about this phone's token. */
export function rememberPassive(status: PassiveAuthFields | null): void {
  if (!status) return;
  if (status.scope === "passive") lsSet(LS.passive, "1");
  else lsDel(LS.passive);
}

/** The rows the passive screen draws: APKs only, newest first. */
export function passiveRows<T extends { item: Pick<PullItem, "name" | "relPath" | "ts"> }>(records: readonly T[]): T[] {
  return records.filter((r) => isPassiveItem(r.item)).sort((a, b) => b.item.ts - a.item.ts);
}

/** One line per app row, in the Downloads sheet's words. */
export function passiveRowText(r: { state: string; received: number; item: { size: number }; error?: string }): string {
  switch (r.state) {
    case "queued": return "new build — waiting to download";
    case "downloading": {
      const pct = r.item.size > 0 ? Math.min(99, Math.floor((r.received / r.item.size) * 100)) : null;
      return pct === null ? "downloading" : `downloading ${pct}%`;
    }
    case "paused": return "download paused";
    case "done": return "downloaded — installs itself if this app is allowed to";
    case "failed": return r.error ? `download failed: ${r.error}` : "download failed — tries again on the next check";
    default: return r.state;
  }
}

/** When a running unlock should reload the page: just after the host ended it. */
export function relockDelayMs(unlockedUntil: number, now = Date.now()): number {
  return Math.max(0, unlockedUntil - now) + 750;
}
