/** One limit window's recent readings as a labelled chart under its bar. */
import { useMemo, useRef, useState } from "react";
import { type UsageHistoryDoc } from "@waterplane/shared";
import {
  burnRate, Explain, nearestUsage, ScrubHint, SERIES, timeTicks, until, usageMarksText, usageOutlook, usageSegments,
  usageSpan, useBoxWidth,
} from "@waterplane/kit";
import { HISTORY_HOURS } from "./constants.ts";
import { resetWhen, tickWhen } from "./when.ts";

/**
 * The plotting area's height.
 *
 * It was 40px, which is a sparkline: a shape you glance at beside a number,
 * with no axis and nothing to read off it. At 2% used that is a hairline on
 * the floor of a grey box, and the box was the whole answer to "what has this
 * window been doing" — so this is a CHART now, tall enough for three labelled
 * rules and a crosshair you can land a finger on.
 */
const SPARK_H = 88;
/** Breathing room inside the strip. Without it a window at 97% draws its line
 *  ON the top edge, where it reads as a border rather than as a value. */
const SPARK_PAD = 6;
/** The row under the plot that holds the time labels. */
const SPARK_TICK_H = 15;
/** The gutter the y labels sit in, in SVG user units — `100%` at
 *  `RepoHealthTiles.tsx`'s 6px-per-character estimate plus the 5px it stands
 *  off the axis, measured in user units where there is no `--ui-font` cascade
 *  to read. Short by six and the widest label loses its first digit, which is
 *  the one that says whether the window is full. */
const SPARK_GUTTER = 36;
/** How much room a time label needs before the next one may be drawn. Wide
 *  enough for the label AND the space beside it: it is the LABELS
 *  that were too wide when the first two ran together on a 390px phone, not
 *  this gap — they carried a weekday each, and now only midnight does. */
const SPARK_TICK_PX = 78;


/**
 * One limit window's recent readings, under its bar.
 *
 * ── What this is not ────────────────────────────────────────────────────────
 *
 * It is not a feed. The host records the readings it happens to take
 * (`usagelog.ts`) — nothing on this screen causes a scrape for the sake of the
 * line — so the series is irregular, and everything here is built so that
 * cannot be mistaken for anything else: gaps are drawn as gaps, a window
 * rollover cuts the line rather than drawing a cliff, and a stretch with no
 * readings simply has no ink in it.
 *
 * ── The projection ──────────────────────────────────────────────────────────
 *
 * The one reading here somebody would plan around is "at this rate, how long
 * does this last", and `usageOutlook` answers it in whichever of the two units
 * the window has an answer in: a TIME when it fills before its reset, a LEVEL
 * ("on track for ~28%") when the reset comes first. The second half was silence
 * until it was not, which read as a projection that could not be made rather
 * than as the good news it is.
 *
 * It still follows this codebase's rule for every heuristic and degrades to
 * ABSENT: no rate without two readings ≥20 minutes apart inside the CURRENT
 * window, no projection when the rate is flat or falling, and none from a
 * reading whose reset has already passed. The instant, when there is one, is
 * written by `resetWhen` — never as a bare wall-clock time, because the weekly
 * window's projection lands days out.
 */
export function UsageSpark({ samples, which, reset, pct, everyMs, width, hours = HISTORY_HOURS, name }: {
  samples: UsageHistoryDoc["samples"];
  which: "session" | "week";
  /** How far back the `session` lane looks. Another source's quota (a month, say) reads its
   *  readings on that lane over a longer stretch (`SourceWindows`). */
  hours?: number;
  /** The window's name for a screen reader, where it is not claude's five-hour or weekly one. */
  name?: string;
  reset: number | null;
  pct: number | null;
  everyMs: number;
  /** A width to draw at instead of measuring one. Static renders only — a page
   *  with no `ResizeObserver` measures zero and draws nothing, which is the one
   *  way a chart goes unchecked. */
  width?: number;
}) {
  const [measured, box] = useBoxWidth();
  const w = width ?? measured;
  const svgRef = useRef<SVGSVGElement | null>(null);
  // WHICH reading the crosshair is on, held as its own timestamp and resolved
  // against the points at every render. Not pixels (the phone rotates and the
  // ring would be painted at the old width's coordinates while the sentence
  // still named the old reading) and not an array index either: this series
  // GROWS at its end as scrapes land, and an index survives that only by
  // accident. `RepoHealthTiles.tsx` argues the same rule at length.
  const [pickedT, setPickedT] = useState<number | null>(null);
  // What was picked when the current gesture began, so a gesture the browser
  // takes away (a vertical scroll claimed as a pan) can be put back rather
  // than landing as a choice.
  const before = useRef<number | null>(null);

  // A gap wider than three polls is a stretch nobody observed. Floored at 45
  // minutes so a host that is not polling at all (the ordinary case — polling
  // is only on when the auto-fire gate needs it) still draws a continuous line
  // across the few readings a person's own visits produced.
  const maxGap = Math.max(45 * 60_000, everyMs * 3);
  // The span is decided BEFORE the segments: the document carries a week, and
  // a reading off the left edge must not be the first point of a segment that
  // is drawn from outside the plot. Minute-rounded so the memo does not re-cut
  // on every render.
  const nowMin = Math.floor(Date.now() / 60_000) * 60_000;
  const span = usageSpan(which, reset, nowMin, hours);
  const inSpan = useMemo(
    () => samples.filter((r) => r.t >= span.t0 && r.t <= Math.max(span.t1, nowMin + 60_000)),
    [samples, span.t0, span.t1, nowMin],
  );
  const segs = useMemo(() => usageSegments(inSpan, which, maxGap), [inSpan, which, maxGap]);
  const rate = useMemo(() => burnRate(segs), [segs]);
  const out = usageOutlook(pct, rate, reset, Date.now());

  const pts = segs.flatMap((s) => s.pts);
  if (pts.length < 2) {
    // Absent, and said in words — an empty chart box reads as a broken chart.
    return (
      <div className="ts-spark-none">
        {inSpan.length
          ? "Only one reading kept so far, so there is no line to draw yet."
          : "No earlier readings kept yet — the history fills in as the screen is read."}
      </div>
    );
  }

  const now = Date.now();
  const t1 = Math.max(span.t1, pts[pts.length - 1].t);
  const t0 = span.t0;
  /** Where "now" falls, when the axis runs past it — the week chart's
   *  remaining room. Absent on the day chart, whose right edge IS now. */
  const nowX = t1 - now > 60_000 ? now : null;
  const spanWords = span.isWindow
    ? `This week’s window, since ${resetWhen(t0)}`
    : which === "week" ? "Last 7 days" : hours > 24 && hours % 24 === 0 ? `Last ${hours / 24} days` : `Last ${hours}h`;
  /** The plot proper, to the right of the y labels. ONE width, computed once:
   *  two copies of this subtraction is a clamp in one place and a negative
   *  number in the other, exactly where the box is narrower than its gutter. */
  const plotW = Math.max(1, w - SPARK_GUTTER);
  const px = (t: number) => SPARK_GUTTER + ((t - t0) / Math.max(1, t1 - t0)) * plotW;
  // Fixed 0..100, never fitted to the data: a window 15% full and a window
  // full look identical on an axis rescaled to their own peak, and that is the
  // one confusion a limit gauge cannot afford.
  const py = (v: number) => SPARK_H - SPARK_PAD - (Math.max(0, Math.min(100, v)) / 100) * (SPARK_H - 2 * SPARK_PAD);
  const path = (seg: { pts: { t: number; v: number }[] }) =>
    seg.pts.map((s, i) => `${i ? "L" : "M"}${px(s.t).toFixed(1)},${py(s.v).toFixed(1)}`).join("");
  /** The same line closed to the floor. Filled faintly, because at the bottom of
   *  a 0–100 axis a bare 12% stroke is a hairline that reads as a rule. */
  const area = (seg: { pts: { t: number; v: number }[] }) => {
    if (seg.pts.length < 2) return "";
    const base = py(0).toFixed(1);
    return `M${px(seg.pts[0].t).toFixed(1)},${base}L${path(seg).slice(1)}L${px(seg.pts[seg.pts.length - 1].t).toFixed(1)},${base}Z`;
  };

  const ticks = timeTicks(t0, t1, Math.max(2, Math.floor(plotW / SPARK_TICK_PX)));
  const marks = usageMarksText(segs);
  /** The picked reading, resolved on THIS render against these points, so the
   *  ring and the sentence under the chart cannot describe two readings. */
  const at = pickedT == null ? null : pts.find((p) => p.t === pickedT) ?? null;

  /** Where a pointer landed, as an instant. The SVG is laid out in CSS px and
   *  drawn in user units, and on a rotated phone those differ — mixing them
   *  puts the crosshair on the wrong reading (`ContextChart` learnt this). */
  const pickAt = (e: { clientX: number }): number | null => {
    const r = svgRef.current?.getBoundingClientRect();
    if (!r?.width) return null;
    const x = ((e.clientX - r.left) / r.width) * w - SPARK_GUTTER;
    return t0 + (Math.max(0, Math.min(plotW, x)) / plotW) * (t1 - t0);
  };
  const pick = (e: { clientX: number }, toggle = false) => {
    const t = pickAt(e);
    if (t == null) return;
    const hit = nearestUsage(segs, t);
    if (!hit) return;
    // A second tap on the reading already chosen lets go: on touch nothing
    // else ever clears it, and a selection with no way out is the same defect
    // as a control that cannot be un-pressed.
    setPickedT(toggle && hit.t === pickedT ? null : hit.t);
  };

  return (
    <div className="ts-spark" ref={box}>
      {w > 0 && (
        <svg ref={svgRef} className="ts-spark-svg" width={w} height={SPARK_H + SPARK_TICK_H}
          viewBox={`0 0 ${w} ${SPARK_H + SPARK_TICK_H}`} role="img"
          aria-label={`${name ?? (which === "session" ? "five-hour" : "weekly")} window, ${spanWords}, ${pts.length} readings`}
          onPointerDown={(e) => { before.current = pickedT; pick(e, true); }}
          onPointerMove={(e) => { if (e.buttons || e.pointerType !== "mouse") pick(e); }}
          // Lifting clears for a MOUSE and must not for a finger: `pointerleave`
          // fires the instant a touch pointer is destroyed, so a shared handler
          // wipes the answer exactly when the reader finally looks at it.
          onPointerLeave={(e) => { if (e.pointerType === "mouse") setPickedT(null); }}
          // A gesture the browser TAKES BACK must not land as a choice — a
          // vertical scroll beginning on the chart fires down (which picks) and
          // then cancel once the pan is claimed.
          onPointerCancel={() => setPickedT(before.current)}>
          {/* The plotting area, drawn, so the strip reads as a chart with a
              floor and a ceiling rather than as a stroke floating in a row —
              which is what a 12% week looked like without it. */}
          <rect x={SPARK_GUTTER} y={0} width={plotW} height={SPARK_H} rx={4}
            fill="var(--fg)" fillOpacity={0.05} />
          {/* Floor, half and full, and all three LABELLED. The axis is fixed
              0–100, and an unlabelled fixed axis is indistinguishable from a
              fitted one — which is the whole difference between a window that
              is nearly full and one that has barely been touched. */}
          {[0, 50, 100].map((v) => (
            <g key={v}>
              <line x1={SPARK_GUTTER} x2={w} y1={py(v)} y2={py(v)} stroke="var(--line)" strokeWidth={1}
                strokeOpacity={v === 50 ? 0.55 : 1} />
              <text className="ts-spark-ylab" x={SPARK_GUTTER - 5} y={py(v) + 3.5} textAnchor="end">{v}%</text>
            </g>
          ))}
          {/* WHEN. A day-wide strip with no time axis is a shape, not a
              reading: "it climbed" with no answer to "since when". */}
          {ticks.map((t, i) => (
            <text key={t} className="ts-spark-tick" x={px(t)} y={SPARK_H + 11}
              textAnchor={i === 0 ? "start" : i === ticks.length - 1 ? "end" : "middle"}>
              {tickWhen(t)}
            </text>
          ))}
          {/* The week the reset closes runs past now: that room is drawn and
              marked, so where the line stops says how far through the week
              you are. A SOLID rule — the dashed one means a rollover. */}
          {nowX != null && (
            <g pointerEvents="none">
              <line x1={px(nowX)} x2={px(nowX)} y1={0} y2={SPARK_H}
                stroke="var(--fg)" strokeOpacity={0.45} strokeWidth={1} />
              <text className="ts-spark-tick" x={px(nowX) - 3} y={10} textAnchor="end">now</text>
            </g>
          )}
          {segs.map((seg, i) => (
            <g key={i}>
              {/* A rollover is DRAWN, not smoothed: the break says the drop was
                  a new window rather than usage coming back. */}
              {seg.rolled && seg.pts.length > 0 && (
                <line x1={px(seg.pts[0].t)} x2={px(seg.pts[0].t)} y1={2} y2={SPARK_H - 2}
                  stroke="var(--fg)" strokeOpacity={0.3} strokeWidth={1} strokeDasharray="3 3" />
              )}
              <path d={area(seg)} fill={SERIES} fillOpacity={0.16} />
              <path d={path(seg)} fill="none" stroke={SERIES} strokeWidth={1.75}
                strokeLinejoin="round" strokeLinecap="round" />
              {seg.pts.length === 1 && (
                <circle cx={px(seg.pts[0].t)} cy={py(seg.pts[0].v)} r={2.5} fill={SERIES} />
              )}
            </g>
          ))}
          <circle cx={px(pts[pts.length - 1].t)} cy={py(pts[pts.length - 1].v)} r={3}
            fill={SERIES} stroke="var(--panel)" strokeWidth={1.5} />
          {/* The crosshair: ink, never the series colour — the coloured dot
              already means "this is where the line ends". */}
          {at && (
            <g pointerEvents="none">
              <line x1={px(at.t)} x2={px(at.t)} y1={0} y2={SPARK_H}
                stroke="var(--fg)" strokeOpacity={0.35} strokeWidth={1} />
              <circle cx={px(at.t)} cy={py(at.v)} r={4.5} fill="var(--panel)"
                stroke="var(--fg)" strokeOpacity={0.7} strokeWidth={2} />
            </g>
          )}
        </svg>
      )}
      {/* The crosshair's answer, in a line that is ALWAYS there: a phone has no
          hover, so a floating box would sit under the finger that summoned it,
          and a reading reachable only by a gesture has to announce the
          gesture — in the kit's one wording, the same under every chart. */}
      <div className="ts-spark-scrub">
        {at
          ? <><b>{resetWhen(at.t)}</b> · <b>{at.v}% used</b>{at.r ? <> · in the window that reset {resetWhen(at.r)}</> : null}</>
          : <ScrubHint />}
      </div>
      <div className="ts-spark-sub">
        {spanWords}, {pts.length} readings
        {rate != null && <> · <b>+{rate.toFixed(rate < 10 ? 1 : 0)}%/h</b> this window</>}
        {/* The projected instant is written like every other one on this screen
            (`resetWhen`) and never as a bare wall-clock time: the weekly window
            runs for days, so an unqualified "15:25" for a projection a day out
            is exactly the wrong-day reading the parse refuses to make upstream.
            The duration rides beside it because "how long have I got" is the
            question, and a date is only the answer once you have done the
            subtraction yourself. */}
        {out?.kind === "full" && <> · <b>full around {resetWhen(out.at)}</b> — in {until(out.at)}, at that rate</>}
        {out?.kind === "lasts" && <> · on track for <b>~{Math.round(out.pctAtReset)}%</b> by the reset at that rate</>}
        {/* What the marks MEAN, named only where they are drawn. The line is
            cut in two different circumstances that look nothing alike once you
            know them and identical until you do, and the screen never said
            which was which. A break is an absence and stays in the open; the
            dashed rule is how a rollover is DRAWN, so it folds behind a `?`
            worded with the mark's name — it stood under the chart on every visit. */}
        {marks?.lead && <><br />{marks.lead}</>}
        {marks?.more && <> <Explain of="the dashed rule" label="dashed rule">{marks.more}</Explain></>}
      </div>
    </div>
  );
}
