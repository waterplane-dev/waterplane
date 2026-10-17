import { useEffect, useState } from "react";
import { RefreshCw, Square, Trash2 } from "lucide-react";
import { BRAND, repoHealthPlotAvailability, repoHealthPlotUnavailableText } from "@waterplane/shared";
import type { RepoHealthPlotSeries } from "@waterplane/shared";
import { useBoxWidth } from "@waterplane/kit";
import type { HealthDoc, HealthRunState, PromptDef, ToExtension } from "../src/protocol";
import { AreaSpread, SeriesTile, WeightStack } from "../../web/src/RepoHealthTiles";
import { LongestFiles } from "../../web/src/RepoHealthLongest";
import { Magnitudes } from "../../web/src/RepoHealthMags";
import { ReadingsTable } from "../../web/src/RepoHealthTable";
import { OwnReadings } from "../../web/src/RepoHealthOwn";
import { HealthIndexChart } from "../../web/src/HealthIndexChart";
import { HintChip } from "./shims/HintChip";
import { CLAUDE_MD_KEY, DESC_KEY } from "../../web/src/repoHealthPlot";
import {
  centralFileLines, centralHeadWords, emptySeriesWords, engineLineWords, lastCommitWords, notPlottedWords, outcomeWords, ownShow,
  plotAxisWords, rankBasisWords, readFailedWords, refreshBusyLabel, refreshLabel, runningWords,
  seriesHeadWords, seriesSizeWords, staleRowsWords, stalenessWords, warningsWords,
} from "../../web/src/repoHealthWords";
import { SCOPE_ALL_LABEL, scopeHeadWords } from "../../web/src/repoHealthWords/repoHealthWordsScope";
import { measureWords, notRunWords, ownAddNoteWords, ownMixedWords, repoMixedWords, sourceWords } from "../src/health/sourcewords";
import { Absent } from "./Absent";
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
 * The repo's shape over time, in the order the phone draws it (`RepoHealthRegion.tsx`) minus narrative
 * and the drawn page. The series is the extension's own copy, read by the bundled engine from git
 * history, or the one the waterplane desktop app left in the folder (read-only, with its scopes);
 * this view only draws what `healthdoc.ts` parsed. A reading that could not be
 * taken is a sentence, never a zero.
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
  const [width, boxRef] = useBoxWidth();
  const [asking, setAsking] = useState(false);
  const now = useNow(!!run);

  const refresh = () => post({ t: "healthRefresh", folder });
  const stop = () => post({ t: "healthCancel", folder });

  const series = doc?.series ?? null;
  const repoName = folder.split(/[\\/]/).filter(Boolean).pop() ?? folder;
  const plot = doc?.plot ?? null;
  const measure = doc?.measure ?? null;
  const last = doc?.last ?? null;

  // The head: one refresh control, or — while a run is out — what it is doing and a stop.
  const head = (
    <div className="section-head">
      <span className="section section-hint">{seriesHeadWords()}</span>
      <span className="btn-row">
        {run ? (
          <>
            <span className="rh-busy" role="status">
              <RefreshCw size={14} className="spin" aria-hidden /> {refreshBusyLabel(series, now - run.startedAt)}
            </span>
            <button type="button" className="key" onClick={stop}><Square size={14} aria-hidden /> stop</button>
          </>
        ) : (
          <button type="button" className="key" onClick={refresh}>
            <RefreshCw size={14} aria-hidden /> {refreshLabel(series)}
          </button>
        )}
      </span>
    </div>
  );

  if (!doc) {
    return (
      <>
        {head}
        {run ? <div className="section section-hint" role="status">{runningWords(run, now)}</div> : null}
        <Absent>{why ?? "No repo-health reading has arrived for this folder yet."}</Absent>
      </>
    );
  }

  const stale = stalenessWords({
    behind: doc.behind, lastSha: series?.lastSha, lastDay: series?.lastDay, headSha: doc.head?.sha,
  });
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
  const axisPoints = plot?.series[0]?.points ?? [];
  const firstDay = axisPoints[0]?.day ?? null;
  const lastDay = axisPoints[axisPoints.length - 1]?.day ?? null;
  const p95 = plot?.series.find((s) => s.key === "size.p95")?.last ?? null;

  const canSplit = prompts.some((p) => p.id === "split-longest-file");
  const canExplain = prompts.some((p) => p.id === "explain-rising-metric");
  const rising = plot?.series.filter((s: RepoHealthPlotSeries) => s.reading?.slope === "rising").length ?? 0;

  return (
    <>
      {head}
      <div className="section section-hint">{sourceWords({ ...doc, series })}</div>
      {measureWords(doc) ? <div className="section section-hint">{measureWords(doc)}</div> : null}
      {doc.scopes.length ? (
        <>
          <div className="btn-row" role="group" aria-label="which part of the repo">
            <span className="ctx-stackpick-lab">reading of</span>
            {[null, ...doc.scopes].map((sc) => (
              <button key={sc ?? "all"} type="button" className={doc.scope === sc ? "key active" : "key"} aria-pressed={doc.scope === sc}
                onClick={() => post({ t: "healthScope", folder, scope: sc })}>
                {sc ?? SCOPE_ALL_LABEL}
              </button>
            ))}
          </div>
          {doc.scope ? <div className="section section-hint">{scopeHeadWords(doc.scope)}</div> : null}
        </>
      ) : null}
      {engineLine ? <div className="section section-hint">{engineLine}</div> : null}
      {why ? <Absent>{why}</Absent> : null}

      {!series && !plot && !why ? (
        <Absent>
          {doc.readError
            ? readFailedWords(doc.readError)
            : emptySeriesWords(measure?.commits, doc.stepMs)}
        </Absent>
      ) : null}

      {doc.shallow ? (
        <div className="section section-hint">
          This checkout is shallow: the series starts at the shallow boundary, not at the first commit.
        </div>
      ) : null}

      {mixed ? <div className="section section-hint">{mixed}</div> : null}

      {stale ? (
        <div className="section section-hint">
          {stale}
          {doc.head ? <> · {lastCommitWords(ago(doc.head.ts, now))}</> : null}
          {sizeWords ? <> · {sizeWords}</> : null}
        </div>
      ) : null}
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
      {(last?.refused || (doc.source === "own" && (doc.readError || mixed))) && !run ? (
        <div className="rh-forget">
          {asking ? (
            <>
              <div className="ctx-note">
                This deletes only the extension’s own copy of the series
                {doc.source === "own" ? <> ({doc.seriesFile})</> : " (in its storage, not the one read from this folder)"} and
                measures the whole history again under the current definition. Nothing in your folder is touched.
              </div>
              <div className="btn-row">
                <button type="button" className="key" onClick={() => { setAsking(false); post({ t: "healthForget", folder }); }}>
                  <Trash2 size={14} aria-hidden /> Yes, forget it and measure again
                </button>
                <button type="button" className="key" onClick={() => setAsking(false)}>Keep it</button>
              </div>
            </>
          ) : (
            <button type="button" className="key" onClick={() => setAsking(true)}>
              <Trash2 size={14} aria-hidden /> Forget this series and measure again…
            </button>
          )}
        </div>
      ) : null}

      {plotMissing ? <div className="section section-hint">{plotMissing}</div> : null}

      {/* The one number that takes a side — score, cap and alerts are drawn by the phone's own chart. */}
      {doc.index ? (
        <HealthIndexChart view={doc.index} empty={doc.index.series ? null : <Absent>No health index yet: {doc.index.reason}.</Absent>} />
      ) : null}

      <div className="rh-box" ref={boxRef}>
        {plot && width > 0 ? (
          <>
            {/* WHOSE readings these are, once, as a heading (as on the phone): everything down to
                the repo's own block is the engine's; the repo's say over them is on their tiles. */}
            <div className="section rh-prov">{centralHeadWords(BRAND.displayName)}</div>
            {centralFileLines(plot.central).map((l) => <div key={l} className="rh-cap">{l}</div>)}
            {notRunWords(plot) ? <div className="rh-cap">{notRunWords(plot)}</div> : null}

            <LongestFiles longest={plot.longest} classics={plot.classics} p95={p95} width={width}
              onOpenFile={(p) => post({ t: "openFile", folder, path: plot.scope ? `${plot.scope.replace(/\/+$/, "")}/${p}` : p })} />

            <ul className="rh-tiles">
              {plot.series.map((s) => (
                <SeriesTile key={s.key} s={s} width={width}
                  actions={s.key === "size.p95" && canSplit ? (
                    <div className="rh-ask">
                      <div className="rh-cap">Ask Claude Code how to split the file that grew most, quoting its row.</div>
                      <PromptActions id="split-longest-file" terminal={terminal} post={post} />
                    </div>
                  ) : null} />
              ))}
            </ul>
            <div className="rh-cap">{plotAxisWords(plot.days, firstDay, lastDay)}</div>
            <div className="rh-cap">
              {rankBasisWords(plot.windowReadings, plot.minReadings)}{" "}
              <HintChip id="repohealth.reading" of="the percentile and the arrow" />
            </div>

            {canExplain ? (
              rising > 0 ? (
                <div className="rh-ask">
                  <div className="rh-cap">
                    {rising === 1 ? "One metric is rising." : `${rising} metrics are rising.`} Ask Claude Code why, for the one that ranks highest. It proposes; it changes no file.
                  </div>
                  <PromptActions id="explain-rising-metric" terminal={terminal} post={post} />
                </div>
              ) : (
                <Absent>No metric in this folder’s series is rising right now, so there is nothing to ask about.</Absent>
              )
            ) : null}

            <WeightStack
              claudeMd={plot.series.find((s) => s.key === CLAUDE_MD_KEY) ?? null}
              descriptions={plot.series.find((s) => s.key === DESC_KEY) ?? null}
              width={width}
            />

            {plot.context.absent ? (
              <div className="rh-cap">The per-area reading was not taken on the latest day — {plot.context.absent}</div>
            ) : Object.keys(plot.context.areas).length === 0 ? (
              <div className="rh-cap">
                No per-area reading here{plot.context.areasAbsent ? <> — {plot.context.areasAbsent}</> : null}.
                The always-on weight above is the whole tree’s and is unaffected.
              </div>
            ) : (
              <AreaSpread areas={plot.context.areas} width={width} />
            )}

            <Magnitudes classics={plot.classics} width={width} />
            <ReadingsTable plot={plot} />
            <div className="rh-cap">{notPlottedWords()}</div>

            {/* The repo's OWN readings, apart from everything above and from the index. */}
            <OwnReadings plot={plot} repoName={repoName} width={width} />
            {ownShow(plot).kind === "add" ? <div className="rh-cap">{ownAddNoteWords()}</div> : null}
          </>
        ) : null}
      </div>
      {plot && width === 0 ? <Absent>This view has no width to draw the charts in yet.</Absent> : null}
    </>
  );
}

