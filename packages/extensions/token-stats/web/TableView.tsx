/** The table twin: every value the charts show, as numbers, scoped by the same window. */
import { type CostBreakdown, fmtCount, fmtExact, fmtUsd, type TokenStatsDoc, tokenTotal } from "@waterplane/shared";
import { type WindowCut } from "./usageCut.ts";

/** The table twin: every value the charts show, as numbers, in full. */
/**
 * The table twin — and it is scoped by the same window the charts are.
 *
 * `cut` is not decoration. The sentence under the scope chips says the cut
 * reaches "down to the model bars", and until this took the cut the values view
 * quietly printed the ALL-TIME model and repo lists under a live-window
 * heading, i.e. the one thing this screen refuses everywhere else: a number
 * standing for a span nobody said it stood for. The chart view has always
 * answered a window by naming what an hour bucket cannot carry; the twin now
 * gives the same two answers rather than a wrong one.
 */
export function TableView({ doc, days, cut = null, part }: {
  doc: TokenStatsDoc;
  days: TokenStatsDoc["days"];
  /** The live window on screen, or null for all time. */
  cut?: WindowCut | null;
  /** Which half: the groups live in the Totals box and follow its span, the
   *  days in the Over-time box and follow its chips. */
  part: "groups" | "days";
}) {
  const rows = [...days].reverse();
  if (part === "days") return (
    <>
      <div className="section section-head"><span>By day <span className="section-hint">· newest first</span></span></div>
      {rows.map((d) => <NumRow key={d.day} label={d.day} t={d} cost={d.cost} />)}
      {!rows.length && <div className="empty">No days in this window.</div>}
    </>
  );
  return (
    <>
      <div className="section section-head">
        <span>By model{cut ? <span className="section-hint"> · {cut.long}</span> : null}</span>
      </div>
      {cut
        ? (cut.modelSplit
          ? cut.models.map((m) => <NumRow key={m.key} label={m.label} t={m} cost={m.cost} />)
          : <div className="empty">
              No model split in this desktop’s hour buckets yet — the host records one from the
              next scan on. The tokens and money above are counted either way.
            </div>)
        : doc.models.map((m) => <NumRow key={m.key} label={m.label} t={m} cost={m.cost} />)}
      <div className="section section-head"><span>By repo</span></div>
      {cut
        ? <div className="empty">
            Not answerable inside a live window — an hour bucket carries the model, not the repo.
            Tap <b>All time</b> at the top of this box for it.
          </div>
        : doc.repos.map((r) => <NumRow key={r.key} label={r.label} t={r} title={r.key} cost={r.cost} />)}
    </>
  );
}

function NumRow({ label, t, title, cost }: {
  label: string;
  t: TokenStatsDoc["totals"];
  title?: string;
  /** The row's list-price cost. The table twin carries it always — a table
   *  that only shows what the chart is currently drawing is not a twin. */
  cost?: CostBreakdown;
}) {
  return (
    <div className="row ctx-row ts-numrow" title={title}>
      <span className="row-title">{label}</span>
      <span className="ts-num">{fmtExact(tokenTotal(t))}</span>
      {cost && <span className="ts-num ts-cost">{fmtUsd(cost.total)}</span>}
      <span className="row-meta">
        <span className="row-sub">in {fmtCount(t.input)}</span>
        <span className="row-sub">out {fmtCount(t.output)}</span>
        <span className="row-sub">cache r {fmtCount(t.cacheRead)}</span>
        <span className="row-sub">cache w {fmtCount(t.cacheWrite)}</span>
        <span className="row-sub">{fmtExact(t.turns)} turns</span>
      </span>
    </div>
  );
}
