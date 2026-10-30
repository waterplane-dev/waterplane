/**
 * A backend's OWN ledger cut to a span: what Copilot, Codex, Gemini or opencode spent over the
 * span a claude card is showing (`docs/analysis/backend-parity-v3/c2.md` §1).
 *
 * Shown BESIDE claude's figure, never in it: each backend is its own account and its own kinds,
 * so nothing here adds one ledger to another, to claude's tokens or to a dollar, and no verdict
 * reads it. The kinds stay apart; the native unit (Copilot's AI credits) is never converted.
 *
 * **The span is cut on the ledger's HOURS, never its days.** A ledger's `days` are the host's
 * local calendar day, while a claude period is `[start, reset)` in the period's own zone and a
 * week window starts at whatever minute it reset — a day summed into either puts up to 23 hours
 * of spend into the wrong span. So the cut reads `hourly` (each row the start of the HOST's local
 * hour — the same bucket claude's ledger keeps, `hourFloor`) and answers ABSENT, with the sentence
 * that says why, wherever it cannot be exact: no hours kept, an edge off the hour, a span reaching
 * past the hours kept, records after `to` in `to`'s own hour, records it could not date
 * (`hourly.undated`), a stalled scan.
 */
import { hourFloor } from "./costwindow.js";
import { fmtCount, fmtNative } from "./tokens.js";
import type { CostWindowBeside } from "./wire/costwindow.js";

const HOUR = 3_600_000;
/** A ledger scanned longer than this before the span's end is a floor, not a figure — absent
 *  (`periodspend.ts`'s `SPEND_STALE_MS`: a stalled scan fails open). */
export const LEDGER_SPAN_STALE_MS = 10 * 60_000;

/** One hour of a backend ledger. `hour` = start of the host's local hour (`hourFloor`). */
export interface LedgerHourRow {
  hour: number;
  /** The backend's own kinds, never folded into one another. */
  kinds: Record<string, number>;
  /** The native unit's amount in this hour (`unit.name` on the document). Absent = none. */
  unit?: number;
}

/** The hour slot a ledger may carry (`BackendTokensDoc.hourly`, and opencode's own document). */
export interface LedgerHourly {
  /** The earliest hour kept (an hour start). A ledger may keep hours for less than its reach. */
  from: number;
  /** Ascending; only hours with activity. */
  rows: LedgerHourRow[];
  /** Records in the ledger's totals that NO row holds because they carry no readable instant.
   *  Above 0, any span could be missing them, so a cut is a floor and reads ABSENT. Absent =
   *  a ledger (or an older host) that does not say: cut as before. */
  undated?: number;
}

/** The part of a ledger the cut reads — structural, so a backend with its own document type
 *  (opencode's) is cut by the same rule without core reading the rest of it. */
export interface LedgerSpanInput {
  available: boolean;
  hourly?: LedgerHourly;
  unit?: { name: string };
  firstAt?: number | null;
  lastAt?: number | null;
  scannedAt?: number;
}

export type LedgerSpan =
  /** Nothing to say: no store here, or nothing ran in the span. Not a line at all. */
  | { kind: "none" }
  | { kind: "absent"; why: string }
  | { kind: "spent"; kinds: Record<string, number>; unit?: { name: string; amount: number } };

const fin = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n);
const onHour = (t: number) => hourFloor(t) === t;
const when = (t: number) => {
  const d = new Date(t);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")} ${String(d.getHours()).padStart(2, "0")}:00`;
};

/**
 * THE rule for a ledger that counted records it could not date (`LedgerHourly.undated`, and the
 * same field on claude's own documents — `TokenStatsDoc`, `CostWindowDoc`, `TokenWindowsDoc`):
 * those records are in its totals and in no hour, so ANY sum of its hours over a span is a floor
 * that looks exact. Null = cut as usual (none undated, or a ledger/older host that does not say);
 * else the reason, worded to follow a ledger's name (`label: why`, the beside-line form).
 * One copy: `ledgerOverSpan` and every reader of claude's span figures ask this.
 */
export function undatedWhy(undated: unknown): string | null {
  if (undated == null) return null;
  if (!fin(undated) || undated < 0) return "its ledger holds a figure that is not a count";
  if (undated === 0) return null;
  // The count is the one `undatedSince` gives for THIS span (an upper bound past the pair cap), not
  // the ledger's all-time total — so the sentence says the records could fall here, not that they do.
  return `holds ${fmtCount(undated)} record${undated === 1 ? "" : "s"} it could not date that could fall in this span, so the figure could be missing ${undated === 1 ? "it" : "them"}`;
}

/** How many `[mtime, count]` pairs `TokenStatsDoc.undatedLogs` carries at most (`undatedLogsOf`). */
export const UNDATED_LOGS_CAP = 32;

/**
 * The per-log list a document carries beside `undated` (`undatedLogs`): one `[mtime, count]` pair
 * per log holding records it could not date, ascending by mtime, one pair per mtime. A log with an
 * unknown mtime (or a zero count) gets no pair — it stays in `undated` and is never subtracted.
 * BOUNDED at `UNDATED_LOGS_CAP`: past it the OLDEST pair is merged into the next one under that
 * one's (newer) mtime, so a merged count reaches into MORE spans, never fewer — the newest logs,
 * the ones a current window can hold, stay exact. The host builds it; `undatedSince` reads it.
 */
export function undatedLogsOf(pairs: Iterable<readonly [number, number]>): Array<[number, number]> {
  const byM = new Map<number, number>();
  for (const [m, k] of pairs) if (fin(m) && fin(k) && k > 0) byM.set(m, (byM.get(m) ?? 0) + k);
  const out = [...byM].sort((a, b) => a[0] - b[0]);
  while (out.length > UNDATED_LOGS_CAP) {
    const [, k] = out.shift()!;
    out[0] = [out[0][0], out[0][1] + k];
  }
  return out;
}

/**
 * THE count of `undated` records that could fall in a span `[from, to)` — the ONE function the
 * host's `/api/costwindow` and every phone sentence ask, so one window says one N everywhere.
 * A record is never later than its log's mtime, so a log last written before `from` holds none of
 * the span's records; `to` bounds nothing (a record can be any time before its mtime).
 * Reads, most exact first: `undatedLogs` (per-log pairs: the total minus every pair older than
 * `from`), then `undatedUntil` (the newest such mtime: 0 when it is older than `from`, else the
 * whole count). Anything it cannot read (no list, pairs that outnumber the total, a non-number)
 * falls back a rung, ending at the whole count — sound, never a wrong number. An older document
 * without either field reads as before. Feed the answer to `undatedWhy`/`undatedText`.
 */
export function undatedSince(
  doc: { undated?: unknown; undatedUntil?: unknown; undatedLogs?: unknown } | null | undefined,
  from: number,
): unknown {
  const n = doc?.undated;
  if (!fin(n) || n <= 0) return n;
  const logs = doc?.undatedLogs;
  if (Array.isArray(logs) && fin(from)) {
    let listed = 0;
    let before = 0;
    let ok = true;
    for (const p of logs) {
      if (!Array.isArray(p) || !fin(p[0]) || !fin(p[1]) || p[1] < 0) { ok = false; break; }
      listed += p[1];
      if (p[0] < from) before += p[1];
    }
    if (ok && listed <= n) return n - before;
  }
  const until = doc?.undatedUntil;
  return fin(until) && fin(from) && until < from ? 0 : n;
}

/** The label claude's own span figures are refused under — the backend's name, as a beside line. */
export const CLAUDE_LEDGER_LABEL = "Claude Code";

/** `undatedWhy` as a clause naming claude's ledger — what a budget that cannot read its window
 *  says in place of the reason it would otherwise guess. Null when nothing is undated. */
export function undatedClause(undated: unknown): string | null {
  const why = undatedWhy(undated);
  return why ? `${CLAUDE_LEDGER_LABEL}'s ledger ${why.replace(/^its ledger /, "")}` : null;
}

/** `undatedWhy` as the sentence a claude span figure prints in its place, or null to draw it. */
export function undatedText(undated: unknown, label = CLAUDE_LEDGER_LABEL): string | null {
  const why = undatedWhy(undated);
  return why ? `${label}: ${why}.` : null;
}

/**
 * `doc` over `[from, to)`. `to` may be "now" (off the hour): the running hour is then counted
 * only when nothing in the ledger is later than `to` — else that hour's row holds spend from
 * after the span, and the answer is absent.
 */
export function ledgerOverSpan(doc: LedgerSpanInput | null | undefined, from: number, to: number, now = Date.now()): LedgerSpan {
  if (!doc || doc.available !== true) return { kind: "none" };
  if (!fin(from) || !fin(to) || !(to > from)) return { kind: "absent", why: "the span asked for is not a span" };
  const h = doc.hourly;
  if (!h || !fin(h.from) || !Array.isArray(h.rows)) {
    return { kind: "absent", why: "keeps its ledger by day, so it cannot be cut to this span" };
  }
  const undated = undatedWhy(h.undated);
  if (undated) return { kind: "absent", why: undated };
  if (!onHour(from)) return { kind: "absent", why: "this span does not start on the hour, and the ledger keeps hours" };
  const last = fin(doc.lastAt) ? doc.lastAt : null;
  if (!onHour(to) && last != null && last > to) {
    return { kind: "absent", why: "this span ends inside an hour the ledger has later spend in" };
  }
  const first = fin(doc.firstAt) ? doc.firstAt : null;
  if (from < h.from && first != null && first < h.from) {
    return { kind: "absent", why: `keeps hours only since ${when(h.from)}, and this span starts earlier` };
  }
  if (!fin(doc.scannedAt) || !(doc.scannedAt > 0) || Math.min(to, now) - doc.scannedAt > LEDGER_SPAN_STALE_MS) {
    return { kind: "absent", why: "its ledger has not been read recently enough to count this span" };
  }
  const end = onHour(to) ? to : hourFloor(to) + HOUR;
  const kinds: Record<string, number> = {};
  let amount = 0;
  let any = false;
  let anyUnit = false;
  for (const r of h.rows) {
    if (!r || !fin(r.hour) || r.hour < from || r.hour >= end) continue;
    for (const [k, v] of Object.entries(r.kinds ?? {})) {
      if (!fin(v) || v < 0) return { kind: "absent", why: "its ledger holds a figure that is not a count" };
      if (v > 0) { kinds[k] = (kinds[k] ?? 0) + v; any = true; }
    }
    if (r.unit != null) {
      if (!fin(r.unit) || r.unit < 0) return { kind: "absent", why: "its ledger holds a figure that is not a count" };
      if (r.unit > 0) { amount += r.unit; anyUnit = true; }
    }
  }
  const unitName = typeof doc.unit?.name === "string" && doc.unit.name.trim() ? doc.unit.name.trim() : null;
  if (anyUnit && !unitName) return { kind: "absent", why: "its ledger counts a unit it does not name" };
  if (!any && !anyUnit) return { kind: "none" };
  return { kind: "spent", kinds, ...(anyUnit && unitName ? { unit: { name: unitName, amount: tidy(amount) } } : {}) };
}

/** Round float noise (0.1 + 0.2) off a total, but a positive total NEVER rounds to 0: fmtNative says "<0.1". */
function tidy(n: number): number {
  const r = Math.round(n * 1000) / 1000;
  return r > 0 ? r : n;
}

/** One beside row in words: the native unit where the ledger has one, else its kinds, largest
 *  first, each named (never one token total — the kinds are the backend's own accounting). */
export function besideFigure(b: Extract<CostWindowBeside, { kinds: Record<string, number> }>): string {
  if (b.unit) return `${fmtNative(b.unit.amount)} ${b.unit.name}`;
  const ks = Object.entries(b.kinds).filter(([, v]) => v > 0).sort((a, c) => c[1] - a[1]);
  return ks.length ? `${ks.map(([k, v]) => `${fmtCount(v)} ${k}`).join(", ")} tokens` : "nothing counted";
}

/** The block's lead, said ONCE above the rows. */
export const BESIDE_LEAD = "Also on this desktop over this span — each its own account, not in the figure above";
