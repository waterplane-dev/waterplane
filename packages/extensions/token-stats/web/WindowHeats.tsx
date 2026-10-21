/** Every window before this one as a box: the stepper, the two heat grids and their selection. */
import { useCallback, useMemo } from "react";
import { ChevronLeft, ChevronRight, Grid3x3 } from "lucide-react";
import { fmtCount, fmtUsd, tokenTotal, type TokenWindowSeries } from "@waterplane/shared";
import {
  heatFrac, heatStep, LIVE_WINDOWS, type LiveWindowId, type WindowCell, type WindowCut, windowGrid,
  windowWhen,
} from "./usageCut.ts";
import { type ResourceState, Button } from "@waterplane/kit";

/**
 * WHICH window the readouts are cut to: a kind, and how many windows back.
 *
 * `null` is all time — an absent scope rather than a magic string, so a new
 * window kind cannot end up spelled two ways.
 */
export type WindowScope = { id: LiveWindowId; back: number } | null;

/** How many boxes before a grid draws them small. Four months of five-hour
 *  windows is ~570 and wants the small box; seventeen weeks wants a box a thumb
 *  can hit without aiming. */
const HEAT_DENSE = 120;
/** Steps on the ramp, including the empty one. Five reads as a scale and not as
 *  a legend of categories, and it is what `styles.css` defines swatches for. */
const HEAT_STEPS = 5;

/**
 * Stepping through the windows of one kind — the stepper beside the chips.
 *
 * The chips pick a KIND of window; this picks WHICH one, and the grids below
 * pick the same thing by tap. All three write one `{id, back}`, so there is
 * never a second idea on this screen of what is selected.
 *
 * Both ends are SENTENCES rather than dead buttons (`Unavailable.tsx`'s rule):
 * at `back: 0` there is no newer window because it has not happened, and past
 * the record there is no older one because nobody has a ledger for it — two
 * different facts, and a greyed arrow states neither.
 */
export function WindowStep({ cut, grid, onScope }: {
  cut: WindowCut;
  grid: TokenWindowSeries | null;
  onScope: (s: WindowScope) => void;
}) {
  // How far back the ledger reaches for this kind, straight off the same grid
  // the boxes are drawn from — never a second reading of "does that window
  // exist", which is exactly how a stepper ends up offering a box the heatmap
  // does not draw.
  const oldest = useMemo(() => {
    const cells = windowGrid(grid);
    return cells.length ? cells[0].back : 0;
  }, [grid]);
  const canOlder = cut.back < oldest;
  const canNewer = cut.back > 0;
  return (
    <div className="ts-wstep">
      {canOlder
        ? <Button onClick={() => onScope({ id: cut.id, back: cut.back + 1 })}
            title="the window before this one">
            <ChevronLeft size={14} /> older
          </Button>
        : <span className="ts-wstep-end">the record stops here</span>}
      <span className="ts-wstep-at">
        {cut.back === 0 ? "the window running now" : windowWhen(cut.openedAt, cut.resetAt)}
      </span>
      {canNewer
        ? <Button onClick={() => onScope({ id: cut.id, back: cut.back - 1 })}
            title="the window after this one">
            newer <ChevronRight size={14} />
          </Button>
        : <span className="ts-wstep-end">nothing newer has happened</span>}
    </div>
  );
}

/**
 * Every window before this one, as a grid of boxes — one per window, shaded by
 * what went through it.
 *
 * TWO grids and never one: a weekly window holds ~34 times a five-hour one, so
 * a shared scale would paint every five-hour box at the bottom of the ramp and
 * say nothing about which of them was busy. Each carries its own maximum, said
 * in its own legend.
 *
 * Absent — not an error box — when the host does not answer: the route is newer
 * than the screen, and a desktop one version behind must render exactly as it
 * did before this existed.
 */
export function WindowHeats({ grids, res, money, scope, onScope }: {
  grids: Map<LiveWindowId, TokenWindowSeries>;
  res: { state: ResourceState };
  money: boolean;
  scope: WindowScope;
  onScope: (s: WindowScope) => void;
}) {
  const kinds = LIVE_WINDOWS.filter((w) => grids.has(w.id));
  if (!kinds.length) return null;
  return (
    <div className="ts-heats">
      {kinds.map((spec) => (
        <WindowHeat key={spec.id} spec={spec} grid={grids.get(spec.id)!}
          money={money} scope={scope} onScope={onScope} />
      ))}

      {/* Staleness is a FACT about what is on screen, so it stays visible; the
          reading guide under it is METHOD and folds.

          Two clauses do NOT fold with it. WHICH WAY the boxes run is how you
          find the one you are looking at — a grid read backwards is read wrong,
          not read partially. And an OUTLINED box is the absence rule: it is the
          one mark here that stands for "nobody measured this", against an empty
          box that stands for a measured nothing, and a screen that draws those
          two differently while explaining the difference behind a disclosure is
          inviting the exact reading this app refuses to let a zero make. The
          per-cell `title` does not answer it — this is a phone. */}
      {(res.state === "cached" || res.state === "offline") && (
        <div className="empty ts-caveat">These grids are the last copy this phone had.</div>
      )}
      <div className="empty ts-caveat">
        Oldest first; the last box is the window running now. An <b>empty</b> box ran
        nothing, which is a reading; an <b>outlined</b> one is a window the hour record
        does not reach, which is not.
      </div>
      <details className="hint-more ctx-method">
        <summary>how to read the boxes</summary>
        <p>
          A tap cuts every readout above down to that one window. Shaded by{" "}
          <b>{money ? "list-price cost" : "tokens"}</b> against the busiest box in ITS OWN grid — the
          two never share a scale, because a week holds about thirty-four five-hour
          windows. The scale is square-rooted, so a box twice as dark is rather more
          than twice as busy.
          {" "}Each box counts from the hour nearest the moment its window opened to the
          hour nearest its reset — the same rule the live readout above states — so every
          hour is in exactly one box, and a box is off its window by at most half an hour
          at each end.
        </p>
      </details>
    </div>
  );
}

/** One kind's grid. The sentence that says what a box IS belongs to the pair
 *  (`WindowHeats`) and not here: printed under each grid it was the same nine
 *  lines twice, and a caveat a reader has already skipped once is a caveat. */
function WindowHeat({ spec, grid, money, scope, onScope }: {
  spec: (typeof LIVE_WINDOWS)[number];
  grid: TokenWindowSeries;
  money: boolean;
  scope: WindowScope;
  onScope: (s: WindowScope) => void;
}) {
  const cells = useMemo(() => windowGrid(grid), [grid]);
  /** What a box is worth under the metric the whole screen is on. One switch,
   *  never a second one here: these are the same numbers the hero is showing,
   *  asked one window at a time. */
  const valueOf = useCallback(
    (c: WindowCell) => (c.totals ? (money ? (c.cost?.total ?? 0) : tokenTotal(c.totals)) : null),
    [money],
  );
  const vals = cells.map(valueOf);
  const max = vals.reduce<number>((m, v) => Math.max(m, v ?? 0), 0);
  const counted = vals.filter((v) => v != null).length;
  const ran = vals.filter((v) => (v ?? 0) > 0).length;
  if (!cells.length) return null;
  const fmt = (v: number) => (money ? fmtUsd(v) : `${fmtCount(v)} tokens`);
  const dense = cells.length > HEAT_DENSE;

  return (
    <div className="ts-heat">
      <div className="section section-head">
        <span>
          <Grid3x3 size={12} style={{ verticalAlign: "-2px", marginRight: 4 }} />
          {spec.id === "session" ? "Five-hour windows" : "Weekly windows"}
        </span>
        <span className="ts-heat-n">{ran} of {counted} had anything in them</span>
      </div>

      <div className={`ts-heat-grid${dense ? " dense" : ""}`}>
        {cells.map((c, i) => {
          const v = vals[i];
          const on = scope?.id === spec.id && scope.back === c.back;
          const step = v == null ? 0 : heatStep(heatFrac(v, max), HEAT_STEPS);
          const when = windowWhen(c.openedAt, c.resetAt);
          const said = v == null
            ? "outside the hour record"
            : v > 0 ? fmt(v) : "nothing counted";
          return (
            <button key={c.back} type="button"
              className={`ts-heat-b s${step}${v == null ? " unknown" : ""}${c.back === 0 ? " now" : ""}${on ? " on" : ""}`}
              aria-label={`${when} — ${said}`}
              title={`${when} — ${said}`}
              // A box is the same decision the stepper takes, so it writes the
              // same scope; tapping the one already on takes the readouts back
              // to all time, which is how every other filter on this screen
              // lets go.
              onClick={() => onScope(on ? null : { id: spec.id, back: c.back })} />
          );
        })}
      </div>

      <div className="ts-heat-key">
        <span className="ts-heat-key-l">less</span>
        {Array.from({ length: HEAT_STEPS }, (_, i) => (
          <span key={i} className={`ts-heat-b s${i}`} aria-hidden="true" />
        ))}
        <span className="ts-heat-key-l">more{max > 0 ? ` · busiest ${fmt(max)}` : ""}</span>
      </div>

    </div>
  );
}
