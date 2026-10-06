/**
 * The figures behind the charts, in text.
 *
 * Its own file rather than a section of `RepoHealthTiles.tsx` for the reason
 * that file's neighbours are: it is the only thing on this sheet that is not
 * an SVG, it shares no geometry with anything there, and the tiles module was
 * already at the line cap the linter sets.
 */
import type { RepoHealthPlot } from "@waterplane/shared";
import { foldPartSeries } from "./repoHealthPlot";
import { axisDayWords, readingsTableWords, seriesValueWords } from "./repoHealthWords";
import { HintChip } from "./HintChip";

const values = (points: readonly { v: number | null }[]): (number | null)[] => points.map((p) => p.v);

// ── the table ─────────────────────────────────────────────────────────────

/** How many readings the table shows. The drawn page showed 14 and this is
 *  that card, moved: long enough to see a step, short enough to scroll past. */
const TABLE_TAIL = 14;

/**
 * The figures behind the charts, in text — the one card the separate drawn
 * page had that this sheet did not.
 *
 * It exists on the page for the contrast rule: two of the four band hues sit
 * under 3:1 on a light surface, so the numbers have to be readable without
 * the colour. That argument holds here unchanged — and a second one arrives
 * on a phone, where the only other way to read a past day is to hold a finger
 * on a curve, which answers for ONE day at a time and cannot be compared with
 * the day beside it.
 *
 * Columns are the plot's own arrays, indexed together: every `points` array
 * in a plot is `days` long by construction, so row `i` of each is the same
 * reading. The packages are folded exactly as `PackageStack` folds them, so
 * the table's columns and the chart's bands are the same set with the same
 * names — a table that quietly kept a fifth package the chart had merged
 * would be two different answers to "what is in this repo".
 */
export function ReadingsTable({ plot }: { plot: RepoHealthPlot }) {
  const p95 = plot.series.find((s) => s.key === "size.p95") ?? null;
  const days = plot.classics.files.length ? plot.classics.files : (p95?.points ?? []);
  if (!days.length) return null;

  const parts = plot.classics.packages
    .filter((pk) => pk.points.length === days.length)
    // The same `bySize` the chart folds by, so the table's columns and the
    // chart's bands stay the same set — a table quietly keeping a group the
    // chart merged is two answers to "what is in this repo".
    .map((pk) => ({ key: pk.pkg, label: pk.pkg, values: values(pk.points), bySize: pk.rank }));
  const folded = parts.length ? foldPartSeries(parts, "the rest") : [];

  const from = Math.max(0, days.length - TABLE_TAIL);
  const rows = [];
  for (let i = from; i < days.length; i++) rows.push(i);

  // `longest` is optional on the wire — a desktop or a tool older than the
  // field sends none — so the column is absent rather than a row of dashes
  // that would read as "measured, and empty every day".
  const longest = plot.longest?.points.length === days.length ? plot.longest.points : null;
  const cols: { head: string; at: (i: number) => number | null }[] = [
    { head: "p95", at: (i) => p95?.points[i]?.v ?? null },
    ...(longest ? [{ head: "longest", at: (i: number) => longest[i]?.v ?? null }] : []),
    { head: "files", at: (i) => plot.classics.files[i]?.v ?? null },
    ...folded.map((f) => ({ head: f.label, at: (i: number) => f.values[i] ?? null })),
    { head: "deps", at: (i) => plot.classics.deps[i]?.v ?? null },
  ];

  return (
    <div className="rh-chart">
      <div className="rh-chart-head">
        <span className="rh-chart-label">the readings, as numbers</span>
        <HintChip id="repohealth.table" of="the numbers table" />
      </div>
      {/* Its own scroller: a table is the one thing on this sheet allowed to
          be wider than the phone, and only inside a box of its own. */}
      <div className="rh-table-wrap">
        <table className="rh-table">
          <thead>
            <tr>
              <th scope="col">day</th>
              {cols.map((c) => <th key={c.head} scope="col" className="num">{c.head}</th>)}
            </tr>
          </thead>
          <tbody>
            {rows.map((i) => (
              <tr key={days[i].day ?? i}>
                <th scope="row">{axisDayWords(days[i].day)}</th>
                {cols.map((c) => (
                  <td key={c.head} className="num">{seriesValueWords(c.at(i))}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="rh-cap">{readingsTableWords(rows.length, plot.days)}</div>
    </div>
  );
}

