/**
 * "All backends": one CARD per ledger, side by side — pure, so `node --test` runs it.
 *
 * The rule this view exists under is the one the source picker was built on:
 * the ledgers are different accounting (claude's four kinds, another CLI's five,
 * a premium-request count for Copilot), so **nothing here is summed across
 * cards and nothing shares an axis** — a common scale would assert the units
 * are commensurable, which is the claim a merged total makes in a picture.
 * Each card is its own unit, its own total WITH its split, and the last day it
 * was active. A ledger the host cannot read is its sentence, never a 0.
 */
import type { BackendTokensDoc, TokenStatsDoc } from "@waterplane/shared";
import type { LedgerSummary } from "@waterplane/sdk";
import { kindRows, type KindRow, ledgerAbsent, unitHero } from "./backendLedger.ts";

export interface OverviewCard {
  id: string;
  label: string;
  /** What `total` counts. Always said on the card. */
  unit: string;
  /** A sentence instead of figures: unreadable, or nothing counted. */
  absent?: string;
  total?: number;
  /** The split `total` is made of, largest first. Never absent beside a total. */
  rows?: KindRow[];
  turns?: number;
  /** The last local day with anything in it, `YYYY-MM-DD`; null = no dated activity. */
  lastDay?: string | null;
  /** A second figure in the unit the backend is BILLED in (premium requests), its own line. */
  billed?: { name: string; total: number };
  /** Scope words, e.g. "Anthropic models only". */
  scope?: string;
}

/** The last day in an ascending day list that carried anything. */
export function lastActiveDay<D extends { day: string }>(days: readonly D[], has: (d: D) => boolean = () => true): string | null {
  for (let i = days.length - 1; i >= 0; i--) if (has(days[i])) return days[i].day;
  return null;
}

/** A total with its split, or null when no kind has a count (never a 0 hero). */
function withSplit(kinds: Record<string, number>): { total: number; rows: KindRow[] } | null {
  const rows = kindRows(kinds);
  if (!rows.length) return null;
  return { total: rows.reduce((a, r) => a + r.n, 0), rows };
}

/** Claude Code's card. `doc` is the Anthropic-only cut where one exists. */
export function claudeCard(doc: TokenStatsDoc | null, scope?: string): OverviewCard {
  const base = { id: "claude", label: "Claude Code", unit: "tokens" };
  if (!doc) return { ...base, absent: "Claude Code’s logs have not been read yet." };
  const t = doc.totals;
  const s = withSplit({ input: t.input, output: t.output, cacheRead: t.cacheRead, cacheWrite: t.cacheWrite });
  if (!s) return { ...base, absent: "No conversation logs on this desktop yet — nothing counted." };
  return {
    ...base, ...s, turns: t.turns, ...(scope ? { scope } : {}),
    lastDay: lastActiveDay(doc.days, (d) => d.input + d.output + d.cacheRead + d.cacheWrite > 0),
  };
}

/**
 * A contributed view's card (`LedgerViewDef.summary`): the extension states its kinds, apart, and the
 * sheet totals and splits them here — so a guest card can no more print a total without its split
 * than Claude's can.
 */
export function guestCard(id: string, label: string, sum: LedgerSummary): OverviewCard {
  const base = { id, label, unit: "tokens" };
  if ("absent" in sum) return { ...base, absent: sum.absent };
  const s = withSplit(sum.kinds);
  if (!s) return { ...base, absent: sum.nothing };
  return { ...base, ...s, ...(sum.turns != null ? { turns: sum.turns } : {}), lastDay: sum.lastDay };
}

/** Any other backend's own ledger (`BackendTokensDoc`). */
export function ledgerCard(id: string, label: string, doc: BackendTokensDoc | null): OverviewCard {
  const base = { id, label, unit: "tokens" };
  if (!doc) return { ...base, absent: `${label}’s ledger has not been read yet.` };
  const why = ledgerAbsent(label, doc);
  if (why || doc.available === false) return { ...base, absent: why ?? `${label} has no token ledger on this desktop.` };
  const s = withSplit(doc.totals.kinds);
  const unit = unitHero(doc);
  return {
    ...base,
    ...(s ?? {}),
    ...(s ? { turns: doc.totals.turns } : {}),
    ...(unit ? { billed: { name: unit.name, total: unit.total } } : {}),
    ...(doc.sliceOf ? { scope: `cut from ${doc.sliceOf}` } : {}),
    lastDay: lastActiveDay(doc.days, (d) =>
      d.turns > 0 || Object.values(d.kinds).some((n) => n > 0)) ?? lastActiveDay(unit?.days ?? []),
  };
}

/** "last active 30 Sep" / "no dated activity" — a card with no day says so. */
export function lastDayWords(day: string | null | undefined, fmt: (day: string) => string): string {
  return day ? `last active ${fmt(day)}` : "no dated activity";
}
