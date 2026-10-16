/**
 * **A slot: the waiting timed rows that fire TOGETHER** — the one bucketing
 * function behind the slot check (smart pick's replacement, 2026-10-16).
 *
 * The phone asks it twice — the send receipt's "3 others run at this reset"
 * and the backlog group header's *check these N* — and the host asks it once,
 * to know which rows a slot-scoped assessment may judge. CLAUDE.md: a count on
 * a control is a filter, so the number and the cut come from THIS function and
 * nowhere else; `slotMates` is the cut and its `.length` is the number.
 *
 * ── What a slot is ─────────────────────────────────────────────────────────
 *
 *  • **Same usage-window reset.** A `window` rule's occurrence is
 *    `reset + offset` (`nextFireAt`), so the reset it hangs off is read back
 *    from its own armed `nextAt` — `before` and `after` edges alike, any lead
 *    time. Rows on the same period whose resets sit within `RESET_MATCH_MS`
 *    are one slot: the CLI's *resets in 1h 59m* lands on two neighbouring
 *    minutes between scrapes (`budgetpass.ts` measured it), and no other
 *    reset of the same period is closer than hours.
 *  • **Same instant.** Every other one-off (`once`, a one-shot `weekly`) is
 *    its `nextAt`; instants within `RESET_MATCH_MS` of each other are one slot.
 *  • **A one-off instant that lands on a window slot JOINS it** — when it is
 *    within tolerance of that slot's reset, or of any member's own fire
 *    instant. They fire together, which is the whole question a slot answers;
 *    splitting them because one was typed as "18:00" and the other as "at
 *    the reset" would hide exactly the pair most likely to collide.
 *
 * Recurring rules (`isScheduleRow` — a standing schedule is a rule, not one
 * piece of work), untimed rows, rows not yet armed (`nextAt` absent: a
 * `window` rule before the first usage scrape has no reset to compare), and
 * rows that are not WAITING (running, settled, archived) are in no slot.
 *
 * ── Deterministic, and never a chain ───────────────────────────────────────
 *
 * Clustering is greedy from the EARLIEST instant: a cluster takes everything
 * within tolerance of its first member, so four one-offs 4 minutes apart are
 * two slots, never one 12-minute slot grown link by link. Both ends running
 * this over the same rows get the same slots, the same keys and the same
 * member order (input order).
 *
 * The key (`reset:<period>:<ms>` / `at:<ms>`) names the slot on the wire
 * (`AssessScope`). The two ends may read one reset a minute apart, so a key is
 * matched back with tolerance (`findSlot`), never by string equality.
 *
 * ── Merging across clocks ──────────────────────────────────────────────────
 *
 * `latestClock`: a merge of rows on different clocks inside one slot ("1h
 * before" + "30m before" one reset) carries the LATEST member's clock, so the
 * merged row never runs earlier than any member asked. A near-tie between two
 * DIFFERENT rules is null — which one is later can flip on the next scrape —
 * and so is any member without an armed instant. The grace is the caller's:
 * this answers WHEN, and the host keeps the chosen member's own `graceMin`.
 *
 * Pure: no clock, no host. `test/slot.test.mjs`.
 */

import type { ScheduleRule } from "../schedule.js";
import { ruleRecurs } from "../schedule.js";
import type { Intent } from "./row.js";
import { RESET_MATCH_MS } from "./budgetpass.js";
import { isTimedWorkRow } from "./kind.js";

/**
 * The one input shape — what both an `Intent` and a `BacklogItem` reduce to.
 * Build it with `slotRowOfIntent` / `slotRowOfItem`, never by hand, so the two
 * ends agree on what "waiting" means.
 */
export interface SlotRow {
  id: string;
  rule: ScheduleRule;
  /** The armed instant; absent/null = not armed, in no slot. */
  nextAt?: number | null;
  /** Still to run: not started, not settled, not archived. */
  waiting: boolean;
}

/** One slot. `ids` in input order; `at` is the reset (`reset`) or the first
 *  member's instant (`instant`) — the cluster's anchor. */
export interface Slot {
  key: string;
  kind: "reset" | "instant";
  /** `reset` only: the period the reset belongs to (`session`, `weekly`, or a
   *  configured `periodId`). */
  period?: string;
  at: number;
  ids: string[];
}

/** An `Intent` as a slot row, or null when it can never be in a slot. */
export function slotRowOfIntent(i: Intent): SlotRow | null {
  if (!isTimedWorkRow(i) || i.trigger.kind !== "at") return null;
  return {
    id: i.id,
    rule: i.trigger.rule,
    nextAt: i.nextAt,
    waiting: !i.archived && (i.state === "queued" || i.state === "blocked"),
  };
}

/** A phone `BacklogItem` (structurally — only these fields are read) as a slot
 *  row, or null when it carries no clock. `queued` is the item's only waiting
 *  status. */
export function slotRowOfItem(b: {
  id: string; status: string; archived?: boolean;
  at?: { rule: ScheduleRule; nextAt: number | null };
}): SlotRow | null {
  if (!b.at) return null;
  return { id: b.id, rule: b.at.rule, nextAt: b.at.nextAt, waiting: !b.archived && b.status === "queued" };
}

interface Anchored {
  row: SlotRow;
  fire: number;
  /** `window` rows only. */
  reset?: number;
  period?: string;
}

function anchorOf(r: SlotRow): Anchored | null {
  if (!r || !r.waiting || !r.rule || ruleRecurs(r.rule)) return null;
  const fire = r.nextAt;
  if (typeof fire !== "number" || !Number.isFinite(fire)) return null;
  if (r.rule.kind !== "window") return { row: r, fire };
  // `nextFireAt`'s arithmetic read backwards: `after` adds a non-negative lead,
  // `before` adds the (negative) offset as written.
  const off = (r.rule.offsetMin ?? 0) * 60_000;
  const reset = fire - (r.rule.edge === "after" ? Math.max(0, off) : off);
  const period = r.rule.periodId ?? (r.rule.window === "weekly" ? "weekly" : "session");
  return { row: r, fire, reset, period };
}

const byInstant = (a: number, b: number, ia: string, ib: string): number => a - b || (ia < ib ? -1 : ia > ib ? 1 : 0);

/** Every slot among these rows, singletons included (a slot of one is a row
 *  that fires alone). Sorted by `at`, then key. */
export function slotsOf(rows: readonly SlotRow[]): Slot[] {
  const order = new Map<string, number>();
  const anchored: Anchored[] = [];
  rows.forEach((r, n) => {
    const a = anchorOf(r);
    if (!a || order.has(r.id)) return;
    order.set(r.id, n);
    anchored.push(a);
  });

  // 1. Reset slots, per period, greedy from the earliest reading.
  const resetSlots: { slot: Slot; fires: number[] }[] = [];
  const windows = anchored.filter((a) => a.reset != null)
    .sort((a, b) => byInstant(a.reset as number, b.reset as number, a.row.id, b.row.id));
  const periods = [...new Set(windows.map((a) => a.period as string))].sort();
  for (const p of periods) {
    let cur: { slot: Slot; fires: number[] } | null = null;
    for (const a of windows) {
      if (a.period !== p) continue;
      if (!cur || (a.reset as number) - cur.slot.at > RESET_MATCH_MS) {
        cur = { slot: { key: `reset:${p}:${a.reset}`, kind: "reset", period: p, at: a.reset as number, ids: [] }, fires: [] };
        resetSlots.push(cur);
      }
      cur.slot.ids.push(a.row.id);
      cur.fires.push(a.fire);
    }
  }

  // 2. Instants: join the nearest reset slot they fire with, else cluster.
  const loose: Anchored[] = [];
  const instants = anchored.filter((a) => a.reset == null).sort((a, b) => byInstant(a.fire, b.fire, a.row.id, b.row.id));
  for (const a of instants) {
    let best: { slot: Slot; fires: number[] } | null = null;
    let bestD = Infinity;
    for (const s of resetSlots) {
      const d = Math.min(Math.abs(a.fire - s.slot.at), ...s.fires.map((f) => Math.abs(a.fire - f)));
      if (d <= RESET_MATCH_MS && (d < bestD || (d === bestD && best && byInstant(s.slot.at, best.slot.at, s.slot.key, best.slot.key) < 0))) {
        best = s; bestD = d;
      }
    }
    if (best) best.slot.ids.push(a.row.id);
    else loose.push(a);
  }
  const out: Slot[] = resetSlots.map((s) => s.slot);
  let cur: Slot | null = null;
  for (const a of loose) {
    if (!cur || a.fire - cur.at > RESET_MATCH_MS) {
      cur = { key: `at:${a.fire}`, kind: "instant", at: a.fire, ids: [] };
      out.push(cur);
    }
    cur.ids.push(a.row.id);
  }
  for (const s of out) s.ids.sort((x, y) => (order.get(x) as number) - (order.get(y) as number));
  return out.sort((a, b) => byInstant(a.at, b.at, a.key, b.key));
}

/** The slot this row is in, or null (not waiting, recurring, untimed, unarmed). */
export function slotOf(rows: readonly SlotRow[], id: string): Slot | null {
  return slotsOf(rows).find((s) => s.ids.includes(id)) ?? null;
}

/** The OTHER waiting rows that fire with this one — the cut a *check these*
 *  opens, and (by `.length`) the count on it. Empty when it fires alone. */
export function slotMates(rows: readonly SlotRow[], id: string): string[] {
  return slotOf(rows, id)?.ids.filter((x) => x !== id) ?? [];
}

/** Parse a slot key: `reset:<period>:<ms>` or `at:<ms>`. Null on anything else. */
export function parseSlotKey(key: string): { kind: "reset" | "instant"; period?: string; at: number } | null {
  if (typeof key !== "string") return null;
  const cut = key.lastIndexOf(":");
  const at = Number(key.slice(cut + 1));
  if (cut < 0 || !Number.isFinite(at) || !/^\d+$/.test(key.slice(cut + 1))) return null;
  if (key.startsWith("at:") && cut === 2) return { kind: "instant", at };
  if (key.startsWith("reset:") && cut > 6) return { kind: "reset", period: key.slice(6, cut), at };
  return null;
}

/**
 * The slot a key names, matched with `RESET_MATCH_MS` tolerance — the phone and
 * the host may read one reset a minute apart, so the host never compares keys
 * as strings. Null when nothing among these rows is that slot any more.
 */
export function findSlot(rows: readonly SlotRow[], key: string): Slot | null {
  const k = parseSlotKey(key);
  if (!k) return null;
  let best: Slot | null = null;
  for (const s of slotsOf(rows)) {
    if (s.kind !== k.kind || s.period !== k.period) continue;
    const d = Math.abs(s.at - k.at);
    if (d <= RESET_MATCH_MS && (!best || d < Math.abs(best.at - k.at))) best = s;
  }
  return best;
}

/** What a rule's instant moves with: the clock itself, or one window's scraped reset. */
const clockAnchor = (r: ScheduleRule): string =>
  r.kind === "window" ? `window:${r.window ?? "session"}:${r.periodId ?? ""}` : "clock";

/** What `latestClock` reads off a member. */
export interface ClockMember {
  rule: ScheduleRule;
  nextAt?: number | null;
}

/**
 * The clock a merged row carries: the member that fires LAST, returned whole
 * so the caller keeps its grace and hold. Null on an empty list, a member with
 * no armed instant, or a near-tie (within `RESET_MATCH_MS`) between two
 * members on different ANCHORS — a heuristic degrades to null, never to a wrong
 * clock.
 *
 * Only a different anchor makes "which fires last" uncertain: a window rule's
 * instant moves with the scraped reset, a one-off's does not, so a one-off two
 * minutes after a reset-relative row may really be before it. Two one-offs are
 * exact instants, and two offsets from the same window move together, so those
 * near-ties are ordered as read. (Refusing every near-tie between different
 * rules refused most merges in a slot — a slot IS rows within that tolerance.)
 */
export function latestClock<T extends ClockMember>(members: readonly T[]): T | null {
  if (!members.length) return null;
  let last: T | null = null;
  for (const m of members) {
    if (!m || typeof m.nextAt !== "number" || !Number.isFinite(m.nextAt)) return null;
    if (!last || m.nextAt > (last.nextAt as number)) last = m;
  }
  if (!last) return null;
  const top = last.nextAt as number;
  const anchor = clockAnchor(last.rule);
  for (const m of members) {
    if (top - (m.nextAt as number) <= RESET_MATCH_MS && clockAnchor(m.rule) !== anchor) return null;
  }
  return last;
}

/** The receipt's sentence for a crowded slot: "3 others run at this reset". */
export function slotOthersText(others: number, kind: Slot["kind"]): string {
  const where = kind === "reset" ? "at this reset" : "at this time";
  return others === 1 ? `1 other runs ${where}` : `${others} others run ${where}`;
}
