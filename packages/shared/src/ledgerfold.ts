/**
 * One iteration over the token ledger's cells, for every fold that reads it.
 *
 * The ledger (`host/tokenscan.ts`) keeps, per conversation file, one `Tally`
 * per hour×model "cell". Three folds (the all-sessions screen, the cost
 * window, the VS Code corpus) each used to carry their own copy of the key
 * split, the tally-to-totals conversion and the price lookup; a rule changed
 * in one would then be a second answer in another. This is the one copy.
 *
 * Rules every caller inherits:
 *  - a cell with no parseable hour has `hour === ""` and `day === ""`: it
 *    belongs in the totals and in no time bucket (the caller decides);
 *  - `cost` is `null` when no rate covers the model on that day: tokens
 *    without money, never a zero charge that reads as free.
 *
 * Pure: no clock, no disk. Projections stay with the callers.
 */
import { costOf } from "./pricing.js";
import type { CostBreakdown } from "./pricing.js";
import type { TokenTotals } from "./wire/telemetry.js";

/** Six numbers: the four kinds, the 1-hour SUBSET of the cache writes (which is
 *  what the 2x price tier is charged on), and the turn count. Positional because
 *  there are ~9,500 of these and the key names would be most of the file. */
export type Tally = [input: number, output: number, cacheRead: number, cacheWrite: number, cacheWrite1h: number, turns: number];

export const CROSS = "\u0000";
export const crossKey = (hour: string, model: string) => `${hour}${CROSS}${model}`;

export const uncross = (k: string): [hour: string, model: string] => {
  const i = k.indexOf(CROSS);
  return i < 0 ? ["", k] : [k.slice(0, i), k.slice(i + 1)];
};

export const tallyToTotals = (t: Tally): TokenTotals =>
  ({ input: t[0], output: t[1], cacheRead: t[2], cacheWrite: t[3], cacheWrite1h: t[4], turns: t[5] });

/** What one file summary must hold for the iteration: its hour×model tallies. */
export interface LedgerFile { x: Record<string, Tally> }

export interface LedgerCell<S extends LedgerFile = LedgerFile> {
  slug: string;
  fileKey: string;
  /** The file's whole summary, for the caller's per-file facts (`sub`, `w`, ...). */
  sum: S;
  /** The cell's hour key, "" when the record's timestamp would not parse. */
  hour: string;
  /** The day: a PREFIX of the hour, never a second derivation. "" with no hour. */
  day: string;
  model: string;
  totals: TokenTotals;
  /** List-price cost at the model's rate on `day`; null where no rate covers it. */
  cost: CostBreakdown | null;
}

/** The cells of ONE file, in the order its tallies were written. */
export function eachFileCell<S extends LedgerFile>(
  slug: string, fileKey: string, sum: S, visit: (cell: LedgerCell<S>) => void,
): void {
  for (const [key, tally] of Object.entries(sum.x)) {
    const [hour, model] = uncross(key);
    const day = hour.slice(0, 10);
    const totals = tallyToTotals(tally);
    visit({ slug, fileKey, sum, hour, day, model, totals, cost: costOf(totals, model, day || undefined) });
  }
}

/** Every cell of every file: slug → file key → summary. */
export function eachLedgerCell<S extends LedgerFile>(
  files: Record<string, Record<string, S>>, visit: (cell: LedgerCell<S>) => void,
): void {
  for (const [slug, byFile] of Object.entries(files)) {
    for (const [fileKey, sum] of Object.entries(byFile)) eachFileCell(slug, fileKey, sum, visit);
  }
}
