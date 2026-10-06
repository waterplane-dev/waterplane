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
import { useCallback, useEffect, useRef, useState } from "react";
import { Activity, FolderTree, RefreshCw, Send } from "lucide-react";
import {
  recutCommandOf, repoHealthAvailability, repoHealthPlotAvailability,
  repoHealthPlotUnavailableText, repoHealthUnavailableText,
} from "@waterplane/shared";
import type { RepoHealthPlotSeries, RepoHealthView, RepoTarget } from "@waterplane/shared";
import { api, copyText } from "./api";
import { track } from "./usage";
import { useRemoteResource } from "./useRemoteResource";
import { useNow } from "./useNow";
import { ago } from "./format";
import { Empty } from "./Empty";
import { CantInline } from "./Unavailable";
import { Markdown } from "./Markdown";
import { seriesAbsenceWords, seriesAllRemedyPrompt, seriesRemedyPrompt } from "./setupRemedy";
import { AreaSpread, SeriesTile, WeightStack } from "./RepoHealthTiles";
import { LongestFiles } from "./RepoHealthLongest";
import { Magnitudes } from "./RepoHealthMags";
import { ReadingsTable } from "./RepoHealthTable";
import { HintChip } from "./HintChip";
import { CLAUDE_MD_KEY, DESC_KEY } from "./SetupSheet";
import {
  SCOPE_ALL_LABEL, SERIES_ASK_ALL_LABEL, SERIES_ASK_LABEL, drawnPageWords, emptySeriesWords, engineLineWords, lastCommitWords,
  mixedPlotWords, mixedVersionWords, narrativeWrittenWords, notPlottedWords, outcomeWords,
  plotAxisWords, rankBasisWords, rankSentence, readFailedWords, refreshBusyLabel,
  refreshFailedWords, refreshLabel, runningWords, seriesAskNoteWords, seriesHeadWords,
  scopeChoiceHeadWords, scopeEmptyWords, scopeHeadWords, scopePickWords,
  seriesSizeWords, seriesValueWords, staleRowsWords, stalenessWords,
  warningsWords,
} from "./repoHealthWords";
import { splitNarrativeDays } from "./narrativeDays";

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

  // The SVGs are drawn at a MEASURED width rather than stretched to fit: a
  // viewBox scaled to a box distorts the stroke and the text along with the
  // curve, and a phone rotating is the common case here. Measured through a
  // CALLBACK REF, never `useRef` + a mount effect — the box lives inside a
  // conditional and the series arrives asynchronously, so on the first commit
  // there is no node to observe and an effect with `[]` deps would never look
  // again (`ContextSheet.tsx`'s header: `width` stayed 0 for the life of the
  // sheet and both charts rendered nothing).
  const roRef = useRef<ResizeObserver | null>(null);
  const [width, setWidth] = useState(0);
  const boxRef = useCallback((el: HTMLDivElement | null) => {
    roRef.current?.disconnect();
    roRef.current = null;
    if (!el) return;
    // `clientWidth` is the PADDING box; this box carries the gutter every other
    // row in the sheet has, and drawing at the padded width pushes a
    // right-anchored mark past the visible edge.
    const contentWidth = (node: HTMLDivElement) => {
      const cs = getComputedStyle(node);
      return Math.max(0, node.clientWidth - parseFloat(cs.paddingLeft || "0") - parseFloat(cs.paddingRight || "0"));
    };
    setWidth(contentWidth(el));
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => setWidth(contentWidth(el)));
    ro.observe(el);
    roRef.current = ro;
  }, []);
  useEffect(() => () => roRef.current?.disconnect(), []);

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

  const stale = stalenessWords({
    behind: view?.behind,
    lastSha: series?.lastSha,
    lastDay: series?.lastDay,
    headSha: view?.head?.sha,
  });
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
  const last = view?.last ?? null;
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
  // Every `points` array in one plot is exactly `days` long by construction, so
  // ANY series gives the x axis — but an empty `series` gives none, and
  // `plot.series[0].points.length` inside an optional chain is still evaluated.
  const axisPoints = plot?.series[0]?.points ?? [];
  const firstDay = axisPoints[0]?.day ?? null;
  const lastDay = axisPoints[axisPoints.length - 1]?.day ?? null;
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

  return (
    <>
      <div className="section-head">
        <span className="section section-hint">{seriesHeadWords()}</span>
        {repo && !noEngine ? (
          <button className="key" onClick={() => void refresh()}>
            <RefreshCw size={ICON} className={busy ? "spin" : undefined} />
            {busy ? refreshBusyLabel(series, now - startedAt) : refreshLabel(series)}
          </button>
        ) : null}
      </div>

      {/* WHICH READING, above everything it changes.
          Drawn whenever the repo has scopes or could have them, because the
          chooser is the only way one ever gets configured — and a repo with a
          scope on screen must always carry the way back to the whole tree.
          A chip is a filter in this repo's sense: the tap does not narrow what
          is drawn, it loads a different series, and the sentence under it says
          which. */}
      {repo && !noEngine && (scopes.length || candidates.length) ? (
        <>
          <div className="ts-filter" role="group" aria-label="which part of the repo">
            <span className="ctx-stackpick-lab">reading of</span>
            <button className={`key${scope === null ? " active" : ""}`} onClick={() => onScope(null)}>
              {SCOPE_ALL_LABEL}
            </button>
            {scopes.map((sc) => (
              <button key={sc} className={`key${scope === sc ? " active" : ""}`}
                onClick={() => { track("action:repohealth.scope"); onScope(sc); }}>
                {sc}
              </button>
            ))}
            {candidates.length ? (
              <button className={`key${picking ? " active" : ""}`} onClick={() => setPicking((v) => !v)}>
                <FolderTree size={12} /> break down…
              </button>
            ) : null}
          </div>
          {scope ? <div className="section section-hint">{scopeHeadWords(scope)}</div> : null}
          {picking ? (
            <div className="section section-hint">
              <div>{scopeChoiceHeadWords(candidates.length)}</div>
              <ul className="rh-filter">
                {candidates.map((g) => (
                  <li key={g}>
                    <button
                      className={scopes.includes(g) ? "key on" : "key"}
                      aria-pressed={scopes.includes(g)}
                      onClick={() => void setScopes(
                        scopes.includes(g) ? scopes.filter((x) => x !== g) : [...scopes, g],
                      )}
                    >
                      {g}
                    </button>
                  </li>
                ))}
              </ul>
              <div>{scopePickWords()}</div>
            </div>
          ) : null}
        </>
      ) : null}

      {/* Which engine read this tree and what it found the tree to be written
          in. Under the head rather than in it: it is a fact about THIS read,
          it changes between repos, and it is what makes the absences further
          down legible — "duplication absent, no parser" is only readable
          beside "kotlin". */}
      {engineLine ? <div className="section section-hint">{engineLine}</div> : null}

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
          button above stays pressable — this sheet predicts the refusal, it
          does not enforce it. */}
      {mixed ? <div className="section section-hint">{mixed}</div> : null}

      {stale ? (
        <div className="section section-hint">
          {stale}
          {narrative ? <> · {narrativeWrittenWords(ago(narrative.mtime))}</> : null}
          {view?.head ? <> · {lastCommitWords(ago(view.head.ts))}</> : null}
          {sizeWords ? <> · {sizeWords}</> : null}
        </div>
      ) : null}
      {staleRows ? <div className="section section-hint">{staleRows}</div> : null}
      {running ? <div className="section section-hint">{running}</div> : null}

      {last ? (
        <div className="section section-hint">
          {outcomeWords(last)}
          {last.at ? <> ({ago(last.at)})</> : null}
          {/* VERBATIM, trailing newline and all. It is not a stack trace: it is
              the argument for the refusal plus the one command that re-cuts the
              history, and that command deletes the series. `.update-log` is
              borrowed rather than re-declared — it is this app's one
              pre-wrapped, bounded, scrollable quote block — UNBOUNDED here
              (`.rh-refusal`): its last line is the remedy, and a 140px box hid
              exactly that line behind an inner scroll nobody finds on a phone. */}
          {last.refused ? <pre className="update-log rh-refusal">{last.refused.text}</pre> : null}
          {warnings ? <div>{warnings}</div> : null}
        </div>
      ) : null}

      {runError ? <div className="section section-hint">{refreshFailedWords(runError)}</div> : null}

      {/* THE CHARTS LEAD, and each caption sits under the chart it is about
          (`ContextSheet.tsx`'s rule). The bands above are the clock they are
          read at, which is why they are the one thing that comes first. */}
      {plotMissing ? <div className="section section-hint">{plotMissing}</div> : null}

      <div className="rh-box" ref={boxRef}>
        {plot ? (
          <>
            {mixedPlotWords(series?.versions) ? (
              <div className="rh-cap">{mixedPlotWords(series?.versions)}</div>
            ) : null}

            {/* FIRST: one file taking an ever larger share of the tree is the
                shape this sheet most needs to show, and it used to sit under
                every tile and every stack. */}
            <LongestFiles longest={plot.longest} classics={plot.classics} p95={p95} width={width}
              // Every path in the plot is relative to ITS scope, so a scoped
              // reading's `src/App.tsx` is re-rooted before it leaves here.
              onOpenFile={repo && onOpenFile
                ? (p) => onOpenFile(repo.id, plot.scope ? `${plot.scope.replace(/\/+$/, "")}/${p}` : p)
                : undefined} />

            <ul className="rh-tiles">
              {plot.series.map((s) => (
                <SeriesTile
                  key={s.key}
                  s={s}
                  width={width}
                  actions={onRemedy && repo ? (
                    <button className="key" onClick={() => askAbout(s)}>
                      <Send size={12} /> {SERIES_ASK_LABEL}…
                    </button>
                  ) : null}
                />
              ))}
            </ul>
            <div className="rh-cap">{plotAxisWords(plot.days, firstDay, lastDay)}</div>
            <div className="rh-cap">
              {rankBasisWords(plot.windowReadings, plot.minReadings)}{" "}
              <HintChip id="repohealth.reading" of="the percentile and the arrow" />
            </div>
            {/* Under the tiles rather than in the head: it carries what the
                tiles say, so a tap before they are drawn would send a set
                nobody has seen. Beside the note that says what both verbs
                are — and it is absent, never dimmed, where there is no send
                path or no repo to send to. */}
            {onRemedy && repo && plot.series.length ? (
              <div className="rh-tile-acts">
                <button className="key" onClick={askAll}>
                  <Send size={12} /> {SERIES_ASK_ALL_LABEL}…
                </button>
              </div>
            ) : null}
            <div className="rh-cap">{seriesAskNoteWords()}</div>

            <WeightStack
              claudeMd={plot.series.find((s) => s.key === CLAUDE_MD_KEY) ?? null}
              descriptions={plot.series.find((s) => s.key === DESC_KEY) ?? null}
              width={width}
            />

            {/* Three states, and until now two of them drew nothing at all.
                The family unread on the latest day is one sentence. A family
                that WAS read and yielded no areas is a different one — most
                repos on this desktop have no `<router>-*` convention, so this
                is their normal state, and a chart that simply is not there
                reads as a chart that failed. The tool states which; where it
                did not, the panel still says there are no per-area readings
                rather than leaving the gap to be interpreted. */}
            {plot.context.absent ? (
              <div className="rh-cap">
                The per-area reading was not taken on the latest day — {plot.context.absent}
              </div>
            ) : Object.keys(plot.context.areas).length === 0 ? (
              <div className="rh-cap">
                No per-area reading here{plot.context.areasAbsent ? <> — {plot.context.areasAbsent}</> : null}.
                The always-on weight above is the whole tree's and is unaffected.
              </div>
            ) : (
              <AreaSpread areas={plot.context.areas} width={width} />
            )}

            <Magnitudes classics={plot.classics} width={width} />

            {/* Last, because it is the same figures the charts above already
                drew — the picture first, the numbers for whoever wants to
                check one. It used to be the one card on the separately
                generated page that this sheet had no copy of, which is what
                kept an *open the drawn page* button alive down here after the
                sheet had absorbed every other card on it. */}
            <ReadingsTable plot={plot} />

            <div className="rh-cap">{notPlottedWords()}</div>
            <div className="rh-cap">{drawnPageWords(!!view?.page)}</div>
          </>
        ) : null}
      </div>


      {split && split.preamble ? (
        <>
          {/* Folded, because it is the tool's standing explanation of how to
              read a row and does not change between runs — but reachable,
              because without it "37th percentile of the last 15 readings" is
              a number with no stated basis. */}
          <details className="hint-more" open={showPreamble}
            onToggle={(e) => setShowPreamble((e.currentTarget as HTMLDetailsElement).open)}>
            <summary>how to read this</summary>
            <div className="tr-say rh-doc">
              <Markdown src={split.preamble} q="" onCopy={(t) => void copyText(t)} />
            </div>
          </details>
        </>
      ) : null}

      {days.map((d) => (
        <div className="tr-say rh-doc" key={d.day}>
          {/* The day's own heading and body, re-joined exactly as the tool
              wrote them, so the sheet shows the words and not a re-rendering
              of what they were taken to mean. */}
          <Markdown src={`## ${d.day}${d.body}`} q="" onCopy={(t) => void copyText(t)} />
        </div>
      ))}
    </>
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
