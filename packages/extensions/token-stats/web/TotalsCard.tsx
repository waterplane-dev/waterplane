/** The Totals box and the costliest conversations under it, hook-free: every value is a render value of TokenStatsBody. */
import { type ComponentProps } from "react";
import {
  type CostBreakdown, fmtCount, fmtExact, fmtUsd, type TokenConvo, type TokenStatsDoc, tokenTotal,
  type TokenTotals, topGroups,
} from "@waterplane/shared";
import { ScopeCard, ScopeTag, TopConvos } from "./TokenInsights.tsx";
import { cutSpan, LIVE_WINDOWS, type LiveWindowId, type WindowCut } from "./usageCut.ts";
import { CacheVerdict, modelBands } from "@waterplane/kit";
import { WindowHeats, type WindowScope, WindowStep } from "./WindowHeats.tsx";
import { Bars, ModelLegend } from "./charts/Bars.tsx";
import { Composition, Tiles, WindowTiles } from "./Readouts.tsx";
import { TableView } from "./TableView.tsx";

/**
 * The Totals box and the costliest conversations under it: the hero, the split it
 * is never printed without, the tiles, the model and repo bars, the past-window
 * grids. Hook-free — every value it reads is a render value of `TokenStatsBody`,
 * which keeps all the state, so moving this out cannot change a hook's position.
 */
export function TotalsCard({ doc, money, table, active, scopable, scopeOn, scope, setScope, grids, hist, shownTotals, shownCost, shownTok, coldNote, scopeWords, bands, canModel, days, nameOf, onExplain, isLive, onOpenConvo }: {
  doc: TokenStatsDoc;
  money: boolean;
  table: boolean;
  active: WindowCut | null;
  scopable: typeof LIVE_WINDOWS;
  scopeOn: "all" | LiveWindowId;
  scope: WindowScope;
  setScope: (s: WindowScope) => void;
  grids: ComponentProps<typeof WindowHeats>["grids"];
  hist: ComponentProps<typeof WindowHeats>["res"];
  shownTotals: TokenTotals | undefined;
  shownCost: CostBreakdown | undefined;
  shownTok: number;
  coldNote: string | null | undefined;
  scopeWords: string;
  bands: ReturnType<typeof modelBands>;
  canModel: boolean;
  days: TokenStatsDoc["days"];
  nameOf?: (id: string) => string | undefined;
  onExplain?: (c: TokenConvo, title: string) => void;
  isLive?: (id: string) => boolean;
  onOpenConvo?: (id: string) => void;
}) {
  return (
    <>

      {/* ── TOTALS: one box, its span chosen in its own head ─────────── */}
      <ScopeCard title="Totals"
        chips={<>
          <button className={`key${!active ? " active" : ""}`}
            onClick={() => setScope(null)}>All time</button>
          {scopable.map((w) => (
            <button key={w.id} className={`key${scopeOn === w.id ? " active" : ""}`}
              onClick={() => setScope({ id: w.id, back: 0 })}>{w.label}</button>
          ))}
        </>}
        caption={active
          ? <>{cutSpan(active, Date.now())} Everything in this box is cut to it; the boxes below are not.</>
          : scopable.length > 0
            ? <>Every conversation on record. Pick a live window to see what the limit percentages above are made of.</>
            : <>Every conversation on record.</>}>
        {active && <WindowStep cut={active} grid={grids.get(active.id) ?? null} onScope={setScope} />}
      {/* ── the headline, and immediately what it is made of ───────── */}
      {/* Both numbers, always — the metric switch decides which is the hero
          and which is the line under it, but neither is ever hidden. A
          token count with no money beside it under-sells the screen; a
          money figure with no token count behind it is unfalsifiable. */}
      <div className="ts-hero-wrap">
        <div className="ts-hero" title={money ? `${fmtUsd(shownCost!.total)} at list prices` : `${fmtExact(shownTok)} tokens`}>
          {money ? fmtUsd(shownCost!.total) : fmtCount(shownTok)}
        </div>
        <div className="ts-hero-sub">
          {money
            ? <>at list prices · {fmtCount(shownTok)} tokens</>
            : <>tokens · {fmtUsd(shownCost!.total)} at list prices</>}
          {/* WHAT the figure covers, never left implied. All-time
              counts conversations, because that is the unit a log is;
              a window counts TURNS, because an hour bucket has no
              conversation in it to count and inventing one would be a
              number nobody could check. */}
          {active
            ? <> · {fmtExact(active.totals.turns)} turns in {active.long}</>
            : <> across {fmtExact(doc.conversations)} conversations{doc.firstAt ? <> since {new Date(doc.firstAt).toLocaleDateString(undefined, { day: "numeric", month: "long", year: "numeric" })}</> : null}</>}
        </div>
      </div>

      <Composition totals={shownTotals!} cost={shownCost!} money={money} />

      {/* The caveat is a first-class part of the readout, not a footnote:
          a dollar figure this screen computed is the app's most
          misleading number without the sentence under it.

          The tokens branch is GONE, not folded — `CacheVerdict` renders
          directly below and opens with the same claim carrying its own
          numbers, and the pointer it ended on ("switch to cost") is
          answered by the metric row now leading the list. What stays is
          the counterfactual, which nothing else says; the rate table
          under it is method and folds. */}
      {money && <>
        <div className="empty ts-caveat">
          This is a <b>counterfactual, not a bill</b>: what the same traffic would have cost billed
          through the API at published pay-as-you-go rates ({doc.pricesAsOf} price list).
          {/* Both of these are counted over the WHOLE corpus, so they
              are withheld under a window rather than restated about a
              span they were not measured over. */}
          {!active && tokenTotal(doc.unpriced) > 0 && <> {fmtCount(tokenTotal(doc.unpriced))} tokens ran on a model with no published rate and are <b>not</b> in this figure.</>}
          {!active && doc.fastTurns > 0 && <> {fmtExact(doc.fastTurns)} turns ran in fast mode, which bills at roughly double and is priced here at the standard rate — the real figure is higher.</>}
          {/* A MEASUREMENT of this desktop, not method: it says which
              way the dearest line on the bill is moving, and it is the
              one number the rate rules below cannot be worked out
              from. A number does not fold. */}
          {" "}{Math.round((shownTotals!.cacheWrite1h / Math.max(1, shownTotals!.cacheWrite)) * 100)}% of the writes
          here were the dearer 1-hour tier.
        </div>
        <details className="hint-more ctx-method">
          <summary>how it is priced</summary>
          <p>
            Cache reads are charged at a tenth of the input rate and cache writes at 1.25×
            (5-minute) or 2× (1-hour). The CLI is normally run on a subscription, which is a
            flat fee however many tokens go through it — which is what makes the figure above
            “what this would have cost” rather than “what you paid”.
          </p>
        </details>
      </>}

      <CacheVerdict totals={shownTotals!} />

      {/* What the GAPS cost, as opposed to the work.
                  
          Every other figure on this screen answers "what did the work
          cost". This one answers a question nothing here could ask
          before: a conversation resumed inside the hour re-READS its
          window at a tenth of the write rate, and one resumed the next
          morning re-WRITES it. Same tokens, same conversation, up to
          twenty times the price — and it is invisible in every chart
          above, because those tokens look exactly like any other cache
          write.
                  
          Whole-corpus, so it is withheld under a window rather than
          restated about a span it was not measured over — the same
          rule the unpriced and fast-mode clauses follow. Drawn only
          when it happened. */}
      {!active && coldNote && (
        <div className="empty ts-caveat">{coldNote}</div>
      )}


        {!table ? <>
        {active
          ? <WindowTiles cut={active} money={money} />
          : <Tiles doc={doc} money={money} />}

        <div className="section section-head">
          <span>By model <ScopeTag>{scopeWords}</ScopeTag></span>
        </div>
        {active
          ? (active.modelSplit
            ? <Bars rows={topGroups(active.models, 6, "models")} money={money} />
            : <div className="empty">
                No model split in this desktop’s hour buckets yet — the host records one from
                the next scan on. The tokens and money above are counted either way.
              </div>)
          : <Bars rows={topGroups(doc.models, 6, "models")} money={money} />}

        <div className="section section-head"><span>By repo <ScopeTag>{scopeWords}</ScopeTag></span></div>
        {active
          ? <div className="empty">
              Not answerable inside a live window — an hour bucket carries the model, not the
              repo. Tap <b>All time</b> at the top of this box for it.
            </div>
          : <Bars rows={topGroups(doc.repos, 8, "repos")} money={money}
              bands={canModel ? bands : undefined} />}
        {!active && canModel && <>
          <ModelLegend bands={bands} />
          <details className="hint-more ctx-method">
            <summary>why the split is there</summary>
            <p>
              Each bar is split by the model that ran there. It is the answer to the question
              the lengths raise and cannot settle: two repos with the same token count can be
              several-fold apart in cost, because opus is 2.5× sonnet per token and 5× haiku —
              so a repo whose share of the <b>money</b> is bigger than its share of the tokens
              is a repo running a dearer model, and nothing else.
            </p>
          </details>
        </>}
        </> : <TableView doc={doc} days={days} cut={active} part="groups" />}

        {/* Every window BEFORE this one, as two grids — a tap on a box
            scopes THIS box to that window, which is why they are in it. */}
        <div className="section section-head"><span>Past windows <ScopeTag>tap one to cut this box to it</ScopeTag></span></div>
        <WindowHeats grids={grids} res={hist} money={money} scope={scope} onScope={setScope} />
      </ScopeCard>

      {/* ── The conversations that carried the bill ─────────────────── */}
      {!!doc.top?.length && <>
        <div className="section section-head">
          <span>Costliest conversations <ScopeTag muted>all time · in money · no filter</ScopeTag></span>
        </div>
        <TopConvos rows={doc.top} total={doc.cost.total}
          nameOf={nameOf} onExplain={onExplain} isLive={isLive} onOpen={onOpenConvo} />
        <div className="empty ts-caveat">
          Each counts its subagents in. <b>Explain the cost</b> starts a new session that reads
          that conversation’s log, names what made it expensive and lists ideas — it changes
          nothing until you pick one.
        </div>
      </>}
    </>
  );
}
