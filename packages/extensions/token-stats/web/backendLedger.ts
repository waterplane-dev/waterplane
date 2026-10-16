/**
 * The generic per-backend ledger, as rows — pure, so `node --test` runs it.
 *
 * A `BackendTokensDoc` carries its kinds as a `Record<string, number>` because
 * the kinds are the backend's. Two rules hold for every figure drawn from it:
 *
 *  - **A total is never printed without its split.** `ledgerHero` returns the
 *    total and the per-kind rows together, or neither.
 *  - **Absent is said, never 0.** An unreadable ledger is a sentence
 *    (`ledgerAbsent`); a kind that no turn reported is not a row.
 *
 * Kinds are never folded into one another and never summed with another
 * backend's document: this module only ever sees one.
 */
import { dayToMs, type BackendTokensDoc } from "@waterplane/shared";

export type AvailableLedger = Extract<BackendTokensDoc, { available: true }>;

export interface KindRow { kind: string; n: number; share: number | null }

/** The kinds, largest first, each with its share of the sum (null when the sum is 0). */
export function kindRows(kinds: Record<string, number>): KindRow[] {
  const entries = Object.entries(kinds).filter(([, n]) => Number.isFinite(n) && n > 0);
  const sum = entries.reduce((a, [, n]) => a + n, 0);
  return entries
    .map(([kind, n]) => ({ kind, n, share: sum > 0 ? n / sum : null }))
    .sort((a, b) => b.n - a.n || a.kind.localeCompare(b.kind));
}

export function kindsTotal(kinds: Record<string, number>): number {
  return kindRows(kinds).reduce((a, r) => a + r.n, 0);
}

/** The hero: a total WITH its split. Null when there is nothing to total (no
 *  kinds with a count) — the caller then says "nothing counted", not 0. */
export function ledgerHero(doc: AvailableLedger): { total: number; rows: KindRow[]; turns: number } | null {
  const rows = kindRows(doc.totals.kinds);
  if (rows.length === 0) return null;
  return { total: rows.reduce((a, r) => a + r.n, 0), rows, turns: doc.totals.turns };
}

/** The unit total (premium requests, …) summed from the per-day map, with its name; null when the doc has no unit
 *  OR no day carries a count — an empty map is "nothing counted", and summing it would print a 0. */
export function unitHero(doc: AvailableLedger): { name: string; total: number; days: { day: string; n: number }[] } | null {
  if (!doc.unit) return null;
  const days = Object.entries(doc.unit.perDay)
    .filter(([, n]) => Number.isFinite(n))
    .map(([day, n]) => ({ day, n }))
    .sort((a, b) => a.day.localeCompare(b.day));
  if (days.length === 0) return null;
  return { name: doc.unit.name, total: days.reduce((a, d) => a + d.n, 0), days };
}

/** The sentence for a ledger that cannot be shown. Never empty, never a zero. */
export function ledgerAbsent(label: string, doc: BackendTokensDoc | null): string | null {
  if (!doc) return null;
  if (doc.available === false) return doc.reason?.trim() || `${label} has no token ledger on this desktop.`;
  if (!ledgerHero(doc) && !unitHero(doc)) return `${label} has a ledger but nothing is counted in it yet.`;
  return null;
}

/** The last `n` days, newest last, each with its own split (never a bare total). */
export function recentDays(doc: AvailableLedger, n = 14): { day: string; total: number; rows: KindRow[]; turns: number; byModel?: { key: string; total: number; turns: number }[] }[] {
  return doc.days.slice(-n).map((d) => ({
    day: d.day, total: kindsTotal(d.kinds), rows: kindRows(d.kinds), turns: d.turns,
    ...(d.byModel ? { byModel: d.byModel.map((m) => ({ key: m.key, total: kindsTotal(m.kinds), turns: m.turns })) } : {}),
  }));
}

/**
 * One "Last days" row as words. A day whose kinds are all empty says nothing was
 * counted (with its turns) — it never prints "0 tokens —" with a dash leading
 * into nothing.
 */
export function dayWords(d: { total: number; rows: KindRow[]; turns: number }, fmt: (n: number) => string = String): string {
  const turns = `${d.turns.toLocaleString()} turns`;
  if (d.rows.length === 0) return `nothing counted, ${turns}`;
  return `${fmt(d.total)} tokens, ${turns} — ${d.rows.map((r) => `${r.kind} ${fmt(r.n)}`).join(", ")}`;
}

/** The scope sentence under a ledger's tab: its own store, or a CUT of another ledger. */
export function scopeWords(label: string, doc: AvailableLedger, unitName?: string): string {
  if (doc.sliceOf) return `${label}: ${doc.sliceOf}. Counted in their own kinds, never added to the Claude Code tab’s figures.`;
  return `${label} sessions only — counted in ${label}’s own kinds${unitName ? ` and ${unitName}` : ""}, never added to another ledger.`;
}

/** "over 12 turns, 3 sessions" — the session count only where the ledger counted one. */
export function turnsWords(doc: AvailableLedger, turns: number): string {
  return `over ${turns.toLocaleString()} turns${doc.sessions != null ? `, ${doc.sessions.toLocaleString()} sessions` : ""}`;
}

export interface CostLine { key: string; text: string; priced: boolean }

/**
 * The money, per model, as lines — or null when the ledger is never priced.
 *
 * A priced model says whose price it was; a loopback model says it runs here;
 * an unpriced one is the host's sentence on how to add a price. The totals are
 * one per currency, never converted and never summed across.
 */
export function costLines(doc: AvailableLedger, fmt: (n: number, currency: string) => string): { totals: string[]; lines: CostLine[]; problems: string[]; pricesFile: string } | null {
  const c = doc.cost;
  if (!c) return null;
  const lines = c.models.map((m): CostLine => {
    if ("unpriced" in m) return { key: m.key, text: m.unpriced, priced: false };
    const whose = m.source === "local" ? "runs on this machine (its catalogue prices it at zero)"
      : m.source === "user" ? `your price for ${m.pattern ?? m.key}` : "Anthropic list price";
    return { key: m.key, text: `${fmt(m.total, m.currency)} — ${whose}`, priced: true };
  });
  return {
    totals: c.totals.map((t) => fmt(t.total, t.currency)),
    lines,
    problems: c.problems ?? [],
    pricesFile: c.pricesFile,
  };
}

/**
 * The backends that get a GENERIC ledger tab: every one the host describes
 * except claude (the screen's first view) and those an extension draws itself
 * (`viewIds`, `LedgerViewDef`). A backend with no ledger still answers
 * `available:false` with a sentence, which its tab shows — so the absence is
 * said, not silently missing. No list (an old host) ⇒ no tabs.
 */
export function ledgerBackends(list: readonly { id: string; label: string }[] | null | undefined, viewIds: readonly string[] = []): { id: string; label: string }[] {
  if (!list) return [];
  return list.filter((b) => b.id !== "claude" && !viewIds.includes(b.id)).map((b) => ({ id: b.id, label: b.label }));
}

/** A day series as the shared `DayChart` draws it (`{t, v, day}`), oldest first. */
export interface LedgerPoint { t: number; v: number; day: string }

/**
 * Tokens per day — the same columns the Claude Code tab draws, so a second ledger reads in the same
 * shape. A day the ledger kept with nothing counted is a 0 (it was scanned); a day it never kept is
 * not a point (the chart's gap fill is the caller's).
 */
export function tokenDayPoints(doc: AvailableLedger): LedgerPoint[] {
  return doc.days.map((d) => ({ t: dayToMs(d.day), day: d.day, v: kindsTotal(d.kinds) }))
    .sort((a, b) => a.t - b.t);
}

/** The unit per day (premium requests, AI credits, …), the same shape. */
export function unitDayPoints(days: readonly { day: string; n: number }[]): LedgerPoint[] {
  return days.map((d) => ({ t: dayToMs(d.day), day: d.day, v: d.n })).sort((a, b) => a.t - b.t);
}

/** The models as split rows (largest first, share of the sum) — the bars the Claude Code tab's by-model readout draws. */
export function modelRows(doc: AvailableLedger): KindRow[] {
  return kindRows(Object.fromEntries(doc.models.map((m) => [m.label || m.key, kindsTotal(m.kinds)])));
}
