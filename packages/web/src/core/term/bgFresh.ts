/**
 * Background freshness: what the open terminal does while the app is HIDDEN.
 *
 * The Android shell keeps the WebView alive behind the screen (the background
 * link's foreground service), so a session left open in the terminal used to
 * stream every TUI redraw — spinner frames included — to a page nobody was
 * looking at, with a 12 s heartbeat on top. That was most of a phone's battery
 * (1h35 of "background" in two hours).
 *
 * The other side of it is R-offline-002: walk into a dead zone and the last
 * screen you can read is the last one this phone SAVED. So it is a dial, per
 * device, never synced (a tablet on a charger and a phone in a pocket want
 * different answers):
 *
 *  - `live`  — as before: attached, streaming, heartbeat.
 *  - N ms    — detached while hidden; every N the terminal re-attaches from its
 *              last seq, the host replays only the delta, the tail is saved and
 *              it detaches again (one round trip, no stream).
 *  - `off`   — detached while hidden; what you read offline is the screen as it
 *              was when you left the app.
 *
 * Pure half here; the wiring is `useTermFeed.ts` and `ws.ts`'s heartbeat.
 */
import { LS, lsGet, lsSet } from "../../storage.ts";

export type BgFresh = "live" | "off" | number;

/** The slider's stops, freshest first. Hidden-page timers are throttled to
 *  once a minute by the WebView, so a minute is the shortest real interval. */
export const BG_FRESH_STEPS: readonly BgFresh[] = ["live", 60_000, 300_000, 900_000, "off"];
export const BG_FRESH_DEFAULT: BgFresh = 300_000;

export function parseBgFresh(raw: string | null | undefined): BgFresh {
  if (raw === "live" || raw === "off") return raw;
  const n = Number(raw);
  return raw && Number.isFinite(n) && BG_FRESH_STEPS.includes(n) ? n : BG_FRESH_DEFAULT;
}

export function bgFreshLabel(v: BgFresh): string {
  if (v === "live") return "live";
  if (v === "off") return "off";
  return `every ${Math.round(v / 60_000)} min`;
}

/** What a hidden app keeps of the terminal, as the row's note says it. */
export function bgFreshNote(v: BgFresh): string {
  if (v === "live") return "Hidden, the open session keeps streaming. Freshest offline screen, most battery.";
  if (v === "off") return "Hidden, the open session stops. Offline you read the screen as you left it.";
  return `Hidden, the open session stops and catches up ${bgFreshLabel(v)}. Offline you read a screen at most that old.`;
}

/** True when a hidden app should let go of the terminal stream. */
export function parksWhenHidden(v: BgFresh): boolean { return v !== "live"; }

/** The catch-up interval while parked, or null for none. */
export function catchUpMs(v: BgFresh): number | null { return typeof v === "number" ? v : null; }

export function bgFresh(): BgFresh { return parseBgFresh(lsGet(LS.bgFresh)); }
export function setBgFresh(v: BgFresh): void { lsSet(LS.bgFresh, String(v)); }
