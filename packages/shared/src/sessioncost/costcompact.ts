// Cut from sessioncost.ts (move only): what compacting saved and cost
// The one door stays `./sessioncost.js`; this slice imports its siblings directly, never the barrel.

import { fmtUsd } from "../pricing.js";
import { fmtMultiple, fmtTok } from "./costwords.js";

// ── What compacting saved, and what it cost ───────────────────────────────

/**
 * The compaction ledger folded into one reading — both triggers together.
 *
 * The wire splits auto from manual because "was typing `/compact` worth it" is
 * only answerable if the CLI's own decisions are counted apart. Most sentences
 * are about the pair, so the fold lives here rather than at each call site,
 * and the money fields come back null — never 0 — for `costChip`'s reason.
 */
export interface CompactionReading {
  /** Compactions in the figures: both triggers, `unmeasured` excluded. */
  count: number;
  manual: number;
  /** Boundaries the log did not describe well enough to price — see
   *  `CompactionLedger.unmeasured`. In none of the figures below. */
  unmeasured: number;
  shedTok: number;
  savedTok: number;
  savedUsd: number | null;
  rebuildTok: number;
  rebuildUsd: number | null;
}

/** Fold the two rows. Null money where nothing was priced or nothing saved. */
export function compactionReading(l: {
  auto: CompactionRow; manual: CompactionRow; unmeasured: number;
}): CompactionReading {
  const usd = (a?: number, b?: number) => {
    const n = (a ?? 0) + (b ?? 0);
    return n > 0 ? n : null;
  };
  return {
    count: l.auto.count + l.manual.count,
    manual: l.manual.count,
    unmeasured: l.unmeasured,
    shedTok: l.auto.shedTok + l.manual.shedTok,
    savedTok: l.auto.savedTok + l.manual.savedTok,
    savedUsd: usd(l.auto.savedUsd, l.manual.savedUsd),
    rebuildTok: l.auto.rebuildTok + l.manual.rebuildTok,
    rebuildUsd: usd(l.auto.rebuildUsd, l.manual.rebuildUsd),
  };
}

/** The shape `compactionReading` folds — `CompactionCost` structurally, so this
 *  module stays readable without the wire file. */
export interface CompactionRow {
  count: number;
  shedTok: number;
  savedTok: number;
  savedUsd?: number;
  rebuildTok: number;
  rebuildUsd?: number;
}

/**
 * How many compactions, and how many of them somebody asked for — one line.
 *
 * Null when none have run, because "0 compactions" is a panel's worth of
 * chrome around nothing; the caller says that in a sentence instead.
 */
export function compactionCountText(r: CompactionReading): string | null {
  // MEASURED ones only. A boundary the log did not describe is not "the CLI's
  // own" — nothing here knows who asked for it, and folding it into the other
  // row is how a count becomes a claim nobody measured. It gets its own
  // sentence, beside these figures rather than inside them.
  const n = r.count;
  if (n <= 0) return null;
  const who = n === 1
    ? (r.manual === 1 ? "One compaction, and you asked for it." : "One compaction, the CLI's own.")
    : r.manual === 0 ? `${n} compactions, none of them yours.`
      : r.manual === n ? `${n} compactions, all of them yours.`
        : `${n} compactions — ${r.manual} you asked for, ${n - r.manual} the CLI's own.`;
  const shed = r.shedTok > 0
    ? ` ${n === 1 ? "It took" : "Together they took"} ${fmtTok(r.shedTok)} out of the window.`
    : "";
  return who + shed;
}

/**
 * Compactions in NO figure, as their own sentence — never a number folded into
 * the rows above.
 *
 * `unpricedTok`'s posture applied to a count: what could not be measured is
 * named, because the alternative is a ledger that silently reads as complete.
 */
export function compactionUnmeasuredText(r: CompactionReading): string | null {
  if (r.unmeasured <= 0) return null;
  const n = r.unmeasured === 1
    ? "One more compaction is"
    : `${r.unmeasured} more compactions are`;
  return `${n} in none of these figures — the log did not record both sides of the drop, so there is nothing to measure them from.`;
}

/**
 * A ledger row's numbers, as the chips it wears.
 *
 * Built here rather than in the component for the reason `costChip` is: this is
 * where "no figure" is decided. A `saved 0 · cost 0` row is the token spelling
 * of the `$0` this file refuses everywhere else — it reads as a verdict on
 * compacting, when the fact is that no turn has run since. So a zero side is
 * DROPPED, and a row with neither says which state it is in.
 */
export function compactionRowFacts(c: CompactionRow): string[] {
  const out: string[] = [];
  if (c.savedTok > 0) {
    out.push(`saved ${fmtTok(c.savedTok)}${c.savedUsd != null ? ` · ${fmtUsd(c.savedUsd)}` : ""}`);
  }
  if (c.rebuildTok > 0) {
    out.push(`cost ${fmtTok(c.rebuildTok)}${c.rebuildUsd != null ? ` · ${fmtUsd(c.rebuildUsd)}` : ""}`);
  }
  return out.length ? out : ["nothing back yet"];
}

/**
 * What compacting has saved, in one sentence.
 *
 * The saving is a COUNTERFACTUAL and is worded as one: these are tokens no
 * request had to re-send, so unlike everything else on the screen the money is
 * not in any total — it was never spent. "so far" for `usageText`'s reason and
 * for one more: the figure grows with every turn that follows, because every
 * one of them re-sends a window this much smaller.
 *
 * Null while nothing has been saved yet — a compaction with no turn after it.
 * That is a real state with its own sentence (`compactionPendingText`), not a
 * `$0` to print.
 */
export function compactionSavedText(r: CompactionReading): string | null {
  if (r.savedTok <= 0) return null;
  const money = r.savedUsd != null
    ? `, worth ${fmtUsd(r.savedUsd)} at list prices — the one figure here that was never actually spent`
    : "";
  return `Every request since has carried that much less: ${fmtTok(r.savedTok)} tokens not re-sent${money}.`;
}

/** Compacted, but nothing has run since — so nothing is saved YET. */
export function compactionPendingText(r: CompactionReading): string | null {
  if (r.count <= 0 || r.savedTok > 0) return null;
  return "No turn has run since, so nothing has been saved back yet — the saving is what the next requests will not have to carry.";
}

/**
 * What compacting cost, in one sentence — and what that figure leaves out.
 *
 * Two things a reader would otherwise get wrong, so both are in the words:
 * this money IS in the session's own total (the cache write happened), and
 * the summarising request is NOT in it, because the CLI does not write that
 * call to the conversation log. Measured, not assumed: between the boundary
 * and the next prompt there is no assistant record at all.
 */
export function compactionCostText(r: CompactionReading): string | null {
  if (r.rebuildTok <= 0) return null;
  const money = r.rebuildUsd != null ? ` (${fmtUsd(r.rebuildUsd)})` : "";
  return `Rebuilding the window afterwards wrote ${fmtTok(r.rebuildTok)} tokens${money} — real spend, already counted in this session's total. The summarising request itself is not in the CLI's log, so it is in neither figure.`;
}

/**
 * The two sides as a ratio, where one exists — the reading somebody is
 * actually after.
 *
 * Only in money, and only when both sides could be priced: the token counts
 * compare a cache read with a cache write, which differ by up to twenty times
 * in price, so their ratio is a number that means nothing.
 */
export function compactionRatioText(r: CompactionReading): string | null {
  if (r.savedUsd == null || r.rebuildUsd == null || r.rebuildUsd <= 0) return null;
  const m = r.savedUsd / r.rebuildUsd;
  if (!(m >= 1)) return `That is ${fmtUsd(r.rebuildUsd - r.savedUsd)} more than it has saved back so far.`;
  return `${fmtMultiple(m)} what it cost.`;
}

/**
 * Where the counterfactual stops being a saving and starts being the only way
 * the conversation could have continued.
 *
 * An uncompacted window of 1.4M is not an expensive conversation, it is a
 * refused request — so past the model's own window the money above is not what
 * you would have paid, it is what those turns would have cost if they could
 * have run at all. That is a stronger statement than the saving and it has to
 * be said where it is true, which is most long conversations.
 *
 * Null when the window is unknown (`windowTok` null) — nothing is claimed
 * about a ceiling nobody measured.
 */
export function compactionWindowText(
  r: CompactionReading,
  tok: number | null,
  windowTok: number | null,
): string | null {
  // "Those turns could not have run" is a sentence about the turns SINCE, so a
  // conversation that compacted and then stopped has none to make it about —
  // and the reading would be asserting a consequence for work nobody did.
  if (!(r.savedTok > 0) || !(r.shedTok > 0)) return null;
  if (!(windowTok && windowTok > 0) || !(tok && tok > 0)) return null;
  const would = tok + r.shedTok;
  if (would <= windowTok) return null;
  return `Uncompacted it would be carrying ${fmtTok(would)} — past the ${fmtTok(windowTok)} window, so those turns could not have run at all.`;
}

/**
 * How both figures were arrived at, and which way each one errs.
 *
 * Not a disclaimer: it is the reason the reading can be trusted in the
 * direction it will be used in. Somebody reads this panel to decide whether to
 * keep typing `/compact`, so both estimates are deliberately biased AGAINST
 * the answer "yes" — the saving priced at the cheapest thing those tokens
 * could have been, the cost counting a write the turn partly owed anyway. A
 * ratio built the other way round would be an advertisement.
 */
export function compactionMethodText(): string {
  return "The saving prices those tokens as cache reads — the cheapest they could have been; a conversation resumed after the cache expired re-writes its window at up to twenty times that rate. The cost counts the whole first write after each boundary, part of which the next turn would have paid anyway. Both err against compacting looking worthwhile.";
}

/** The label a ledger row wears. Plural-aware, and the manual one names the
 *  command, because "manual" is the wire's word and not a person's. */
export function compactionRowLabel(kind: "auto" | "manual", count: number): string {
  if (kind === "manual") return count === 1 ? "you typed /compact" : `you typed /compact ${count}×`;
  return count === 1 ? "the CLI compacted" : `the CLI compacted ${count}×`;
}
