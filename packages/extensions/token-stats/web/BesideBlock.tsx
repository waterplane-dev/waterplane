/**
 * Other backends over this card's span, beside the claude figure and never in it (c2): the lead
 * is said once, then one quiet line per backend. No total, no bar, no badge; nothing here
 * filters, so nothing carries a count. Renders nothing for an older host or an empty list.
 */
import type { CostWindowBeside } from "@waterplane/shared";
import { besideLines } from "./besideLines.ts";

export function BesideBlock({ rows }: { rows: readonly CostWindowBeside[] | undefined }) {
  const v = besideLines(rows);
  if (!v) return null;
  return (
    <div className="empty ts-caveat">
      <div>{v.lead}.</div>
      {v.lines.map((l) => <div key={l.key}><b>{l.label}</b>: {l.text}</div>)}
    </div>
  );
}
