/** The clock-face chart, the horizontal category bars and the one model legend and fill they share. */
import { useState } from "react";
import {
  fmtCount, fmtExact, fmtShare, fmtUsd, type ModelSlice, normalizeModel, type TokenGroup,
  type TokenStatsDoc, tokenTotal,
} from "@waterplane/shared";
import { barRows, clockColumns, MODEL_SLOT, modelBands, SERIES } from "@waterplane/kit";

/**
 * The 24-hour clock: when, in a day, this desktop actually works.
 *
 * A CATEGORICAL axis, not the time axis every other chart here uses, and the
 * distinction matters enough to be a separate function in `statsPlot`: hour 23
 * is next to hour 0 of the following day, not to hour 22 of this one. Folding
 * the corpus onto a clock face throws the calendar away on purpose — the
 * question is "am I a morning person or a 2 a.m. one", and that question has no
 * dates in it.
 *
 * Every one of the 24 slots is drawn, including the empty ones. "I have never
 * once started before 9" is a reading, and it only exists if the hours nobody
 * worked are visible as hours nobody worked.
 */
export function ClockChart({ slots, width, money }: {
  slots: TokenStatsDoc["hourOfDay"];
  width: number;
  money: boolean;
}) {
  const height = 120;
  const pad = { top: 8, right: 6, bottom: 18, left: 6 };
  const box = { x: pad.left, y: pad.top, w: Math.max(1, width - pad.left - pad.right), h: Math.max(1, height - pad.top - pad.bottom) };
  const values = slots.map((h) => (money ? h.cost.total : tokenTotal(h)));
  const cols = clockColumns(values, box);
  const [hover, setHover] = useState<number | null>(null);
  const peak = cols.reduce((m, c) => (c.value > m.value ? c : m), cols[0]);
  const busiest = peak && peak.value > 0 ? peak : null;

  return (
    <>
      <svg className="ctx-chart" width={width} height={height} viewBox={`0 0 ${width} ${height}`} role="img"
        aria-label="usage by hour of the day, all time">
        {cols.map((c) => (
          <rect key={`s${c.hour}`} x={c.x} y={box.y} width={c.w} height={box.h} rx={2}
            fill="var(--fg)" fillOpacity={0.045}
            onPointerDown={() => setHover(c.hour)} onPointerEnter={() => setHover(c.hour)} />
        ))}
        {cols.map((c) => (
          <rect key={c.hour} x={c.x} y={c.y} width={c.w} height={c.h} rx={Math.min(2, c.w / 2)}
            fill={SERIES} fillOpacity={hover != null && hover !== c.hour ? 0.45 : 0.85} />
        ))}
        {/* Four labels, not 24 — the rest are read off the shape. */}
        {[0, 6, 12, 18].map((h) => (
          <text key={h} className="ctx-tick" x={cols[h].x + cols[h].w / 2} y={height - 5} textAnchor="middle">
            {String(h).padStart(2, "0")}
          </text>
        ))}
      </svg>
      <div className="ctx-readout">
        {hover != null
          ? `${String(hover).padStart(2, "0")}:00 — ${values[hover] > 0 ? `${money ? fmtUsd(values[hover]) : fmtExact(values[hover])} · ${fmtShare(cols[hover].share)} of the day` : "nothing, ever"}`
          : busiest
            ? `busiest hour ${String(busiest.hour).padStart(2, "0")}:00 · ${fmtShare(busiest.share)} of everything`
            : "nothing recorded"}
      </div>
    </>
  );
}

/** Horizontal bars — long category names, so the layout rotates, not the text. */
export function Bars({ rows, money = false, bands: modelSlots }: {
  rows: TokenGroup[];
  money?: boolean;
  /**
   * Split each bar by the model that ran there — see `modelBands`.
   *
   * The reason this exists on the REPO list and not the model one: a bar says
   * myapp is 42% of the tokens and cannot say why it is a different share of the
   * money, and the answer is never in the total. Opus is 2.5× sonnet per token
   * and 5× haiku, so the gap between a repo's token share and its cost share is
   * a statement about its model mix and about nothing else. Stacked, the bar
   * answers both questions at once and the "why" stops being a thing the reader
   * has to already know.
   *
   * Absent ⇒ the solid fill these bars have always had.
   */
  bands?: ReturnType<typeof modelBands>;
}) {
  // Ranked BY the metric on screen, not always by tokens. The two orders really
  // differ — a repo that ran on Opus costs more per token than one that ran on
  // Sonnet — and a bar list sorted by something other than what it is drawing
  // is a chart that contradicts itself.
  const value = (g: TokenGroup) => (money ? g.cost.total : tokenTotal(g));
  const ordered = [...rows].sort((a, b) => value(b) - value(a));
  const bars = barRows(ordered, value, (g) => g.label);
  if (!bars.length) return <div className="empty">Nothing recorded.</div>;
  return (
    <div className="ts-bars">
      {bars.map((b) => (
        <div key={b.item.key} className="ts-barrow">
          <div className="ts-barhead">
            <span className="ts-barlabel" title={b.item.key}>{b.label}</span>
            <span className="ts-barval">
              {money ? fmtUsd(b.value) : b.text}
              {/* A model with no published rate shows the fact rather than a
                  $0 that reads as "free". */}
              {money && b.item.priced === false ? <em>no list price</em> : <em>{fmtShare(b.share)}</em>}
            </span>
          </div>
          <div className="ts-bartrack">
            {/* One fill, or the same fill split by model. The segments are laid
                end to end inside the bar's own width — so the bar still means
                what it meant (its length is the value) and the split is a
                second reading laid over the first, never a change to the
                first. */}
            {modelSlots && b.item.byModel?.length
              ? <ModelFill group={b.item} frac={b.frac} money={money} bands={modelSlots} />
              : <span className="ts-barfill" style={{ width: `${Math.max(1, b.frac * 100)}%` }} />}
          </div>
        </div>
      ))}
    </div>
  );
}

/**
 * Which colour is which model — the one legend for every model stack on this
 * screen.
 *
 * Present whenever a chart is split by model, because identity is never colour
 * alone: the four token kinds have the composition strip naming them on every
 * screen they appear on, and the models had nothing. One component so the day
 * chart, the subagent chart and the repo bars cannot disagree about which hue
 * means which model — they already share the slot assignment, and a legend
 * rebuilt per chart is the way that guarantee gets quietly broken.
 */
export function ModelLegend({ bands: modelSlots }: { bands: ReturnType<typeof modelBands> }) {
  const entries = [
    ...modelSlots.bands.map((b) => ({ slot: b.slot, name: b.alias.replace(/^claude-/, "") })),
    ...(modelSlots.restSlot != null ? [{ slot: modelSlots.restSlot, name: modelSlots.restName }] : []),
  ];
  if (entries.length < 2) return null;
  return (
    <div className="ctx-legend ctx-legend-stack">
      {entries.map((e) => (
        <span key={e.name}>
          <svg width="10" height="10" aria-hidden>
            <rect x="0" y="1" width="10" height="8" rx="2" fill={MODEL_SLOT[e.slot] ?? SERIES} />
          </svg>
          {e.name}
        </span>
      ))}
    </div>
  );
}

/**
 * One bar's fill, split by the model that ran there.
 *
 * Segments are sized against the BAR's own value, not against the largest row,
 * so the bar's length still means what it always meant and the split is laid
 * inside it. Every non-zero model gets at least a hairline — a part-to-whole
 * that silently omits a part is not one, the rule `compose` states — and the
 * exact share is in each segment's own title as well as in the row's tooltip,
 * so nothing is reachable only by hovering.
 */
function ModelFill({ group, frac, money, bands: modelSlots }: {
  group: TokenGroup;
  frac: number;
  money: boolean;
  bands: ReturnType<typeof modelBands>;
}) {
  const named = new Map(modelSlots.bands.map((b) => [b.alias, b.slot]));
  const val = (m: ModelSlice) => (money ? m.cost.total : tokenTotal(m.totals));
  // Folded to the ALIAS, so a dated snapshot and the plain id are one segment.
  const byAlias = new Map<string, { slot: number; name: string; v: number }>();
  for (const m of group.byModel ?? []) {
    const alias = normalizeModel(m.model) ?? m.model;
    const slot = named.get(alias);
    const key = slot != null ? alias : "\u0000rest";
    const cur = byAlias.get(key) ?? {
      slot: slot ?? modelSlots.restSlot ?? MODEL_SLOT.length - 1,
      name: slot != null ? alias.replace(/^claude-/, "") : modelSlots.restName,
      v: 0,
    };
    cur.v += val(m);
    byAlias.set(key, cur);
  }
  const segs = [...byAlias.values()].filter((sg) => sg.v > 0).sort((a, b) => a.slot - b.slot);
  const whole = segs.reduce((n, sg) => n + sg.v, 0);
  if (!segs.length || whole <= 0) {
    return <span className="ts-barfill" style={{ width: `${Math.max(1, frac * 100)}%` }} />;
  }
  return (
    <span className="ts-barfill ts-barfill-split" style={{ width: `${Math.max(1, frac * 100)}%` }}>
      {segs.map((sg) => (
        <span key={sg.name} className="ts-barseg"
          title={`${sg.name}: ${money ? fmtUsd(sg.v) : fmtCount(sg.v)} (${fmtShare(sg.v / whole)})`}
          style={{ width: `${(sg.v / whole) * 100}%`, background: MODEL_SLOT[sg.slot] ?? SERIES }} />
      ))}
    </span>
  );
}
