/** The Totals box and the costliest conversations under it, hook-free: every value is a render value of TokenStatsBody. */
import { type ComponentProps } from "react";
import { CircleHelp } from "lucide-react";
import {
  type CostBreakdown, DOLLARS_WHY, DOLLARS_WHY_HEAD, fmtCount, fmtExact, fmtUsd, type TokenConvo, type TokenStatsDoc, tokenTotal,
  type TokenGroup, type TokenTotals, topGroups,
} from "@waterplane/shared";
import { ScopeCard, ScopeTag, TopConvos } from "./TokenInsights.tsx";
import { cutSpan, type WindowCut } from "./usageCut.ts";
import { type DaysCut } from "./span.ts";
import { CacheVerdict, modelBands } from "@waterplane/kit";
import { WindowHeats, type WindowScope, WindowStep } from "./WindowHeats.tsx";
import { Bars, ModelLegend } from "./charts/Bars.tsx";
import { Composition, DaysTiles, Tiles, WindowTiles } from "./Readouts.tsx";
import { TableView } from "./TableView.tsx";
import { foldStateText } from "./weekBands.ts";

/**
 * The Totals box and the costliest conversations under it: the hero, the split it
 * is never printed without, the tiles, the model and repo bars, the past-window
 * grids. Hook-free — every value it reads is a render value of `TokenStatsBody`,
 * which keeps all the state, so moving this out cannot change a hook's position.
 */
export function TotalsCard({ doc, money, table, active, dcut, scope, setScope, grids, hist, shownTotals, shownCost, shownTok, coldNote, scopeWords, bands, canModel, days, scopeRepos, scopeRes, reposRefusal, top, pts, weekTwin, nameOf, onExplain, isLive, onOpenConvo }: {
  doc: TokenStatsDoc;
  money: boolean;
  table: boolean;
  active: WindowCut | null;
  /** The span filter's calendar days (30 / 90), with how many calendar days and its words — null
   *  under a live window or all time. Never both this and `active`. */
  dcut: { cut: DaysCut; calendarDays: number; caption: string } | null;
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
  /** The window's repos, folded by the host over the cut on screen (`/api/costwindow`) — null
   *  while it is read or when it cannot be, which `scopeRes` words. Unused without a cut. */
  scopeRepos?: TokenGroup[] | null;
  scopeRes?: { state: string; error?: string | null };
  /** Why the span has no repo split at all (a calendar span longer than the host's cost window
   *  folds) — a sentence in place of the bars. */
  reposRefusal?: string | null;
  /** The costliest conversations for the span on screen: the rows, the span's total they are a
   *  share of, and the words the section's tag and caption carry. */
  top: { rows: TokenConvo[]; total: number; tag: string; note?: string };
  /** A costliest row's dollars as weekly points, off the screen's one calibration; null where it
   *  refused or the row did not run wholly inside this week (`convoInWeek`). */
  pts?: (usd: number, c: TokenConvo) => string | null;
  /** The live week's repo split is the week card's document, while the hero here is the hour
   *  record — said in the caption so two "since reset" figures are never read as one. */
  weekTwin?: boolean;
  nameOf?: (id: string) => string | undefined;
  onExplain?: (c: TokenConvo, title: string) => void;
  isLive?: (id: string) => boolean;
  onOpenConvo?: (id: string) => void;
}) {
  return (
    <>

      {/* ── TOTALS: one box, its span chosen in its own head ─────────── */}
      {/* No chips of its own since 2026-10-15: the span is the sticky bar's, which reaches every
          box below it. The caption still says exactly what span the numbers here stand for. */}
      <ScopeCard title="Totals" chips={null}
        caption={active
          ? <>{cutSpan(active, Date.now())}
            {weekTwin && <> Counted from the desktop’s hour record, like the figure under the limit bar; <em>Where the week went</em> folds each conversation’s log, so the two can differ by what ran between the two reads.</>}</>
          : dcut
            ? <>{dcut.caption}</>
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
            : dcut
            ? <> · {fmtExact(dcut.cut.totals.turns)} turns in {scopeWords}</>
            : <> across {fmtExact(doc.conversations)} conversations{doc.firstAt ? <> since {new Date(doc.firstAt).toLocaleDateString(undefined, { day: "numeric", month: "long", year: "numeric" })}</> : null}</>}
        </div>
      </div>

      <Composition totals={shownTotals!} cost={shownCost!} money={money} />
      {/* The span's first dollar figure is the hero, so the question it raises is answered here, in
          the shared words (moved with the last-7-days headline this box replaced, 2026-10-15). */}
      <details className="hint-more ts-dollars-why">
        <summary><CircleHelp size={12} aria-hidden /> {DOLLARS_WHY_HEAD}</summary>
        <p>{DOLLARS_WHY}</p>
      </details>

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
          {!active && !dcut && tokenTotal(doc.unpriced) > 0 && <> {fmtCount(tokenTotal(doc.unpriced))} tokens ran on a model with no published rate and are <b>not</b> in this figure.</>}
          {!active && !dcut && doc.fastTurns > 0 && <> {fmtExact(doc.fastTurns)} turns ran in fast mode, which bills at roughly double and is priced here at the standard rate — the real figure is higher.</>}
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
      {!active && !dcut && coldNote && (
        <div className="empty ts-caveat">{coldNote}</div>
      )}


        {!table ? <>
        {active
          ? <WindowTiles cut={active} money={money} />
          : dcut
          ? <DaysTiles days={dcut.cut.days} totals={dcut.cut.totals} cost={dcut.cut.cost} calendarDays={dcut.calendarDays} money={money} />
          : <Tiles doc={doc} money={money} />}

        <div className="section section-head">
          <span>By model <ScopeTag>{scopeWords}</ScopeTag></span>
        </div>
        {(active ?? dcut?.cut)
          ? ((active ?? dcut!.cut).modelSplit
            ? <Bars rows={topGroups((active ?? dcut!.cut).models, 6, "models")} money={money} />
            : <div className="empty">
                No model split in this desktop’s hour buckets yet — the host records one from
                the next scan on. The tokens and money above are counted either way.
              </div>)
          : <Bars rows={topGroups(doc.models, 6, "models")} money={money} />}

        <div className="section section-head"><span>By repo <ScopeTag>{scopeWords}</ScopeTag></span></div>
        {/* Under a window the repos come from the host's fold of that span's conversations —
            an hour bucket carries the model, not the repo. While it is read, offline or
            refused (an older host), a sentence says which. */}
        {reposRefusal
          ? <div className="empty">{reposRefusal}</div>
          : (active || dcut)
          ? (scopeRepos
            ? <Bars rows={topGroups(scopeRepos, 8, "repos")} money={money} bands={canModel ? bands : undefined} />
            : <div className="empty">{foldStateText(scopeRes ?? { state: "loading" }, "window")}</div>)
          : <Bars rows={topGroups(doc.repos, 8, "repos")} money={money}
              bands={canModel ? bands : undefined} />}
        {(active || dcut) && scopeRepos && !reposRefusal && canModel && <ModelLegend bands={bands} />}
        {!active && !dcut && canModel && <>
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
        </> : <TableView doc={doc} days={days} cut={active ?? (dcut ? { long: scopeWords, modelSplit: dcut.cut.modelSplit, models: dcut.cut.models } : null)} part="groups"
          repos={reposRefusal ? null : scopeRepos} reposNote={reposRefusal ?? foldStateText(scopeRes ?? { state: "loading" }, "window")} />}

        {/* Every window BEFORE this one, as two grids — a tap on a box
            scopes THIS box to that window, which is why they are in it. No grid (an older host, the
            VS Code panel, which reads no limit window) ⇒ no heading over nothing. */}
        {grids.size > 0 && <>
          <div className="section section-head"><span>Past windows <ScopeTag>tap one to set the span to it</ScopeTag></span></div>
          <WindowHeats grids={grids} res={hist} money={money} scope={scope} onScope={setScope} />
        </>}
      </ScopeCard>

      {/* ── The conversations that carried the bill ─────────────────── */}
      <div className="section section-head">
        <span>Costliest conversations <ScopeTag>{top.tag}</ScopeTag></span>
      </div>
      {top.note && <div className="empty ts-caveat">{top.note}</div>}
      {!top.rows.length && !top.note && <div className="empty">No conversation ran in {scopeWords}.</div>}
      {!!top.rows.length && <>
        <TopConvos rows={top.rows} total={top.total} pts={pts}
          nameOf={nameOf} onExplain={onExplain} isLive={isLive} onOpen={onOpenConvo} />
        <div className="empty ts-caveat">
          Each counts its subagents in{pts ? <>; weekly points are given only for a conversation that ran wholly inside this week, since the rate is this week’s</> : null}. <b>Explain the cost</b> starts a new session that reads
          that conversation’s log, names what made it expensive and lists ideas — it changes
          nothing until you pick one.
        </div>
      </>}
    </>
  );
}
