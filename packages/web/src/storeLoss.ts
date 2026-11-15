/**
 * What a sheet says when the desktop lost the store behind its reading
 * (`shared/deskstorage.ts` `StoreLoss`). Pure, node-tested (`storeLoss.test.mjs`).
 *
 * The sentence itself is `storeLossText` — the one wording, never redone here.
 * This file adds only the clock and the two decisions a sheet must not make
 * twice: whether a "never used" list may be printed, and what a ceiling that
 * reads "off" may claim.
 */
import type { StoreLoss } from "@waterplane/shared";

/** When the loss last happened: a repeated failed write is one record. */
export function lossWhenAt(l: StoreLoss): number {
  return l.lastAt ?? l.at;
}

/**
 * The ONE rule for whether a loss makes a figure unknown. A failed save leaves
 * memory intact (the host still serves what it holds), so only a corrupt or
 * unreadable store — where the host started from defaults — hides figures.
 */
export function lossHidesFigures(l: StoreLoss | null | undefined): l is StoreLoss {
  return !!l && l.kind !== "write-failed";
}

/** The banner on budget, usage and sent log: that the store was lost, and when. The error and path stay on the storage card. */
export function lossLineText(l: StoreLoss, agoText: (ts: number) => string): string {
  const what = l.kind === "write-failed" ? "could not be saved" : l.kind === "unreadable" ? "could not be read" : "was lost";
  return `${l.store} ${what}, ${agoText(lossWhenAt(l))}.`;
}

/** Where the bytes went, as a sentence for the storage card; null when `storeLossText` already says it. */
export function lossBytesNote(l: StoreLoss): string | null {
  if (l.kind === "write-failed") return null;
  if (!l.movedTo) return "The bytes were left in place.";
  if (l.movedToExists === false) return "The moved bytes are gone — nothing to recover.";
  return null;
}

/**
 * The usage view's "never used" list is a claim about the history. While the
 * file was lost, a feature at zero may only mean "not counted since the loss",
 * so the list is replaced by that sentence.
 */
export function neverUsedHeading(unusedCount: number, loss: StoreLoss | undefined): string | null {
  if (lossHidesFigures(loss)) return `no count since the record was lost (${unusedCount})`;
  return unusedCount > 0 ? `never used (${unusedCount})` : null;
}

/** A ceiling readout: with the budget record lost, "off" is unknown, not a setting. */
export function ceilingState(setPct: number | null, loss: StoreLoss | undefined): string {
  if (lossHidesFigures(loss)) return setPct == null ? "not known" : `${setPct}% (may be stale)`;
  return setPct == null ? "off" : `${setPct}%`;
}
