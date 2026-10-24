/**
 * The two pieces every ledger view draws with — the split as bars, and a table
 * row — so a new view reuses them instead of inventing class names. Every class
 * here is one `styles.css` defines; `.ts-card`, `.ts-kinds` and `.ts-kind-row`
 * do not exist, and two views that used them rendered as unstyled text.
 */
import { fmtCount, fmtShare } from "@waterplane/shared";
import type { KindRow } from "./backendLedger.ts";
import { RowTitle, RowSub } from "@waterplane/kit";

/** The split under a hero, as the same bars a contributed ledger view draws. */
export function KindBars({ rows, name = (k) => k }: { rows: KindRow[]; name?: (kind: string) => string }) {
  const top = rows[0]?.n ?? 0;
  return (
    <div className="ts-bars">
      {rows.map((r) => (
        <div key={r.kind}>
          <div className="ts-barhead">
            <span className="ts-barlabel">{name(r.kind)}</span>
            <span className="ts-barval">{fmtCount(r.n)}{r.share != null && <em>{fmtShare(r.share)}</em>}</span>
          </div>
          <div className="ts-bartrack"><span className="ts-barfill" style={{ width: `${Math.max(1, top > 0 ? (r.n / top) * 100 : 0)}%` }} /></div>
        </div>
      ))}
    </div>
  );
}

/** One table row: a label, its figure, and the parts it is made of as sub-lines. */
export function NumRow({ label, value, subs, title }: { label: string; value: string; subs: string[]; title?: string }) {
  return (
    <div className="row ctx-row ts-numrow" title={title}>
      <RowTitle>{label}</RowTitle>
      <span className="ts-num">{value}</span>
      {subs.length > 0 && (
        <span className="row-meta">
          {subs.map((t) => <RowSub key={t}>{t}</RowSub>)}
        </span>
      )}
    </div>
  );
}
