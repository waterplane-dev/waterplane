/**
 * Where a Setup check door lands in the token statistics: a span, a box to scroll to and, for the
 * costliest list, the conversations it named. Pure; `TokenStatsBody` does the drawing.
 *
 * The cut is a filter, so it says what it hides ("n of N", with a clear) and the rows and the number
 * come from the one `cutTop` call.
 */
import { cutByIds, evidenceCutWords, type TokenConvo } from "@waterplane/shared";
import type { SpanSel } from "./span.ts";

export type FocusBox = "cold" | "writes" | "agents" | "top" | "models" | "requests" | "limits" | "hostspend";

export interface TokenFocus { span?: "week" | "30" | "90" | "all"; box: FocusBox; ids?: string[] }

/** The span a door asks for, or undefined (the screen's own default). */
export const focusSpan = (f: TokenFocus | null | undefined): SpanSel | undefined =>
  f?.span ? { id: f.span, back: 0 } : undefined;

/** The attribute a box carries so a door can scroll to it. */
export const boxAttr = (box: FocusBox): { "data-ev": FocusBox } => ({ "data-ev": box });

/** The costliest list cut to the named conversations; `bar` is the "n of N" sentence, null when uncut. */
export function cutTop<T extends { rows: TokenConvo[] }>(top: T, ids: readonly string[] | null | undefined): { top: T; bar: string | null } {
  if (!ids || !ids.length) return { top, bar: null };
  const rows = cutByIds(top.rows, ids, (c) => c.id);
  return { top: { ...top, rows }, bar: evidenceCutWords(rows.length, top.rows.length, "conversations") };
}
