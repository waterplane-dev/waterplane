/**
 * Period-to-date DOLLARS, from the local ledger - the number a `usd` ceiling is
 * judged against and a period card prints.
 *
 * The fold itself is `tokenstats.ts`'s `costWindow` (the token store cut over
 * `[from, to)` and priced per model x day, hour buckets - which is why a month
 * needs no raise of the 35-day read cap: that cap guards `GET /api/costwindow`,
 * not the fold). This module only decides WHICH span each period asks for and
 * what may be believed afterwards.
 *
 * **The verdict is synchronous** (the backlog tick asks it several times a
 * second), the fold is not, so spend is a cache a timer refreshes. Three rules
 * keep a cache from becoming a wrong number:
 *  - an entry belongs to the period START it was measured for: past the reset a
 *    calendar period's cached total is about a month that has ENDED and reads as
 *    absent, which is exactly what releases a cap at the computed reset with no
 *    refresh and no event;
 *  - an entry older than `SPEND_STALE_MS` is absent too (a refresh that stopped
 *    must fail OPEN, like a stale `/usage` reading);
 *  - a fold that cannot answer (ledger never scanned) leaves the previous entry
 *    to age out and never records 0.
 *
 * The figure is THIS desktop at list price - not the invoice. The store holds
 * HOUR buckets only, so a period whose start or reset is not on the hour (a
 * half-hour zone, an unaligned span) cannot be summed exactly: it reads ABSENT,
 * never a figure up to an hour too wide. The trailing 30 days is folded over
 * whole hours (`hourFloor(now) - 30d` to the end of this hour: the last 720
 * hours plus the one running), so it is exact. A period's reset hour belongs to
 * the NEXT period: the span is `[start, reset)`.
 */
import { hourFloor, periodBounds, undatedClause, undatedWhy, type BudgetPeriod, type BudgetSpend, type BudgetSpendWhy, type PeriodId } from "@waterplane/shared";

const HOUR = 3_600_000;
/** How long a measured total is believed. */
export const SPEND_STALE_MS = 10 * 60_000;
/** How often the host re-folds while any dollar period exists. */
export const SPEND_REFRESH_MS = 60_000;

export interface PeriodSpendDeps {
  /** The dollar periods worth measuring (configured, unit usd). */
  periods(): readonly BudgetPeriod[];
  /** List-price USD over `[from, to)`, or null when the ledger cannot say, or `{ why }` when it
   *  can say WHY (`foldAnswer`). May reject. */
  fold(from: number, to: number): Promise<number | null | { why: string }>;
  now?: () => number;
}

/** The total of a folded document, or null when the ledger was never scanned or its scan is older than `SPEND_STALE_MS` (a stalled scan must fail open, not read as fresh). */
export function foldTotal(doc: { scannedAt: number; cost: { total: number }; undated?: number }, now = Date.now()): number | null {
  if (!(doc.scannedAt > 0) || now - doc.scannedAt > SPEND_STALE_MS) return null;
  // Records with no hour are in no period: the fold would be a floor that looks exact.
  if (undatedWhy(doc.undated)) return null;
  return Number.isFinite(doc.cost.total) ? doc.cost.total : null;
}

/** `foldTotal`, or — where the figure is refused for records the ledger could not date — the
 *  sentence naming that cause (shared `undatedClause`), so a dollar budget says why it is not
 *  holding rather than "usage could not be read". */
export function foldAnswer(doc: { scannedAt: number; cost: { total: number }; undated?: number }, now = Date.now()): number | null | { why: string } {
  const v = foldTotal(doc, now);
  if (v != null || !(doc.scannedAt > 0) || now - doc.scannedAt > SPEND_STALE_MS) return v;
  const why = undatedClause(doc.undated);
  return why ? { why } : null;
}

interface Entry { start: number; usd: number; at: number }

export class PeriodSpend {
  private cache = new Map<PeriodId, Entry>();
  private whys = new Map<PeriodId, { start: number; why: string; at: number }>();
  private busy: Promise<boolean> | null = null;
  constructor(private deps: PeriodSpendDeps) {}

  private clock = (): number => (this.deps.now ?? Date.now)();

  /** What may be believed right now, per period id. Absent = nobody measured. */
  get(now = this.clock()): BudgetSpend {
    const out: BudgetSpend = {};
    for (const p of this.deps.periods()) {
      const e = this.cache.get(p.id);
      if (!e || now - e.at > SPEND_STALE_MS || e.at > now + SPEND_STALE_MS) continue;
      const b = periodBounds(p, now);
      if (!b.active) continue;
      if (p.kind !== "rolling" && e.start !== b.start) continue; // measured for a period that has ended
      out[p.id] = e.usd;
    }
    return out;
  }

  /** Why a period has no figure right now, where the ledger said (fresh, same period start). */
  why(now = this.clock()): BudgetSpendWhy {
    const out: BudgetSpendWhy = {};
    const have = this.get(now);
    for (const p of this.deps.periods()) {
      const e = this.whys.get(p.id);
      if (!e || typeof have[p.id] === "number" || now - e.at > SPEND_STALE_MS || e.at > now + SPEND_STALE_MS) continue;
      const b = periodBounds(p, now);
      if (!b.active || (p.kind !== "rolling" && e.start !== b.start)) continue;
      out[p.id] = e.why;
    }
    return out;
  }

  /** Re-fold every dollar period. True when any figure moved. Never throws; concurrent calls share one run. */
  refresh(): Promise<boolean> {
    this.busy ??= this.run().finally(() => { this.busy = null; });
    return this.busy;
  }

  private async run(): Promise<boolean> {
    const now = this.clock();
    let changed = false;
    const live = new Set<PeriodId>();
    for (const p of this.deps.periods()) {
      live.add(p.id);
      const b = periodBounds(p, now);
      if (!b.active) continue;
      const nowHour = hourFloor(now);
      // Whole hours or nothing: rolling30d is re-cut to the last 720 whole hours; any other edge off the hour is unanswerable.
      const from = p.kind === "rolling" ? nowHour - p.lenMs : b.start;
      if (p.kind !== "rolling" && (b.start % HOUR !== 0 || (b.resetAt != null && b.resetAt % HOUR !== 0))) continue;
      const to = Math.min(nowHour + HOUR, b.resetAt ?? Infinity);
      let answer: number | null | { why: string } = null;
      try { answer = await this.deps.fold(from, to); } catch { answer = null; }
      if (answer != null && typeof answer === "object") {
        if (this.whys.get(p.id)?.why !== answer.why) changed = true;
        this.whys.set(p.id, { start: b.start, why: answer.why, at: now });
        continue;
      }
      const usd = answer;
      if (usd == null || !Number.isFinite(usd) || usd < 0) continue;
      this.whys.delete(p.id);
      const prev = this.cache.get(p.id);
      if (!prev || (p.kind !== "rolling" && prev.start !== b.start) || Math.round(prev.usd * 100) !== Math.round(usd * 100)) changed = true;
      this.cache.set(p.id, { start: b.start, usd, at: now });
    }
    for (const id of [...this.cache.keys()]) if (!live.has(id)) { this.cache.delete(id); changed = true; }
    for (const id of [...this.whys.keys()]) if (!live.has(id)) this.whys.delete(id);
    return changed;
  }
}
