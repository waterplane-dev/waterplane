import { Fragment, useEffect, useRef, useState } from "react";
import {
  CloudOff, Download, Eye, FileText, Loader, Pencil, Play, Plus, ScanEye, ShieldCheck, Square, Trash2, X,
} from "lucide-react";
import type {
  BuildArtifact, CaptureBackendId, CaptureBackendInfo, CaptureRun, CaptureRunStatus, CaptureTarget,
  CaptureThemePref, CaptureVerification, CaptureViewport, RepoTarget,
} from "@waterplane/shared";
import { CAPTURE_BACKEND_IDS, DEFAULT_CAPTURE_VIEWPORT, branchLabel } from "@waterplane/shared";
import { DownloadButton } from "./DownloadButton";
import { Unavailable } from "./Unavailable";
import { track } from "./usage";
import { ago, durSpan, fmtSize, seqId, stripAnsi, when } from "./format";
import { SheetHead } from "./Sheet";
import { RadioRows } from "./kit";
import { useBackStep } from "./backStep";
import { Empty } from "./Empty";

interface Props {
  repo: RepoTarget;
  targets: CaptureTarget[];
  runs: CaptureRun[];                     // this repo's runs, newest first
  /**
   * What this DESKTOP can actually drive, as sentences.
   *
   * Rides on the `capture.list` reply rather than being probed on its own, so
   * the row has the reason in hand at the moment it draws. An EMPTY array is not
   * "nothing works" — it is "nobody has said", which is every offline open and
   * every older host, and the difference decides whether a run control is drawn
   * at all (see `backendOf`).
   */
  backends: CaptureBackendInfo[];
  output: ReadonlyMap<string, string>;    // runId → retained output
  outTick: number;                        // bumps when `output` mutates (force re-render)
  onSave: (next: CaptureTarget[]) => void;
  /**
   * Take a capture. App routes it through the durable send queue, so a tap on a
   * dead tunnel is kept and run on reconnect (and never run twice).
   *
   * `watch` is the SAME op with one flag set — the second verb rides the one
   * durable route rather than getting a send path of its own. A watch run keeps
   * capturing until it is stopped, keeping a frame only when the screen has
   * moved past the target's threshold.
   */
  onRun: (targetId: string, watch?: boolean) => void;
  /** false = no socket. The run is still accepted (it queues); the hint says so. */
  online?: boolean;
  /**
   * When the host last confirmed `targets` (0 = never on this device).
   *
   * The list is cached per repo, because this sheet is opened to find out what a
   * screen looks like when you are NOT at the desk — the same moment the link is
   * worst. A cached list that cannot say how old it is reads as current, and a
   * target deleted at the desk last week looks exactly like a live one.
   */
  listAt?: number;
  onCancel: (runId: string) => void;
  onDownload: (a: BuildArtifact) => void;
  onClose: () => void;
}

/**
 * **The runs cut, and the counts on the chips that open it — one function.**
 *
 * A number on a control is a promise about what a tap shows. Deriving "3 failed"
 * from one pass and the filtered list from another is how a badge starts lying:
 * the two edges drift by one commit and the chip then opens a list that does not
 * match it. So the count IS `captureCut(runs, s).length`, and the cut IS
 * `captureCut(runs, s)`. Exported for the test that pins exactly that.
 */
export type CaptureCut = "all" | CaptureRunStatus;
export function captureCut(runs: readonly CaptureRun[], cut: CaptureCut): CaptureRun[] {
  return cut === "all" ? [...runs] : runs.filter((r) => r.status === cut);
}

/** How many rows the UNFILTERED list draws before it says it is holding back. */
export const CAPTURE_RUNS_CAP = 8;

/**
 * The rows actually drawn — and the only place the cap lives.
 *
 * The cap and the cut are not the same kind of thing, and conflating them is
 * what made the chips liars: a chip saying "12 failed" that opened a list of 8
 * had promised twelve and shown eight, with nothing on screen admitting it. So
 * **a cut is never capped** — a tap on a count opens exactly that count — and
 * the unfiltered list, which promises nothing in particular, keeps its phone-
 * sized preview and SAYS what it is holding back (`capturedHidden`).
 */
export function captureRows(runs: readonly CaptureRun[], cut: CaptureCut): CaptureRun[] {
  const rows = captureCut(runs, cut);
  return cut === "all" ? rows.slice(0, CAPTURE_RUNS_CAP) : rows;
}

/** How many runs the unfiltered list is not drawing (0 when it draws them all).
 *  Same two functions the list itself uses, so the sentence cannot overstate. */
export function captureHidden(runs: readonly CaptureRun[], cut: CaptureCut): number {
  return captureCut(runs, cut).length - captureRows(runs, cut).length;
}

/**
 * Is this run a WATCH run — one that keeps capturing until it is stopped?
 *
 * Read defensively off the run, because it is a fact only the host can state
 * and an older host does not state it at all. Absence degrades to "just
 * running", never to a claim in either direction: a long-lived watch shown as
 * an ordinary run is a missing label, while an ordinary run labelled
 * "watching" would tell somebody to go and press Stop on something that is
 * about to stop itself.
 */
function watching(r: CaptureRun | undefined | null): boolean {
  return !!r && r.status === "running" && (r as CaptureRun & { watch?: boolean }).watch === true;
}

/** Which statuses get a counting chip — one list, so "is there a chip for this"
 *  and "draw the chips" are the same question asked once. */
const CHIP_CUTS = ["failed", "running", "done"] as const;

/** The words for one cut, in the two places it is named. Both come off the same
 *  row so the chip and the bar it opens can never describe different sets. */
const CUT_LABEL: Record<CaptureRunStatus, { chip: string; bar: string }> = {
  running: { chip: "still running", bar: "still running" },
  done: { chip: "finished", bar: "that finished" },
  failed: { chip: "failed", bar: "that failed" },
  cancelled: { chip: "cancelled", bar: "that were cancelled" },
};

/**
 * How much a frame can be trusted, as a chip.
 *
 * This maps the `CaptureVerification` ENUM, which is a field of its own on the
 * run. It does NOT parse `verdict` — that string is the host's, written by one
 * function there, and the moment the phone starts splitting it on its separator
 * there are two gramars for one rule and they will disagree. The words below are
 * the ones `wire/capture.ts` documents each level as printing.
 */
const LEVEL: Record<CaptureVerification, { word: string; tag: string; title: string }> = {
  anchor: {
    word: "verified", tag: "idle",
    title: "an oracle was asked and the expected text was on the screen",
  },
  stable: {
    word: "settled", tag: "coding",
    title: "consecutive frames agreed, so nothing was mid-load or mid-animation — a claim about the screen having stopped, not about it being right",
  },
  unverified: {
    word: "unverified", tag: "dead",
    title: "one frame, nothing to compare it against, nobody asked",
  },
};

/**
 * Verified capture for one repo: the named screens this project can be asked to
 * photograph, what came back, and how much each picture can be trusted.
 *
 * `BuildSheet.tsx`'s shape, deliberately and prop-for-prop — a capture IS a
 * build with a picture at the end of it. Targets are buttons, a run is an intent
 * the desktop owns, output streams, and the frames come back as the same
 * `BuildArtifact` records the one download button already understands.
 *
 * The half that is NOT a build is the claim. Every reading here can be ABSENT,
 * and absent is rendered as words: a run with no `score` says `n/a` rather than
 * `0`, a run with no `verification` shows no chip rather than "unverified", and
 * a backend this desktop cannot drive is a SENTENCE rather than a dimmed button.
 */
export function CaptureSheet({ repo, targets, runs, backends, output, outTick, onSave, onRun, onCancel, onDownload, onClose, online = true, listAt = 0 }: Props) {
  const [editing, setEditing] = useState<CaptureTarget | null>(null);
  const [cut, setCut] = useState<CaptureCut>("all");
  const shownRuns = captureCut(runs, cut);
  // What is DRAWN, and what that leaves out — both off the functions above, so
  // the list, the chips and the sentence under them cannot describe three
  // different sets of runs.
  const runRows = captureRows(runs, cut);
  const hiddenRuns = captureHidden(runs, cut);
  // Which run's output to show; defaults to the newest run IN THE CUT, so the
  // detail pane can never belong to a row the filter is hiding. It follows the
  // CUT and not `runRows`, deliberately: the cap is a drawing preview, not a
  // claim about which runs exist, and a pane you opened should not close itself
  // because a newer run pushed its row past the eighth.
  const [sel, setSel] = useState<string | null>(null);
  const selRun = shownRuns.find((r) => r.runId === sel) ?? shownRuns[0] ?? null;
  const logRef = useRef<HTMLPreElement>(null);

  // Follow the tail of the live log.
  useEffect(() => {
    const el = logRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [outTick, selRun?.runId]);

  /**
   * What this desktop said about one backend — and `undefined` when it said
   * nothing at all.
   *
   * Three states, not two. `available: false` carries a sentence and the run
   * verb becomes that sentence. NOTHING KNOWN is the offline case and the
   * old-host case, and there the verb is drawn: refusing to offer a run because
   * nobody has told us whether it would work is a guess dressed as a fact, and
   * the host refuses in words of its own if it cannot do it.
   */
  function backendOf(id: CaptureBackendId): CaptureBackendInfo | undefined {
    return backends.find((b) => b.id === id);
  }

  function remove(id: string) { onSave(targets.filter((t) => t.id !== id)); }
  function upsert(t: CaptureTarget) {
    const name = t.name.trim();
    if (!name) { setEditing(null); return; }
    const clean: CaptureTarget = { ...t, name, dir: t.dir?.trim() || undefined };
    onSave(targets.some((x) => x.id === t.id) ? targets.map((x) => (x.id === t.id ? clean : x)) : [...targets, clean]);
    setEditing(null);
  }

  // Back — the gesture as much as the arrow — closes this step, not the sheet.
  useBackStep(editing !== null, () => setEditing(null));
  if (editing) {
    return <CaptureEditor draft={editing} backends={backends}
      onCancel={() => setEditing(null)} onSave={upsert} />;
  }

  return (
    <div className="sheet">
      <SheetHead title={<><ScanEye size={16} /> Capture · {repo.repoName}</>} onClose={onClose}>
        {branchLabel(repo) && <span className="row-sub head-branch">{branchLabel(repo)}</span>}
        {/* Writing the list is `capture.save`, a live-only frame: it edits a file
            on the desktop and there is no honest way to hold one. Offline the
            control is ABSENT and the sentence below says why — a dimmed “new”
            with the explanation in a `title` is invisible on the device this app
            is for. */}
        {online && (
          <button className="key" title="add a capture target"
            onClick={() => setEditing({ id: seqId("t"), name: "", backend: "web" })}><Plus size={16} /> new</button>
        )}
      </SheetHead>
      <div className="form-hint">
        Photograph a running screen and say how much the picture can be trusted — no session, no tokens. The frames and an evidence sidecar land in <span className="mono">.claude/outbox/</span>, so the gallery lists them and an agent can read the verdict instead of the image.
        {!online && " No connection right now: a tap is queued and the capture runs once the link is back."}
      </div>
      {/* Two verbs, named in words rather than left to two icons. They are
          different lengths of work — one is over in seconds, the other holds a
          browser or a simulator open for up to ten minutes — and a phone user
          has to know which one a tap starts BEFORE tapping it, not from a
          `title` no touch screen ever shows. */}
      <div className="form-hint">
        <Play size={12} style={{ verticalAlign: "-1px" }} /> takes one frame now.{" "}
        <Eye size={12} style={{ verticalAlign: "-2px" }} /> <strong>watch</strong> keeps the screen open and keeps a frame each time it changes past the target’s threshold — until you stop it, or it hits its own ceiling. That is what makes this a loop rather than a snapshot: leave it watching while you change the code and the outbox fills with the moments that actually moved.
      </div>
      {/* Offline the rows below came off this device, not the host. Say so, and
          say when — the targets are cached, the RUN is what needed the link. */}
      {!online && (
        <>
          <div className="form-hint">
            <CloudOff size={13} style={{ verticalAlign: "-2px" }} />{" "}
            {targets.length === 0
              ? "this device has no copy of this repo's targets"
              : listAt
                ? `these targets are this device's copy, last confirmed ${ago(listAt)} ago`
                : "these targets are this device's copy"}
            {" — running one does not need the link."}
          </div>
          <Unavailable cants={[{
            label: "adding, editing or deleting a target",
            reason: "capture targets live in a file on the desktop and there is no honest way to hold an edit — the change would be composed now against a file that has moved on",
          }]} />
        </>
      )}

      {/* ONE scroll region for everything under the hint — `BuildSheet`'s
          `.build-body`, and for its reason: a capture log is unbounded, and as a
          sibling of the two lists its own height became their flex basis and
          squeezed every control for starting another capture off the screen. */}
      <div className="build-body">
        <div className="list build-cmds">
          {targets.map((t) => {
            const running = runs.find((r) => r.targetId === t.id && r.status === "running");
            const isWatch = watching(running);
            const be = backendOf(t.backend);
            const blocked = be && !be.available;
            const reason = be?.reason;
            const body = (
              <>
                {/* A watch run is long-lived ON PURPOSE, and the one thing the
                    row must not do is let it read as a capture that has hung.
                    The spinner alone says "still going"; the chip says which
                    kind of still-going this is, and therefore whether Stop is
                    the thing you are waiting to press. */}
                <span className="row-title">{t.name}{running ? <> <Loader size={12} className="spin" /></> : null}
                  {isWatch ? <> <span className="tag coding"><Eye size={11} /> watching</span></> : null}</span>
                <span className="row-sub mono">{t.backend}{t.dir ? ` · ${t.dir}` : ""}{targetDetail(t) ? ` · ${targetDetail(t)}` : ""}</span>
              </>
            );
            return (
              <Fragment key={t.id}>
                <div className="row-wrap">
                  {/* A target this desktop cannot drive is not a control at all —
                      not a dimmed one, and not a live one that refuses on tap. A
                      thing that looks pressable and does nothing is the failure
                      `Unavailable.tsx` exists for, so the row goes flat and the
                      sentence underneath carries the whole answer. */}
                  {blocked
                    ? <div className="row grow" title={t.id}>{body}</div>
                    : <button className="row grow" title={t.id}
                      onClick={() => {
                        if (running) { setCut("all"); setSel(running.runId); return; }
                        track("action:capture.run"); onRun(t.id);
                      }}>{body}</button>}
                  {running
                    // Stop reaches a watching run through exactly the same live
                    // (never queued) cancel: a watch is the one run that is
                    // still there to be called off, and the one a cancel
                    // delivered an hour late would call off long after the
                    // person had walked away from the screen it was watching.
                    ? <button className="key danger" title={isWatch ? "stop watching — the frames kept so far stay" : "stop this capture"}
                      onClick={() => onCancel(running.runId)}><Square size={16} /></button>
                    : blocked
                      // No control at all — the sentence below IS the answer.
                      ? null
                      : (
                        <>
                          <button className="key" title="take one frame now" onClick={() => { track("action:capture.run"); onRun(t.id); }}><Play size={16} /></button>
                          {/* A SECOND verb, never a mode switch on the first
                              one: whichever way a toggle was left, the primary
                              button would then start whichever length of work
                              you last picked, and a phone gives you nothing to
                              check that against before your thumb lands. */}
                          <button className="key" title="watch this screen — keep capturing until stopped" onClick={() => { track("action:capture.watch"); onRun(t.id, true); }}><Eye size={16} /></button>
                        </>
                      )}
                  {/* Absent, not dimmed, with the link down — the sheet says once,
                      above, why every one of these is gone, rather than N rows
                      each carrying an invisible `title`. */}
                  {online && <button className="key" title="edit" onClick={() => setEditing(t)}><Pencil size={16} /></button>}
                  {online && <button className="key danger" title="delete" onClick={() => remove(t.id)}><Trash2 size={16} /></button>}
                </div>
                {/* Outside the row, deliberately: `.act-cants` is a block, and a
                    block inside a `<button>` is markup a phone browser is free to
                    lay out however it likes. "web needs Playwright — npm i -D
                    playwright in this repo" is something a person can act on; a
                    greyed Play with that in a `title` is not. */}
                {blocked && (
                  <Unavailable cants={[{
                    label: `“${t.name}”`,
                    reason: reason ?? `this desktop cannot drive the ${t.backend} backend, and did not say why`,
                  }]} />
                )}
              </Fragment>
            );
          })}
          {/* Two different nothings, `BuildSheet`'s distinction. With the link up
              the host has told us this repo has no targets, which is a fact.
              Offline it means this device has never seen this repo's list — the
              repo may well have sixteen. An empty list is a CLAIM, and printing
              the first sentence for the second case makes it a false one. */}
          {targets.length === 0 && (online ? (
            <Empty>
              No capture targets yet. Tap “new” — e.g. name “droplet · home”, backend <span className="mono">web</span>, url <span className="mono">http://localhost:5173/</span>, and an anchor word you expect to be on that screen. The anchor is what lets a capture claim it was <em>verified</em> rather than merely taken.
            </Empty>
          ) : (
            <Empty>
              No connection, and this device has no copy of this repo’s capture targets — it has not had them since it was last on the link. This says nothing about whether the repo has any. Open this sheet once with the link up and they are cached here from then on.
            </Empty>
          ))}
        </div>

        {runs.length > 0 && (
          <>
            <div className="section">
              Runs
              {/* A count on a control is a filter. Each chip's number is
                  `captureCut(runs, s).length` and a tap shows exactly
                  `captureCut(runs, s)` — one function, so the badge cannot
                  promise a list it does not open. */}
              {CHIP_CUTS.map((s) => {
                const n = captureCut(runs, s).length;
                if (!n) return null;
                return (
                  <button key={s} className={`tag tag-filter ${cut === s ? "on" : ""} ${s === "failed" ? "dead" : s === "running" ? "coding" : "idle"}`}
                    title={`show only the ${n} ${CUT_LABEL[s].chip}`}
                    onClick={() => { track("action:capture.filter"); setCut(cut === s ? "all" : s); setSel(null); }}>
                    {n} {CUT_LABEL[s].chip}
                  </button>
                );
              })}
            </div>
            {cut !== "all" && (
              // Same bar, same words, same clear button as the launcher's, the
              // backlog's and the schedule sheet's: what is hidden, counted
              // against the UNFILTERED list, and the one way out.
              <div className="section filter-bar">
                <span className="filter-bar-txt">
                  Only the runs {CUT_LABEL[cut].bar} · {shownRuns.length} of {runs.length}
                  {shownRuns.length === 0 && " — nothing here is in that cut"}
                </span>
                <button className="filter-bar-clear" title="clear the filter — show every run for this repo again"
                  onClick={() => { track("action:capture.filter.clear"); setCut("all"); setSel(null); }}><X size={13} /> clear</button>
              </div>
            )}
            <div className="list build-runs">
              {runRows.map((r) => {
                const lvl = r.verification ? LEVEL[r.verification] : null;
                return (
                  <button key={r.runId} className={`row ${selRun?.runId === r.runId ? "active" : ""}`} onClick={() => setSel(r.runId)}>
                    <span className="row-title">
                      {r.status === "running" ? <Loader size={12} className="spin" /> : null} {r.name}
                      {" "}<span className={`tag ${r.status === "done" ? "idle" : r.status === "running" ? "coding" : "dead"}`}>{r.status}{r.exitCode ? ` ${r.exitCode}` : ""}</span>
                      {/* Told apart from a stuck run, which is the only reason
                          this chip exists: both spin for minutes and only one
                          of them is waiting for you to stop it. */}
                      {watching(r) ? <> <span className="tag coding"><Eye size={11} /> watching</span></> : null}
                      {/* No chip at all while there is nothing to claim. A run
                          still going, or one that died before it took a frame,
                          has no level — and painting "unverified" there would
                          turn "not yet" into a judgement. */}
                      {lvl ? <> <span className={`tag ${lvl.tag}`} title={lvl.title}><ShieldCheck size={11} /> {lvl.word}</span></> : null}
                    </span>
                    {/* The verdict, WHOLE and verbatim. The host writes it with
                        one function so the row, the sheet and the agent's HTTP
                        answer cannot word it three ways; the phone's job is to
                        print it, never to re-derive it or cut it at its
                        separator. */}
                    {r.verdict ? <span className="row-sub">{r.verdict}</span> : null}
                    {/* The backend, and NOTHING where there isn't one.
                        `CaptureRun.backend` is what the run was actually taken
                        with, and a row whose payload and sidecar both went
                        missing cannot say — it used to say "window", which is
                        not a shrug, it is "a photograph of the whole desktop",
                        printed over a row whose config said `garmin`. So the
                        absence is the absence: a neutral phrase, never a
                        guessed id and never a dimmed one. */}
                    <span className="row-sub">{when(r.finishedAt ?? r.startedAt)} · {durSpan(r.startedAt, r.finishedAt)} · {r.backend ?? "backend not recorded"}{r.files?.length ? ` · ${r.files.length} file${r.files.length > 1 ? "s" : ""}` : ""}</span>
                  </button>
                );
              })}
            </div>
            {/* The unfiltered list keeps a phone-sized preview, and says so.
                A cut is never cut again — a chip that counted twelve opens
                twelve — so this sentence can only ever appear here, and it
                names the chips as the way to see all of one kind rather than
                leaving the reader to wonder where the other rows went. */}
            {hiddenRuns > 0 && (
              <div className="form-hint">
                Showing the newest {runRows.length} of {runs.length} runs for this repo.
                {/* Only mention the chips when there ARE chips: a repo whose
                    older runs were all cancelled draws none, and pointing at a
                    control that is not on the screen is its own small lie. */}
                {CHIP_CUTS.some((s) => captureCut(runs, s).length > 0)
                  && ` The counts above are over all ${runs.length}; tap one to open exactly those.`}
              </div>
            )}
          </>
        )}

        {selRun && (
          <div className="build-run">
            <div className="form-hint">
              {/* ABSENT is rendered as absent. A finished run with no `score`
                  means no scorer exists on this machine — nobody looked — and
                  `0` there would read as "this screenshot is terrible", which is
                  the opposite of what is known. While it is still running there
                  is no reading yet, so the line says nothing at all. */}
              {/* A watch run has no ENDING to wait for, so "still going" is the
                  wrong shape of sentence for it: it is going for as long as you
                  leave it, and the reading it will eventually carry is about
                  the last frame, not about a batch that is nearly ready. */}
              {selRun.status === "running"
                ? watching(selRun)
                  ? `watching — a frame is kept each time the screen changes${selRun.files?.length ? `, ${selRun.files.length} so far` : ""}. Stop it from the target above; the frames already written stay.`
                  : "still going — no reading yet"
                : <>score {typeof selRun.score === "number"
                  ? selRun.score
                  // `typeof`, not `!== undefined`: a `null` off the wire is the
                  // same fact (nothing was measured) and must not print as the
                  // word "null" on a phone.
                  : <span title="no scorer on this desktop, so nobody looked — this is not a low score">n/a</span>}</>}
              {/* The evidence file, by its FULL transport path — that path is
                  what a report quotes and what the artifact endpoint takes. */}
              {selRun.sidecarRelPath ? <> · <FileText size={12} style={{ verticalAlign: "-2px" }} /> <span className="mono">{selRun.sidecarRelPath}</span></> : null}
            </div>
            {selRun.files && selRun.files.length > 0 && (
              <div className="list">
                {selRun.files.map((a) => (
                  <FrameRow key={a.relPath} a={a} repoDir={repo.worktreePath} repoName={repo.repoName} onDownload={onDownload} />
                ))}
              </div>
            )}
            {/* A live run's frame list is a running total, not a batch. Said
                rather than implied, and said WITHOUT counting: the desktop
                reports a run's frames as it goes and there is no way from here
                to know whether one taken a second ago has been reported yet, so
                an empty list mid-run is "not told", never "none taken". */}
            {selRun.status === "running" && (
              <div className="form-hint">
                {watching(selRun)
                  ? "This run is still keeping frames. What is listed here is what the desktop has reported so far — more arrive while it watches, and the verdict is written when it stops."
                  : "Frames are listed as the desktop reports them; this list is not final until the run finishes."}
              </div>
            )}
            {selRun.status === "done" && !selRun.files?.length && (
              <Empty>This run finished and wrote no frame — there is nothing to look at.</Empty>
            )}
            {selRun.status === "failed" && !selRun.files?.length && (
              <Empty>This run failed before it took a frame. The log below is what it managed to say.</Empty>
            )}
            <pre className="build-log" ref={logRef}>{stripAnsi(output.get(selRun.runId) ?? "") || "(no output yet)"}</pre>
          </div>
        )}
      </div>
    </div>
  );
}

/** The one line under a target's name that says what it actually points at.
 *  Backend-specific and ABSENT when the field a backend needs has not been
 *  filled in — the row stays, the run refuses in the host's words. */
function targetDetail(t: CaptureTarget): string {
  switch (t.backend) {
    case "web": return t.url ?? "";
    case "android": return t.serial ?? "";
    case "garmin": return [t.screen, t.device].filter(Boolean).join(" · ");
    case "window": return t.windowTitle ?? "";
  }
}

/**
 * One frame this run wrote: what it is, and what its download is doing.
 *
 * `BuildSheet`'s `ArtifactRow`, unchanged in substance — the verb is the app's
 * one download button, never another `<a download>`, which does nothing at all
 * inside the APK.
 */
function FrameRow({ a, repoDir, repoName, onDownload }: {
  a: BuildArtifact;
  repoDir: string;
  repoName: string;
  onDownload: (a: BuildArtifact) => void;
}) {
  return (
    <div className="row-wrap">
      <button className="row grow" title={a.relPath} onClick={() => { track("action:capture.artifact"); onDownload(a); }}>
        <span className="row-title"><Download size={14} /> {a.name}</span>
        {/* The FULL transport path, not just the base name: it is what a report
            quotes and the only thing that tells two frames of one target apart. */}
        <span className="row-sub mono">{a.relPath}</span>
        <span className="row-sub">{fmtSize(a.size)}{a.mtime ? ` · ${when(a.mtime)}` : ""}</span>
      </button>
      <DownloadButton compact trackId="action:capture.artifact"
        target={{ repoId: a.repoId, relPath: a.relPath, name: a.name, size: a.size, mtime: a.mtime, repoDir, repoName }} />
    </div>
  );
}

/** `"390x844, 1280x800"` ⇄ `CaptureViewport[]`. Anything unparseable is DROPPED
 *  rather than coerced: a viewport of `0x844` is a frame nobody asked for. */
function parseViewports(s: string): CaptureViewport[] {
  const out: CaptureViewport[] = [];
  for (const part of s.split(/[,\n]/)) {
    const m = /^\s*(\d+)\s*[x×]\s*(\d+)\s*$/.exec(part);
    if (!m) continue;
    const w = Number(m[1]), h = Number(m[2]);
    if (w > 0 && h > 0) out.push({ w, h });
  }
  return out;
}
const fmtViewports = (v?: CaptureViewport[]) => (v ?? []).map((p) => `${p.w}x${p.h}`).join(", ");

/** Watch mode's emit threshold as typed. Blank — or anything that is not a
 *  percentage — is ABSENT, which the host reads as "use your default"; it is
 *  never rounded down to 0, which would mean "keep every frame". */
function parsePct(s: string): number | undefined {
  const t = s.trim();
  if (!t) return undefined;
  const n = Number(t.replace(/%$/, ""));
  return Number.isFinite(n) && n >= 0 && n <= 100 ? n : undefined;
}

/**
 * Add or edit one capture target.
 *
 * Two rules shape it. **Backend-specific fields are shown for the chosen backend
 * only** — a garmin target has no url and an android one has no window title,
 * and eight boxes where three are meaningless is how a phone form becomes
 * unusable. And **nothing here is dimmed to mean no**: every backend stays
 * pickable even where this desktop cannot currently drive it, with the reason
 * printed underneath, because a target is configured once and the tool that
 * drives it is installed whenever. Refusing to let somebody WRITE the target
 * because Playwright is not installed yet would be the app deciding what order
 * to do two independent things in.
 */
function CaptureEditor({ draft, backends, onCancel, onSave }: {
  draft: CaptureTarget;
  backends: CaptureBackendInfo[];
  onCancel: () => void;
  onSave: (t: CaptureTarget) => void;
}) {
  const [name, setName] = useState(draft.name);
  const [backend, setBackend] = useState<CaptureBackendId>(draft.backend);
  const [dir, setDir] = useState(draft.dir ?? "");
  const [anchor, setAnchor] = useState((draft.anchor ?? []).join(", "));
  // Blank is INHERIT, not zero — the field opens on what is stored, never on
  // the desktop's effective default, or every first save would pin a number
  // nobody chose (`ContextLimits.tsx`'s rule).
  const [diffPct, setDiffPct] = useState(typeof draft.diffPct === "number" ? String(draft.diffPct) : "");
  const [url, setUrl] = useState(draft.url ?? "");
  const [viewports, setViewports] = useState(fmtViewports(draft.viewports));
  const [theme, setTheme] = useState<CaptureThemePref | "">(draft.theme ?? "");
  const [serial, setSerial] = useState(draft.serial ?? "");
  const [screen, setScreen] = useState(draft.screen ?? "");
  const [device, setDevice] = useState(draft.device ?? "");
  const [windowTitle, setWindowTitle] = useState(draft.windowTitle ?? "");

  const be = backends.find((b) => b.id === backend);

  function save() {
    const anchors = anchor.split(/[,\n]/).map((s) => s.trim()).filter(Boolean);
    const vps = parseViewports(viewports);
    track("action:capture.save");
    // Only the chosen backend's fields are written. Carrying a stale `url` on a
    // target somebody switched to `garmin` would leave a field that means
    // nothing to the backend and everything to the next person reading the file.
    onSave({
      id: draft.id,
      name,
      backend,
      dir: dir.trim() || undefined,
      anchor: anchors.length ? anchors : undefined,
      settleMs: draft.settleMs,
      // Unparseable is DROPPED rather than coerced, `parseViewports`' rule: a
      // threshold of 0 means "keep every frame", which is the opposite of what
      // somebody who typed "two percent" asked for. What is stored is what the
      // field shows next time, so a dropped value is visible, not silent.
      diffPct: parsePct(diffPct),
      url: backend === "web" ? (url.trim() || undefined) : undefined,
      viewports: backend === "web" && vps.length ? vps : undefined,
      theme: backend === "web" && theme ? theme : undefined,
      serial: backend === "android" ? (serial.trim() || undefined) : undefined,
      screen: backend === "garmin" ? (screen.trim() || undefined) : undefined,
      device: backend === "garmin" ? (device.trim() || undefined) : undefined,
      windowTitle: backend === "window" ? (windowTitle.trim() || undefined) : undefined,
    });
  }

  return (
    <div className="sheet">
      <SheetHead title={<>{draft.name ? "Edit capture target" : "New capture target"}</>} onClose={onCancel} />
      <div className="build-body">
        <div className="form">
          <input className="search" placeholder="Name (e.g. droplet · home)" value={name} onChange={(e) => setName(e.target.value)} autoFocus />
          {/* Which backend is chosen is marked with a TICK, not with a shade.
              The `.on` accent this app has for segmented pairs is scoped to one
              other sheet's class, and borrowing a colour rule from elsewhere is
              how a picker ends up with no visible selection at all on the one
              screen nobody re-tested. A mark works in both themes and needs no
              CSS this file does not own. */}
          <RadioRows
            label="capture backend"
            options={CAPTURE_BACKEND_IDS.map((id) => ({ key: id, label: id }))}
            value={backend}
            onChange={setBackend}
          />
          {/* Said, not dimmed. `available: true` may still carry a sentence —
              which tool was found — and that is worth printing too. */}
          {be?.reason && (
            be.available
              ? <div className="form-hint">{be.reason}</div>
              : <Unavailable cants={[{ label: `${backend} captures on this desktop`, reason: be.reason }]} />
          )}
          {be === undefined && (
            <div className="form-hint">
              <CloudOff size={13} style={{ verticalAlign: "-2px" }} /> This desktop has not said whether it can drive <span className="mono">{backend}</span>. The target saves either way; a run that cannot happen refuses in words.
            </div>
          )}
          <input className="search" placeholder="Working sub-dir (optional, relative to repo root)" value={dir} onChange={(e) => setDir(e.target.value)} style={{ fontFamily: "monospace" }} />
          <input className="search" placeholder="Anchor text, comma-separated (e.g. TOTAL, Settings)" value={anchor} onChange={(e) => setAnchor(e.target.value)} />
          <div className="form-hint">
            Anchors are what make a capture claim <em>verified</em> instead of merely taken: the backend goes and asks the running thing what text is on its screen. A backend with no oracle — a window grab, a simulator nobody can query — can never answer an anchor however many you set, and says <em>settled</em> at best.
          </div>
          {/* Watch mode's only knob, on the target rather than on the tap: it is
              a property of the screen (a spinner-heavy page moves constantly, a
              form barely moves), not a decision to make again every time. */}
          <input className="search" inputMode="decimal" placeholder="Watch: keep a frame past this % changed (blank = the desktop's default)" value={diffPct} onChange={(e) => setDiffPct(e.target.value)} />
          <div className="form-hint">
            Only watch runs read this. With no pixel tool on the desktop nothing can be measured, so the gate opens and every frame is kept — the run's output says that is what happened rather than quietly keeping none.
          </div>

          {backend === "web" && (
            <>
              <input className="search" placeholder="URL (required — e.g. http://localhost:5173/)" value={url} onChange={(e) => setUrl(e.target.value)} style={{ fontFamily: "monospace" }} />
              <input className="search" placeholder={`Viewports, e.g. ${DEFAULT_CAPTURE_VIEWPORT.w}x${DEFAULT_CAPTURE_VIEWPORT.h}, 1280x800`} value={viewports} onChange={(e) => setViewports(e.target.value)} style={{ fontFamily: "monospace" }} />
              <RadioRows
                label="emulated colour scheme"
                options={(["", "light", "dark", "both"] as const).map((t) => ({ key: t || "default", label: t || "default theme" }))}
                value={theme || "default"}
                onChange={(k) => setTheme(k === "default" ? "" : (k as typeof theme))}
              />
              <div className="form-hint">
                Capture never starts a dev server. A URL that does not answer is refused in words, and the Build sheet is where you start one. Empty viewports means one frame at <span className="mono">{DEFAULT_CAPTURE_VIEWPORT.w}×{DEFAULT_CAPTURE_VIEWPORT.h}</span>.
              </div>
            </>
          )}
          {backend === "android" && (
            <>
              <input className="search" placeholder="Device serial (optional)" value={serial} onChange={(e) => setSerial(e.target.value)} style={{ fontFamily: "monospace" }} />
              <div className="form-hint">Empty means the only connected device. With more than one connected and no serial the run refuses rather than guessing which phone you meant.</div>
            </>
          )}
          {backend === "garmin" && (
            <>
              <input className="search" placeholder="Screen name (ciqkit sim shot &lt;screen&gt;)" value={screen} onChange={(e) => setScreen(e.target.value)} style={{ fontFamily: "monospace" }} />
              <input className="search" placeholder="Device (e.g. venu3)" value={device} onChange={(e) => setDevice(e.target.value)} style={{ fontFamily: "monospace" }} />
            </>
          )}
          {backend === "window" && (
            <>
              <input className="search" placeholder="Window title (optional)" value={windowTitle} onChange={(e) => setWindowTitle(e.target.value)} />
              <div className="form-hint">Resolved best-effort. A title that matches nothing falls back to the whole desktop, and the run’s evidence file records that it did — the picture is never passed off as that window.</div>
            </>
          )}
        </div>
      </div>

      <div className="sheet-actions">
        <button className="key" onClick={onCancel}><X size={16} /> cancel</button>
        <span className="spacer" />
        {/* The one thing a target cannot be saved without is the label on its own
            button. Said as a sentence where the button would be, rather than as a
            faded Save nobody can tell apart from a live one on a phone. */}
        {name.trim()
          ? <button className="send" onClick={save}>Save</button>
          : <Unavailable cants={[{ label: "save", reason: "a target needs a name — it is the label on the button you will tap" }]} />}
      </div>
    </div>
  );
}
