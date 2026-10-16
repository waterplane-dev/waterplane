/**
 * The magnitudes: how much there is, split by where it lives and by what it is.
 *
 * Split out of `RepoHealthTiles.tsx` when the per-type chart took that file
 * past this repo's 900-line lint cap, and along the line the sheet itself
 * draws. Everything in `RepoHealthTiles.tsx` is a READING — a value against
 * its own past, carrying a percentile and a slope. Nothing in here is: a size,
 * a split of a whole, a distribution of one day. The captions for both halves
 * split the same way, into `repoHealthWords.ts` and `repoHealthStackWords.ts`.
 *
 * The geometry still lives in `repoHealthPlot.ts` and the stacked chart itself
 * is still `StackChart`, imported from the tiles: two implementations of "a
 * stack whose top edge is the total" is two charts that disagree about what a
 * hole in a band means.
 */
import { useRef, useState } from "react";
import { FileText } from "lucide-react";
import type { RepoHealthPlotClassics, RepoHealthPoint } from "@waterplane/shared";
import { MIN_READINGS, columnsGeom, foldPartSeries } from "./repoHealthPlot";
import { SeriesSpark, StackChart, values } from "./RepoHealthTiles";
import {
  TYPE_FILTER_CLEAR, depsWords, magnitudeLeadWords, magnitudesNoteWords, packageStackWords,
  tapePickWords, typeChipWords, typeFilterWords, typeStackWords, typesAbsentWords,
} from "./repoHealthStackWords";
import { pointReadoutWords, seriesValueWords } from "./repoHealthWords";
import { ScrubHint } from "./kit/chart/ScrubHint";
import { HintChip } from "./HintChip";
import { Explain } from "./Explain";

const TAPE_H = 64;

const lastOf = (pts: readonly RepoHealthPoint[] | undefined): number | null => {
  if (!pts || !pts.length) return null;
  const v = pts[pts.length - 1].v;
  return v == null || !Number.isFinite(v) ? null : v;
};

/**
 * One magnitude over time: a number and its curve, with NO reading beside it.
 *
 * Deliberately not a `SeriesTile`. A tile carries a percentile and a slope
 * because the tool computed them; these four carry neither, because nothing
 * compares them to anything. Rendering them in the tile's clothes would
 * invite the eye to read a rank that was never taken, and synthesising an
 * empty one would print the tool's "not enough history" reason for a question
 * nobody asked. The absence of that line is the honest difference, so it is
 * left absent.
 */
function MagnitudeCurve({ points, label, unit, width, hint }: {
  points: readonly RepoHealthPoint[];
  label: string;
  unit: string;
  width: number;
  hint: string;
}) {
  const [pickedIndex, setPickedIndex] = useState<number | null>(null);
  if (!points.length) return null;
  const picked = pickedIndex == null ? null : points[pickedIndex] ?? null;
  const readings = points.reduce((n, p) => (p.v == null ? n : n + 1), 0);
  const drawn = width > 0 && readings >= MIN_READINGS;
  return (
    <li className="rh-tile">
      <div className="rh-tile-head">
        <span className="rh-tile-label">{label} <HintChip id={hint} of={label} /></span>
      </div>
      <div className="rh-tile-val">{seriesValueWords(lastOf(points), unit)}</div>
      {drawn ? (
        <SeriesSpark points={points} width={width} label={label} unit={unit} axes
          onPick={setPickedIndex} />
      ) : null}
      {drawn ? (
        <div className="rh-scrub">{pointReadoutWords(picked, unit) ?? <ScrubHint />}</div>
      ) : null}
    </li>
  );
}

/**
 * Lines of source by GROUP, stacked, over the whole series.
 *
 * The bands are the engine's source groups — the top-level boundaries it
 * derives at HEAD — and they are called that on screen because on this repo
 * they include `tools`, `deploy` and `.`, and on a Flutter tree none of them
 * is a package at all. The wire field is still `packages`; the label is not.
 *
 * The top edge is total source lines, which is why there is no separate
 * total-lines curve beside it: one quantity, one mark. It replaced a
 * single-day part-to-whole bar — the bar answered "what is the split today"
 * and this answers that (the right-hand edge) plus "what was it before",
 * which on a repo that went 2.8k to 143k lines in three months is the whole
 * question.
 */
export function PackageStack({ classics, width }: {
  classics: RepoHealthPlotClassics;
  width: number;
}) {
  const parts = classics.packages
    .filter((p) => p.points.length)
    // `bySize` is the wire's `rank` under the name the geometry module is
    // allowed to give it (see `PartSeries`): which groups are the big ones is
    // the tool's statement, which hue each wears is still its name's.
    .map((p) => ({ key: p.pkg, label: p.pkg, values: values(p.points), bySize: p.rank }));
  if (!parts.length) return null;
  const folded = foldPartSeries(parts, "the rest");
  return (
    <StackChart
      inputs={folded.map((f) => ({ key: f.key, label: f.label, slot: f.slot, values: f.values }))}
      points={classics.packages[0].points}
      unit="lines"
      totalLabel="every group"
      label="lines of source by group"
      width={width}
      caption={packageStackWords()}
      hint="repohealth.packages"
    />
  );
}

/**
 * The same lines, cut by file TYPE, with the cut itself in the reader's hands.
 *
 * ── Why a second chart of one number ───────────────────────────────────────
 *
 * The group stack answers "which part of the tree grew". This answers "what
 * grew in it", and the two are the same total drawn twice on purpose. In a
 * monorepo where one app is one language they agree, and a reader given only
 * the first will answer the second from it — right until an app is half
 * Kotlin, at which point the first chart has said nothing about that and looks
 * as though it has.
 *
 * ── Why the filter is here and not a fold ──────────────────────────────────
 *
 * A fold is the palette's answer to too many bands, and it is the tool's
 * `rank` that decides which survive it. That is right for a chart nobody is
 * interrogating and wrong for this one: a reader asking "how much of this tree
 * is `.kt`" wants the other eleven types gone, not ranked. So the chips are a
 * FILTER in this repo's sense — the count on the control and the cut come from
 * one set, the filtered chart says what it is hiding as `n of N` with the
 * lines that went with it, and there is one way back out.
 *
 * The consequence has to be said out loud, which is what `typeFilterWords`
 * does: with a type switched off the top edge is no longer the tree. Every
 * other stack on this sheet has a top edge that IS the whole, so a chart that
 * silently changed what its highest line means is exactly the misreading this
 * region spends its captions preventing.
 *
 * The state is deliberately not persisted. A filter that survives the sheet
 * being closed is a chart that lies to whoever opens it next — including the
 * same person tomorrow — and the reopened default is the tree.
 */
export function TypeStack({ classics, width }: {
  classics: RepoHealthPlotClassics;
  width: number;
}) {
  // Which types are switched OFF, by extension. Off rather than on so a type
  // the engine starts reporting tomorrow arrives visible: the default is the
  // whole tree, and it stays the whole tree as the tree changes.
  const [off, setOff] = useState<ReadonlySet<string>>(() => new Set<string>());

  // Two shapes, one sentence: no `types` key at all is a host or an engine
  // older than the reading, and an EMPTY list is a series whose rows were
  // written before the field existed — which is every repo on this desktop
  // until its next re-cut. Both are "nobody measured this", and neither is a
  // tree with no source in it: that case takes `classics` down as a whole and
  // is answered above.
  const all = (classics.types ?? []).filter((t) => t.points.length);
  if (!all.length) return <div className="rh-cap">{typesAbsentWords()}</div>;

  const kept = all.filter((t) => !off.has(t.ext));
  const allLoc = all.reduce((n, t) => n + (lastOf(t.points) ?? 0), 0);
  const keptLoc = kept.reduce((n, t) => n + (lastOf(t.points) ?? 0), 0);
  const filtered = typeFilterWords(kept.length, all.length, keptLoc, allLoc);

  // The tool's order, COMPACTED over what survived the filter — 0 is still the
  // largest of these, so `foldPartSeries` still reads a clean cut and the fold
  // still keeps the big ones. Nothing is derived from the values here: the
  // order is the one the engine stated, with the gaps closed.
  const rankOf = new Map(
    [...kept].sort((a, b) => a.rank - b.rank).map((t, i) => [t.ext, i]),
  );
  const parts = kept.map((t) => ({
    key: t.ext, label: t.ext, values: values(t.points), bySize: rankOf.get(t.ext) ?? 0,
  }));
  const folded = parts.length ? foldPartSeries(parts, "the rest") : [];

  const toggle = (ext: string) => setOff((prev) => {
    const next = new Set(prev);
    if (next.has(ext)) next.delete(ext); else next.add(ext);
    return next;
  });

  return (
    <div className="rh-types">
      {/* The chips before the chart, because they are what the chart is OF.
          Every type is listed whether it is on or off — a filter that hides
          the thing it filters by is a filter with no way back. */}
      <ul className="rh-filter">
        {all.map((t) => (
          <li key={t.ext}>
            <button
              className={off.has(t.ext) ? "key" : "key on"}
              aria-pressed={!off.has(t.ext)}
              onClick={() => toggle(t.ext)}
            >
              {typeChipWords(t.ext, t.pack, lastOf(t.points))}
            </button>
          </li>
        ))}
      </ul>

      {folded.length ? (
        <StackChart
          inputs={folded.map((f) => ({ key: f.key, label: f.label, slot: f.slot, values: f.values }))}
          points={all[0].points}
          unit="lines"
          // What the top edge IS, and it changes with the filter: "every type"
          // is a claim about the tree, and with two types switched off it is a
          // claim about two types.
          totalLabel={kept.length === all.length ? "every type" : `these ${kept.length} types`}
          label="lines of source by file type"
          width={width}
          caption={typeStackWords()}
          hint="repohealth.types"
        />
      ) : (
        // Every type switched off. Not an error and not an empty box: the
        // sentence says what happened and the control beside it is the way
        // back, which is the same rule a filtered list follows here.
        <div className="rh-cap">No type is selected, so there is nothing to stack.</div>
      )}

      {filtered ? (
        <div className="rh-cap">
          {filtered}{" "}
          <button className="key" onClick={() => setOff(new Set<string>())}>{TYPE_FILTER_CLEAR}</button>
        </div>
      ) : null}
    </div>
  );
}

/**
 * The "how big is this thing" numbers — in the open, not behind a fold.
 *
 * They are not readings: nothing compares them to anything, so no percentile
 * and no direction appears beside them. They were folded once, on the
 * argument that a sense of magnitude is acquired once and then carried. That
 * was wrong twice over. A percentile is unreadable without the magnitude it
 * is a percentile OF, so the thing that makes the six tiles above mean
 * anything was the one thing a reader had to go and ask for; and the LOC tape
 * is the reason this whole series exists — it is what gives a feel for how
 * much there is to handle. A fold is a button, and the classics are not
 * behind one.
 */
export function Magnitudes({ classics, width }: {
  classics: RepoHealthPlotClassics;
  width: number;
}) {
  const files = lastOf(classics.files);
  const loc = lastOf(classics.loc);
  const deps = lastOf(classics.deps);
  const lead = magnitudeLeadWords(files, loc);

  return (
    <div className="rh-mags">
      <div className="rh-mags-head">the magnitudes these are percentiles of</div>
      {classics.absent ? (
        <div className="rh-cap">This reading was not taken on the latest day — {classics.absent}</div>
      ) : null}
      {lead ? <div className="rh-lead">{lead}</div> : null}
      <div className="rh-cap">{magnitudesNoteWords()}</div>

      <PackageStack classics={classics} width={width} />
      <TypeStack classics={classics} width={width} />

      <ul className="rh-tiles">
        <MagnitudeCurve points={classics.files} label="source files" unit="files" width={width}
          hint="repohealth.classics.files" />
        <MagnitudeCurve points={classics.deps} label="production dependencies" unit="" width={width}
          hint="repohealth.classics.deps" />
      </ul>
      {depsWords(deps) ? <div className="rh-cap">{depsWords(deps)}</div> : null}
      {/* The longest-files tape moved to the top of the region, beside the
          curve of the longest file over time — `RepoHealthLongest.tsx`. */}
    </div>
  );
}

/**
 * The longest-files tape, and the file under the finger.
 *
 * The pick is an INDEX held as state, like every crosshair on this sheet, and
 * its answer is a text line under the chart, never a floating box. A drag
 * scrubs along the row; lifting keeps the pick (it is what the *open* button
 * acts on), `pointercancel` restores the pick the gesture began with (a
 * vertical scroll over the row fires down-then-cancel), and a tap on the
 * picked bar lets go.
 */
export function Tape({ tape, paths, width, caption, onOpenFile }: {
  tape: number[];
  paths: (string | null)[] | null;
  width: number;
  /** `tapeWords`' pair: `lead` drawn, `more` folded. */
  caption: { lead: string; more: string };
  onOpenFile?: (path: string) => void;
}) {
  const [picked, setPicked] = useState<number | null>(null);
  const gesture = useRef<{ start: number | null; moved: boolean } | null>(null);
  const cols = width > 0 ? columnsGeom(tape, width, TAPE_H) : null;
  if (!cols) return null;

  const indexAt = (e: React.PointerEvent<SVGSVGElement>): number => {
    const box = e.currentTarget.getBoundingClientRect();
    const i = Math.floor(((e.clientX - box.left) / Math.max(1, box.width)) * tape.length);
    return Math.max(0, Math.min(tape.length - 1, i));
  };
  const pick = picked != null && picked < tape.length
    ? { rank: picked + 1, lines: tape[picked], path: paths?.[picked] ?? null }
    : null;

  return (
    <div className="rh-chart">
      <div className="rh-chart-head">
        <span className="rh-chart-label">the longest files</span>
        <HintChip id="repohealth.classics.tape" of="the longest-files tape" />
      </div>
      <svg width={width} height={TAPE_H} viewBox={`0 0 ${width} ${TAPE_H}`} role="img"
        aria-label={`the ${tape.length} longest source files`}
        style={{ touchAction: "pan-y", cursor: "pointer" }}
        onPointerDown={(e) => {
          const i = indexAt(e);
          gesture.current = { start: picked, moved: false };
          // A tap on the bar already picked lets go; anything else picks.
          setPicked(i === picked ? null : i);
        }}
        onPointerMove={(e) => {
          const g = gesture.current;
          if (!g) return;
          g.moved = true;
          setPicked(indexAt(e));
        }}
        onPointerUp={() => { gesture.current = null; }}
        onPointerLeave={(e) => { if (e.pointerType === "mouse") gesture.current = null; }}
        onPointerCancel={() => {
          const g = gesture.current;
          gesture.current = null;
          if (g) setPicked(g.start);
        }}>
        <title>the {tape.length} longest source files, biggest first</title>
        {cols.bars.map((b, i) => (
          <rect key={i} x={b.x} y={b.y} width={b.w} height={b.h} rx={1}
            fill={i === picked ? "var(--accent)" : "currentColor"}
            fillOpacity={i === picked ? 1 : 0.45} />
        ))}
      </svg>
      <div className="rh-scrub rh-tape-pick">
        {/* Unpicked, the line is an instruction, muted like the kit's `ScrubHint`;
            a picked bar's answer keeps the readout's weight. */}
        <span className={`rh-tape-pick-words${pick ? "" : " scrub-hint"}`}>{tapePickWords(pick, !!paths)}</span>
        {pick?.path && onOpenFile ? (
          <button className="key" onClick={() => onOpenFile(pick.path!)}>
            <FileText size={14} /> open
          </button>
        ) : null}
      </div>
      {/* The figures in the open; why they are words and not rules folds behind
          the `?` at the end of that line. */}
      <div className="rh-cap">
        {caption.lead} <Explain of="the longest-files caption">{caption.more}</Explain>
      </div>
    </div>
  );
}
