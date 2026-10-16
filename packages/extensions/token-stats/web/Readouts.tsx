/** The readouts under the filters: the week stepper, the composition strip, the six tiles and the live window's four. */
import { ChevronLeft, ChevronRight } from "lucide-react";
import {
  cacheHitPct, type CostBreakdown, dayToMs, fmtCount, fmtExact, fmtUsd, perTurn, type TokenStatsDoc,
  tokenTotal,
} from "@waterplane/shared";
import { type WindowCut } from "./usageCut.ts";
import { KindBar, shiftWeek, until, type WeekDay, weekDelta, weekLabel, weekStart } from "@waterplane/kit";
import { shareNote, spanDays, spanWord, whenShort } from "./when.ts";

/**
 * Stepping through calendar weeks, and what the week being looked at came to.
 *
 * ── Why the arrows come and go rather than grey out ─────────────────────────
 *
 * A dimmed control is identical to the live one beside it but for its opacity,
 * which on a phone is a tap that does nothing and says nothing. So an arrow
 * with nowhere to go is NOT RENDERED and the sentence under the row says why —
 * the same rule `Unavailable.tsx` states for a blocked verb. The space is held
 * open so the label does not jump sideways as you step across an edge.
 *
 * ── Where the edges are ─────────────────────────────────────────────────────
 *
 * The bound is the DATA, not the calendar (`weekBounds`): past the first
 * recorded day every further step is an empty week, which reads as a broken
 * screen rather than as the end of the record. Forward stops at the current
 * week, which is always reachable — "nothing yet this week" is an answer, and a
 * Monday morning is exactly when it is the true one.
 *
 * ── The comparison ──────────────────────────────────────────────────────────
 *
 * A week is only meaningful against the week before it, so the delta rides
 * beside the total. It is ABSENT when the previous week has nothing
 * (`weekDelta` returns null): a percentage change from zero is a division by
 * zero with a face on it, and this screen's rule everywhere else is to degrade
 * to absent rather than to a plausible mistake.
 */
export function WeekNav({ week, bounds, onGo, totals, prev, rows }: {
  week: number;
  bounds: { first: number; last: number };
  onGo: (t: number) => void;
  totals: TokenStatsDoc["totals"];
  prev: TokenStatsDoc["totals"];
  rows: WeekDay[];
}) {
  const canPrev = week > bounds.first;
  const canNext = week < bounds.last;
  const current = weekStart(Date.now());
  const total = tokenTotal(totals);
  const delta = weekDelta(total, tokenTotal(prev));
  const active = rows.filter((r) => tokenTotal(r.totals) > 0).length;
  const busiest = [...rows].sort((a, b) => tokenTotal(b.totals) - tokenTotal(a.totals))[0];

  return (
    <div className="ts-week">
      <div className="ts-week-nav">
        {canPrev
          ? <button className="key" onClick={() => onGo(shiftWeek(week, -1))} title="the week before"><ChevronLeft size={16} /></button>
          : <span className="ts-week-gap" aria-hidden="true" />}
        <span className="ts-week-label">{weekLabel(week)}</span>
        {canNext
          ? <button className="key" onClick={() => onGo(shiftWeek(week, 1))} title="the week after"><ChevronRight size={16} /></button>
          : <span className="ts-week-gap" aria-hidden="true" />}
      </div>

      <div className="ts-week-sum">
        <b title={`${fmtExact(total)} tokens`}>{total > 0 ? fmtCount(total) : "nothing"}</b>
        {total > 0 && <> tokens over {active} {active === 1 ? "day" : "days"}{week === current ? " so far" : ""}</>}
        {/* A week still running is being compared with a whole one, so the
            comparison says so rather than reading as a 34% drop that has not
            happened yet. */}
        {delta != null && (
          <span className="ts-week-delta">
            {delta === 0 ? "level with" : `${Math.abs(delta * 100) < 1 ? "<1" : Math.round(Math.abs(delta) * 100)}% ${delta > 0 ? "more than" : "less than"}`}
            {week === current ? " the whole week before, with this one still running" : " the week before"}
          </span>
        )}
      </div>

      <div className="empty ts-week-note">
        Monday–Sunday in this device’s zone, not the account’s week above.{" "}
        {!canPrev && <>Nothing was recorded before it, so there is no earlier week to step to. </>}
        {!canNext && week !== current && <>Nothing has been recorded since. </>}
        {delta == null && total > 0 && <>The week before it recorded nothing, so there is no comparison to make. </>}
        {busiest && tokenTotal(busiest.totals) > 0 && (
          <>Busiest day {new Date(busiest.t).toLocaleDateString(undefined, { weekday: "long" })}, {fmtCount(tokenTotal(busiest.totals))}. </>
        )}
        {week !== current && (
          <button className="linkish" onClick={() => onGo(current)}>jump to this week</button>
        )}
      </div>
    </div>
  );
}

/**
 * The four kinds as one 100%-wide bar — `KindBar`, fed this ledger's bag.
 *
 * The strip itself is `TokenComposition.tsx` because the per-session context
 * sheet draws the same one: a kind must not pick up a different hue, or a
 * different word, between the screen that says what a session spent and the
 * screen that says what every session spent.
 */
export function Composition({ totals, cost, money }: {
  totals: TokenStatsDoc["totals"];
  cost: CostBreakdown;
  /** Compose by MONEY rather than by tokens. Same four entities, same four
   *  colours, a completely different picture — which is the point of offering
   *  it: 96/3 by tokens is 55/38 by money. */
  money: boolean;
}) {
  // The bar takes a bag keyed by the kind ids, so the money view is fed the
  // costs under the same keys. The kinds, their order and their colours are
  // untouched — an entity keeps its hue whatever is measured.
  const bag = money
    ? { input: cost.input, output: cost.output, cacheRead: cost.cacheRead, cacheWrite: cost.cacheWrite, cacheWrite1h: 0, turns: 0 }
    : totals;
  return money
    ? <KindBar bag={bag} whole={cost.total} fmt={fmtUsd} exact={fmtUsd} />
    : <KindBar bag={bag} whole={tokenTotal(totals)} />;
}

/** The KPI row. Each tile is a number plus what it is — never a number alone. */
export function Tiles({ doc, money = false }: { doc: TokenStatsDoc; money?: boolean }) {
  const t = doc.totals;
  const hit = cacheHitPct(t);
  const per = perTurn(t);
  const busiest = [...doc.days].sort((a, b) => tokenTotal(b) - tokenTotal(a))[0];
  const subPct = tokenTotal(t) > 0 ? (tokenTotal(doc.subagents) / tokenTotal(t)) * 100 : 0;
  const dearest = [...doc.days].sort((a, b) => b.cost.total - a.cost.total)[0];
  const perDay = doc.days.length ? doc.cost.total / doc.days.length : 0;
  const costPerTurn = t.turns ? doc.cost.total / t.turns : 0;
  // The money view answers different questions from the token view, so it gets
  // its own tiles rather than the same six with a currency sign. "What does a
  // turn cost" and "what does a working day cost" are the two a person actually
  // has, and neither is derivable by eye from the headline.
  const costTiles: { label: string; value: string; note?: string; title?: string }[] = [
    { label: "Per turn", value: fmtUsd(costPerTurn), note: `over ${fmtCount(t.turns)} turns` },
    { label: "Per active day", value: fmtUsd(perDay), note: `over ${doc.days.length} days` },
    ...(dearest ? [{
      label: "Dearest day", value: fmtUsd(dearest.cost.total),
      note: new Date(dayToMs(dearest.day)).toLocaleDateString(undefined, { day: "numeric", month: "short" }),
    }] : []),
    { label: "Subagents", value: fmtUsd(doc.subagentCost.total), note: `${Math.round((doc.subagentCost.total / Math.max(1e-9, doc.cost.total)) * 100)}% of the spend` },
    { label: "Output", value: fmtUsd(doc.cost.output), note: `${Math.round((doc.cost.output / Math.max(1e-9, doc.cost.total)) * 100)}% of the spend, 0.2% of the tokens` },
    { label: "Cache", value: fmtUsd(doc.cost.cacheRead + doc.cost.cacheWrite), note: `${Math.round(((doc.cost.cacheRead + doc.cost.cacheWrite) / Math.max(1e-9, doc.cost.total)) * 100)}% of the spend` },
  ];
  const tiles: { label: string; value: string; note?: string; title?: string }[] = [
    { label: "Turns", value: fmtCount(t.turns), note: `${fmtCount(per ?? 0)} per turn`, title: `${fmtExact(t.turns)} assistant turns` },
    { label: "Active days", value: String(doc.days.length), note: doc.days.length ? `of ${spanDays(doc)} since the first` : undefined },
    { label: "Served from cache", value: hit == null ? "—" : `${hit.toFixed(1)}%`, note: "of everything sent in" },
    { label: "Subagents", value: fmtCount(tokenTotal(doc.subagents)), note: `${subPct.toFixed(0)}% of the total` },
    ...(busiest ? [{
      label: "Busiest day", value: fmtCount(tokenTotal(busiest)),
      note: new Date(dayToMs(busiest.day)).toLocaleDateString(undefined, { day: "numeric", month: "short" }),
    }] : []),
    { label: "Output", value: fmtCount(t.output), note: "what the model wrote" },
  ];
  return (
    <div className="ts-tiles">
      {(money ? costTiles : tiles).map((x) => (
        <div key={x.label} className="ts-tile" title={x.title}>
          <div className="ts-tile-v">{x.value}</div>
          <div className="ts-tile-l">{x.label}</div>
          {x.note && <div className="ts-tile-n">{x.note}</div>}
        </div>
      ))}
    </div>
  );
}

/**
 * The KPI row for a LIVE WINDOW — deliberately not `Tiles` with a filter.
 *
 * Four of `Tiles`' six are facts about the CORPUS: active days, the busiest
 * day, the dearest day, the per-active-day average, and the subagent slice,
 * which the hour buckets do not carry at all. A tile row that kept them under
 * a five-hour heading would be six numbers of which four were about something
 * else — so this is the subset the cut can actually answer, and nothing is
 * carried over to keep the shape the same.
 *
 * `Hours counted` is here rather than implied because it is the one number
 * that says how much of the window has actually happened: 3 of 5 hours at 1%
 * and 5 of 5 at 1% are a quiet morning and a quiet window.
 */
export function WindowTiles({ cut, money = false }: { cut: WindowCut; money?: boolean }) {
  const t = cut.totals;
  const hit = cacheHitPct(t);
  const per = perTurn(t);
  const tok = tokenTotal(t);
  const left = Math.max(0, cut.resetAt - Date.now());
  const costPerTurn = t.turns ? cut.cost.total / t.turns : 0;
  const tiles = money
    ? [
      { label: "Per turn", value: fmtUsd(costPerTurn), note: `over ${fmtCount(t.turns)} turns` },
      { label: "Output", value: fmtUsd(cut.cost.output), note: shareNote(cut.cost.output, cut.cost.total) },
      { label: "Cache", value: fmtUsd(cut.cost.cacheRead + cut.cost.cacheWrite), note: shareNote(cut.cost.cacheRead + cut.cost.cacheWrite, cut.cost.total) },
      // A window that has CLOSED does not reset in anything — it ran, and when
      // it ran is the fact a reader stepping back through them needs. Two
      // different claims, so two different tiles rather than one tile with a
      // clock that quietly counts a past instant down to "any moment".
      cut.back > 0
        ? { label: "Ran until", value: whenShort(cut.resetAt), note: `${cut.back} window${cut.back === 1 ? "" : "s"} ago` }
        : { label: "Resets in", value: until(cut.resetAt), note: left > 0 ? "on this window" : "any moment" },
    ]
    : [
      { label: "Turns", value: fmtCount(t.turns), note: `${fmtCount(per ?? 0)} per turn`, title: `${fmtExact(t.turns)} assistant turns` },
      { label: "Served from cache", value: hit == null ? "—" : `${hit.toFixed(1)}%`, note: "of everything sent in" },
      // Only where this side HAS the buckets. A window folded by the host
      // arrives with its totals and no hours, and "0 hours counted" under a
      // window with tokens in it is the readout contradicting itself.
      cut.hours
        ? { label: "Hours counted", value: String(cut.hours.length), note: "buckets with a turn in them" }
        : { label: "Ran", value: whenShort(cut.openedAt), note: `for ${spanWord(cut.resetAt - cut.openedAt)}` },
      { label: "Output", value: fmtCount(t.output), note: tok ? shareNote(t.output, tok) : "what the model wrote" },
    ];
  return (
    <div className="ts-tiles">
      {tiles.map((x) => (
        <div key={x.label} className="ts-tile" title={(x as { title?: string }).title}>
          <div className="ts-tile-v">{x.value}</div>
          <div className="ts-tile-l">{x.label}</div>
          {x.note && <div className="ts-tile-n">{x.note}</div>}
        </div>
      ))}
    </div>
  );
}

/**
 * The KPI row for a run of CALENDAR days (the span filter's 30 / 90 days) — `Tiles` cut to what
 * day rows can answer. The subagent slice is left out: a `TokenDay` counts launches, not the
 * agents' tokens, and a corpus figure under a 30-day heading is a number about something else.
 */
export function DaysTiles({ days, totals, cost, calendarDays, money = false }: {
  days: TokenStatsDoc["days"];
  totals: TokenStatsDoc["totals"];
  cost: CostBreakdown;
  /** How many calendar days the span covers, today counted as one. */
  calendarDays: number;
  money?: boolean;
}) {
  const t = totals;
  const hit = cacheHitPct(t);
  const per = perTurn(t);
  const busiest = [...days].sort((a, b) => tokenTotal(b) - tokenTotal(a))[0];
  const dearest = [...days].sort((a, b) => b.cost.total - a.cost.total)[0];
  const date = (day: string) => new Date(dayToMs(day)).toLocaleDateString(undefined, { day: "numeric", month: "short" });
  const tiles: { label: string; value: string; note?: string; title?: string }[] = money
    ? [
      { label: "Per turn", value: fmtUsd(t.turns ? cost.total / t.turns : 0), note: `over ${fmtCount(t.turns)} turns` },
      { label: "Per active day", value: fmtUsd(days.length ? cost.total / days.length : 0), note: `over ${days.length} days` },
      ...(dearest ? [{ label: "Dearest day", value: fmtUsd(dearest.cost.total), note: date(dearest.day) }] : []),
      { label: "Output", value: fmtUsd(cost.output), note: shareNote(cost.output, cost.total) },
      { label: "Cache", value: fmtUsd(cost.cacheRead + cost.cacheWrite), note: shareNote(cost.cacheRead + cost.cacheWrite, cost.total) },
    ]
    : [
      { label: "Turns", value: fmtCount(t.turns), note: `${fmtCount(per ?? 0)} per turn`, title: `${fmtExact(t.turns)} assistant turns` },
      { label: "Active days", value: String(days.length), note: `of ${calendarDays}` },
      { label: "Served from cache", value: hit == null ? "—" : `${hit.toFixed(1)}%`, note: "of everything sent in" },
      ...(busiest ? [{ label: "Busiest day", value: fmtCount(tokenTotal(busiest)), note: date(busiest.day) }] : []),
      { label: "Output", value: fmtCount(t.output), note: "what the model wrote" },
    ];
  return (
    <div className="ts-tiles">
      {tiles.map((x) => (
        <div key={x.label} className="ts-tile" title={x.title}>
          <div className="ts-tile-v">{x.value}</div>
          <div className="ts-tile-l">{x.label}</div>
          {x.note && <div className="ts-tile-n">{x.note}</div>}
        </div>
      ))}
    </div>
  );
}
