/** "Where the week went": the week since its reset, by hour, repo and launch, in money and weekly points. */
import { useMemo, useRef, useState } from "react";
import { BarChart3, ChevronDown, ChevronUp, SearchCheck, X } from "lucide-react";
import {
  agentModelInsight, type CostConvo, type CostWindowDoc, fmtCount, fmtUsd, foldLaunches, LAUNCH_KIND_WORD,
  type PtsCalibration, type PtsRefusal, ptsText, rankRepos, tokenTotal, type TokenConvo, type UsageSample, weekCut,
} from "@waterplane/shared";
import { useBoxWidth } from "@waterplane/kit";
import { ScopeCard, ScopeTag } from "./TokenInsights.tsx";
import { Composition } from "./Readouts.tsx";
import { RepoHourChart, slotFill } from "./charts/RepoHourChart.tsx";
import {
  agentPct, calText, foldStateText, hourText, hourWords, legendEntries, listedText, moreText, priced, repoSlots,
  rowFacts, usdOrTok, weekCaption,
} from "./weekBands.ts";

/** Rows before *show all*: TopConvos' five plus the room a fan-out row's neighbours need. */
const ROWS_SHOWN = 8;
const SESSIONS_SHOWN = 8;
/** The hour chart's height in the compact "now" block. */
const COMPACT_H = 110;

interface Group {
  key: string;
  label: string;
  facts: string;
  usd: number;
  tok: number;
  agentUsd: number;
  convos: CostConvo[];
  /** Sessions the host's cap folded into this row's totals — counted, not listable. */
  more: number;
}

/**
 * The week since its reset, in money — what the limit's percentage was spent on.
 *
 * The limit bar says 32%; this says on what: an hour per column stacked by repo, with the weekly
 * percentage drawn over it, and the conversations below grouped by repo or by what launched
 * them (a fan-out is ONE row, not the thirty-six sessions it opened). A tap on an hour is a
 * filter — `weekCut` is the one bucketing function behind the column's count and the list it
 * opens, and the list says "n of N" with a clear button.
 *
 * Everything is in MONEY (the metric switch does not reach this box, and the tag says so), with
 * tokens in the facts line; points are `ptsText` over the screen's ONE calibration, absent when
 * it refused. Reads nothing itself: the body reads the week (`weekcost:`) so the calibration and
 * the Totals box's repo split are made from the same document.
 */
export function WeekCard({ doc, res, openedAt, samples, everyMs, cal, span, compact = false, nameOf, onExplain, isLive, onOpenConvo }: {
  /** The week's document, already checked to answer this week (`docFor`). */
  doc: CostWindowDoc | null;
  res: { state: string; error?: string | null };
  /** The instant the week opened (`weekSpan`), or null without a future weekly reset instant —
   *  then there is no week to cut. */
  openedAt: number | null;
  samples: readonly UsageSample[];
  everyMs: number;
  cal: PtsCalibration | PtsRefusal | null;
  /** A span that is NOT the weekly-limit window (the VS Code panel's rolling seven days, with no
   *  reset instant on hand): its caption and its tag replace every "since the reset" sentence, and
   *  the limit line's legend and the points method are left out. Absent on the phone. */
  span?: { caption: string; tag: string };
  /** The token sheet's "now" block (2026-10-15): a shorter chart, and the session list folded
   *  until an hour is picked or it is asked for — the span filter's Totals and costliest list
   *  under it answer the same week by default, so the list is not the screen's lead any more. */
  compact?: boolean;
  nameOf?: (id: string) => string | undefined;
  onExplain?: (c: TokenConvo, title: string) => void;
  isLive?: (id: string) => boolean;
  onOpenConvo?: (id: string) => void;
}) {
  const [hour, setHour] = useState<string | null>(null);
  const [by, setBy] = useState<"repo" | "launch">("repo");
  const [open, setOpen] = useState<Set<string>>(() => new Set());
  const [width, boxRef] = useBoxWidth();
  const cut = useMemo(() => (doc ? weekCut(doc) : null), [doc]);
  // The picked hour, resolved against THIS document: a re-read whose span no longer holds it lets go.
  const pick = hour && cut?.buckets.some((b) => b.hour === hour) ? hour : null;
  const shown = useMemo(() => (cut ? cut.convosIn(pick) : []), [cut, pick]);
  // With the folded sessions (`rest`), so a repo's hue and the legend follow its whole spend.
  const ranked = useMemo(() => (doc ? rankRepos(doc.convos, doc.rest) : []), [doc]);
  // A slot follows the repo for the life of the card: the last assignment is kept across re-reads.
  const prevSlots = useRef<Map<string, number> | null>(null);
  const slots = useMemo(() => {
    const s = repoSlots(ranked.map((r) => r.repo), prevSlots.current);
    prevSlots.current = s;
    return s;
  }, [ranked]);
  // Unfiltered, the folded sessions go back into their rows so every total stays whole. Under a
  // picked hour they cannot: a folded group carries no hours, so the list is the listed sessions
  // that ran then and `restText(hour)` says how many more did.
  const rest = pick ? undefined : doc?.rest;
  const groups: Group[] = useMemo(() => (by === "repo"
    ? rankRepos(shown, rest).map((r) => ({
        key: `r:${r.repo}`, label: r.label, usd: r.cost.total, tok: tokenTotal(r.totals), agentUsd: r.agentCost.total,
        convos: r.convos, more: r.more, facts: rowFacts(r.convos.length, r.more, tokenTotal(r.totals)),
      }))
    : foldLaunches(shown, rest).map((l) => ({
        key: `l:${l.key}`, label: l.label, usd: l.cost.total, tok: tokenTotal(l.totals), agentUsd: l.agentCost.total,
        convos: l.convos, more: l.more, facts: `${LAUNCH_KIND_WORD[l.kind] ?? l.kind} · ${rowFacts(l.convos.length, l.more, tokenTotal(l.totals))}`,
      }))), [by, shown, rest]);

  const toggle = (k: string) => setOpen((s) => { const n = new Set(s); if (n.has(k)) n.delete(k); else n.add(k); return n; });
  const now = Date.now();
  // Under a `span` with no launch record anywhere (the panel reads no launch log), "by launch"
  // would be one "no launch record" row — no choice, so no chips.
  const launches = !span || !!doc?.convos.some((c) => c.launch) || !!doc?.rest?.some((r) => r.launch);
  // Compact: the repo/launch choice only matters to the list, so it appears with it.
  const chips = cut && cut.total > 0 && launches && (!compact || open.has("*list") || !!pick) ? <>
    <button className={`key${by === "repo" ? " active" : ""}`} onClick={() => setBy("repo")}>by repo</button>
    <button className={`key${by === "launch" ? " active" : ""}`} onClick={() => setBy("launch")}>by launch</button>
  </> : null;

  if (openedAt == null) {
    return (
      <ScopeCard title="Where the week went" chips={null}>
        <div className="empty ts-caveat">No weekly reset instant on hand yet — re-read the limits above.</div>
      </ScopeCard>
    );
  }
  if (!doc) {
    return (
      <ScopeCard title="Where the week went" chips={null}>
        <div className="empty ts-caveat">{foldStateText(res, "week")}</div>
      </ScopeCard>
    );
  }
  const total = doc.cost.total;
  const totalTok = tokenTotal(doc.totals);
  const weekPts = ptsText(total, cal);
  const weekAgents = agentPct(doc.agentCost.total, total);
  const at = pick ? cut!.buckets.find((b) => b.hour === pick) ?? null : null;
  const legend = legendEntries(ranked, slots);
  const list = open.has("*all") ? groups : groups.slice(0, ROWS_SHOWN);
  const calLine = calText(cal);

  return (
    <ScopeCard title="Where the week went" chips={chips}
      caption={<>{span ? span.caption : weekCaption(doc, openedAt, now)} <ScopeTag>{span ? span.tag : "since reset"} · in {priced(doc.cost.total) ? "money" : "tokens"}</ScopeTag> {compact ? null : <>The <em>count in</em> switch does not reach this box.</>}</>}>
      {/* Compact: the limit bar above already prints the week's tokens and money, and the Totals
          box under the span filter opens on this same week with its full split — so here the
          chart leads and nothing is said twice. */}
      {!compact && <>
      <div className="ts-hero-wrap">
        {/* Money when a list price covered any of it; an all-unpriced week (a local model) leads
            with its tokens, never "$0" — which reads as free. */}
        <div className="ts-hero">{priced(total) ? fmtUsd(total) : fmtCount(totalTok)}</div>
        <div className="ts-hero-sub">
          {priced(total) ? <>at list prices{weekPts ? <> · {weekPts}</> : null}{weekAgents != null ? <> · {weekAgents}% subagents</> : null} · {fmtCount(totalTok)} tokens</> : <>tokens · no list price covers them</>}
          {" "}across {cut!.total} {cut!.total === 1 ? "session" : "sessions"}
        </div>
      </div>
      <Composition totals={doc.totals} cost={doc.cost} money={priced(total)} />
      {tokenTotal(doc.unpriced) > 0 && (
        <div className="empty ts-caveat">{fmtCount(tokenTotal(doc.unpriced))} tokens ran on a model with no published rate and are <b>not</b> in this figure.</div>
      )}
      </>}

      {!cut!.total ? <div className="empty ts-caveat">Nothing has run on this desktop {span ? `in the ${span.tag}` : "since the weekly reset"}.</div> : <>
        <div className="ts-week-chart" ref={boxRef}>
          {width > 0 && cut && (
            <RepoHourChart buckets={cut.buckets} slots={slots} samples={samples} everyMs={everyMs}
              from={doc.fromHour} now={now} width={width} picked={pick} onPick={setHour}
              limitAxis={!span || samples.length > 0} height={compact ? COMPACT_H : undefined} />
          )}
        </div>
        <div className="ctx-legend ctx-legend-stack">
          {legend.map((e) => (
            <span key={e.key}>
              <svg width="10" height="10" aria-hidden><rect x="0" y="1" width="10" height="8" rx="2" fill={slotFill(e.slot)} /></svg>
              {e.label}
            </span>
          ))}
          {(!span || samples.length > 0) && <span>
            <svg width="14" height="10" aria-hidden><line x1="0" x2="14" y1="5" y2="5" stroke="var(--fg)" strokeOpacity={0.75} strokeWidth={1.5} /></svg>
            weekly limit, % (right axis)
          </span>}
        </div>
        <div className="ctx-readout">
          {at ? hourText(at) : "Tap a column to list only the sessions that ran in that hour."}
        </div>
        {!compact && <div className="empty ts-caveat">
          An hour is a whole column, so the first one starts on the hour nearest {span ? "the start of the span" : "the reset"} (said above); an hour nothing ran in is a gap.
        </div>}

        {pick && (
          <div className="ts-filter ts-week-filter">
            <span>{cut!.filterText(pick)}</span>
            <button className="key" onClick={() => setHour(null)}><X size={13} /> clear</button>
          </div>
        )}
        {compact && !pick && !open.has("*list") ? (
          <button className="key ts-convos-more" onClick={() => toggle("*list")}>
            <ChevronDown size={13} /> list the week by {by === "repo" ? "repo" : "launch"} ({groups.length})
          </button>
        ) : <>
        <div className="section section-head">
          <span>{by === "repo" ? "By repo" : "By launch"} <ScopeTag>{pick ? `sessions that ran ${hourWords(at!.t)} · their week` : span ? span.tag : "since reset"} · in {priced(total) ? "money" : "tokens"}</ScopeTag></span>
        </div>
        <div className="ts-convos">
          {list.map((g) => (
            <WeekRow key={g.key} g={g} total={total} totalTok={totalTok} cal={cal} open={open.has(g.key)} allSessions={open.has(`${g.key}#all`)}
              onToggle={() => toggle(g.key)} onAll={() => toggle(`${g.key}#all`)}
              nameOf={nameOf} onExplain={onExplain} isLive={isLive} onOpenConvo={onOpenConvo} />
          ))}
          {groups.length > ROWS_SHOWN && (
            <button className="key ts-convos-more" onClick={() => toggle("*all")}>
              {open.has("*all") ? `show the top ${ROWS_SHOWN}` : `show all ${groups.length}`}
            </button>
          )}
          {pick
            ? (cut!.restText(pick) && <div className="empty ts-caveat">{cut!.restText(pick)} — the host folds the cheapest sessions by repo and launch, without their hours.</div>)
            : (listedText(doc.convos.length, cut!) && <div className="empty ts-caveat">{listedText(doc.convos.length, cut!)}</div>)}
          {compact && !pick && (
            <button className="key ts-convos-more" onClick={() => toggle("*list")}><ChevronUp size={13} /> fold the list</button>
          )}
        </div>
        </>}
      </>}

      {calLine && (!compact || open.has("*list") || pick) && <div className="empty ts-caveat">{calLine}</div>}
      <details className="hint-more ctx-method">
        <summary>how the week is read</summary>
        {compact && <p>
          An hour is a whole column, so the first one starts on the hour nearest {span ? "the start of the span" : "the reset"}; an hour nothing ran in is a gap.
        </p>}
        <p>
          The desktop folds every conversation log with a turn {span ? `in the ${span.tag}` : "since the weekly reset"} — closed sessions
          included — and names each from the sessions it still remembers; one nobody named is its repo
          and the first characters of its id. A session counts its subagents in, and is grouped by what
          opened it: a fan-out run, a backlog item, a schedule, or your own hand.
        </p>
        {!span && <p>
          Points are dollars divided by what one weekly point cost while the readings above climbed —
          the ledger’s spend over each run of readings without a reset, against how far the weekly
          figure rose. It is refused when the runs disagree, and when it disagrees with the
          per-reading rate (this week’s spend over the percent read). That check leaves out work
          handed to peer desktops, which the per-prompt week share counts.
        </p>}
      </details>
    </ScopeCard>
  );
}

/** One repo or launch: its money, share, points and subagent share; a tap lists its sessions. */
function WeekRow({ g, total, totalTok, cal, open, allSessions, onToggle, onAll, nameOf, onExplain, isLive, onOpenConvo }: {
  g: Group;
  total: number;
  totalTok: number;
  cal: PtsCalibration | PtsRefusal | null;
  open: boolean;
  allSessions: boolean;
  onToggle: () => void;
  onAll: () => void;
  nameOf?: (id: string) => string | undefined;
  onExplain?: (c: TokenConvo, title: string) => void;
  isLive?: (id: string) => boolean;
  onOpenConvo?: (id: string) => void;
}) {
  // The share follows the rung the figure is printed on: money when the week was priced, tokens
  // when nothing in it was (every row then reads in tokens, so the bars still compare).
  const share = priced(total) ? g.usd / total : totalTok > 0 ? g.tok / totalTok : 0;
  const shown = usdOrTok(g.usd, g.tok);
  const pts = ptsText(g.usd, cal);
  const ag = agentPct(g.agentUsd, g.usd);
  const sessions = allSessions ? g.convos : g.convos.slice(0, SESSIONS_SHOWN);
  return (
    <div className="ts-convo">
      <div className="ts-week-rowhead" role="button" tabIndex={0} aria-expanded={open} onClick={onToggle}
        onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onToggle(); } }}>
        <div className="ts-barhead">
          <span className="ts-barlabel">{g.label}</span>
          <span className="ts-barval">
            {shown}<em>{share < 0.01 ? "<1" : Math.round(share * 100)}%</em>
            {open ? <ChevronUp size={14} className="ts-week-chev" /> : <ChevronDown size={14} className="ts-week-chev" />}
          </span>
        </div>
        <div className="ts-bartrack"><span className="ts-barfill" style={{ width: `${Math.max(1, share * 100)}%` }} /></div>
        <div className="ts-convo-facts">
          {g.facts}{pts ? <> · {pts}</> : null}{ag != null ? <> · {ag}% subagents</> : null}
        </div>
      </div>
      {open && (
        <div className="ts-week-sessions">
          {sessions.map((c) => (
            <WeekSession key={c.id} c={c} cal={cal} nameOf={nameOf} onExplain={onExplain} isLive={isLive} onOpenConvo={onOpenConvo} />
          ))}
          {g.convos.length > SESSIONS_SHOWN && (
            <button className="key ts-convos-more" onClick={onAll}>
              {allSessions ? `show the top ${SESSIONS_SHOWN}` : `show all ${g.convos.length} sessions`}
            </button>
          )}
          {moreText(g.more) && <div className="empty ts-caveat">{moreText(g.more)}</div>}
        </div>
      )}
    </div>
  );
}

function WeekSession({ c, cal, nameOf, onExplain, isLive, onOpenConvo }: {
  c: CostConvo;
  cal: PtsCalibration | PtsRefusal | null;
  nameOf?: (id: string) => string | undefined;
  onExplain?: (c: TokenConvo, title: string) => void;
  isLive?: (id: string) => boolean;
  onOpenConvo?: (id: string) => void;
}) {
  const title = c.title ?? nameOf?.(c.id) ?? `${c.label} · ${c.id.slice(0, 8)}`;
  const pts = ptsText(c.cost.total, cal);
  const ag = agentPct(c.agentCost.total, c.cost.total);
  const insight = agentModelInsight(c);
  const live = c.live || !!isLive?.(c.id);
  return (
    <div className="ts-week-session">
      <div className="ts-barhead">
        <span className="ts-barlabel">{title}</span>
        <span className="ts-barval">{usdOrTok(c.cost.total, tokenTotal(c.totals))}{pts ? <em>{pts}</em> : null}</span>
      </div>
      <div className="ts-convo-facts">
        {c.label} · {fmtCount(tokenTotal(c.totals))} tokens
        {c.agents > 0 && <> · {c.agents} subagents{ag != null ? ` (${ag}% of it)` : ""}</>}
        {c.peakCtx ? <> · peak {fmtCount(c.peakCtx)} context</> : null}
        {live && <> · <span className="tag ts-week-live">live</span></>}
      </div>
      {insight && <div className="ts-convo-facts">{insight}</div>}
      {onExplain && (
        <div className="ts-convo-acts">
          <button className="key" onClick={() => onExplain(c, title)}><SearchCheck size={13} /> explain the cost</button>
          {onOpenConvo && isLive?.(c.id) && (
            <button className="key" onClick={() => onOpenConvo(c.id)}><BarChart3 size={13} /> context & cost</button>
          )}
        </div>
      )}
    </div>
  );
}
