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
 * past the hours kept, records after `to` in `to`'s own hour, a stalled scan.
 */
import { hourFloor } from "./costwindow.js";
import { fmtCount } from "./tokens.js";
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
  return { kind: "spent", kinds, ...(anyUnit && unitName ? { unit: { name: unitName, amount: Math.round(amount * 1000) / 1000 } } : {}) };
}

/** One beside row in words: the native unit where the ledger has one, else its kinds, largest
 *  first, each named (never one token total — the kinds are the backend's own accounting). */
export function besideFigure(b: Extract<CostWindowBeside, { kinds: Record<string, number> }>): string {
  const fmt = (n: number) => (Number.isInteger(n) ? fmtCount(n) : String(Math.round(n * 10) / 10));
  if (b.unit) return `${fmt(b.unit.amount)} ${b.unit.name}`;
  const ks = Object.entries(b.kinds).filter(([, v]) => v > 0).sort((a, c) => c[1] - a[1]);
  return ks.length ? `${ks.map(([k, v]) => `${fmtCount(v)} ${k}`).join(", ")} tokens` : "nothing counted";
}

/** The block's lead, said ONCE above the rows. */
export const BESIDE_LEAD = "Also on this desktop over this span — each its own account, not in the figure above";
