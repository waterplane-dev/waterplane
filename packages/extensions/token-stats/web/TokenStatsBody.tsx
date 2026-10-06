/** Everything the screen draws, given a document: all of the sheet's state and derivations, the skeleton, and the contributed tabs. */
import { Headline } from "./Headline.tsx";
import { useCallback, useEffect, useMemo, useState } from "react";
import { BarChart3, Loader, RefreshCw } from "lucide-react";
import {
  coldStartText, type CostBreakdown, cumulative, dayToMs, hourToMs,
  type TokenConvo, type TokenStatsDoc, tokenTotal, type TokenTotals, type TokenWindowsDoc,
  type TokenWindowSeries, type UsageHistoryDoc, type UsageInfo, zeroCost, zeroTotals, fmtCount,
} from "@waterplane/shared";
import { InsightsPanel, ScopeCard, ScopeTag } from "./TokenInsights.tsx";
import { statsInsights } from "./statsInsights.ts";
import {
  type CutRefusal, isCut, LIVE_WINDOWS, type LiveWindowId, seriesCut, windowCut, type WindowCut,
  windowSpecs,
} from "./usageCut.ts";
import { ledgers, type LedgerViewParts } from "@waterplane/sdk";
import {
  type DayPoint, Empty, fillMix, fillSeries, HOUR_MS, hourPoints, modelBands, type ResourceState,
  rollingMean, SheetHead, shiftWeek, useBoxWidth, useRemoteResource, weekBounds, type WeekDay,
  weekDays, weekStart, weekTotals,
} from "@waterplane/kit";
import { type RangeId, RANGES, type SourceId, TREND_DAYS } from "./constants.ts";
import { type WindowScope } from "./WindowHeats.tsx";
import { LimitWindows } from "./LimitWindows.tsx";
import { BackendLedgerView } from "./BackendLedgerView.tsx";
import { DayChart } from "./charts/DayChart.tsx";
import { claudeOnlyText, type GuestLedger, shownGuests } from "./guests.ts";
import { TotalsCard } from "./TotalsCard.tsx";
import { AllBackendsView } from "./AllBackendsView.tsx";
import { LocalRunnerView } from "./LocalRunnerView.tsx";
import { showRunnerTab } from "./localRunner.ts";
import type { LocalUsageDoc } from "@waterplane/shared";
import { allNoteText, splitLocal, splitNoteText } from "./localSplit.ts";

/** The overview's key on the ledger-tab state — not a backend id (those match `^[a-z]`). */
const ALL_TAB = "*all";
/** The local runner's tab on the same state — what ollama itself did, not a backend's ledger. */
const RUNNER_TAB = "*runner";
import { OverTimeCard } from "./OverTimeCard.tsx";

/** This sheet's own widgets, lent to every contributed tab (`LedgerViewParts`). */
const PARTS: LedgerViewParts = { DayChart, ScopeCard, ScopeTag };

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
export function TokenStatsBody({ doc: rawDoc, res, guests = [], usage, usageHistory, online = true, onRefreshUsage, onClose, onRescan, initialRange = "30", initialSource = "claude", ledgerTabs = [], fresh = 0, nameOf, onExplain, isLive, onOpenConvo }: {
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
  fresh?: number;
  /** Both live windows, or null when nothing has been scraped yet. Optional so
   *  a static render of the charts needs no host snapshot. */
  usage?: UsageInfo | null;
  /** A kept-readings history to draw instead of reading one — static renders
   *  only, same reason as `initialRange`. */
  usageHistory?: UsageHistoryDoc | null;
  /** The socket's verdict. Passed down so the history read is skipped rather
   *  than left to time out with the tunnel down. */
  online?: boolean;
  onRefreshUsage?: (quiet?: boolean) => void;
  onClose: () => void;
  onRescan: () => void;
  /** Which window the charts open on. Only a static render passes it — the
   *  "render it and look at it" step cannot click a filter chip, and a chart
   *  nobody can see rendered is a chart nobody checked. */
  initialRange?: RangeId;
  /** Which source the screen opens on. Same reason as `initialRange`, and the
   *  same rule: nothing in the app passes it, so every real open starts on
   *  Claude. */
  initialSource?: SourceId;
  /** The costliest-conversations list's doors — `TopConvos`. All optional: a
   *  static render has no session to start and no sheet to open. */
  nameOf?: (id: string) => string | undefined;
  onExplain?: (c: TokenConvo, title: string) => void;
  isLive?: (id: string) => boolean;
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
  const [source, setSource] = useState<SourceId>(initialSource);
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
  const [extraId, setExtraId] = useState<string | null>(null);
  const extra = ledgerTabs.find((t) => t.id === extraId) ?? null;
  /** The "All backends" overview rides on the same id state, under a key no
   *  backend can have (ids are `^[a-z]`). */
  const overview = extraId === ALL_TAB;
  /** The local runner's ledger (`/api/localusage`): its tab and card exist only
   *  where the host has it AND it has seen the runner — an older host (404) or a
   *  desktop with no local models gets neither, never an empty or dimmed one. */
  const runnerRes = useRemoteResource<LocalUsageDoc>(`localusage:${fresh}`, () => ledgers.localUsage(), { offline: !online });
  const showRunner = showRunnerTab(runnerRes.data);
  const runner = extraId === RUNNER_TAB && showRunner;
  const showPicker = showSource || ledgerTabs.length > 0 || showRunner;
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
  const [range, setRange] = useState<RangeId>(initialRange);
  /**
   * Which LIVE rate-limit window the READOUTS are cut to — a different
   * decision from `range`, which scopes the time charts, and deliberately a
   * different control.
   *
   * State and not persisted, the same rule the rest of this screen follows: a
   * scope is the tap, not a setting made days ago and shown nowhere. It
   * matters more here than anywhere else on the screen, because a hero figure
   * silently standing for five hours instead of four months is the most
   * misleading thing this file can print.
   *
   * It carries WHICH window as well as which kind (`back`, 0 being the one
   * running now), because the heat grids below scope to a window that closed
   * days ago and every sentence under the hero has to know which one it is
   * describing. `null` is all time — an absent scope rather than a magic
   * string, so a new window kind cannot be spelled two ways.
   */
  const [scope, setScope] = useState<WindowScope>(null);
  // Which week the week view is looking at, as the Monday's local midnight.
  // Null until the scan lands, because the sensible opening week is the last
  // one with anything in it — a screen that opens on an empty current week
  // reads as "nothing was ever recorded" on a Monday morning.
  const [weekAt, setWeekAt] = useState<number | null>(null);

  const [width, boxRef] = useBoxWidth();

  // The filter row scopes the TIME charts only. It is applied by dropping days
  // off the front, so the cumulative curve inside a window starts at that
  // window's own zero — a running total that began before the left edge would
  // draw a cliff at the first point and mean nothing.
  const allDays = doc?.days ?? [];
  // eslint-disable-next-line react-hooks/exhaustive-deps -- keyed on `doc`: `allDays` is `doc?.days ?? []`, a new array each render when absent
  const bounds = useMemo(() => weekBounds(allDays, Date.now()), [doc]);
  // The opening week: the last one that had activity, clamped into the range
  // the stepper can reach. Re-seeded only while unset, so a rescan does not
  // yank the view back off the week being read.
  const week = weekAt ?? (doc?.lastAt != null ? weekStart(doc.lastAt) : bounds.last);
  useEffect(() => {
    if (weekAt == null && doc) setWeekAt(week);
  }, [doc, weekAt, week]);

  // eslint-disable-next-line react-hooks/exhaustive-deps -- keyed on `doc`: `allDays` is `doc?.days ?? []`, a new array each render when absent
  const weekRows: WeekDay[] = useMemo(() => weekDays(allDays, week), [doc, week]);
  const wTotals = useMemo(() => weekTotals(weekRows), [weekRows]);
  const prevTotals = useMemo(
    () => weekTotals(weekDays(allDays, shiftWeek(week, -1))),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- keyed on `doc`: `allDays` is `doc?.days ?? []`, a new array each render when absent
    [doc, week],
  );

  const days = useMemo(() => {
    const all = doc?.days ?? [];
    // `src` carries the per-model split and the subagent launches through the
    // week view; a day the scan never saw has neither, stated as empty.
    if (range === "week") {
      return weekRows.map((d) => ({
        day: d.day, ...d.totals, cost: d.cost,
        byModel: d.src?.byModel ?? [], agents: d.src?.agents ?? [],
      }));
    }
    const n = RANGES.find((r) => r.id === range)?.days ?? 0;
    return n > 0 ? all.slice(-n) : all;
  }, [doc, range, weekRows]);

  const daily: DayPoint[] = useMemo(
    () => days.map((d) => ({ day: d.day, t: dayToMs(d.day), v: valueOf(d) })),
    [days, valueOf],
  );
  // A running total is only drawn over days that have HAPPENED. In week mode
  // the seven columns run to Sunday whether or not the week is over — the
  // frame is the point — but carrying the cumulative line flat across days
  // still in the future states that nothing was used on them, which is a
  // reading of the data rather than the absence of one.
  const running: DayPoint[] = useMemo(() => {
    const today = weekStart(Date.now()) === week && range === "week"
      ? new Date(new Date().setHours(0, 0, 0, 0)).getTime()
      : Infinity;
    const past = daily.filter((d) => d.t <= today);
    return cumulative(past.map((d) => ({ day: d.day, total: d.v })))
      .map((d) => ({ day: d.day, t: dayToMs(d.day), v: d.sum }));
  }, [daily, range, week]);

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
   * The hours to draw, scoped by the SAME filter row as everything else.
   *
   * The host only ships a recent window of hours (`hoursFrom`), so a range the
   * window does not reach back to is answered with a sentence rather than with
   * a chart of the part it happens to have — a 90-day chip showing 14 days of
   * hours would be a chart lying about its own extent.
   */
  const hourRows = useMemo(() => {
    const all = doc?.hours ?? [];
    if (!all.length) return [];
    if (range === "week") {
      const keys = new Set(weekRows.map((d) => d.day));
      return all.filter((h) => keys.has(h.hour.slice(0, 10)));
    }
    // The same window as every other chart in its box: the day chips cut the
    // hours too, so a chip in the box's head never leaves one chart unmoved.
    const n = RANGES.find((r) => r.id === range)?.days ?? 0;
    if (n > 0 && days.length) {
      const from = days[0].day;
      return all.filter((h) => h.hour.slice(0, 10) >= from);
    }
    return all;
  }, [doc, range, weekRows, days]);

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
    if (!scope) return undefined;
    const spec = LIVE_WINDOWS.find((w) => w.id === scope.id);
    if (!spec) return undefined;
    const grid = grids.get(scope.id) ?? null;
    const fromGrid = grid ? seriesCut(spec, grid, scope.back, doc?.models ?? []) : null;
    if (fromGrid && isCut(fromGrid)) return fromGrid;
    return scope.back === 0 ? cuts.get(scope.id) : (fromGrid ?? undefined);
  }, [scope, grids, cuts, doc]);
  const active = picked && isCut(picked) ? picked : null;
  const scopeOn: "all" | LiveWindowId = active && active.back === 0 ? active.id : "all";
  /** The windows there is a chip for at all. A window that cannot be cut has
   *  no chip — the reason is a sentence in the limit block above, and a dead
   *  chip would be the greyed control this app does not draw. */
  const scopable = LIVE_WINDOWS.filter((w) => isCut(cuts.get(w.id)!));

  const totals = doc?.totals;
  const grand = totals ? tokenTotal(totals) : 0;
  /** What the readouts are actually counting. One pair of values feeding the
   *  hero, the strip, the caveat and the cache verdict, so no two of them can
   *  end up describing different spans. */
  const shownTotals = active ? active.totals : totals;
  // The expired-cache re-writes across every conversation on this desktop —
  // the ONE wording, shared with the context sheet and the launcher row.
  const coldNote = coldStartText(doc?.coldStarts, "corpus");
  const shownCost = active ? active.cost : doc?.cost;
  const shownTok = shownTotals ? tokenTotal(shownTotals) : 0;

  /**
   * The words every section repeats in its own head, so a chart scrolled to in
   * the middle of a box still says what span it is drawing. One derivation per
   * box, shared by its caption and its sections.
   */
  const fmtDay = (d?: string) => d ? new Date(dayToMs(d)).toLocaleDateString(undefined, { day: "numeric", month: "short" }) : "";
  const rangeWords = range === "week"
    ? `week of ${fmtDay(weekRows[0]?.day)}`
    : range === "all" ? "all time" : `last ${RANGES.find((r) => r.id === range)?.days} days`;
  const rangeCaption = days.length
    ? <>{range === "week" ? "One calendar week" : range === "all" ? "Every day on record" : `The last ${RANGES.find((r) => r.id === range)?.days} days`}, {fmtDay(days[0]?.day)} – {fmtDay(days[days.length - 1]?.day)}.</>
    : <>No days in this window.</>;
  const scopeWords = active ? active.long : "all time";
  const hourWords = doc?.hoursFrom != null && days.length && dayToMs(days[0].day) < doc.hoursFrom
    ? `${rangeWords}, from ${new Date(doc.hoursFrom).toLocaleDateString(undefined, { day: "numeric", month: "short" })}`
    : rangeWords;
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
      <SheetHead title={<><BarChart3 size={16} style={{ verticalAlign: "-3px", marginRight: 4 }} />Token usage</>} onClose={onClose}>
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
        <button className="key" onClick={() => { if (res.inflight) return; onRescan(); }}
          title={guest
            ? guest.def.rescanTitle
            : "re-scan the conversation logs — a point-in-time answer, not a live feed"}>
          {res.inflight ? <Loader size={14} className="spin" /> : <RefreshCw size={14} />}
        </button>
      </SheetHead>

      {/* ONE scroll region for the whole screen, not a pinned head over a
          scrolling tail. The live windows used to sit outside `.list` — the
          only scroller `.sheet` has — so "RIGHT NOW" held a third of the phone
          permanently and the history under it read through a slot. Nothing here
          is worth pinning: both percentages carry their own reset instant in
          text, so they say the same thing scrolled past as they do on screen. */}
      <div className="sheet-scroll">
        {/* The source picker: two chips, and only when there is a second
            source to pick. NOT a filter — no count rides on it, because a
            number on a control means "tap here and see exactly these", and
            these two chips swap the whole document rather than cutting one.
            Ranged above everything, because it scopes the entire screen.
            `ts-filter`'s row is reused rather than given a class of its own:
            it is the one chip-row rule this screen has, and a second one would
            be two answers to the question of how a chip row looks. */}
        {showPicker && (
          <div className="ts-filter">
            <button className={`key${!extra && !overview && view === "claude" ? " active" : ""}`}
              onClick={() => { setExtraId(null); setSource("claude"); }}>Claude Code</button>
            {shown.map((g) => (
              <button key={g.def.id} className={`key${!extra && !overview && view === g.def.id ? " active" : ""}`}
                onClick={() => { setExtraId(null); setSource(g.def.id); }}>{g.def.label}</button>
            ))}
            {ledgerTabs.map((t) => (
              <button key={t.id} className={`key${extra?.id === t.id ? " active" : ""}`}
                onClick={() => setExtraId(t.id)}>{t.label}</button>
            ))}
            {showRunner && (
              <button className={`key${runner ? " active" : ""}`} onClick={() => setExtraId(RUNNER_TAB)}>Local runner</button>
            )}
            <button className={`key${overview ? " active" : ""}`} onClick={() => setExtraId(ALL_TAB)}>All backends</button>
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
        ) : extra ? (
          <BackendLedgerView id={extra.id} label={extra.label} online={online} fresh={fresh} />
        ) : view === "claude" ? <>
          {/* The scope sentence, drawn only where the switch is — with one
              source there is nothing for "only" to be exclusive of, and the
              screen must read exactly as it did before. */}
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
              <button className="key" onClick={() => setAllModels((v) => !v)}>
                {allModels ? `Anthropic’s ${cut.shown} only` : `show all ${cut.all} models`}
              </button>
            </div>
          )}
          {/* The live windows come FIRST, above the history, because they are what
              the launcher chip that leads here is about: the history says how much
              has ever been spent, and only these two say whether anything can be
              spent in the next hour. Rendered outside `Empty`, so a desktop with
              no conversation logs at all still answers "when do my limits reset". */}
          {/* The headline LEADS: one number for the last seven days, never
              without its split and its money (`Headline.tsx`). It obeys none of
              the switches below it, and says so. */}
          {doc && grand > 0 && <Headline doc={doc} />}
          <LimitWindows usage={usage ?? null} onRefresh={onRefreshUsage}
            online={online} history={usageHistory}
            cuts={cuts} scope={scopeOn}
            onScope={(x) => setScope(x === "all" ? null : { id: x, back: 0 })} />

          <Empty res={res} empty={!doc || !grand} thing="the token statistics" noun="scan"
            note="These are read out of the CLI’s own conversation logs, so a machine that has not run it yet has nothing to count.">
            {cut && !allModels
              ? "Every token in Claude Code’s logs is from a model that is not Anthropic’s — nothing to count on this view."
              : "No conversation logs on this desktop yet — nothing to count."}
          </Empty>

          {doc && grand > 0 && (
            <div className="list ts-list">

              {/* ── The two switches that reach EVERYTHING below ──────────────
                  Pinned while the screen scrolls, because they change every
                  box under them and a switch scrolled out of sight is a switch
                  nobody connects to the number it changed. The filters that
                  reach only PART of the screen are not here: each one is the
                  head of the box it filters (`ScopeCard`). */}
              <div className="ts-global">
                <div className="ts-filter" role="group" aria-label="count in">
                  <span className="ctx-stackpick-lab">count in</span>
                  <button className={`key${!money ? " active" : ""}`} onClick={() => setMetric("tokens")}>tokens</button>
                  <button className={`key${money ? " active" : ""}`} onClick={() => setMetric("cost")}>cost</button>
                  <span className="ts-seg-sep" aria-hidden="true" />
                  <span className="ctx-stackpick-lab">show as</span>
                  <button className={`key${!table ? " active" : ""}`} onClick={() => setTable(false)}>chart</button>
                  <button className={`key${table ? " active" : ""}`} onClick={() => setTable(true)}>values</button>
                </div>
              </div>

              <InsightsPanel items={insights} />

              <TotalsCard doc={doc} money={money} table={table} active={active} scopable={scopable} scopeOn={scopeOn}
                scope={scope} setScope={setScope} grids={grids} hist={hist} shownTotals={shownTotals} shownCost={shownCost}
                shownTok={shownTok} coldNote={coldNote} scopeWords={scopeWords} bands={bands} canModel={canModel}
                days={days} nameOf={nameOf} onExplain={onExplain} isLive={isLive} onOpenConvo={onOpenConvo} />

              <OverTimeCard doc={doc} money={money} table={table} range={range} setRange={setRange}
                rangeCaption={rangeCaption} rangeWords={rangeWords} week={week} bounds={bounds} setWeekAt={setWeekAt}
                wTotals={wTotals} prevTotals={prevTotals} weekRows={weekRows} boxRef={boxRef} width={width}
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
