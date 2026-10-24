import { useEffect, useMemo, useState } from "react";
import { RefreshCw, Square, Trash2 } from "lucide-react";
import { BRAND, healthCommitsAvailability, repoHealthPlotAvailability, repoHealthPlotUnavailableText } from "@waterplane/shared";
import type { RepoHealthPlotSeries } from "@waterplane/shared";
import type { HealthDoc, HealthRunState, PromptDef, ToExtension } from "../src/protocol";
import { TilesCard, WeightCard } from "../../web/src/RepoHealthTiles";
import { LongestFiles } from "../../web/src/RepoHealthLongest";
import { Magnitudes } from "../../web/src/RepoHealthMags";
import { ReadingsTable } from "../../web/src/RepoHealthTable";
import { OwnReadings } from "../../web/src/RepoHealthOwn";
import { HealthIndexChart } from "../../web/src/HealthIndexChart";
import { AxisRow, HealthNav, RefreshKey, SectionCard, navKeysOf, shownSections } from "../../web/src/RepoHealthCards";
import { foldPlot } from "../../web/src/repoHealthFoldPlot";
import { Explain } from "../../web/src/Explain";
import { FilterChip } from "../../web/src/kit/FilterChip";
import { Button } from "@waterplane/kit";
import type { HealthAxisMode } from "../../web/src/healthIndexWords";
import { CLAUDE_MD_KEY, DESC_KEY } from "../../web/src/repoHealthPlot";
import {
  centralFileLines, centralHeadWords, emptySeriesWords, engineLineWords, lastCommitWords, notPlottedWords, outcomeRepeatsReadError, outcomeWords, ownShow,
  readFailedWords, refreshBusyLabel, refreshLabel, runningWords, seriesHeadWords, seriesSizeWords, seriesStatusWords,
  staleRowsWords, stalenessWords, warningsWords,
} from "../../web/src/repoHealthWords";
import { SCOPE_ALL_LABEL, scopeHeadWords } from "../../web/src/repoHealthWords/repoHealthWordsScope";
import { NOT_GIT, XCODE_LICENSE, knownReadErrorWords, measureWords, notRunWords, ownAddNoteWords, ownMixedWords, repoMixedWords, sourceWords } from "../src/health/sourcewords";
import { Absent } from "./Absent";
import { loadHealthAxis, saveHealthAxis } from "./host";
import "../../web/src/repohealth.css";
import { PromptActions } from "./Actions";

/** `3 min ago` style age, for the two timestamps this tab prints. Coarse on purpose. */
function ago(ms: number, now: number): string {
  const s = Math.max(0, Math.round((now - ms) / 1000));
  if (s < 60) return "moments ago";
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h} h ago`;
  return `${Math.round(h / 24)} days ago`;
}

/** Ticks once a second while `on`, so the running sentence and the busy label keep counting. */
export function useNow(on: boolean, ms = 1000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!on) return;
    setNow(Date.now());
    const t = window.setInterval(() => setNow(Date.now()), ms);
    return () => window.clearInterval(t);
  }, [on, ms]);
  return on ? now : Date.now();
}

/**
 * The repo's shape over time, drawn as the phone draws it (`RepoHealthRegion.tsx`): one status
 * line with its `?`, the sticky jump bar with the refresh verb, ONE x-axis row, then a card each —
 * score, longest file, tiles, always-on weight, size, table, the repo's own — built from the
 * phone's own card frame (`RepoHealthCards.tsx`) and chart modules. Minus the daily narrative and
 * the drawn page, which the extension never writes.
 *
 * The series is the extension's own copy, read by the bundled engine from git history, or the one
 * the waterplane desktop app left in the folder (read-only, with its scopes); this view only draws
 * what `healthdoc.ts` parsed. A reading that could not be taken is a sentence, never a zero.
 */
export function HealthView({ folder, doc, why, run, prompts, terminal, post }: {
  folder: string;
  doc: HealthDoc | null;
  why?: string;
  run: HealthRunState | null;
  prompts: PromptDef[];
  terminal: string | null;
  post: (m: ToExtension) => void;
}) {
  const [asking, setAsking] = useState(false);
  const now = useNow(!!run);
  // The region's ONE x-axis choice, kept across hides as the phone keeps it per device.
  const [axis, setAxisState] = useState<HealthAxisMode>(loadHealthAxis);
  const setAxis = (m: HealthAxisMode) => { saveHealthAxis(m); setAxisState(m); };

  const refresh = () => post({ t: "healthRefresh", folder });
  const stop = () => post({ t: "healthCancel", folder });

  const series = doc?.series ?? null;
  const repoName = folder.split(/[\\/]/).filter(Boolean).pop() ?? folder;
  const plot = doc?.plot ?? null;
  const measure = doc?.measure ?? null;
  // With no series, a failed run's line repeats the read error word for word; the read error says it once.
  const last = doc?.last && !outcomeRepeatsReadError(doc.last, doc.readError, !!series) ? doc.last : null;

  // `commits` is offered only where the index carries the per-commit series; a scope has no index,
  // and its tiles' commit mode needs none, so unknown (null) still offers it — as on the phone.
  const commits = doc?.index ? healthCommitsAvailability(doc.index) : null;
  const drawnAxis: HealthAxisMode = axis === "commits" && commits === "absent" ? "weeks" : axis;
  const drawn = useMemo(() => (plot ? foldPlot(plot, drawnAxis) : null), [plot, drawnAxis]);

  // The refresh verb lives at the end of the jump bar; while a run is out, what it is doing and a stop.
  const verb = run ? (
    <>
      <span className="rh-busy" role="status">
        <RefreshCw size={14} className="spin" aria-hidden /> {refreshBusyLabel(series, now - run.startedAt)}
      </span>
      <Button type="button" className="rh-nav-refresh" onClick={stop}><Square size={14} aria-hidden /> stop</Button>
    </>
  ) : (
    <RefreshKey busy={false} label={refreshLabel(series)} onClick={refresh} />
  );

  if (!doc) {
    return (
      <div className="rh-region">
        <div className="section-head rh-head"><span className="section section-hint rh-status rh-push">{seriesHeadWords()}</span></div>
        <HealthNav keys={[]} refresh={verb} />
        {run ? <div className="section section-hint" role="status">{runningWords(run, now)}</div> : null}
        <Absent>{why ?? "No repo-health reading has arrived for this folder yet."}</Absent>
      </div>
    );
  }

  const staleness = { behind: doc.behind, lastSha: series?.lastSha, lastDay: series?.lastDay, headSha: doc.head?.sha };
  const stale = stalenessWords(staleness);
  const status = seriesStatusWords({ ...staleness, rows: series?.rows, days: series?.days });
  // The folder's own series is the desktop app's: its re-cut command deletes THAT file, so it is
  // never quoted from here, and a refresh here would not touch it, so nothing "will refuse".
  // Our own copy's remedy is the forget button (offered below whenever this is said), never a
  // command: the engine's re-cut line names `rm` and a worker file nobody types.
  const engineV = measure?.engineVersion ?? series?.preregVersion;
  const mixed = doc.source === "repo"
    ? repoMixedWords(series?.versions, engineV)
    : ownMixedWords(series?.versions, engineV);
  const engineLine = engineLineWords({ kind: "bundled", version: measure?.engineVersion, packs: measure?.packs });
  const sizeWords = seriesSizeWords(series);
  const staleRows = staleRowsWords(series?.staleRows);
  const warnings = warningsWords(last?.warnings);
  const running = runningWords(run, now);

  // Plot absent: say why in the engine's words where the engine is the reason.
  const plotMissing = series
    ? repoHealthPlotUnavailableText(repoHealthPlotAvailability(doc), doc.plotError)
    : null;
  const p95 = plot?.series.find((s) => s.key === "size.p95")?.last ?? null;

  const canSplit = prompts.some((p) => p.id === "split-longest-file");
  const canExplain = prompts.some((p) => p.id === "explain-rising-metric");
  const rising = plot?.series.filter((s: RepoHealthPlotSeries) => s.reading?.slope === "rising").length ?? 0;

  // What the status line folds, as on the phone: the intro, both commits with the ages and the
  // definition, whose file this is and where a measure writes, and which engine read the tree.
  const details = (
    <>
      {status ? <p>{seriesHeadWords()}</p> : null}
      {stale ? (
        <p>
          {stale}
          {doc.head ? <> · {lastCommitWords(ago(doc.head.ts, now))}</> : null}
          {sizeWords ? <> · {sizeWords}</> : null}
        </p>
      ) : null}
      <p>{sourceWords({ ...doc, series })}</p>
      {measureWords(doc) ? <p>{measureWords(doc)}</p> : null}
      {engineLine ? <p>{engineLine}</p> : null}
    </>
  );

  // The cards drawn, in screen order — the jump bar names exactly these. The whole tree only has a score.
  const shown = shownSections({ index: !!doc.index && !doc.scope, drawn, plot, own: true });

  return (
    <div className="rh-region">
      <div className="section-head rh-head">
        <span className="section section-hint rh-status">{status ?? seriesHeadWords()}</span>
        <Explain of="this series">{details}</Explain>
      </div>

      {/* WHICH READING, above everything it changes — a chip loads a different series, and exactly
          one is always chosen, so no ×. Scopes are the desktop app's; the extension only reads them. */}
      {doc.scopes.length ? (
        <>
          <div className="fchips wrap rh-scope" role="group" aria-label="which part of the repo">
            <span className="ctx-stackpick-lab">reading of</span>
            {[null, ...doc.scopes].map((sc) => (
              <FilterChip key={sc ?? "all"} on={doc.scope === sc} clears={false}
                onClick={() => post({ t: "healthScope", folder, scope: sc })}>
                {sc ?? SCOPE_ALL_LABEL}
              </FilterChip>
            ))}
          </div>
          {doc.scope ? <div className="section section-hint">{scopeHeadWords(doc.scope)}</div> : null}
        </>
      ) : null}
      {why ? <Absent>{why}</Absent> : null}

      {!series && !plot && !why ? (
        <Absent>
          {doc.readError
            ? knownReadErrorWords(doc.readError) ?? readFailedWords(doc.readError)
            : emptySeriesWords(measure?.commits, doc.stepMs)}
        </Absent>
      ) : null}

      {doc.shallow ? (
        <div className="section section-hint">
          This checkout is shallow: the series starts at the shallow boundary, not at the first commit.
        </div>
      ) : null}

      {mixed ? <div className="section section-hint">{mixed}</div> : null}
      {staleRows ? <div className="section section-hint">{staleRows}</div> : null}
      {run ? <div className="section section-hint" role="status">{running}</div> : null}

      {last ? (
        <div className="section section-hint">
          {outcomeWords(last)}
          {last.at ? <> ({ago(last.at, now)})</> : null}
          {/* The engine's own paragraph, verbatim: it ends in the one command that re-cuts the history. */}
          {last.refused ? <pre className="update-log rh-refusal">{last.refused.text}</pre> : null}
          {warnings ? <div>{warnings}</div> : null}
        </div>
      ) : null}

      {doc.tailNote ? <div className="section section-hint">{doc.tailNote}</div> : null}

      {/* A refusal or a series that cannot be read offers this; it deletes only OUR copy of the series, never anything in the folder. */}
      {/* Not offered on a folder with no git, nor where git itself is blocked (Xcode's license): there
          is no series to forget, and only the folder or the machine answers that. */}
      {(last?.refused || (doc.source === "own" && ((doc.readError && !NOT_GIT.test(doc.readError) && !XCODE_LICENSE.test(doc.readError)) || mixed))) && !run ? (
        <div className="rh-forget">
          {asking ? (
            <>
              <div className="ctx-note">
                This deletes only the extension’s own copy of the series
                {doc.source === "own" ? <> ({doc.seriesFile})</> : " (in its storage, not the one read from this folder)"} and
                measures the whole history again under the current definition. Nothing in your folder is touched.
              </div>
              <div className="btn-row">
                <Button type="button" onClick={() => { setAsking(false); post({ t: "healthForget", folder }); }}>
                  <Trash2 size={14} aria-hidden /> Yes, forget it and measure again
                </Button>
                <Button type="button" onClick={() => setAsking(false)}>Keep it</Button>
              </div>
            </>
          ) : (
            <Button type="button" onClick={() => setAsking(true)}>
              <Trash2 size={14} aria-hidden /> Forget this series and measure again…
            </Button>
          )}
        </div>
      ) : null}

      {plotMissing ? <div className="section section-hint">{plotMissing}</div> : null}

      {/* The jump bar sticks to the top of the view while the cards scroll; the refresh verb is in it. */}
      <HealthNav keys={navKeysOf(shown)} refresh={verb} />

      {shown.score || drawn ? <AxisRow axis={drawnAxis} onAxis={setAxis} commits={commits} /> : null}

      {/* The one number that takes a side — score, cap, alerts and the spend line, drawn by the phone's own chart. */}
      {shown.score && doc.index ? (
        <HealthIndexChart view={doc.index} axis={drawnAxis}
          empty={doc.index.series ? null : <Absent>No health index yet: {doc.index.reason}.</Absent>} />
      ) : null}

      {drawn && plot ? (
        <>
          {/* WHOSE readings these are, once, as a heading (as on the phone): everything down to
              the repo's own card is the engine's; the repo's say over them is on their tiles. */}
          <div className="section rh-prov">{centralHeadWords(BRAND.displayName)}</div>
          {centralFileLines(plot.central).map((l) => <div key={l} className="rh-cap rh-gutter">{l}</div>)}
          {notRunWords(plot) ? <div className="rh-cap rh-gutter">{notRunWords(plot)}</div> : null}

          {shown.longest ? (
            <SectionCard id="longest">
              {(w) => (
                <LongestFiles longest={drawn.longest} classics={drawn.classics} p95={p95} width={w}
                  onOpenFile={(p) => post({ t: "openFile", folder, path: plot.scope ? `${plot.scope.replace(/\/+$/, "")}/${p}` : p })} />
              )}
            </SectionCard>
          ) : null}

          <TilesCard series={drawn.series} windowReadings={plot.windowReadings} minReadings={plot.minReadings} axis={drawnAxis}
            actionsFor={(s) => (s.key === "size.p95" && canSplit ? (
              <div className="rh-ask">
                <div className="rh-cap">Ask Claude Code how to split the file that grew most, quoting its row.</div>
                <PromptActions id="split-longest-file" terminal={terminal} post={post} />
              </div>
            ) : null)}
            after={canExplain ? (
              rising > 0 ? (
                <div className="rh-ask">
                  <div className="rh-cap">
                    {rising === 1 ? "One metric is rising." : `${rising} metrics are rising.`} Ask Claude Code why, for the one that ranks highest. It proposes; it changes no file.
                  </div>
                  <PromptActions id="explain-rising-metric" terminal={terminal} post={post} />
                </div>
              ) : (
                <div className="rh-cap">No metric in this folder’s series is rising right now, so there is nothing to ask about.</div>
              )
            ) : null} />

          <WeightCard
            claudeMd={drawn.series.find((s) => s.key === CLAUDE_MD_KEY) ?? null}
            descriptions={drawn.series.find((s) => s.key === DESC_KEY) ?? null}
            context={plot.context} />

          <SectionCard id="size">{(w) => <Magnitudes classics={drawn.classics} width={w} />}</SectionCard>

          {/* Last: the same figures the charts drew, as text, for whoever wants to check one. */}
          {shown.table ? (
            <SectionCard id="table">
              {() => (
                <>
                  <ReadingsTable plot={plot} />
                  <details className="hint-more rh-more">
                    <summary>not drawn here</summary>
                    <p>{notPlottedWords()}</p>
                  </details>
                </>
              )}
            </SectionCard>
          ) : null}

          {/* The repo's OWN readings, apart from everything above and from the index. */}
          <OwnReadings plot={plot} repoName={repoName} series={drawn.own?.series} axis={drawnAxis} />
          {ownShow(plot).kind === "add" ? <div className="rh-cap rh-gutter">{ownAddNoteWords()}</div> : null}
        </>
      ) : null}
    </div>
  );
}
