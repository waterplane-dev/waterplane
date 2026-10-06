// Cut from schedule.ts (move only): zones and the hours window
// The one door stays `./schedule.js`; this slice imports its siblings directly, never the barrel.

import type { ScheduleRule } from "./schedrule.js";

/**
 * The zone offset (ms east of UTC) at epoch `at`, for an IANA zone like
 * "Europe/Berlin". Null on an unknown/invalid zone.
 *
 * Shared with the limit-banner parser, which needs the same trick for the same
 * reason: a wall-clock time expressed in the USER's zone has to map to an epoch
 * even when the daemon's own process TZ differs.
 */
export function zoneOffsetMs(zone: string, at: number): number | null {
  try {
    const dtf = new Intl.DateTimeFormat("en-US", {
      timeZone: zone, hourCycle: "h23",
      year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", second: "2-digit",
    });
    const p: Record<string, number> = {};
    for (const part of dtf.formatToParts(new Date(at))) if (part.type !== "literal") p[part.type] = Number(part.value);
    const asUTC = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
    return asUTC - at;
  } catch {
    return null; // not a real IANA zone
  }
}

/** Epoch ms for a Y/M/D h:m wall clock interpreted in `zone` (null → host-local). */
export function wallClockToEpoch(y: number, mo: number, d: number, h: number, mi: number, zone: string | null): number {
  if (!zone) return new Date(y, mo, d, h, mi, 0, 0).getTime();
  const guess = Date.UTC(y, mo, d, h, mi, 0);
  // Two passes settle the DST edge (the offset can differ between the UTC guess
  // and the resolved instant); an unknown zone falls back to host-local.
  let off = zoneOffsetMs(zone, guess);
  if (off == null) return new Date(y, mo, d, h, mi, 0, 0).getTime();
  let e = guess - off;
  off = zoneOffsetMs(zone, e) ?? off;
  return guess - off;
}

/** The calendar date `at` falls on, as the wall clock in `zone` sees it. */
export function zoneDate(zone: string | null, at: number): { y: number; mo: number; d: number } {
  const off = zone ? zoneOffsetMs(zone, at) : null;
  const shifted = new Date(off != null ? at + off : at);
  return off != null
    ? { y: shifted.getUTCFullYear(), mo: shifted.getUTCMonth(), d: shifted.getUTCDate() }
    : { y: shifted.getFullYear(), mo: shifted.getMonth(), d: shifted.getDate() };
}

/**
 * The wall clock at `at`, as MINUTES OF DAY in `zone`.
 *
 * Deliberately the same shape as `zoneDate` above — one shift through
 * `zoneOffsetMs`, then read the shifted instant as if it were UTC, with the
 * host-local fallback for a zone that did not resolve. There is exactly one way
 * of turning an epoch into a local reading in this file and this is it: a
 * second one (a hand-rolled `Intl` format, a `getHours()` on the raw instant)
 * would answer differently across a DST edge, which is the drift the zone is
 * stored to prevent in the first place.
 */
function zoneMinuteOfDay(zone: string | null, at: number): number {
  const off = zone ? zoneOffsetMs(zone, at) : null;
  const shifted = new Date(off != null ? at + off : at);
  return off != null
    ? shifted.getUTCHours() * 60 + shifted.getUTCMinutes()
    : shifted.getHours() * 60 + shifted.getMinutes();
}

/**
 * **Is `at` inside this rule's run window?** True whenever there is no window,
 * which is what makes every rule written before `hours` existed answer the
 * same as it always did.
 *
 * The window is half-open — `from` is inside it, `to` is not — so 07:00–22:00
 * and 22:00–07:00 are complements rather than two windows that both claim
 * 22:00. It wraps: a `from` after its `to` is a night window, and the test
 * becomes an OR rather than an AND.
 */
export function inHours(rule: ScheduleRule, at: number): boolean {
  const h = rule.hours;
  if (!h) return true;
  const m = zoneMinuteOfDay(rule.tz || null, at);
  return h.from <= h.to ? m >= h.from && m < h.to : m >= h.from || m < h.to;
}

/**
 * **The first instant at or after `at` when the run window is open** — the
 * basis a late occurrence's grace is measured from, and `null` when it cannot
 * be worked out.
 *
 * Why the grace moves with the window and not with the anchor: a rule anchored
 * at 03:00 with a 07:00–22:00 window is DUE at 03:00 and may not run until
 * 07:00, so measuring two hours of grace from 03:00 means the row is "missed"
 * at 05:00 — every single day, having never once been allowed to try. The
 * grace exists to say how late a run is still worth doing; four hours of it
 * spent waiting for permission is not lateness, it is the schedule working.
 *
 * `null` rather than a guess when no opening resolves (only reachable through
 * a zone that stopped resolving between two calls). The caller falls back to
 * the anchor, which is the OLD behaviour and the conservative direction —
 * more likely to call a run missed, never more likely to fire one at an hour
 * the user shut the door on.
 */
export function hoursOpenFrom(rule: ScheduleRule, at: number): number | null {
  if (!rule.hours) return at;
  if (inHours(rule, at)) return at;
  const tz = rule.tz || null;
  const { y, mo, d } = zoneDate(tz, at);
  const hour = Math.floor(rule.hours.from / 60);
  const minute = rule.hours.from % 60;
  // Today's opening, then tomorrow's: `at` is outside the window, so one of the
  // two is ahead of it. Every candidate is resolved through the zone afresh,
  // for `nextFireAt`'s reason — a DST weekend must not move the opening.
  for (let k = 0; k <= 2; k++) {
    const open = wallClockToEpoch(y, mo, d + k, hour, minute, tz);
    if (open >= at) return open;
  }
  return null;
}

/**
 * A run window as a row says it: "22:00–07:00". Null when there is none — the
 * ONE spelling, so the rule line and the wait sentence agree.
 *
 * The ZONE is deliberately not in here. `hours` is minutes of day in `rule.tz`,
 * and every caller sits somewhere different in its own sentence — beside an
 * anchor that already names the zone (`describeRule`'s weekly line), at the end
 * of a paragraph (`hoursWords`), inside a parenthesis (`hoursText`) — so each
 * appends `rule.tz` where its own sentence has room, and this stays the spelling
 * of the WINDOW. `hoursZone` below is the one wording for the suffix, including
 * what an absent zone means: the host's clock, said out loud, because a rule
 * with hours and no zone is exactly the rule that silently moves when the
 * daemon's `TZ` does.
 */
export function describeHours(rule: ScheduleRule): string | null {
  const h = rule.hours;
  if (!h) return null;
  const hm = (min: number) => `${String(Math.floor(min / 60)).padStart(2, "0")}:${String(min % 60).padStart(2, "0")}`;
  return `${hm(h.from)}–${hm(h.to)}`;
}

/**
 * **Whose clock the run window is read on**, as a suffix: `" Europe/Berlin"`,
 * or `" host clock"` when the rule carries no zone.
 *
 * Absent is not silence here. `inHours` falls back to the host process's zone
 * when `tz` is missing, which is a real reading and a real risk — the window
 * moves with the daemon's `TZ`, not with the person who typed it — so a row
 * that shows only "07:00–22:00" is showing the zone-less case as though it were
 * the ordinary one. Every rule the sheet writes now carries a zone
 * (`composeRule` takes the device's); what is left saying "host clock" is a
 * legacy or hand-edited rule, which is precisely the one worth flagging.
 */
export function hoursZone(rule: ScheduleRule): string {
  return rule.tz ? ` ${rule.tz}` : " host clock";
}
