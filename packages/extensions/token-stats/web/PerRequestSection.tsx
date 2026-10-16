/**
 * Cost per request, over time and by repo — the all-sessions screen's
 * "a request costs n% less than the week before" drawn as a line, with the
 * repos that make it up listed underneath.
 *
 * The numbers are `perRequest.ts`'s (pure, tested); this file only paints.
 * Two rules from there that show up here as sentences: a stretch with too few
 * requests is a CUT in the line, never a join, and requests no list price
 * covered are left out of the division and said to be.
 *
 * The axis is plotted in tenths of a cent and labelled in dollars: `yScale`
 * steps in whole units (it was written for tokens), and a price per request is
 * a few cents.
 */
import { useCallback, useMemo, useRef, useState } from "react";
import { fmtCount, fmtUsd, type TokenStatsDoc } from "@waterplane/shared";
import { ScrubHint, SERIES, SLOT, dayTicks, makeDayPlot, stepPath } from "@waterplane/kit";
import {
  clipRuns, hasRepoDays, PER_REQ_DAYS, PER_REQ_MIN, repoPerRequest, reqDays, rollingPerRequest, unpricedIn,
  type ReqPoint,
} from "./perRequest.ts";

const PAD = { top: 10, right: 10, bottom: 20, left: 46 };
const CHART_H = 170;
/** Tenths of a cent: what the axis counts in. */
const MILLS = 1000;
const REPO_LINE = SLOT[1];
/** Repo rows listed before *show all*. */
const REPO_ROWS = 8;

function dayMs(day: string): number {
  const [y, m, d] = day.split("-").map(Number);
  return new Date(y, (m || 1) - 1, d || 1).getTime();
}

const fmtDate = (t: number) => new Date(t).toLocaleDateString(undefined, { day: "numeric", month: "short" });

/** The section body. `from`/`to` are the Over-time box's window as day keys. */
export function PerRequestSection({ doc, from, to, width, table, compare = false }: {
  doc: TokenStatsDoc;
  from: string;
  to: string;
  /** The repo table compares `[from, to]` with the equally long run of days before it, instead of
   *  the last 7 days against the 7 before — the token sheet's span filter reaching it. */
  compare?: boolean;
  width: number;
  /** The values half: the line as rows instead of pixels. */
  table: boolean;
}) {
  const [repo, setRepo] = useState<string | null>(null);
  const [allRepos, setAllRepos] = useState(false);
  const ok = useMemo(() => hasRepoDays(doc.days), [doc]);
  const lo = dayMs(from), hi = dayMs(to);

  const allRows = useMemo(() => reqDays(doc.days), [doc]);
  // Rolled over the WHOLE record and clipped afterwards, so the line entering
  // the window's left edge carries the real week before it.
  const all = useMemo(() => clipRuns(rollingPerRequest(allRows), lo, hi), [allRows, lo, hi]);
  const mine = useMemo(
    () => (repo ? clipRuns(rollingPerRequest(reqDays(doc.days, repo)), lo, hi) : []),
    [doc, repo, lo, hi],
  );
  const repos = useMemo(() => repoPerRequest(doc.days, doc.repos, Date.now(), undefined, compare ? { from, to } : undefined), [doc, compare, from, to]);
  const unpriced = useMemo(() => unpricedIn(allRows, from, to), [allRows, from, to]);
  // The dearest few first; the rest behind one tap, and a drawn repo is never
  // the one row hidden.
  const shown = allRepos ? repos.rows : repos.rows.filter((r, i) => i < REPO_ROWS || r.key === repo);
  const repoLabel = repo ? repos.rows.find((r) => r.key === repo)?.label ?? repo : null;

  if (!ok) {
    return <div className="empty ctx-note">The host has not split its days by repo yet — this appears after it is restarted on a version that does.</div>;
  }

  return (
    <>
      {table
        ? <PerRequestTable runs={all} />
        : <PerRequestChart all={all} mine={mine} repoLabel={repoLabel} lo={lo} hi={hi} width={width} />}
      {all.length === 0
        ? <div className="empty ts-caveat">No stretch in this window had {PER_REQ_MIN} priced requests in {PER_REQ_DAYS} days, so there is no price per request to draw rather than one read off a handful.</div>
        : <div className="empty ts-caveat">
            Each point is the {PER_REQ_DAYS} days up to it: their dollars over their requests. Where a
            week held fewer than {PER_REQ_MIN} requests the line stops rather than guessing.
          </div>}
      {unpriced > 0 && (
        <div className="empty ts-caveat">
          {fmtCount(unpriced)} requests in this window ran on a model with no list price and are left out of the division.
        </div>
      )}
      <details className="hint-more ctx-method">
        <summary>why dollars over requests, and not a mean</summary>
        <p>
          A day of three requests at $2 and a day of three hundred at $0.05 average to about a
          dollar — the price of nothing that happened. Dividing the week’s dollars by the week’s
          requests is the price a request actually had. A request is one call to the model, a
          subagent’s included, so a turn that fans out is several. The line moves when conversations
          get longer (each request re-sends more), when a dearer model takes over, or when the cache
          goes cold between prompts.
        </p>
      </details>

      <div className="section section-head">
        <span>By repo <span className="section-hint">· {compare ? "this span against as many days before it" : <>last {PER_REQ_DAYS} days against the {PER_REQ_DAYS} before</>}</span></span>
      </div>
      {repos.rows.length === 0
        ? <div className="empty ctx-note">No repo has {PER_REQ_MIN} priced requests on record yet.</div>
        : <>
          <div className="empty ts-caveat">
            {repo
              ? <>Drawing <b>{repoLabel}</b> on the chart above. Tap it again to take it off.</>
              : <>Tap a repo to draw its line beside the total.</>}
          </div>
          <div className="ts-perreq">
            <div className="ts-perreq-row ts-perreq-head">
              <span>repo</span><span>{compare ? "span" : "7 days"}</span><span>{compare ? "before" : "7 before"}</span><span>change</span><span>all time</span>
            </div>
            {shown.map((r) => (
              <button key={r.key} type="button"
                className={`ts-perreq-row${repo === r.key ? " on" : ""}`}
                onClick={() => setRepo(repo === r.key ? null : r.key)}>
                <span className="ts-perreq-name">{r.label}</span>
                <span>{r.cur != null ? fmtUsd(r.cur) : "–"}</span>
                <span>{r.prev != null ? fmtUsd(r.prev) : "–"}</span>
                <span>{r.change != null ? `${r.change > 0 ? "+" : ""}${r.change}%` : ""}</span>
                <span>{r.all != null ? fmtUsd(r.all) : "–"}</span>
              </button>
            ))}
            {repos.rows.length > REPO_ROWS && (
              <button type="button" className="ts-perreq-more" onClick={() => setAllRepos(!allRepos)}>
                {allRepos ? `show the first ${REPO_ROWS}` : `show all ${repos.rows.length} (${shown.length} of ${repos.rows.length} listed)`}
              </button>
            )}
          </div>
          <div className="empty ts-caveat">
            A dash is a week with fewer than {PER_REQ_MIN} priced requests in that repo — too few to be a price.
            {repos.hidden > 0 && <> {fmtCount(repos.hidden)} more {repos.hidden === 1 ? "repo has" : "repos have"} never had that many and {repos.hidden === 1 ? "is" : "are"} not listed.</>}
          </div>
        </>}
    </>
  );
}

function PerRequestChart({ all, mine, repoLabel, lo, hi, width }: {
  all: ReqPoint[][];
  mine: ReqPoint[][];
  repoLabel: string | null;
  lo: number;
  hi: number;
  width: number;
}) {
  const peak = Math.max(0, ...all.flat().map((p) => p.v), ...mine.flat().map((p) => p.v)) * MILLS;
  // The x domain is the WINDOW, not the points, so the total and a repo that
  // only started last week are drawn on one calendar.
  const p = makeDayPlot({
    width, height: CHART_H, pad: PAD,
    points: [{ t: lo, v: 0, day: "" }, { t: hi, v: peak, day: "" }],
  });
  const mills = (runs: ReqPoint[][]) => runs.map((r) => r.map((q) => ({ ...q, v: q.v * MILLS })));
  const a = mills(all), m = mills(mine);
  const [hover, setHover] = useState<number | null>(null);
  const svgRef = useRef<SVGSVGElement | null>(null);
  const onMove = useCallback((e: React.PointerEvent<SVGSVGElement>) => {
    const box = svgRef.current?.getBoundingClientRect();
    if (!box) return;
    const t = p.t0 + ((((e.clientX - box.left) / box.width) * width - p.x) / p.w) * (p.t1 - p.t0);
    // Snap to a whole day, and hold the DAY rather than pixels.
    const d = new Date(t + 43_200_000); d.setHours(0, 0, 0, 0);
    setHover(Math.max(lo, Math.min(hi, d.getTime())));
  }, [p, width, lo, hi]);
  const at = (runs: ReqPoint[][], t: number | null) => (t == null ? null : runs.flat().find((q) => q.t === t) ?? null);
  const ha = at(all, hover), hm = at(mine, hover);

  return (
    <>
      <div className="ctx-box">
      <svg ref={svgRef} className="ctx-chart" width={width} height={CHART_H} viewBox={`0 0 ${width} ${CHART_H}`}
        onPointerDown={onMove} onPointerMove={onMove}
        onPointerLeave={(e) => { if (e.pointerType === "mouse") setHover(null); }}
        role="img" aria-label="cost per request over time">
        {p.yTicks.map((v) => (
          <line key={v} x1={p.x} x2={p.x + p.w} y1={p.py(v)} y2={p.py(v)} stroke="var(--line)" strokeWidth={1} />
        ))}
        {a.map((r, i) => r.length === 1
          ? <circle key={`a${i}`} cx={p.px(r[0].t)} cy={p.py(r[0].v)} r={2.5} fill={SERIES} />
          : <path key={`a${i}`} d={stepPath(p, r)} fill="none" stroke={SERIES} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />)}
        {m.map((r, i) => r.length === 1
          ? <circle key={`m${i}`} cx={p.px(r[0].t)} cy={p.py(r[0].v)} r={2.5} fill={REPO_LINE} />
          : <path key={`m${i}`} d={stepPath(p, r)} fill="none" stroke={REPO_LINE} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />)}
        {p.yTicks.map((v) => (
          <text key={`t${v}`} className="ctx-tick" x={p.x - 6} y={p.py(v) + 3.5} textAnchor="end">{v === 0 ? "$0" : fmtUsd(v / MILLS)}</text>
        ))}
        {dayTicks(p).map((t, i) => (
          <text key={i} className="ctx-tick" x={t.x} y={CHART_H - 6} textAnchor={t.anchor}>{t.label}</text>
        ))}
        {hover != null && (
          <g>
            <line x1={p.px(hover)} x2={p.px(hover)} y1={p.y} y2={p.y + p.h} stroke="var(--fg)" strokeOpacity={0.35} strokeWidth={1} />
            {ha && <circle cx={p.px(hover)} cy={p.py(ha.v * MILLS)} r={4.5} fill={SERIES} stroke="var(--panel)" strokeWidth={2} />}
            {hm && <circle cx={p.px(hover)} cy={p.py(hm.v * MILLS)} r={4.5} fill={REPO_LINE} stroke="var(--panel)" strokeWidth={2} />}
          </g>
        )}
      </svg>
      </div>
      <div className="ts-perreq-legend">
        <span><i style={{ background: SERIES }} />all repos</span>
        {repoLabel && <span><i style={{ background: REPO_LINE }} />{repoLabel}</span>}
      </div>
      <div className="ctx-readout">
        {hover == null
          ? <ScrubHint />
          : `${fmtDate(hover)} · ${ha ? `${fmtUsd(ha.v)} per request (${fmtCount(ha.priced)} in ${PER_REQ_DAYS} days)` : "too few requests for a price"}${
              repoLabel ? ` · ${repoLabel} ${hm ? fmtUsd(hm.v) : "–"}` : ""}`}
      </div>
    </>
  );
}

/** The values half: one row per day of the line, newest first. */
function PerRequestTable({ runs }: { runs: ReqPoint[][] }) {
  const rows = runs.flat().slice().reverse();
  if (!rows.length) return null;
  return (
    <div className="ts-perreq">
      <div className="ts-perreq-row ts-perreq-head ts-perreq-days">
        <span>{PER_REQ_DAYS} days to</span><span>per request</span><span>requests</span><span>cost</span>
      </div>
      {rows.map((r) => (
        <div key={r.day} className="ts-perreq-row ts-perreq-days">
          <span>{fmtDate(r.t)}</span><span>{fmtUsd(r.v)}</span><span>{fmtCount(r.priced)}</span><span>{fmtUsd(r.usd)}</span>
        </div>
      ))}
    </div>
  );
}
