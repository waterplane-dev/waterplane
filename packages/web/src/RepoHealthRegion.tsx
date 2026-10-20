/**
 * `Repo readings`, region 2 — against its own past.
 *
 * Split out of `SetupSheet.tsx`, which stayed the sheet both regions live in
 * (it still owns the region switch and the merge story — see that file's own
 * header), once region 2 was about to grow and the file was already at this
 * repo's 900-line lint cap. The same split already happened once to this
 * region's own drawing half (`RepoHealthTiles.tsx` → `RepoHealthTable.tsx`),
 * for the same reason.
 *
 * The comparator that separates the two regions is argued in `SetupSheet.tsx`;
 * what belongs here follows from it: a fact about this repo against the same
 * fact on earlier commits has no side to be on, so nothing below may grow a
 * stripe, a status colour or a verdict word. `repoHealthWords.ts`'s own tests
 * hold that ban, and `repoHealthPlot.ts` computes no rank.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { Activity, FolderTree, Send } from "lucide-react";
import {
  recutCommandOf, repoHealthAvailability, repoHealthPlotAvailability,
  repoHealthPlotUnavailableText, repoHealthUnavailableText,
} from "@waterplane/shared";
import { BRAND, type RepoHealthPlotSeries, type RepoHealthView, type RepoTarget } from "@waterplane/shared";
import { api, copyText } from "./api";
import { track } from "./usage";
import { useRemoteResource } from "./useRemoteResource";
import { useNow } from "./useNow";
import { ago } from "./format";
import { Empty } from "./Empty";
import { Explain } from "./Explain";
import { HealthIndexSection } from "./HealthIndexSection";
import { FilterChip } from "./kit/FilterChip";
import { CantInline } from "./Unavailable";
import { Markdown } from "./Markdown";
import {
  ENGINE_ADOPT_LABEL, engineAdoptPrompt, healthAskContextOf, healthIndexRemedyPrompt, healthTrendRemedyPrompt, seriesAbsenceWords, seriesAllRemedyPrompt, seriesRemedyPrompt,
  type IndexNow, type IndexTrendWeek, type IndexVsSubject, type IndexWeekSubject,
} from "./setupRemedy";
import { TilesCard, WeightCard } from "./RepoHealthTiles";
import { LongestFiles } from "./RepoHealthLongest";
import { Magnitudes } from "./RepoHealthMags";
import { ReadingsTable } from "./RepoHealthTable";
import { OwnReadings } from "./RepoHealthOwn";
import { CLAUDE_MD_KEY, DESC_KEY } from "./repoHealthPlot";
import {
  SCOPE_ALL_LABEL, SERIES_ASK_LABEL, centralFileLines, centralHeadWords, drawnPageWords, emptySeriesWords, engineLineWords, lastCommitWords,
  mixedPlotWords, mixedVersionWords, narrativeWrittenWords, notPlottedWords, outcomeRepeatsReadError, outcomeWords,
  rankSentence, readFailedWords, refreshBusyLabel,
  refreshFailedWords, refreshLabel, runningWords, seriesHeadWords,
  scopeChoiceHeadWords, scopeEmptyWords, scopeHeadWords, scopePickWords,
  seriesSizeWords, seriesStatusWords, seriesValueWords, staleRowsWords, stalenessWords,
  warningsWords,
} from "./repoHealthWords";
import { splitNarrativeDays } from "./narrativeDays";
import { foldPlot } from "./repoHealthFoldPlot";
import { readHealthAxis, writeHealthAxis } from "./storage";
import type { HealthAxisMode } from "./healthIndexWords";
import { AxisRow, HealthNav, RefreshKey, SectionCard, navKeysOf, shownSections } from "./RepoHealthCards";
import { DailyNotes } from "./RepoHealthNotes";
import "./repohealth.css";

/** The size every button in the repo's action row uses. `ICON` is App-local
 *  (`App.tsx`, `const ICON = 16`) and `App.tsx` is not ours to import from, so
 *  the number is repeated rather than the convention broken: a menu row one
 *  pixel-size out from its siblings reads as a different kind of control. */
const ICON = 16;

/** While the host says a run of its own is out. Quiet — `reload({quiet: true})`
 *  keeps the document on screen; a poll that blanks what somebody is reading to
 *  prove a request went out is worse than the wait. */
const POLL_MS = 1500;

// ───────────────────────────────────────────────────────────────────────────
// Region 2 — against its own past.
// ───────────────────────────────────────────────────────────────────────────

/**
 * The series, its narrative, and the charts drawn from it.
 *
 * The read/poll/refresh arrangement moved here whole from the sheet this
 * replaced, and the reasoning it carried is worth restating because it is easy
 * to undo:
 *
 *  - **The cached series paints before anything is asked.** A cold run is
 *    ~18 s. A sheet that ran the tool on open would be a tap that looks broken
 *    for eighteen seconds, on the device where that is the whole difference
 *    between a control and a dead button.
 *  - **The refresh's running state is a LOCAL `busy`**, never
 *    `res.state === "loading"`: `loading` means *nothing to show yet* and is
 *    false from the first paint on.
 *  - **A refusal prints as the tool's own paragraph**, verbatim. It ends in
 *    the command that re-cuts the history, and that command deletes a file, so
 *    this screen offers no button that runs it.
 *  - **Staleness is counted in COMMITS**, never days: this repo has a 57-day
 *    hole in its history and an untouched repo is not stale.
 */
export function SeriesRegion({ repo, res, view, onRemedy, scope, onScope, onOpenFile }: {
  repo: RepoTarget | null;
  res: ReturnType<typeof useRemoteResource<RepoHealthView>>;
  view: RepoHealthView | null;
  onRemedy?: (prompt: string, repo: RepoTarget, label: string) => void;
  /** The subtree being read, or null for the repo. Owned by the sheet because
   *  it is part of the resource key — see `SetupSheet.tsx`. */
  scope: string | null;
  onScope: (scope: string | null) => void;
  /** Open a REPO-relative file (the longest-files tape). Absent = no verb. */
  onOpenFile?: (repoId: string, relPath: string) => void;
}) {
  const series = view?.series ?? null;
  const plot = view?.plot ?? null;

  /** The WRITE half. Separate from the read's own state on purpose: "the
   *  series could not be read" and "the run I just asked for failed" are
   *  different facts with different next actions. */
  const [busy, setBusy] = useState(false);
  const [startedAt, setStartedAt] = useState(0);
  const [runError, setRunError] = useState<string | null>(null);
  const [showPreamble, setShowPreamble] = useState(false);
  const now = useNow(1000);

  const { reload } = res;
  // `!!view.run` rather than the object: a fresh object arrives with every poll
  // and the effect would tear down and re-arm its own interval each time.
  const hostRunning = !!view?.run;
  useEffect(() => {
    if (!hostRunning) return;
    const t = window.setInterval(() => reload({ quiet: true }), POLL_MS);
    return () => window.clearInterval(t);
  }, [hostRunning, reload]);

  // The SVGs are drawn at a MEASURED width, and every card measures its OWN
  // content box (`SectionCard`, `useBoxWidth`): a card is narrower than the
  // region by its padding, and a grid tile narrower still.

  // The region's ONE x-axis choice, per device. `weeks` folds every per-day
  // series to each week's last day; `commits` draws them whole. The index
  // card gets the choice as given and reports whether the desktop sends a
  // commit series at all (`onCommits`), which decides whether the chip exists.
  const [axis, setAxisState] = useState<HealthAxisMode>(readHealthAxis);
  const setAxis = (m: HealthAxisMode) => { track(`action:repohealth.axis.${m}`); writeHealthAxis(m); setAxisState(m); };
  const [commits, setCommits] = useState<"absent" | "none" | "present" | null>(null);
  const onCommits = useCallback((a: typeof commits) => setCommits(a), []);
  // A stored `commits` on a desktop that sends none is drawn as weeks, and the
  // row says why — never a lit chip for a mode that is not on screen.
  const drawnAxis: HealthAxisMode = axis === "commits" && commits === "absent" ? "weeks" : axis;
  const drawn = useMemo(() => (plot ? foldPlot(plot, drawnAxis) : null), [plot, drawnAxis]);

  // The subtrees this repo measures, and the ones it could. `scopes` is the
  // host's stored list; the candidates are the engine's own derived groups, so
  // the list offered here and the bands on the group chart are one set.
  const scopes = view?.scopes ?? [];
  const candidates = (view?.measure?.groups ?? []).filter((g) => g && g !== ".");
  const [picking, setPicking] = useState(false);
  const [savingScopes, setSavingScopes] = useState(false);

  async function setScopes(next: string[]) {
    if (!repo || savingScopes) return;
    setSavingScopes(true);
    try {
      const r = await api.repoHealthScopes(repo.id, next);
      // If the scope being READ was just dropped, the reading has to go back
      // to the repo — a chart left on screen under a name nothing measures any
      // more is the stalest thing this sheet could show.
      if (scope && !r.scopes.includes(scope)) onScope(null);
      await reload({ quiet: true });
    } catch (e) {
      setRunError(String((e as Error)?.message || e));
    } finally {
      setSavingScopes(false);
    }
  }

  async function refresh() {
    if (busy || !repo) return;
    track("action:repohealth.refresh");
    setBusy(true);
    setStartedAt(Date.now());
    setRunError(null);
    try {
      // 200 s on the phone against the host's 180 s cap — see `api.ts`. The
      // route answers 200 even when the tool refuses, so there is nothing to
      // read off the status: the outcome is in the body.
      const next = await api.repoHealthRefresh(repo.id, scope);
      res.set(next);
    } catch (e) {
      // Only a transport failure reaches here. A refusal is a body.
      setRunError(String((e as Error)?.message || e));
    } finally {
      setBusy(false);
    }
  }

  const staleness = {
    behind: view?.behind,
    lastSha: series?.lastSha,
    lastDay: series?.lastDay,
    headSha: view?.head?.sha,
  };
  const stale = stalenessWords(staleness);
  const status = seriesStatusWords({ ...staleness, rows: series?.rows, days: series?.days });
  const measure = view?.measure ?? null;
  // The re-cut line is the ENGINE's, for the root it measured. The constant
  // this replaced named `tools/repohealth.mjs` relative to a repo most repos
  // are not, and began with `rm`.
  const mixed = mixedVersionWords(
    series?.versions, measure?.engineVersion ?? series?.preregVersion, recutCommandOf(measure));
  const engineLine = engineLineWords({
    kind: view?.engine?.kind ?? null,
    version: measure?.engineVersion,
    packs: measure?.packs,
  });
  // The desktop holds no engine. That is a fix beside the daemon, not a tap
  // here — so the control is NOT DRAWN (never greyed: `Unavailable.tsx`) and
  // the sentence in the `Empty` below is left to stand on its own. It used to
  // be offered one line above "nothing here can be read", which is a tap into
  // nothing on the one screen that has no other way out.
  const noEngine = !!view && !view.tool;
  const staleRows = staleRowsWords(series?.staleRows);
  const running = runningWords(view?.run, now);
  const last = view?.last && !outcomeRepeatsReadError(view.last, view.readError, !!view.series) ? view.last : null;
  const narrative = view?.narrative ?? null;
  const sizeWords = seriesSizeWords(series);
  const warnings = warningsWords(last?.warnings);
  const split = narrative ? splitNarrativeDays(narrative.text) : null;
  // Newest FIRST. The file is oldest-first, so the day a person opened this
  // sheet to read is the last thing in it.
  const days = split ? [...split.days].reverse() : [];

  // THREE states, and the third is not a shrug: an absent `plot` field is a
  // desktop older than the charts, `null` is the tool answering nothing, and
  // only an object is drawable. Resolved through the shared helper rather than
  // tested for `undefined` here — the rule `local/no-raw-optional-cap` states.
  //
  // Said only where it is the ONLY thing missing: with no tool in the repo, or
  // with no series measured at all, the `Empty` above has already answered —
  // and "this desktop is older than the plot" printed under "nothing has been
  // measured yet" is a second, contradictory next action.
  //
  // And where the ENGINE is why there is no chart, the sheet says that instead
  // of the standing remedy: a repo carrying a copy of the tool older than the
  // `plot` subcommand is read with that copy, so "refresh it to measure one"
  // points at a button that cannot help. `plotError` is the host's sentence
  // for exactly those cases and is null for the ordinary one.
  const plotState = repoHealthPlotAvailability(view);
  const plotMissing = view?.tool && series
    ? repoHealthPlotUnavailableText(plotState, view?.plotError ?? null)
    : null;
  const p95 = plot?.series.find((s) => s.key === "size.p95")?.last ?? null;

  // Why a series has no number, in one sentence — the same three cases the
  // tile draws, worded for a document with no tile beside it.
  const absence = (s: RepoHealthPlotSeries) =>
    seriesAbsenceWords({
      absent: s.absent,
      last: s.last,
      readings: s.points.reduce((n, p) => (p.v == null ? n : n + 1), 0),
    });

  // The wire's series, as the prompt's subject. One conversion, used by both
  // verbs: the row prompt and the set prompt quoting the same reading in two
  // spellings is the drift the single `rankSentence` on this side exists to
  // prevent.
  const subjectOf = (s: RepoHealthPlotSeries) => ({
    key: s.key,
    label: s.label,
    value: seriesValueWords(s.last, s.unit),
    reading: rankSentence(s.reading),
    // `rankSentence` answers with the percentile OR with the tool's reason for
    // having none, and the prompt frames those two differently — a refusal to
    // read is not a reading. The rank on the wire is the only thing that knows
    // which one came back.
    ranked: s.reading?.rank != null,
    detail: s.detail,
    // Only the SET carries this: a row's own absence sentence is already on
    // screen beside its button, and the set has no screen — it is the prompt.
    // Not the wire field alone — a series the latest day simply did not read
    // carries no `absent` at all, and printing its em-dash value into a
    // document is the one thing this prompt may not do.
    ...(absence(s) ? { absent: absence(s) } : {}),
  });

  const askAbout = (s: RepoHealthPlotSeries) => {
    if (!onRemedy || !repo) return;
    track("action:repohealth.ask");
    onRemedy(seriesRemedyPrompt(subjectOf(s), repo.repoName, scope), repo, s.label.toLowerCase());
  };

  const askIndex = (w: IndexWeekSubject, vs: IndexVsSubject | null) => {
    if (!onRemedy || !repo) return;
    track("action:repohealth.askindex");
    // The baseline only decides the tree-growth line, which this prompt does not carry.
    onRemedy(healthIndexRemedyPrompt(w, repo.repoName, healthAskContextOf(plot, view?.engine?.kind, "", vs)), repo, `the health index, week of ${w.week}`);
  };

  const askTrend = (weeks: IndexTrendWeek[], baselineWeek: string, vs: IndexVsSubject | null, now?: IndexNow) => {
    if (!onRemedy || !repo) return;
    track("action:repohealth.asktrend");
    onRemedy(
      healthTrendRemedyPrompt(weeks, baselineWeek, repo.repoName, { ...healthAskContextOf(plot, view?.engine?.kind, baselineWeek, vs), now: now ?? null }),
      repo, "the health index trend");
  };

  // Every reading in the order the sheet drew them, with the engine line — see
  // `seriesAllRemedyPrompt` for why the narrative stays out of it.
  const askAll = () => {
    if (!onRemedy || !repo || !plot?.series.length) return;
    track("action:repohealth.askall");
    onRemedy(
      seriesAllRemedyPrompt(plot.series.map(subjectOf), repo.repoName, engineLine, scope),
      repo,
      scope ? `all the readings of ${scope}` : "all the readings",
    );
  };

  // The repo's OWN engine copy is what failed, and it outranks the desktop's,
  // so another refresh runs the same file. The fix is in the repo: seed a
  // prompt for its agent (`engineAdoptPrompt`). Absent — not greyed — when the
  // desktop's engine is the one that failed, since adopting it changes nothing.
  const ownEngineFailed = view?.engine?.kind === "repo" && !!(last?.error || view.readError);
  const askAdopt = () => {
    if (!onRemedy || !repo || !view) return;
    track("action:repohealth.adoptengine");
    onRemedy(engineAdoptPrompt(repo.repoName, last?.error ?? view.readError, view.engine?.bundled), repo, "the repo-health engine");
  };

  // What the status line folds: the intro, both commits with the two ages and
  // the definition, and which engine read the tree in what packs. Four grey
  // paragraphs stood above the first number; every fact is still here, one tap
  // away. Before the first row the intro IS the head, so it is not said twice.
  // The engine line stays reachable with no series: it is what makes a later
  // absence ("no parser for kotlin") legible.
  const details = status || engineLine ? (
    <>
      {status ? <p>{seriesHeadWords()}</p> : null}
      {stale ? (
        <p>
          {stale}
          {narrative ? <> · {narrativeWrittenWords(ago(narrative.mtime))}</> : null}
          {view?.head ? <> · {lastCommitWords(ago(view.head.ts))}</> : null}
          {sizeWords ? <> · {sizeWords}</> : null}
        </p>
      ) : null}
      {engineLine ? <p>{engineLine}</p> : null}
    </>
  ) : null;

  // The head is the status line and its `?` only; the refresh verb lives at
  // the end of the sticky jump bar, in reach from every card.
  const refreshable = !!repo && !noEngine;
  const refreshKey = refreshable ? (
    <RefreshKey busy={busy} onClick={() => void refresh()}
      label={busy ? refreshBusyLabel(series, now - startedAt) : refreshLabel(series)} />
  ) : null;

  // Which cards are drawn, in screen order — the jump bar names exactly these
  // (a section that is not on screen has no chip, never a dimmed one).
  const indexShown = !!repo && !scope && !noEngine;
  const shown = shownSections({ index: indexShown, drawn, plot, own: !!repo });
  const navKeys = navKeysOf(shown);

  return (
    <div className="rh-region">
      <div className="section-head rh-head">
        <span className={`section section-hint rh-status${details ? "" : " rh-push"}`}>
          {status ?? seriesHeadWords()}
        </span>
        {details ? <Explain of="this series">{details}</Explain> : null}
      </div>

      {/* WHICH READING, above everything it changes.
          Drawn whenever the repo has scopes or could have them, because the
          chooser is the only way one ever gets configured — and a repo with a
          scope on screen must always carry the way back to the whole tree.
          A chip is a filter in this repo's sense: the tap does not narrow what
          is drawn, it loads a different series, and the sentence under it says
          which. Exactly one reading is always chosen, so no ×, and
          `break down…` opens the picker rather than cutting anything. */}
      {repo && !noEngine && (scopes.length || candidates.length) ? (
        <>
          <div className="fchips wrap rh-scope" role="group" aria-label="which part of the repo">
            <span className="ctx-stackpick-lab">reading of</span>
            <FilterChip on={scope === null} clears={false} onClick={() => onScope(null)}>
              {SCOPE_ALL_LABEL}
            </FilterChip>
            {scopes.map((sc) => (
              <FilterChip key={sc} on={scope === sc} clears={false}
                onClick={() => { track("action:repohealth.scope"); onScope(sc); }}>
                {sc}
              </FilterChip>
            ))}
            {candidates.length ? <>
              <span className="fchips-gap" aria-hidden />
              <FilterChip on={picking} clears={false} onClick={() => setPicking((v) => !v)}>
                <FolderTree size={12} /> break down…
              </FilterChip>
            </> : null}
          </div>
          {scope ? <div className="section section-hint">{scopeHeadWords(scope)}</div> : null}
          {picking ? (
            <div className="section section-hint">
              <div>{scopeChoiceHeadWords(candidates.length)}</div>
              {/* A measured subtree is a lit chip whose tap takes it away —
                  the kit's ×, never the old solid `.key.on`. */}
              <div className="fchips wrap rh-filter-chips" role="group" aria-label="subtrees to measure">
                {candidates.map((g) => (
                  <FilterChip key={g} on={scopes.includes(g)} busy={savingScopes && scopes.includes(g)}
                    onClick={() => void setScopes(
                      scopes.includes(g) ? scopes.filter((x) => x !== g) : [...scopes, g],
                    )}>
                    {g}
                  </FilterChip>
                ))}
              </div>
              <div>{scopePickWords()}</div>
            </div>
          ) : null}
        </>
      ) : null}

      {/* The series' OWN nothings, and its own age line. `empty` explicit so
          the cached-age line stands above a document that DOES have rows.
          THREE sentences, in the order their next actions differ: no engine on
          this desktop (nothing to tap, and the control above is absent), an
          engine that ran and could not read the tree (its own words, not a
          tap), and a tree nobody has measured yet (one tap, and what it
          costs). */}
      <Empty res={res} empty={!series && !plot} thing="the repo-health series" noun="reading">
        {noEngine
          ? repoHealthUnavailableText("absent")
          : view?.readError
            ? readFailedWords(view.readError)
            : scope
              // A scope's own emptiness, in its own commits: "1,281 commits"
              // is the repo's number and would misstate a subtree's backfill
              // by an order of magnitude in both directions.
              ? scopeEmptyWords(scope, measure?.commits)
              : emptySeriesWords(measure?.commits, view?.stepTimeoutMs)}
      </Empty>

      {/* BEFORE the tap, not after it: a mixed series makes the next refresh
          exit 3, and the evidence for that is the per-version row counts. The
          button stays pressable — this sheet predicts the refusal, it does
          not enforce it. */}
      {mixed ? <div className="section section-hint">{mixed}</div> : null}

      {staleRows ? <div className="section section-hint">{staleRows}</div> : null}
      {running ? <div className="section section-hint">{running}</div> : null}

      {last ? (
        <div className="section section-hint">
          {outcomeWords(last)}
          {last.at ? <> ({ago(last.at)})</> : null}
          {/* VERBATIM, trailing newline and all. It is not a stack trace: it is
              the argument for the refusal plus the one command that re-cuts the
              history, and that command deletes the series. `.update-log` is
              borrowed rather than re-declared — UNBOUNDED here (`.rh-refusal`):
              its last line is the remedy, and a 140px box hid exactly that
              line behind an inner scroll nobody finds on a phone. */}
          {last.refused ? <pre className="update-log rh-refusal">{last.refused.text}</pre> : null}
          {warnings ? <div>{warnings}</div> : null}
        </div>
      ) : null}

      {ownEngineFailed && onRemedy && repo ? (
        <div className="section">
          <button type="button" className="key rh-verb" onClick={askAdopt}>
            <Send size={12} aria-hidden /> {ENGINE_ADOPT_LABEL}…
          </button>
        </div>
      ) : null}

      {runError ? <div className="section section-hint">{refreshFailedWords(runError)}</div> : null}
      {plotMissing ? <div className="section section-hint">{plotMissing}</div> : null}

      {/* The jump bar sticks under the sheet head while the cards scroll. It
          is drawn even with no card yet: the refresh verb is in it. */}
      {navKeys.length || refreshKey ? <HealthNav keys={navKeys} refresh={refreshKey} /> : null}

      {indexShown || drawn ? <AxisRow axis={drawnAxis} onAxis={setAxis} commits={commits} /> : null}

      {/* The index leads: one number first, the readings it is built from below. The whole tree only — a scope has no index. */}
      {indexShown && repo ? (
        <HealthIndexSection repoId={repo.id} axis={drawnAxis} onCommits={onCommits}
          seriesStamp={`${series?.lastSha ?? ""}:${series?.rows ?? 0}`}
          onAsk={onRemedy ? askIndex : undefined} onAskTrend={onRemedy ? askTrend : undefined} />
      ) : null}

      {drawn && plot ? (
        <>
          {mixedPlotWords(series?.versions) ? (
            <div className="rh-cap rh-gutter">{mixedPlotWords(series?.versions)}</div>
          ) : null}

          {/* WHOSE readings these are, once, as a heading — never a badge per
              card. Everything from here to the repo's own card is the
              engine's; the repo's own, if any, are named apart. */}
          <div className="section rh-prov">{centralHeadWords(BRAND.displayName)}</div>
          {centralFileLines(plot.central).map((l) => <div key={l} className="rh-cap rh-gutter">{l}</div>)}

          {/* FIRST: one file taking an ever larger share of the tree is the
              shape this sheet most needs to show. */}
          {shown.longest ? (
            <SectionCard id="longest">
              {(w) => (
                <LongestFiles longest={drawn.longest} classics={drawn.classics} p95={p95} width={w}
                  // Every path in the plot is relative to ITS scope, so a scoped
                  // reading's `src/App.tsx` is re-rooted before it leaves here.
                  onOpenFile={repo && onOpenFile
                    ? (p) => onOpenFile(repo.id, plot.scope ? `${plot.scope.replace(/\/+$/, "")}/${p}` : p)
                    : undefined} />
              )}
            </SectionCard>
          ) : null}

          <TilesCard series={drawn.series} windowReadings={plot.windowReadings} minReadings={plot.minReadings}
            axis={drawnAxis}
            onAsk={onRemedy && repo ? askAbout : undefined}
            onAskAll={onRemedy && repo && plot.series.length ? askAll : undefined} />

          <WeightCard
            claudeMd={drawn.series.find((s) => s.key === CLAUDE_MD_KEY) ?? null}
            descriptions={drawn.series.find((s) => s.key === DESC_KEY) ?? null}
            context={plot.context} />

          <SectionCard id="size">{(w) => <Magnitudes classics={drawn.classics} width={w} />}</SectionCard>

          {/* Last, because it is the same figures the charts above already
              drew — the picture first, the numbers for whoever wants to check
              one. The readings as they were taken, in either x mode. */}
          {shown.table ? (
            <SectionCard id="table">
              {() => (
                <>
                  <ReadingsTable plot={plot} />
                  <details className="hint-more rh-more">
                    <summary>not drawn here</summary>
                    <p>{notPlottedWords()}</p>
                    <p>{drawnPageWords(!!view?.page)}</p>
                  </details>
                </>
              )}
            </SectionCard>
          ) : null}

          {/* The repo's OWN readings, apart from everything above and from
              the index: one line on how to add one where it declares none. */}
          {repo ? (
            <OwnReadings plot={plot} repoName={repo.repoName} series={drawn.own?.series} axis={drawnAxis}
              actionsFor={onRemedy ? (s) => (
                <button type="button" className="key rh-verb" onClick={() => askAbout({ ...s, detail: s.means })}>
                  <Send size={12} aria-hidden /> {SERIES_ASK_LABEL}…
                </button>
              ) : undefined} />
          ) : null}
        </>
      ) : null}

      {split && split.preamble ? (
        // Folded, because it is the tool's standing explanation of how to read
        // a row and does not change between runs — but reachable, because
        // without it "37th percentile of the last 15 readings" is a number
        // with no stated basis.
        <details className="hint-more rh-notes" open={showPreamble}
          onToggle={(e) => setShowPreamble((e.currentTarget as HTMLDetailsElement).open)}>
          <summary>how to read this</summary>
          <div className="tr-say rh-doc">
            <Markdown src={split.preamble} q="" onCopy={(t) => void copyText(t)} />
          </div>
        </details>
      ) : null}

      <DailyNotes days={days} />
    </div>
  );
}

/**
 * The repo action row's entry to the series half.
 *
 * Three states, and the third is not a shrug. `hasRepoHealth === false` is the
 * DESKTOP having no engine at all — not the repo's own `tools/repohealth.mjs`,
 * not the bundled one, not `WATERPLANE_REPOHEALTH_ENGINE` — because one engine reads
 * every tree now and the repo is never the reason (`wire/repo.ts`, and the
 * sentence `repoHealthUnavailableText` prints below). `undefined` is a
 * desktop that predates the feature and therefore has no answer, which must not
 * render a sentence claiming anything is missing. Both resolve through
 * `repoHealthAvailability` in shared rather than being read off the wire here —
 * the convention `local/no-raw-optional-cap` states for `BackendInfo.caps`: an
 * optional wire boolean resolves through ONE named helper that states its
 * fallback, or every surface re-derives what absent means and one of them gets
 * it backwards, silently, on exactly the desktops that are behind.
 *
 * The unavailable case is a SENTENCE, never a greyed button (`Unavailable.tsx`):
 * a `title` is invisible on a phone, and a dimmed control with the same border
 * and label as its neighbours is a tap into nothing.
 *
 * It lives here rather than in a sheet of its own because the sheet it opened
 * is `SetupSheet.tsx`, at `initialRegion: "series"`.
 */
export function RepoHealthMenuItem({ repo, onOpen }: { repo: RepoTarget; onOpen: () => void }) {
  const avail = repoHealthAvailability(repo);
  if (avail === "unknown") return null;
  if (avail === "absent") {
    // `CantInline` rather than a bespoke line: it is the app's one spelling of
    // "this verb is not here, and here is why", and it cannot be mistaken for
    // something to press. The wrapper is what gives it a line of its own in
    // `.row-more`, which is a wrapping flex row of controls.
    return <div className="act-cants"><CantInline>{repoHealthUnavailableText(avail)}</CantInline></div>;
  }
  // `over time`, not `repo readings`: the checklist entry beside this one is
  // now ALSO called repo readings, because they open the same sheet. Two
  // controls with one name is a menu that cannot be aimed. This one is the
  // direct door to the second region, so it is named after the region — and
  // the region switch at the top of the sheet uses the same two words, which
  // is what makes the door and the destination recognisably the same place.
  return (
    <button className="more-act" onClick={onOpen}>
      <Activity size={ICON} />over time
    </button>
  );
}
