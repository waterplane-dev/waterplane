/**
 * The "also on this desktop" block under a cost window's figure, as words (c2): every OTHER
 * backend over the same span, each in its own account. Pure so `besideLines.test.mjs` runs it
 * bare; `BesideBlock.tsx` only paints it. Never a sum, never a share: one line per backend, a
 * spent row as `label: figure`, an absent one as `label: <why>`.
 */
import { BESIDE_LEAD, besideFigure, type CostWindowBeside } from "@waterplane/shared";

export interface BesideLine { key: string; label: string; text: string }
export interface BesideView { lead: string; lines: BesideLine[] }

/** Null when the host sent none (an older host) or an empty list — the block is then not drawn. */
export function besideLines(rows: readonly CostWindowBeside[] | undefined): BesideView | null {
  if (!rows?.length) return null;
  return {
    lead: BESIDE_LEAD,
    lines: rows.map((r) => ({
      key: r.backend,
      label: r.label,
      text: "absent" in r ? r.absent : besideFigure(r),
    })),
  };
}
