import type { TranscriptBlock } from "@waterplane/shared";
import type { ReaderToolsMode } from "../transcriptUtil";

/** Turns rendered at once, newest-last. Older ones load on demand — a long
 *  conversation would otherwise put tens of thousands of nodes in the DOM. */
export const PAGE = 40;
export const POLL_MS = 6000;
/** While a turn is in flight the log grows — poll harder so the reader isn't
 *  six seconds behind what the terminal would have shown live. */
export const BUSY_POLL_MS = 2500;
/** Data saver multiplies both: each poll that finds a change refetches the whole
 *  document, so on a metered link the cadence is the cost. `since` still makes
 *  an unchanged log a 204, and the turn-end event still refetches immediately —
 *  the reader stays correct, just less eager. */
export const SAVER_POLL_FACTOR = 4;

/** "4s" / "2m 10s" — compact enough for a one-line strip. */
export function since(ts?: number, now = Date.now()): string {
  if (!ts) return "";
  const s = Math.max(0, Math.round((now - ts) / 1000));
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`;
}

export type ToolBlock = Extract<TranscriptBlock, { kind: "tool" }>;

/**
 * What one turn renders as: its blocks, with every RUN of two or more tool
 * calls folded into a single `tools` row.
 *
 * A phone screen holds about fifteen lines. A turn that read six files and ran
 * four commands spends all of them on `> Bash …` rows, and the prose either side
 * — the part a person came to read — is pushed off both ends. Folding a run into
 * one line puts the conversation back on screen and leaves the tool calls one
 * tap away. A LONE tool call is left as it is: it is already one line, and
 * hiding its label behind a placeholder would cost information for no space.
 */
export type Row = { kind: "block"; block: TranscriptBlock; i: number }
         | { kind: "tools"; blocks: ToolBlock[]; i: number };

export function rowsOf(blocks: TranscriptBlock[]): Row[] {
  const rows: Row[] = [];
  for (let i = 0; i < blocks.length; i++) {
    const b = blocks[i];
    if (b.kind !== "tool") { rows.push({ kind: "block", block: b, i }); continue; }
    let j = i;
    while (j + 1 < blocks.length && blocks[j + 1].kind === "tool") j++;
    if (j > i) { rows.push({ kind: "tools", blocks: blocks.slice(i, j + 1) as ToolBlock[], i }); i = j; }
    else rows.push({ kind: "block", block: b, i });
  }
  return rows;
}

/** "5 Bash, 2 Read" — what the folded run actually did, in tool-name order of
 *  first appearance, so the placeholder is skimmable without opening it. */
export function toolTally(blocks: ToolBlock[]): string {
  const counts = new Map<string, number>();
  for (const b of blocks) counts.set(b.name, (counts.get(b.name) ?? 0) + 1);
  return [...counts].map(([n, c]) => (c > 1 ? `${c} ${n}` : n)).join(", ");
}

/** `fold` is the only mode that folds; the other two want every row back. */
export const rowsFor = (blocks: TranscriptBlock[], mode: ReaderToolsMode): Row[] =>
  mode === "fold" ? rowsOf(blocks) : blocks.map((block, i) => ({ kind: "block", block, i }));
