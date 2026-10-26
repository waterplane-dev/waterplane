/** Everything the screen draws, given a document: all of the sheet's state and derivations, the skeleton, and the contributed tabs. */
import { type ReactNode, useCallback, useMemo, useState } from "react";
import { BarChart3, Loader, RefreshCw } from "lucide-react";
import {
  coldStartText, type CostBreakdown, type CostWindowDoc, cumulative, dayToMs, hourToMs, ptsCalibration, ptsText,
  rankRepos, repoRowAsGroup, weekUsdPerPct,
  type TokenConvo, type TokenStatsDoc, tokenTotal, type TokenTotals, type TokenWindowsDoc,
  type TokenWindowSeries, type UsageHistoryDoc, type UsageInfo, zeroCost, zeroTotals, fmtCount,
  hasScrapedWindows, periodStates, windowStartHour, type BillingProfile, type PeriodState, type UsageBudget,
} from "@waterplane/shared";
import { periodCap, periodReadSpan, primaryUsdPeriod } from "@waterplane/sdk";
import { InsightsPanel, ScopeCard, ScopeTag } from "./TokenInsights.tsx";
import { statsInsights } from "./statsInsights.ts";
import {
  type CutRefusal, isCut, LIVE_WINDOWS, type LiveWindowId, seriesCut, windowCut, type WindowCut,
  windowSpecs,
} from "./usageCut.ts";
import { ledgers, type LedgerViewParts } from "@waterplane/sdk";
import {
  type DayPoint, Empty, fillMix, fillSeries, HOUR_MS, hourPoints, modelBands, type ResourceState,
  rollingMean, SheetHead, useBoxWidth, useRemoteResource,
  Button,
} from "@waterplane/kit";
import { FETCH_HOURS, type SourceId, TREND_DAYS } from "./constants.ts";
import {
  clockOf, COST_WINDOW_DAYS, dayKeyOf, daysCut, hoursCover, isLiveSpan, spanDayCount, spanDays, spanHours, spanRange,
  SPANS, type SpanSel,
} from "./span.ts";
import { WeekCard } from "./WeekCard.tsx";
import { PeriodCard } from "./PeriodCard.tsx";
import { convoInWeek, docFor, foldStateText, scopeSpan, weekSpan } from "./weekBands.ts";
import { type WindowScope } from "./WindowHeats.tsx";
import { LimitWindows } from "./LimitWindows.tsx";
import { BackendLedgerView } from "./BackendLedgerView.tsx";
import { DayChart } from "./charts/DayChart.tsx";
import { claudeOnlyText, type GuestLedger, shownGuests } from "./guests.ts";
import { TotalsCard } from "./TotalsCard.tsx";
import { AllBackendsView } from "./AllBackendsView.tsx";
import { LocalRunnerView } from "./LocalRunnerView.tsx";
import { showRunnerTab } from "./localRunner.ts";
import { readingAfterResets, type LocalUsageDoc, type UsageReading } from "@waterplane/shared";
import { SourceWindows } from "./SourceWindows.tsx";
import { openedOnFor, openedTarget, READING_TAB, readingChips, readingForLedger } from "./sourceWords.ts";
import { allNoteText, splitLocal, splitNoteText } from "./localSplit.ts";

/** The overview's key on the ledger-tab state — not a backend id (those match `^[a-z]`). */
const ALL_TAB = "*all";
/** The local runner's tab on the same state — what ollama itself did, not a backend's ledger. */
const RUNNER_TAB = "*runner";
import { OverTimeCard } from "./OverTimeCard.tsx";

/**
 * Scrolls the source row so a lit chip is in sight. The row scrolls rather than wraps, so a tap that
 * opened the sheet on a source far down it (Copilot, past three Claude chips) lit a chip off the
 * right edge. A stable callback ref — no hook (the order is pinned) — runs when a chip BECOMES lit;
 * only the row moves, never the page.
 */
const revealChip = (el: HTMLButtonElement | null) => {
  const row = el?.parentElement;
  if (!el || !row) return;
  const l = el.offsetLeft - row.offsetLeft;
  if (l < row.scrollLeft || l + el.offsetWidth > row.scrollLeft + row.clientWidth) row.scrollLeft = Math.max(0, l - 16);
};

/** This sheet's own widgets, lent to every contributed tab (`LedgerViewParts`). */
const PARTS: LedgerViewParts = { DayChart, ScopeCard, ScopeTag };

/** What the core knows about the account's billing: the profile, and the budget with its dollar periods. */
export interface SpendView {
  profile: BillingProfile | null;
  budget: UsageBudget | null;
  periods: PeriodState[] | null;
}

/**
 * Everything the screen DRAWS, given a document.
 *
 * Split from the read for the ordinary reason and one specific one: this is the
 * half worth looking at during development, and a component whose data arrives
 * through an effect cannot be rendered to a static page and eyeballed. The
 * individual charts are exported for the same reason and only that one: a
 * static page runs no `ResizeObserver`, so the body measures a width of zero
 * and draws nothing, and each chart has to be handed a width directly. The
 * dataviz procedure ends with "render it and look at it", which is not a step
 * that can be skipped on a chart — three real bugs in this app's other chart
 * were found by exactly that and by nothing else.
 */
export function TokenStatsBody({ doc: rawDoc, res, guests = [], usage, spend, usageHistory, online = true, onRefreshUsage, onClose, onRescan, initialSpan = { id: "week", back: 0 }, initialSource = "claude", ledgerTabs = [], localLedgers = [], fresh = 0, nameOf, onExplain, isLive, canOpen, onOpenConvo, readings, openedOn = null, onClearOn, lead, liveWindows = true, doors }: {
  /** Doors to what every turn carries (always-on context); drawn first in the scroll region. */
  doors?: ReactNode;
  /** Drawn first in the NOW block, above the limit windows — the VS Code panel's headline. */
  lead?: ReactNode;
  /**
   * Whether this render has the desktop's live account readings at all. False draws no limit
   * windows, no week-since-reset card and no dollar period — the VS Code panel with no waterplane
   * host to ask: a bar with no reading would be a box claiming nobody scraped yet, which is a
   * different fact from "this side cannot scrape". The live spans need no flag: with no reading
   * there is no cut, so no chip.
   */
  liveWindows?: boolean;
  /** The usage readings per source (`world.usageReadings`): a source with one and no ledger gets a chip (`SourceWindows`). */
  readings?: readonly UsageReading[];
  /** The source the launcher chip's tap filtered this sheet to; null for a lone-claude tap or a plain open. */
  openedOn?: string | null;
  /** The `all` button: forget `openedOn` (the core's `clearTokensOn`). */
  onClearOn?: () => void;
  doc: TokenStatsDoc | null;
  /** Just enough of the read for `Empty` to word itself; a preview passes a
   *  settled one — which is why `inflight` is optional here and absent means
   *  "nothing is out", the only honest reading for a render with no host. */
  res: { state: ResourceState; age?: number | null; error?: string | null; inflight?: boolean; };
  /** The ledgers other extensions draw (`LedgerViewDef`), each with the document the host
   *  answered (null while it is being read). Optional so a static render needs only claude's. */
  guests?: readonly GuestLedger[];
  /** One tab per other backend that keeps a ledger of its own, and the sheet's rescan counter. */
  ledgerTabs?: { id: string; label: string }[];
  /** Ledger tab ids answered on this machine, not by the desktop (the VS Code panel's Copilot Chat):
   *  read even while `online` is false. */
  localLedgers?: readonly string[];
  fresh?: number;
  /** Both live windows, or null when nothing has been scraped yet. Optional so
   *  a static render of the charts needs no host snapshot. */
  usage?: UsageInfo | null;
  /** The billing profile and dollar periods. Absent (a static render, an older core) = a subscription's screen as ever. */
  spend?: SpendView;
  /** A kept-readings history to draw instead of reading one — static renders
   *  only, same reason as `initialRange`. */
  usageHistory?: UsageHistoryDoc | null;
  /** The socket's verdict. Passed down so the history read is skipped rather
   *  than left to time out with the tunnel down. */
  online?: boolean;
  onRefreshUsage?: (quiet?: boolean) => void;
  /** Absent = no sheet head at all: the page around the body (the VS Code panel) owns the title and the re-read. */
  onClose?: () => void;
  onRescan: () => void;
  /** Which window the charts open on. Only a static render passes it — the
   *  "render it and look at it" step cannot click a filter chip, and a chart
   *  nobody can see rendered is a chart nobody checked. */
  initialSpan?: SpanSel;
  /** Which source the screen opens on. Same reason as `initialRange`, and the
   *  same rule: nothing in the app passes it, so every real open starts on
   *  Claude. */
  initialSource?: SourceId;
  /** The costliest-conversations list's doors — `TopConvos`. All optional: a
   *  static render has no session to start and no sheet to open. */
  nameOf?: (id: string) => string | undefined;
  onExplain?: (c: TokenConvo, title: string) => void;
  isLive?: (id: string) => boolean;
  /** Door to the context & cost sheet on a top-conversation row; falls back to `isLive`. */
  canOpen?: (id: string) => boolean;
  onOpenConvo?: (id: string) => void;
}) {
  /**
   * A document this screen cannot read is ABSENT, not half-drawn.
   *
   * `cost` and the per-day/per-group costs under it are threaded through the
   * hero, the tiles, the bars and the table, and every one of them reads
   * `.total` off an object it assumes is there. When it is not — a cached copy
   * written before the field existed, a host on an older build — the throw is
   * not confined to a chart: this sheet is in `PERSISTED_OVERLAYS`, so it is
   * restored on boot and the app does not start. `offlineCache` refuses such a
   * record now; this is the second lock, on the side the cache cannot see.
   *
   * Refusing it wholesale rather than guarding each read is deliberate: half a
   * cost screen is a screen quoting numbers whose provenance nobody can state.
   */
  const fullDoc = rawDoc && rawDoc.cost && rawDoc.subagentCost && rawDoc.unpriced
    && Array.isArray(rawDoc.hours) && Array.isArray(rawDoc.hourOfDay) && rawDoc.hourOfDay.length === 24
    && Array.isArray(rawDoc.days) && rawDoc.days.every((d) => !!d.cost)
    && Array.isArray(rawDoc.models) && rawDoc.models.every((g) => !!g.cost)
    && Array.isArray(rawDoc.repos) && rawDoc.repos.every((g) => !!g.cost)
    ? rawDoc : null;
  /**
   * Anthropic's models only, unless asked for all (`localSplit.ts`).
   *
   * claude-local writes an Ollama model's tokens into the SAME logs as Claude's,
   * so the uncut ledger counts `qwen3-coder` into a hero read as "what Claude
   * did". The default view cuts them out — they are on the claude-local tab,
   * drawn off the same buckets by the host — and says so with a way back to
   * every model. Not persisted: every open starts on the cut, like `source`.
   */
  const [allModels, setAllModels] = useState(false);
  const split = useMemo(() => (fullDoc ? splitLocal(fullDoc) : null), [fullDoc]);
  const cut = split && !("refused" in split) ? split : null;
  const doc = cut && !allModels ? cut.doc : fullDoc;
  // Every backend that writes into Claude's logs has the non-Anthropic models it owns on its own tab.
  const sharerTabs = ledgerTabs.filter((t) => t.id === "claude-local" || t.id === "claude-endpoint").map((t) => t.label);
  const localTab = sharerTabs.length ? sharerTabs.join(" or ") : null;

  const [table, setTable] = useState(false);
  /**
   * Which ledger is on screen.
   *
   * State, and **not** persisted anywhere: this sheet is mounted when it opens,
   * so every open starts on Claude. That is the same rule the filters here
   * follow — the choice is the tap, not a setting made days ago and shown
   * nowhere — and it matters more for a SOURCE than for a window: a screen
   * silently showing a different ledger than the one whose numbers you remember
   * is a screen you cannot trust at a glance.
   */
  // Reading-only sources (a quota with no ledger): one chip each, only while the reading exists.
  const chips = readingChips(readings, [...guests.map((g) => g.def.id), ...ledgerTabs.map((t) => t.id)]);
  // Where the tap that opened this sheet lands — a guest view, a ledger tab or a reading chip (`openedTarget`).
  // Pure and re-derived each render (no hook of its own — the hook order is pinned); only the initializers read it.
  const target = openedTarget(openedOn, {
    guests: guests.map((g) => g.def.id), ledgers: ledgerTabs.map((t) => t.id), chips: chips.map((c) => c.source),
    backendOf: (readings ?? []).find((r) => r.source === openedOn)?.backend ?? null,
  });
  const [source, setSource] = useState<SourceId>(() => (initialSource !== "claude" ? initialSource : target.source));
  /**
   * Whether the choice exists at all.
   *
   * Per contributed tab, its own `hasData`: the host answered AND there is
   * something in it. An empty store is a source with nothing on the other side
   * of the chip, and a picker whose second option is a blank screen is
   * furniture implying a decision nobody has — the `showBackendPicker` rule.
   * With none shown the sheet renders exactly as it did before any existed,
   * and the chip is ABSENT rather than dimmed.
   */
  const shown = shownGuests(guests);
  const showSource = shown.length > 0;
  // A source that went away under a switched-on chip (a rescan against a host
  // that no longer has the store) falls back rather than painting an empty
  // view that cannot be left.
  const guest = shown.find((g) => g.def.id === source) ?? null;
  const view: SourceId = guest ? source : "claude";
  // A generic backend ledger, picked by id. Its own state beside `source`
  // because SourceId is a closed pair; a tab that left the list falls back.
  const [extraId, setExtraId] = useState<string | null>(target.extraId);
  const extra = ledgerTabs.find((t) => t.id === extraId) ?? null;
  // A reading chip that vanished under the view falls back to Claude, like a guest that went away.
  const readingChip = extraId?.startsWith(READING_TAB) ? chips.find((c) => READING_TAB + c.source === extraId) ?? null : null;
  const viewing: string | null = readingChip ? readingChip.source
    // A ledger tab the tap opened is "viewing" the tapped SOURCE (source and backend may be named apart).
    : extra ? (extra.id === target.extraId && openedOn ? openedOn : extra.id) : extraId ? null : guest ? source : "claude";
  const readingRaw = readingChip ? (readings ?? []).find((r) => r.source === readingChip.source) : undefined;
  const readingNow = readingRaw ? readingAfterResets(readingRaw, Date.now()) : null;
  // The tapped source, held HERE: `all` must take the line away at once, and the prop is a snapshot
  // the core does not re-render this sheet for (a stale prop kept the line up after the tap).
  const [on, setOn] = useState<string | null>(openedOn ?? null);
  const onText = openedOnFor(on, viewing, readings);
  /** The "All backends" overview rides on the same id state, under a key no
   *  backend can have (ids are `^[a-z]`). */
  const overview = extraId === ALL_TAB;
  /** The local runner's ledger (`/api/localusage`): its tab and card exist only
   *  where the host has it AND it has seen the runner — an older host (404) or a
   *  desktop with no local models gets neither, never an empty or dimmed one. */
  const runnerRes = useRemoteResource<LocalUsageDoc>(`localusage:${fresh}`, () => ledgers.localUsage(), { offline: !online });
  const showRunner = showRunnerTab(runnerRes.data);
  const runner = extraId === RUNNER_TAB && showRunner;
  const showPicker = showSource || ledgerTabs.length > 0 || showRunner || chips.length > 0;
  /**
   * Tokens or money. One switch for the whole screen rather than a second set
   * of charts: they answer the same questions of the same data, and the two
   * stories genuinely differ — cache reads are 96% of the TOKENS and 55% of the
   * MONEY, while cache writes are 3% of the tokens and 38% of the money.
   */
  const [metric, setMetric] = useState<"tokens" | "cost">("tokens");
  const money = metric === "cost";
  /** What a row is worth under the metric on screen. One function, so the hero,
   *  the charts, the bars and the table can never disagree about which number
   *  they are ranking and drawing. */
  const valueOf = useCallback(
    (t: TokenTotals & { cost?: CostBreakdown }) => (money ? (t.cost?.total ?? 0) : tokenTotal(t)),
    [money],
  );
  /**
   * What the per-day chart draws. Three questions, not three styles:
   *
   *   total — how much (one series, the volume)
   *   mix   — how much, split by kind (the absolute stack)
   *   share — what proportion each kind was (every column rescaled to 100%)
   *
   * `total` stays the default because it is the question the screen was opened
   * with. The other two exist because the mix is the only thing on this screen
   * that can move without the total moving at all.
   */
  const [dayView, setDayView] = useState<"total" | "mix" | "share">("total");
  /**
   * What the mix and share views are split BY — the four token kinds, or the
   * models that ran.
   *
   * A third control would be one too many on a phone, so it rides beside the
   * form chips and appears only in the two views it changes: in `total` there
   * is no stack to split. Sticky per the same rule the rest of this screen's
   * chips follow — it is a reading somebody picked, not a fact about the data.
   */
  const [mixBy, setMixBy] = useState<"kind" | "model">("kind");
  /**
   * Columns or an area — the FORM the two time series are drawn in, kept apart
   * from `dayView`, which is the QUESTION they answer.
   *
   * Two controls rather than six chips of every combination, because they are
   * two decisions: an area of the mix and columns of the mix are the same
   * reading at two densities, and a reader who has switched to `share` should
   * not lose their shape when they switch back. Columns stay the default —
   * they are the exact form, one bucket one mark — and the area earns its place
   * as the window widens, which is the moment a two-pixel column stops being
   * one. Per device, never persisted: it is a way of looking, not a setting.
   */
  const [dayShape, setDayShape] = useState<"bars" | "area">("bars");
  const [hourShape, setHourShape] = useState<"bars" | "area">("bars");
  /**
   * The ONE span every section under the sticky bar follows (2026-10-15, `span.ts`): a live
   * rate-limit window (stepped back with `back`), a run of calendar days ending today, or all time.
   * It replaced the Totals box's live-window chips, the Over time box's calendar chips and week
   * stepper, and the all-time-only sections — about eight frames on one screen, which the owner
   * could not read against each other. The limit bars and the week's hour chart above the bar
   * are the one exception: they are always now.
   *
   * State and not persisted, the rule every scope here follows: a scope is the tap, not a setting
   * made days ago and shown nowhere. It OPENS on the week since its reset — "where did the week
   * go" is the question this screen is opened with; a week that cannot be cut falls to all time.
   */
  const [span, setSpan] = useState<SpanSel>(initialSpan);
  /** The live window the span names, in the shape the heat grids and the stepper speak. */
  const scope: WindowScope = isLiveSpan(span.id) ? { id: span.id, back: span.back } : null;
  const setScope = (x: WindowScope) => setSpan(x ? { id: x.id, back: x.back } : { id: "all", back: 0 });

  const [width, boxRef] = useBoxWidth();

  /**
   * Both live windows, cut out of the hour buckets — or the reason each cannot
   * be. Computed once here and handed BOTH to the limit rows (which print the
   * figure) and to the scope chips (which take the cut), so the number on the
   * control and the view it opens are one call to `windowCut`.
   *
   * `Date.now()` is read INSIDE, once, so the rollover test compares both
   * windows against one instant. The deps are the two things that can move it:
   * a rescan and a fresh `/usage` scrape.
   */
  const cuts = useMemo(() => new Map<LiveWindowId, WindowCut | CutRefusal>(
    LIVE_WINDOWS.map((w) => [w.id, windowCut(w, doc, usage ?? null, Date.now())]),
  ), [doc, usage]);
  /**
   * The cut on screen, or null. A chip whose window stopped being answerable
   * under it — a rescrape that rolled over, a rescan against a host with no
   * hours — falls back to all-time rather than painting an empty readout that
   * cannot be left, exactly as `view` does for a source that went away.
   */
  /**
   * The grids of PAST windows, folded by the host.
   *
   * A second read, and the reason is in `usageCut.ts`: the document carries a
   * bounded fortnight of hour buckets, so this side can cut the window running
   * now and nothing older, while the host keeps every hour it ever saw. The
   * grid goes UP (the anchors are the scraped reset instants, the lengths are
   * `LIVE_WINDOWS`') so the two windows' semantics stay in one place.
   *
   * Re-read when a scrape moves an anchor — a rolled-over window is a different
   * grid, not the same one shifted — and skipped entirely with no anchors or a
   * dead socket, where it could only time out.
   */
  const specs = useMemo(() => windowSpecs(usage ?? null), [usage]);
  const hist = useRemoteResource<TokenWindowsDoc>(
    `tokenwindows:${specs.map((sp) => `${sp.id}@${sp.anchor}`).join(",")}:${doc?.scannedAt ?? 0}`,
    () => ledgers.tokenWindows(specs),
    { enabled: specs.length > 0, offline: !online },
  );
  // The kept `/usage` readings: one read for the limit charts AND the week card's calibration
  // (two reads of one log are two instants drawn as one). Re-read when a new scrape lands.
  const usageRead = useRemoteResource<UsageHistoryDoc>(
    `usagelog:${usage?.checkedAt ?? 0}`,
    () => ledgers.usageLog(FETCH_HOURS),
    { enabled: !usageHistory, offline: !online },
  );
  const history = usageHistory ?? usageRead.data;
  // The week since its reset, folded by the host (`/api/costwindow`) — the week card, the
  // calibration and, under the live week, the Totals box's repo split all read this one document.
  const wk = weekSpan(usage, Date.now());
  const weekRead = useRemoteResource<CostWindowDoc>(
    `weekcost:${wk?.key ?? "none"}:${fresh}`,
    () => ledgers.costWindow(wk!.from, Date.now(), fresh > 0),
    { enabled: !!wk, offline: !online },
  );
  const weekDoc = docFor(weekRead.data, wk?.from ?? null);
  // An account with no weekly window (API key, Bedrock, Vertex) has no week to explain and no limit
  // bars to draw; its screen leads with the dollar period instead. Any host with a dollar period
  // configured gets that card too, beside the week's.
  const scraped = liveWindows && hasScrapedWindows(spend?.profile);
  const periodNow = Date.now();
  const periodState: PeriodState | null = useMemo(() => {
    if (!liveWindows) return null;
    const configured = primaryUsdPeriod(spend?.periods, spend?.budget);
    if (configured || scraped) return configured;
    // Nothing configured on such an account: the calendar month, so the card has an answer before
    // the person has set anything up (no cap, and no chip — the chip needs a measured period).
    return periodStates([{ id: "month", kind: "calendar", unit: "usd", cycle: "month", anchorDay: 1, tz: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC" }], periodNow)[0];
  }, [liveWindows, spend?.periods, spend?.budget, scraped, Math.floor(periodNow / 60_000)]); // eslint-disable-line react-hooks/exhaustive-deps -- the minute is the fact; `periodNow` is rebuilt each render
  const periodSpan = periodState ? periodReadSpan(periodState, periodNow) : null;
  const periodFrom = periodSpan && "from" in periodSpan ? windowStartHour(periodSpan.from) : null;
  const periodRead = useRemoteResource<CostWindowDoc>(
    `periodcost:${periodState?.period.id ?? "none"}:${periodFrom ?? "none"}:${fresh}`,
    () => ledgers.costWindow(periodFrom!, Date.now(), fresh > 0),
    { enabled: periodFrom != null, offline: !online },
  );
  const periodDoc = docFor(periodRead.data, periodFrom);
  /** One grid per window kind, by id — absent for a host too old to know the
   *  route, which leaves the screen exactly as it was before this existed. */
  const grids = useMemo(() => new Map<LiveWindowId, TokenWindowSeries>(
    (hist.data?.series ?? [])
      .filter((se): se is TokenWindowSeries & { id: LiveWindowId } => se.id === "session" || se.id === "week")
      .map((se) => [se.id, se]),
  ), [hist.data]);

  /**
   * The cut on screen, or null.
   *
   * A window the host folded is preferred for EVERY box including the live one,
   * so the grid and the readouts under it cannot answer differently about the
   * box they share; they agree by construction anyway (the host folds under the
   * same hour rule this side applies), and the fallback is what keeps an older
   * host drawing the live window exactly as it did.
   *
   * A scope whose window stopped being answerable under it — a rescrape that
   * rolled over, a rescan against a host with no hours — falls back to all-time
   * rather than painting an empty readout that cannot be left, exactly as
   * `view` does for a source that went away.
   */
  const picked = useMemo(() => {
    if (!isLiveSpan(span.id)) return undefined;
    const spec = LIVE_WINDOWS.find((w) => w.id === span.id);
    if (!spec) return undefined;
    const grid = grids.get(span.id) ?? null;
    const fromGrid = grid ? seriesCut(spec, grid, span.back, doc?.models ?? []) : null;
    if (fromGrid && isCut(fromGrid)) return fromGrid;
    return span.back === 0 ? cuts.get(span.id) : (fromGrid ?? undefined);
  }, [span, grids, cuts, doc]);
  const active = picked && isCut(picked) ? picked : null;
  /**
   * What the span covers. A live span that cannot be cut (no reset instant, a rolled-over scrape,
   * an hour record too short) has no instants and falls to ALL TIME — the limit block above says
   * why in a sentence, and the bar lights the chip that is actually in force.
   */
  const effId = isLiveSpan(span.id) && !active ? "all" : span.id;
  const range = useMemo(() => spanRange({ id: effId, back: span.back }, active, Date.now()), [effId, span.back, active]);
  /** The day rows the span touches — calendar days, its first and last counted whole. */
  const days = useMemo(() => spanDays(doc?.days ?? [], range), [doc, range]);
  const calDays = spanDayCount(effId);

  const daily: DayPoint[] = useMemo(
    () => days.map((d) => ({ day: d.day, t: dayToMs(d.day), v: valueOf(d) })),
    [days, valueOf],
  );
  // The running total starts at the span's own zero — a total that began before the left edge
  // would draw a cliff at the first point and mean nothing.
  const running: DayPoint[] = useMemo(
    () => cumulative(daily.map((d) => ({ day: d.day, total: d.v })))
      .map((d) => ({ day: d.day, t: dayToMs(d.day), v: d.sum })),
    [daily],
  );

  /**
   * The 7-day mean, computed over the WHOLE day series and clipped to the
   * window afterwards.
   *
   * Over the whole series because a mean of the seven days on screen is one
   * point in the middle of them, which restates the total rather than showing a
   * trend; clipped afterwards so the line entering from the left edge carries
   * the real average of the week before it.
   */
  const trend = useMemo(() => {
    const all = (doc?.days ?? []).map((d) => ({ day: d.day, t: dayToMs(d.day), v: valueOf(d) }));
    const mean = rollingMean(all, TREND_DAYS);
    if (!daily.length) return [];
    const lo = daily[0].t;
    const hi = daily[daily.length - 1].t;
    return mean.filter((m) => m.t >= lo && m.t <= hi);
  }, [doc, valueOf, daily]);

  /**
   * The days of the visible window, as the mix chart wants them.
   *
   * The whole `TokenDay` rides along as `src` rather than only its flat totals:
   * the per-model split and the subagent launches are on it, and a row reduced
   * to `TokenTotals` is a row the by-model stack cannot be drawn from.
   */
  const mixRows = useMemo(
    () => days.map((d) => ({ t: dayToMs(d.day), day: d.day, totals: d as TokenTotals, src: d })),
    [days],
  );
  /**
   * Which model wears which colour, over the WHOLE document and not the visible
   * window — see `modelBands`. Folded by alias, so a dated snapshot and its
   * alias are one band rather than two that look like a migration.
   */
  const bands = useMemo(() => modelBands(doc?.models ?? []), [doc]);
  /** Whether there is more than one model to stack at all. A stack of one band
   *  is the flat fill wearing a legend, so the chip is absent rather than
   *  dead. */
  const canModel = bands.bands.length + (bands.restSlot != null ? 1 : 0) > 1
    && days.some((d) => (d.byModel?.length ?? 0) > 0);
  /** Subagents started inside the visible window. Zero means the section is not
   *  rendered at all: a chart of no launches teaches a reader to scroll past
   *  this part of the screen, and the sentence it would carry is already in the
   *  subagent KPI tile above. */
  const agentDays = useMemo(
    () => days.reduce((n, d) => n + (d.agents ?? []).reduce((m, a) => m + a.count, 0), 0),
    [days],
  );

  /**
   * The hours inside the span, cut exactly. The host keeps a bounded window of hours
   * (`hoursFrom`), so a span reaching further back is drawn from where the record starts AND says
   * so (`hourNote`) — never a chart quietly narrower than its tag.
   */
  const hourRows = useMemo(() => spanHours(doc?.hours ?? [], range, hourToMs), [doc, range]);
  const hoursWhole = hoursCover(doc?.hoursFrom, range);
  const hoursFromWords = doc?.hoursFrom != null
    ? new Date(doc.hoursFrom).toLocaleDateString(undefined, { day: "numeric", month: "short" })
    : null;

  const hourly: DayPoint[] = useMemo(
    () => hourPoints(hourRows, (h) => valueOf(h), hourToMs),
    [hourRows, valueOf],
  );

  /**
   * The same three series with their quiet buckets drawn in as zeros — what an
   * area may be drawn over, and only that.
   *
   * `fillSeries`/`fillMix` return null when the window is too wide to fill, and
   * that null travels all the way to the chips: the *area* control is NOT
   * RENDERED rather than dimmed, and the sentence under the chart says why.
   * See `fillSeries` for why filling this particular series is honest and
   * filling the usage readings is not.
   */
  const dailyFilled = useMemo(() => fillSeries(daily), [daily]);
  const mixFilled = useMemo(
    () => fillMix(mixRows, (t, day) => ({
      t, day, totals: zeroTotals(),
      // A day nothing happened on: no model ran and no agent started. Both
      // stated as empty rather than left off, which is what makes a filled day
      // a measured zero instead of a hole the stack has to guess at.
      src: { day, ...zeroTotals(), cost: zeroCost(), byModel: [], agents: [] },
    })),
    [mixRows],
  );
  const hourlyFilled = useMemo(() => fillSeries(hourly, HOUR_MS), [hourly]);
  /** Whether the per-day chart CAN be an area right now — the fill exists for
   *  whichever of the three questions is on screen. */
  const dayAreaOk = dayView === "total" ? !!dailyFilled : !!mixFilled;
  const dayArea = dayShape === "area" && dayAreaOk;
  const hourArea = hourShape === "area" && !!hourlyFilled;

  const scopeOn: "all" | LiveWindowId = active && active.back === 0 ? active.id : "all";
  // The span's repos and conversations: an hour bucket and a day row have none, so the host folds
  // the span (`/api/costwindow`). The live week IS the week card's document ("week"); any other
  // live cut or a calendar span up to the host's 35 days is its own read, keyed to stay put. A
  // longer calendar span has no fold, and says so (`reposRefusal`).
  const liveSS = scopeSpan(active, wk);
  const calSS = !active && calDays != null && calDays <= COST_WINDOW_DAYS && range
    ? { from: range.from, toHour: Infinity, key: `${range.from}:d${calDays}` }
    : null;
  const ss = liveSS ?? calSS;
  const ssOwn = ss && ss !== "week" ? ss : null;
  const scopeRead = useRemoteResource<CostWindowDoc>(
    `costwindow:${ssOwn?.key ?? "none"}:${fresh}`,
    () => ledgers.costWindow(ssOwn!.from, Math.min(ssOwn!.toHour, Date.now()), fresh > 0),
    { enabled: !!ssOwn, offline: !online },
  );
  const scopeDoc = ss === "week" ? weekDoc : docFor(scopeRead.data, ssOwn?.from ?? null);
  const scopeRes = ss === "week" ? weekRead : scopeRead;
  const scopeRepos = useMemo(() => (scopeDoc ? rankRepos(scopeDoc.convos, scopeDoc.rest).map(repoRowAsGroup) : null), [scopeDoc]);
  const reposRefusal = !active && calDays != null && calDays > COST_WINDOW_DAYS
    ? `The desktop folds repos over at most ${COST_WINDOW_DAYS} days, so ${calDays} days has no repo split — 30 days and all time do.`
    : null;
  /** Dollars per weekly point — ONE calibration for the whole screen (the week card and the
   *  costliest list), off the week's readings against its ledger. Readings are INSTANTS, so they
   *  are cut at the reset itself (`openedAt`), not at the hour the ledger's cut starts on: a
   *  stretch never spans the reset either way (`usageStretches` cuts there). */
  const weekCal = useMemo(() => (weekDoc && wk
    ? ptsCalibration((history?.samples ?? []).filter((x) => x.t >= wk.openedAt), weekDoc.hours, weekUsdPerPct(weekDoc.cost.total, usage?.weeklyPct))
    : null), [weekDoc, wk?.openedAt, history, usage?.weeklyPct]); // eslint-disable-line react-hooks/exhaustive-deps -- `wk` is rebuilt each render; its `openedAt` is the fact
  /** The live windows there is a chip for at all. A window that cannot be cut has no chip — the
   *  reason is a sentence in the limit block above, and a dead chip would be the greyed control
   *  this app does not draw. The one picked stays lit while it is a past window the grid reached. */
  const scopable = LIVE_WINDOWS.filter((w) => isCut(cuts.get(w.id)!) || active?.id === w.id);
  /** The span filter's calendar days, cut by day — null under a live window or all time. */
  const dcut = useMemo(() => (!active && calDays != null ? daysCut(days, doc?.models ?? []) : null), [active, calDays, days, doc]);

  const totals = doc?.totals;
  const grand = totals ? tokenTotal(totals) : 0;
  /** What the readouts are actually counting. One pair of values feeding the
   *  hero, the strip, the caveat and the cache verdict, so no two of them can
   *  end up describing different spans. */
  const shownTotals = active ? active.totals : dcut ? dcut.totals : totals;
  // The expired-cache re-writes across every conversation on this desktop —
  // the ONE wording, shared with the context sheet and the launcher row.
  const coldNote = coldStartText(doc?.coldStarts, "corpus");
  const shownCost = active ? active.cost : dcut ? dcut.cost : doc?.cost;
  const shownTok = shownTotals ? tokenTotal(shownTotals) : 0;

  /**
   * The words every section repeats in its own head, so a chart scrolled to in
   * the middle of a box still says what span it is drawing. One derivation per
   * box, shared by its caption and its sections.
   */
  const fmtDay = (d?: string) => d ? new Date(dayToMs(d)).toLocaleDateString(undefined, { day: "numeric", month: "short" }) : "";
  const scopeWords = active ? active.long : calDays != null ? `the last ${calDays} days` : "all time";
  const rangeWords = scopeWords;
  const dayEdges = days.length ? `${fmtDay(days[0]?.day)} – ${fmtDay(days[days.length - 1]?.day)}` : "";
  const rangeCaption = !days.length
    ? "No days in this span."
    : active
      ? `Days touching ${active.long}, ${dayEdges}: the day charts count its first and last day whole, the hour chart is cut to the hour.`
      : calDays != null
        ? `The last ${calDays} calendar days, ${range ? new Date(range.from).toLocaleDateString(undefined, { day: "numeric", month: "short" }) : ""} – today.`
        : `Every day on record, ${dayEdges}.`;
  const hourNote = range && !hoursWhole && hoursFromWords
    ? `Hourly detail is kept from ${hoursFromWords} on, so the hours here start there rather than at the start of the span.`
    : !range && hoursFromWords
      ? `Hourly detail is kept from ${hoursFromWords} on; everything before that is in the day charts only.`
      : null;
  const hourWords = hourNote && hoursFromWords ? `${rangeWords}, from ${hoursFromWords}` : rangeWords;
  /** The clock face: the span's hours where the record reaches its start; else every hour on record, said so. */
  const clockSlots = useMemo(() => (range && hoursWhole ? clockOf(hourRows) : null), [range, hoursWhole, hourRows]);
  const clock = clockSlots
    ? { slots: clockSlots, tag: scopeWords }
    : {
      slots: doc?.hourOfDay ?? [], tag: "all time",
      note: range ? `The hour record starts ${hoursFromWords ?? "later than this span"}, so this clock counts every hour on record rather than ${scopeWords}.` : undefined,
    };
  /** The costliest conversations for the span: the host's fold of it (cost INSIDE the span) where
   *  there is one, the all-time list at all time, and for a span with no fold the all-time list's
   *  rows that ran in it — whole-conversation cost, and said so. */
  const top: { rows: TokenConvo[]; total: number; tag: string; note?: string } = (() => {
    if (!doc) return { rows: [], total: 0, tag: "" };
    if (!range) return { rows: doc.top ?? [], total: doc.cost.total, tag: "all time · in money" };
    if (ss) {
      if (!scopeDoc) return { rows: [], total: 0, tag: `${scopeWords} · in money`, note: foldStateText(scopeRes, "window") };
      const rows = [...scopeDoc.convos].sort((x, y) => y.cost.total - x.cost.total);
      return { rows, total: scopeDoc.cost.total, tag: `${scopeWords} · in money · cost inside the span` };
    }
    const rows = (doc.top ?? []).filter((c) => c.lastAt != null && c.lastAt >= range.from);
    return {
      rows, total: doc.cost.total, tag: `${scopeWords} · in money · whole-conversation cost`,
      note: `Of the ${doc.top?.length ?? 0} dearest conversations on record, the ones that ran in ${scopeWords} — each at its whole cost, and its share is of all time.`,
    };
  })();
  const insights = useMemo(() => (doc ? statsInsights(doc, Date.now()) : []), [doc]);

  /**
   * ── The grammar of this screen ──────────────────────────────────────────────
   *
   * Five rules, and every control on the screen below is one of them. They are
   * written here because the failure they fix is not visible in any one of
   * them: what was wrong was that four different kinds of control looked and
   * sat the same, so the screen could not be read as saying anything about
   * which of them changed what.
   *
   * 1. `.sheet-head` holds CHROME ONLY — back, and verbs about the DOCUMENT
   *    (re-scan it). Nothing in the head changes what the body shows. The
   *    charts/values switch used to live there, which made the one control that
   *    reshaped the whole body indistinguishable from the one that reloaded it.
   *
   * 2. A choice that changes WHAT THE BODY SHOWS is a `.ts-filter` row of
   *    labelled `.key` chips, lit `.key.active`, placed DIRECTLY ABOVE the first
   *    thing it changes and BELOW everything it does not. The tokens/cost switch
   *    sat under the hero and the heat grids it shades; it now leads the list,
   *    because that is where the first thing it moves is.
   *
   * 3. A choice that changes ONE SECTION's reading is `.ts-seg-chips` inside
   *    that `.section-head`, lit `.key.active` — per day's total/mix/share, the
   *    bars/area form pair, and nothing that reaches past its own chart.
   *
   * 4. A verb that CANNOT RUN is not drawn; its reason is text (`Unavailable.tsx`).
   *    A verb that IS RUNNING says so in its own label or glyph — never
   *    `disabled`, which on a phone is a control with no explanation at all.
   *
   * 5. `.key.on` is NEVER written on this screen. It has no CSS rule anywhere
   *    that reaches here — the only `.key.on` in `styles.css` is scoped to
   *    `.bl-modal-seg` — so every chip that wore it has silently never lit.
   *    `.key.active` is the accent fill every other chip here already uses.
   */
  return (
    <>
      {onClose && <SheetHead title={<><BarChart3 size={16} style={{ verticalAlign: "-3px", marginRight: 4 }} />Token usage</>} onClose={onClose}>
        {/* One re-read for both sources — they are two readings of the same
            question and a button that refreshed only the chip you happen to be
            on would leave the other one silently older.

            Never `disabled`: a running verb wears the running in its own GLYPH
            (the head is icon-only across all thirty-three sheets, so there is no
            word to put it in) and the handler is what refuses a second scan.

            `inflight`, never `state === "loading"`: a rescan moves the read's
            KEY rather than calling `reload`, and a key change never passes
            through `loading` — so that flag is false from the first paint
            onward and a glyph keyed on it would never once have appeared. */}
        <Button onClick={() => { if (res.inflight) return; onRescan(); }}
          title={guest
            ? guest.def.rescanTitle
            : "re-scan the conversation logs — a point-in-time answer, not a live feed"}>
          {res.inflight ? <Loader size={14} className="spin" /> : <RefreshCw size={14} />}
        </Button>
      </SheetHead>}

      {/* ONE scroll region for the whole screen. Since 2026-10-15 ONE row in it is pinned: the
          span filter, because it reaches every box under it and a switch scrolled out of sight is
          a switch nobody connects to the number it changed. The "now" block above it scrolls
          away — both percentages carry their own reset instant in text. */}
      <div className="sheet-scroll">
        {doors}
        {/* The source picker: one chip per ledger, only when there is a second to pick. NOT a
            filter — no count rides on it: these chips swap the whole document rather than
            cutting one. One line that SCROLLS rather than wraps (it took three rows of a phone). */}
        {showPicker && (
          <div className="ts-filter ts-src" role="group" aria-label="ledger">
            <Button className={!extra && !overview && !readingChip && view === "claude" ? "active" : undefined}
              onClick={() => { setExtraId(null); setSource("claude"); }}>Claude Code</Button>
            {shown.map((g) => (
              <Button key={g.def.id} ref={!extra && !overview && !readingChip && view === g.def.id ? revealChip : undefined} className={!extra && !overview && !readingChip && view === g.def.id ? "active" : undefined}
                onClick={() => { setExtraId(null); setSource(g.def.id); }}>{g.def.label}</Button>
            ))}
            {chips.map((c) => (
              <Button key={c.source} ref={readingChip?.source === c.source ? revealChip : undefined} className={readingChip?.source === c.source ? "active" : undefined}
                onClick={() => setExtraId(READING_TAB + c.source)}>{c.label}</Button>
            ))}
            {ledgerTabs.map((t) => (
              <Button key={t.id} ref={extra?.id === t.id ? revealChip : undefined} className={extra?.id === t.id ? "active" : undefined}
                onClick={() => setExtraId(t.id)}>{t.label}</Button>
            ))}
            {showRunner && (
              <Button className={runner ? "active" : undefined} onClick={() => setExtraId(RUNNER_TAB)}>Local runner</Button>
            )}
            <Button className={overview ? "active" : undefined} onClick={() => setExtraId(ALL_TAB)}>All backends</Button>
          </div>
        )}

        {/* The filtered view says what it hides, with a clear: a tap on one source of several opened
            this sheet on it, and the others' quotas are not here. Gone once the view moves off it. */}
        {onText && (
          <div className="ts-filter" role="group" aria-label="opened on">
            <span className="empty ts-caveat">{onText}</span>
            <Button onClick={() => { setOn(null); onClearOn?.(); setExtraId(null); setSource("claude"); }}>all</Button>
          </div>
        )}

        {overview ? (
          <AllBackendsView claude={cut?.doc ?? fullDoc} guests={guests} shownIds={shown.map((g) => g.def.id)} ledgerTabs={ledgerTabs}
            runner={showRunner ? runnerRes.data ?? null : undefined} runnerTab={RUNNER_TAB}
            claudeScope={cut ? `Anthropic models only — ${cut.local.join(", ")} ${cut.local.length === 1 ? "is" : "are"} on ${localTab ? `the ${localTab} card` : "no card of their own"}.` : undefined}
            online={online} fresh={fresh}
            onOpen={(id) => {
              if (id === "claude" || guests.some((g) => g.def.id === id)) { setExtraId(null); setSource(id); }
              else setExtraId(id);
            }} />
        ) : runner ? (
          <LocalRunnerView res={runnerRes} />
        ) : readingChip ? (
          <SourceWindows reading={readingNow} online={online} />
        ) : extra ? (
          <BackendLedgerView id={extra.id} label={extra.label} online={online || localLedgers.includes(extra.id)} fresh={fresh} table={table} onTable={setTable}
            reading={(() => { const r = readingForLedger(readings, extra.id); return r ? readingAfterResets(r, Date.now()) : null; })()} />
        ) : view === "claude" ? <>
          {/* ── NOW: the one exception to the span filter ──────────────────
              The two limit windows and the week's hours, compact, because they are what the
              launcher chip that leads here is about and only they have a clock on them. Rendered
              outside `Empty`, so a desktop with no conversation logs still answers "when do my
              limits reset". A figure under a bar is a filter: it sets the span below. */}
          <div className="ts-now">
          {lead}
          {scraped && <LimitWindows usage={usage ?? null} onRefresh={onRefreshUsage}
            history={history} compact
            cuts={cuts} scope={scopeOn}
            onScope={(x) => setSpan(x === "all" ? { id: "all", back: 0 } : { id: x, back: 0 })} />}
          {doc && grand > 0 && scraped && <WeekCard doc={weekDoc} res={weekRead} openedAt={wk?.openedAt ?? null} samples={history?.samples ?? []}
            everyMs={history?.everyMs ?? 0} cal={weekCal} compact
            nameOf={nameOf} onExplain={onExplain} isLive={isLive} onOpenConvo={onOpenConvo} />}
          {doc && grand > 0 && periodState && <PeriodCard state={periodState} cap={periodCap(spend?.budget, periodState.period.id)} doc={periodDoc} res={periodRead}
            refusal={periodSpan && "refusal" in periodSpan ? periodSpan.refusal : null} now={periodNow} />}
          </div>

          {/* ── The span filter, pinned: it reaches EVERYTHING below ──────
              One span, the metric and the form — two short rows, so it costs the screen little.
              Stepping back through past windows is the Totals box's stepper and heat grids. */}
          {doc && grand > 0 && (
            <div className="ts-global">
              <div className="ts-filter" role="group" aria-label="span">
                {SPANS.filter((x) => !isLiveSpan(x.id) || scopable.some((w) => w.id === x.id)).map((x) => (
                  <Button key={x.id} className={effId === x.id ? "active" : undefined}
                    onClick={() => setSpan({ id: x.id, back: 0 })}>{x.label}</Button>
                ))}
              </div>
              <div className="ts-filter" role="group" aria-label="count in">
                <span className="ctx-stackpick-lab">count in</span>
                <Button className={!money ? "active" : undefined} onClick={() => setMetric("tokens")}>tokens</Button>
                <Button className={money ? "active" : undefined} onClick={() => setMetric("cost")}>cost</Button>
                <span className="ts-seg-sep" aria-hidden="true" />
                <span className="ctx-stackpick-lab">show as</span>
                <Button className={!table ? "active" : undefined} onClick={() => setTable(false)}>chart</Button>
                <Button className={table ? "active" : undefined} onClick={() => setTable(true)}>values</Button>
              </div>
            </div>
          )}

          {/* The scope sentence, drawn only where the switch is — with one
              source there is nothing for "only" to be exclusive of. */}
          {showSource && (
            <div className="empty ts-caveat">
              {claudeOnlyText(shown)}
            </div>
          )}
          {/* Which models this view counts. Drawn only when the logs hold a
              model that is not Anthropic's; the button is the clear way to see
              every model, and back. */}
          {split && "refused" in split && <div className="empty ts-caveat">{split.refused}</div>}
          {cut && (
            <div className="ts-filter" role="group" aria-label="models">
              <span className="empty ts-caveat">{allModels ? allNoteText(cut, fmtCount) : splitNoteText(cut, fmtCount, localTab)}</span>
              <Button onClick={() => setAllModels((v) => !v)}>
                {allModels ? `Anthropic’s ${cut.shown} only` : `show all ${cut.all} models`}
              </Button>
            </div>
          )}

          <Empty res={res} empty={!doc || !grand} thing="the token statistics" noun="scan"
            note="These are read out of the CLI’s own conversation logs, so a machine that has not run it yet has nothing to count.">
            {cut && !allModels
              ? "Every token in Claude Code’s logs is from a model that is not Anthropic’s — nothing to count on this view."
              : "No conversation logs on this desktop yet — nothing to count."}
          </Empty>

          {doc && grand > 0 && (
            <div className="list ts-list">
              <InsightsPanel items={insights} />

              <TotalsCard doc={doc} money={money} table={table} active={active}
                dcut={dcut && calDays != null ? { cut: dcut, calendarDays: calDays, caption: rangeCaption } : null}
                scope={scope} setScope={setScope} grids={grids} hist={hist} shownTotals={shownTotals} shownCost={shownCost}
                shownTok={shownTok} coldNote={coldNote} scopeWords={scopeWords} bands={bands} canModel={canModel}
                days={days} nameOf={nameOf} onExplain={onExplain} isLive={isLive} canOpen={canOpen} onOpenConvo={onOpenConvo}
                scopeRepos={scopeRepos} scopeRes={scopeRes} reposRefusal={reposRefusal} top={top}
                weekTwin={ss === "week" && !!weekDoc}
                pts={(usd, c) => (convoInWeek(c, wk?.from) ? ptsText(usd, weekCal) : null)} />

              <OverTimeCard doc={doc} money={money} table={table} dayCharts={effId !== "session"} narrow={days.length <= 14}
                rangeCaption={rangeCaption} rangeWords={rangeWords} clock={clock} hourNote={hourNote}
                reqSpan={range ? { from: dayKeyOf(range.from), to: dayKeyOf(Math.max(range.from, range.to - 1)) } : null}
                boxRef={boxRef} width={width}
                running={running} dayView={dayView} setDayView={setDayView} canModel={canModel} mixBy={mixBy}
                setMixBy={setMixBy} dayArea={dayArea} setDayShape={setDayShape} dayAreaOk={dayAreaOk}
                dailyFilled={dailyFilled} daily={daily} trend={trend} mixFilled={mixFilled} mixRows={mixRows}
                bands={bands} days={days} agentDays={agentDays} hourWords={hourWords} hourRows={hourRows}
                hourArea={hourArea} setHourShape={setHourShape} hourlyFilled={hourlyFilled} hourly={hourly} />

              <div className="empty ts-foot">
                {doc.scannedAt
                  ? <>Scanned {doc.logs.toLocaleString()} conversation logs{doc.reread ? `, ${doc.reread.toLocaleString()} re-read` : ""} at {new Date(doc.scannedAt).toLocaleTimeString()}. </>
                  : null}
                Counts every log currently on this desktop, including {doc.subagentLogs.toLocaleString()} subagent
                transcripts — a conversation deleted from the archive stops counting.
              </div>
            </div>
          )}
        </> : guest ? (
          <guest.def.View doc={guest.doc ?? null} res={guest.res} table={table} onTable={setTable} backend={guest.backend} parts={PARTS} />
        ) : null}
      </div>
    </>
  );
}
