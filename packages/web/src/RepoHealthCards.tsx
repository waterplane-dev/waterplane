/**
 * The frame `RepoHealthRegion.tsx` draws its cards in: the sticky jump bar,
 * the x-axis row and a card for the charts that do not draw one of their own
 * (the daily notes are `RepoHealthNotes.tsx`). Split out so the region stays
 * under the 900-line cap; nothing here fetches, sends or decides a number —
 * and nothing here imports `api.ts` or `Markdown`, because the VS Code
 * Health view draws its region with these same pieces.
 *
 * Rules held here (web-work › `RepoHealthRegion.tsx`, web-numbers › RepoHealth):
 *  - The jump bar is NAVIGATION, not a filter: no count, no lit state, and a
 *    section that is not drawn has no chip (never a dimmed one).
 *  - The x-axis choice is ONE row for the whole region, persisted per device
 *    (`readHealthAxis`), and `commits` is not offered where the desktop sends
 *    no per-commit series — the sentence saying why stands in its place.
 *  - The drag instruction is said ONCE, under that row; no readout repeats it.
 */
import type { ReactNode } from "react";
import { RefreshCw } from "lucide-react";
import { BRAND, type RepoHealthPlot } from "@waterplane/shared";
import { Explain } from "./Explain";
import { FilterChip } from "./kit/FilterChip";
import { useBoxWidth } from "./kit/chart/useBoxWidth";
import {
  NAV_LABELS, SCRUB_HINT, axisModeWords, commitsAbsentWords,
  type HealthAxisMode, type HealthNavKey,
} from "./healthIndexWords";
import { MIN_READINGS } from "./repoHealthPlot";
import { ownShow } from "./repoHealthWords";

/**
 * Which cards are drawn, in screen order — the jump bar names exactly these (a
 * section that is not on screen has no chip, never a dimmed one). ONE answer
 * for the phone's region and the VS Code view: `drawn` is the plot as folded
 * for the x axis, `plot` the unfolded one the table prints.
 */
export function shownSections({ index, drawn, plot, own }: {
  index: boolean;
  drawn: RepoHealthPlot | null;
  plot: RepoHealthPlot | null;
  /** Whether the caller draws the repo's own card at all (the phone: a repo is chosen). */
  own: boolean;
}): Record<HealthNavKey, boolean> {
  const longestReadings = drawn?.longest ? drawn.longest.points.reduce((n, p) => (p.v == null ? n : n + 1), 0) : 0;
  return {
    score: index,
    longest: !!drawn && (longestReadings >= MIN_READINGS || !!drawn.classics.tape?.length),
    tiles: !!drawn?.series.length,
    weight: !!drawn,
    size: !!drawn,
    table: !!plot && (plot.classics.files.length > 0 || !!plot.series.find((s) => s.key === "size.p95")?.points.length),
    own: own && !!plot && ownShow(plot).kind !== "none",
  };
}

/** The keys `shownSections` drew, in screen order. */
export const navKeysOf = (shown: Record<HealthNavKey, boolean>): HealthNavKey[] =>
  (Object.keys(shown) as HealthNavKey[]).filter((k) => shown[k]);

/** The id every card carries, and the one the jump bar scrolls to. */
export const navId = (key: HealthNavKey) => `rh-${key}`;

/**
 * The sticky jump bar: one chip per DRAWN section, in screen order, then the
 * refresh verb (moved here from the head so it is in reach from every card).
 */
export function HealthNav({ keys, refresh }: { keys: readonly HealthNavKey[]; refresh: ReactNode }) {
  const jump = (key: HealthNavKey) =>
    document.getElementById(navId(key))?.scrollIntoView({ behavior: "smooth", block: "start" });
  return (
    <nav className="rh-nav" aria-label="jump to">
      <div className="rh-nav-chips">
        {keys.map((k) => (
          <button key={k} type="button" className="fchip rh-nav-chip" onClick={() => jump(k)}>
            <span className="fchip-pill">{NAV_LABELS[k]}</span>
          </button>
        ))}
      </div>
      {refresh}
    </nav>
  );
}

/** The refresh verb as the bar draws it: a running run says so in its glyph and its words, never `disabled`. */
export function RefreshKey({ busy, label, onClick }: { busy: boolean; label: string; onClick: () => void }) {
  return (
    <button type="button" className="key rh-nav-refresh" onClick={onClick}>
      <RefreshCw size={14} className={busy ? "spin" : undefined} aria-hidden /> {label}
    </button>
  );
}

/**
 * `x axis  [weeks] [commits]  ?`, and the one drag instruction under it.
 * `commits` is absent — with the reason — on a desktop that sends no commit
 * series (`absent`); unknown (null: not read yet, or a scoped reading with no
 * index) still offers it, because the tiles' commit mode needs no index.
 */
export function AxisRow({ axis, onAxis, commits }: {
  axis: HealthAxisMode;
  onAxis: (m: HealthAxisMode) => void;
  commits: "absent" | "none" | "present" | null;
}) {
  const offered = commits !== "absent";
  return (
    <>
      <div className="ts-filter rh-axis" role="group" aria-label="x axis">
        <span className="ctx-stackpick-lab">x axis</span>
        <FilterChip on={axis === "weeks"} clears={false} onClick={() => onAxis("weeks")}>weeks</FilterChip>
        {offered ? (
          <FilterChip on={axis === "commits"} clears={false} onClick={() => onAxis("commits")}>commits</FilterChip>
        ) : null}
        <Explain of="the x axis">
          <p>{axisModeWords("weeks")}.</p>
          {offered ? <p>{axisModeWords("commits")}.</p> : null}
        </Explain>
      </div>
      {offered ? null : <div className="rh-cap rh-gutter">{commitsAbsentWords(BRAND.displayName)}</div>}
      <div className="rh-cap rh-gutter rh-scrubhint">{SCRUB_HINT}</div>
    </>
  );
}

/**
 * A card for a chart module that draws none of its own (longest, size,
 * table). It measures its OWN content box and hands the width down — a card
 * is narrower than the region by its padding, and a chart drawn at the
 * region's width overflows it.
 */
export function SectionCard({ id, children }: { id: HealthNavKey; children: (width: number) => ReactNode }) {
  const [width, ref] = useBoxWidth();
  return <div className="rh-card" id={navId(id)} ref={ref}>{children(width)}</div>;
}
