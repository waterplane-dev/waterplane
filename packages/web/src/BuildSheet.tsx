import { useEffect, useRef, useState } from "react";
import { CalendarClock, CloudOff, Hammer, Loader, Pencil, Play, Plus, Square, Wand2, ChevronDown, ChevronUp } from "lucide-react";
import type { ArtifactPolicy, BuildArtifact, BuildCandidate, BuildParamAnswer, BuildConfig, BuildRecord, BuildRun, RepoTarget, ScheduleEntry, WindowResets } from "@waterplane/shared";
import { branchLabel } from "@waterplane/shared";
import { SETUP_PROMPT, oneBuildPrompt, paramsRowNote, type BuildDraftSeed } from "./buildPrompt";
import { track } from "./usage";
import { ago, durSpan, seqId, stripAnsi, when } from "./format";
import { SheetHead } from "./Sheet";
import { BuildRunLog } from "./BuildRunLog";
import { useBackStep } from "./backStep";
import { Empty } from "./Empty";
import { Explain } from "./Explain";
import { BUILD_LOCAL_ROW, localAfterSave } from "./buildScope";
import { buildRecordWords, earlierBuildsLabel, entryVersions, lastBuildWords } from "./buildVersionWords";
import { BuildEditor } from "./BuildEditor";
import { BuildRunAsk } from "./BuildRunAsk";
import { BuildScheduleForm } from "./BuildScheduleForm";
import type { BuildScheduleCue } from "./buildSchedule";
import type { SendWhen } from "./sendIntent";
import { ArtifactPolicyRow, ArtifactRow } from "./BuildArtifacts";
import { Button } from "./kit/Button";
import { RowSub, Row, RowTitle } from "./kit/Row";
import { Hint } from "./kit/Hint";
import { Tag } from "./kit/Tag";

interface Props {
  repo: RepoTarget;
  /** The host's stored failure of the newest failed build here (`RepoTarget.buildFailed`) and
   *  `done` on it (`notification.handle`). Both absent on an older host. */
  failed?: RepoTarget["buildFailed"];
  onDone?: (id: string) => void;
  builds: BuildConfig[];
  runs: BuildRun[];                       // this repo's runs, newest first
  output: ReadonlyMap<string, string>;    // runId → retained output
  outTick: number;                        // bumps when `output` mutates (force re-render)
  /** `local`: ids to keep in this desktop's file; only when the host sent `localIds`. */
  onSave: (next: BuildConfig[], local?: string[]) => void;
  /** `build.list`'s `localIds`; `undefined` = older host: no scope control, no attribution. */
  localIds?: string[];
  /** `build.list`'s `versions`: each artifact's recent builds (`undefined` = older host: no line). */
  versions?: Record<string, BuildRecord[]>;
  /** Start a build, with whatever its parameters were answered with. App routes
   *  it through the durable send queue, so a tap on a dead tunnel is kept and
   *  started on reconnect (and never run twice). */
  onRun: (buildId: string, params?: Record<string, string>) => void;
  /** false = no socket. The run is still accepted (it queues); the hint says so. */
  online?: boolean;
  /**
   * What this repo does with what its builds produce — the two switches every
   * build in it runs under (`shared/artifacts.ts`).
   *
   * `undefined` means the host has not answered yet, or never will (an older
   * daemon). The row is then not drawn at all: a default painted as this
   * repo's policy is a claim about what the next build will do to files on
   * disk, and this is the one screen where that claim must be true.
   */
  policy?: ArtifactPolicy;
  onSavePolicy?: (p: ArtifactPolicy) => void;
  /**
   * When the host last confirmed `builds` (0 = never on this device).
   *
   * The list is cached per repo, so this sheet works with the link down — which
   * is the state it exists for. A cached list that cannot say how old it is
   * reads as current, and a build command deleted at the desk last week looks
   * exactly like a live one, so the age is shown whenever these rows are not
   * coming off a live socket.
   */
  listAt?: number;
  onCancel: (runId: string) => void;
  onDownload: (a: BuildArtifact) => void;
  /** Open a session in this repo and hand it `SETUP_PROMPT` — the one-tap way to
   *  fill an empty sheet without typing a build command on a phone keyboard. */
  onSetup: (prompt: string) => void;
  /** A run's log to a new session here, via a Send-sheet seed (`buildLogSeed`). */
  onSendLog?: (r: BuildRun, log: string, took: string) => void;
  /**
   * What this repo already describes, off its own manifests (`build.scan`).
   *
   * `null` means nobody has answered yet — which is NOT the same as a repo that
   * describes nothing, and the editor words the two differently. An empty array
   * with `candidatesTotal: 0` is a real answer.
   */
  candidates?: BuildCandidate[] | null;
  /** How many were found before the host capped the list. */
  candidatesTotal?: number;
  /** Ask the host to read the repo. Called when the editor opens; free, no tokens. */
  onScan: () => void;
  /**
   * What this repo's parameterised builds may be set to, keyed by build id then
   * parameter id — the answer to `build.options`.
   *
   * `undefined` for a build nobody has asked about yet, which is NOT the same
   * as a build whose listing command answered nothing, and the form words the
   * two differently (`Empty`'s rule, one screen down).
   */
  paramOptions?: Record<string, Record<string, BuildParamAnswer>>;
  /** Run this build's `optionsCmd`s on the desktop. Called when the ask form
   *  opens — a listing, not the build. */
  onAskOptions: (buildId: string, approve?: { paramId: string; cmd: string }) => void;
  onClose: () => void;
  /** The rules that run an entry, as its cue (`buildSchedule.ts`); absent draws none. */
  scheduleCue?: (b: BuildConfig) => BuildScheduleCue | null;
  /** The cue's tap: Automation cut to exactly `cue.ids`. */
  onOpenScheduleCut?: (cue: BuildScheduleCue) => void;
  /** Save the schedule-a-build form (`schedule.save`, durable). */
  onSaveSchedule?: (b: BuildConfig, entry: ScheduleEntry | null, when: Extract<SendWhen, { kind: "at" }>, vals: Record<string, string>, preview: number | null) => void;
  /** The usage reading a window-anchored rule resolves against. */
  usage?: WindowResets | null;
  /** A build rule's card *edit* landed here: open its form on arrival. */
  scheduleEdit?: { build: BuildConfig; entry: ScheduleEntry } | null;
  /** A run to open on arrival (a build rule's card *last run*). */
  focusRun?: string | null;
}

/* `SETUP_PROMPT` and the editor's one-entry wand live in `buildPrompt.ts`: they
   share one copy of the builds-file schema (two copies drift, and the
   drifting one is always the one an agent is reading) and a prompt is a
   contract with a machine, so they are pinned by a test a JSX file cannot be
   imported into. */

/**
 * Build buttons for one repo: configure named build commands, run them without a
 * claude session (works when you're rate-limited), watch live output, and
 * download the produced artifact (APK/zip/…).
 */
export function BuildSheet({ repo, failed, onDone, builds, runs, output, outTick, onSave, localIds, versions, onRun, onCancel, onDownload, onSetup, onSendLog, onScan, onAskOptions, onClose, candidates = null, candidatesTotal = 0, paramOptions, online = true, listAt = 0, policy, onSavePolicy, scheduleCue, onOpenScheduleCut, onSaveSchedule, usage, scheduleEdit, focusRun }: Props) {
  const [editing, setEditing] = useState<BuildConfig | null>(null);
  // The one entry whose earlier builds are unfolded, if any.
  const [history, setHistory] = useState<string | null>(null);
  /* The build whose questions are being answered. A tap on a parameterised
     button opens this instead of running — the values ARE part of the command,
     so there is no honest way to start without them. */
  const [asking, setAsking] = useState<BuildConfig | null>(null);
  /* The schedule-a-build form: a NEW rule (from the editor's `run on a clock…`)
     or an EXISTING one (a build rule's card `edit`, arriving as `scheduleEdit`). */
  const [scheduling, setScheduling] = useState<{ build: BuildConfig; entry: ScheduleEntry | null } | null>(null);
  useEffect(() => {
    if (!scheduleEdit) return;
    setScheduling(scheduleEdit);
    if (scheduleEdit.build.params?.length) onAskOptions(scheduleEdit.build.id);   // a listing, not the build
  // eslint-disable-next-line react-hooks/exhaustive-deps -- once per hand-over, not per new callback identity
  }, [scheduleEdit]);
  /* Which run is open: `null` = the newest (so a run just started is the one
     you see), `""` = none, because the open run's detail sits UNDER its own
     row now and a person who has read it should be able to fold it away.
     It used to be a pane at the foot of the list, attached to nothing: a
     screen of eight runs and three files below them did not say which run
     the files were from. */
  const [sel, setSel] = useState<string | null>(null);
  useEffect(() => { if (focusRun) setSel(focusRun); }, [focusRun]);
  const selRun = sel === "" ? null : runs.find((r) => r.runId === sel) ?? runs[0] ?? null;
  const logRef = useRef<HTMLPreElement>(null);
  const openRef = useRef<HTMLDivElement>(null);

  // Follow the tail of the live log.
  useEffect(() => {
    const el = logRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [outTick, selRun?.runId]);
  // A tap that opens a run (its row, or a running build's row above) brings
  // its detail into view — the runs list can be below the fold.
  useEffect(() => {
    if (sel) openRef.current?.scrollIntoView({ block: "nearest" });
  }, [sel]);

  function remove(id: string) { const next = builds.filter((b) => b.id !== id); onSave(next, localAfterSave(localIds, next)); setEditing(null); }
  function upsert(b: BuildConfig, local = false) {
    const cmd = b.cmd.trim();
    if (!cmd) { setEditing(null); return; }
    const clean: BuildConfig = { ...b, cmd, name: b.name.trim() || "build", dir: b.dir?.trim() || undefined };
    const next = builds.some((x) => x.id === b.id) ? builds.map((x) => (x.id === b.id ? clean : x)) : [...builds, clean];
    onSave(next, localAfterSave(localIds, next, { id: b.id, local })); setEditing(null);
  }

  /* The scan is asked for when the editor OPENS, not when the sheet does. It
     reads a few dozen files on the desktop and answers in milliseconds, so
     asking on arrival means the suggestions are already there by the time the
     keyboard is — but a person who only came here to RUN a build should not
     make the host walk a monorepo for it. */
  function openEditor(b: BuildConfig) { setEditing(b); onScan(); }

  /**
   * Tap a build. One of two things happens, and which one is a fact about the
   * ENTRY, not a setting: a plain command runs, a parameterised one opens its
   * form first. Nothing is ever started on a guessed value — that is the whole
   * rule of `shared/buildparams.ts`, and the host refuses it too.
   */
  function fire(b: BuildConfig) {
    if (b.params?.length) {
      track("action:build.ask");
      setAsking(b);
      onAskOptions(b.id);   // a listing on the desktop, not the build
      return;
    }
    track("action:build.run");
    onRun(b.id);
  }

  // Back — the gesture as much as the arrow — closes this step, not the sheet.
  useBackStep(editing !== null, () => setEditing(null));
  useBackStep(asking !== null, () => setAsking(null));
  useBackStep(scheduling !== null, () => setScheduling(null));
  if (scheduling && onSaveSchedule) {
    const { build, entry } = scheduling;
    return <BuildScheduleForm build={build} entry={entry} usage={usage} options={paramOptions?.[build.id]} online={online}
      onApprove={(paramId, cmd) => { track("action:build.approve-options"); onAskOptions(build.id, { paramId, cmd }); }}
      onCancel={() => setScheduling(null)}
      onSave={(w, vals, preview) => { track("action:build.schedule"); onSaveSchedule(build, entry, w, vals, preview); setScheduling(null); }} />;
  }
  if (editing) {
    return <BuildEditor draft={editing} candidates={candidates} candidatesTotal={candidatesTotal} online={online}
      saved={builds.some((b) => b.id === editing.id)}
      scope={localIds ? { local: localIds.includes(editing.id) } : null}
      onDelete={() => remove(editing.id)} onAssist={(seed: BuildDraftSeed) => { track("action:build.one"); onSetup(oneBuildPrompt(seed, repo.repoName)); }}
      onCancel={() => setEditing(null)} onSave={upsert}
      onSchedule={onSaveSchedule ? () => { const b = editing; setEditing(null); setScheduling({ build: b, entry: null }); if (b.params?.length) onAskOptions(b.id); } : undefined} />;
  }

  if (asking) {
    return <BuildRunAsk build={asking} options={paramOptions?.[asking.id]} online={online}
      onApprove={(paramId, cmd) => { track("action:build.approve-options"); onAskOptions(asking.id, { paramId, cmd }); }}
      onCancel={() => setAsking(null)}
      onRun={(values) => { track("action:build.run"); onRun(asking.id, values); setAsking(null); }} />;
  }

  return (
    <div className="sheet">
      <SheetHead title={<><Hammer size={16} /> Build · {repo.repoName}</>} onClose={onClose}>
        {branchLabel(repo) && <RowSub className="head-branch">{branchLabel(repo)}</RowSub>}
        <Button title="ask Claude to work out this repo's build commands"
          onClick={() => { track("action:build.setup"); onSetup(SETUP_PROMPT); }}><Wand2 size={16} /> set up</Button>
        {/* Writing the list is `build.save`, a live-only frame: it edits a file
            on the desktop and there is no honest way to hold one. Opening the
            editor offline would take a typed-out gradle line and answer it with
            a toast — so offline the verb is ABSENT and the hint below says
            why, never a dimmed button whose reason lives in a `title`. */}
        {online && <Button title="add a build command"
          onClick={() => openEditor({ id: seqId("b"), name: "", cmd: "", dir: "" })}><Plus size={16} /> new</Button>}
      </SheetHead>
      {/* One line, and the rest behind a `?`: three always-on paragraphs
          stood between the head and the first build. */}
      <Hint>
        Runs in a shell on the desktop, no tokens spent{" "}
        <Explain of="the build sheet">Works while Claude is rate-limited. What it produces is offered for download under its run.</Explain>
      </Hint>
      {/* Offline is never folded: it is why `new` and the pencils are absent.
          The second line says the rows came off this device, not the host, and
          when — the commands are cached, the RUN is what needed the link. */}
      {!online && (
        <Hint>
          <CloudOff size={13} style={{ verticalAlign: "-2px" }} />{" "}
          No connection: a tap is queued and the build starts once the link is back. Adding, editing or deleting a command needs the link.
          {builds.length > 0 && (listAt
            ? ` These commands are this device's copy, last confirmed ${ago(listAt)} ago.`
            : " These commands are this device's copy.")}
        </Hint>
      )}

      {/* ONE scroll region for everything under the hint.
          Before this the build list, the runs list and the log pane were three
          siblings of the sheet's flex column: `.list` is `flex: 1` (basis 0)
          and `.build-run` was `flex: 1 1 auto` (basis = the log's own height),
          so as soon as a run produced a few hundred lines the log's basis
          exceeded the sheet and BOTH lists were squeezed to zero. The screen
          then showed a header, a hint and a wall of gradle output: one build
          could be started, and every control for starting another — including
          the row that starts it — was gone. Scrolling the body cannot do that,
          and the log keeps its own inner scroll below. */}
      <div className="build-body">
        {/* Inside the scroll region: `error` is the failed run's output tail,
            and as a sibling of the sheet's column a long one pushed everything
            below it — the body included — off a screen that could not scroll. */}
        {failed && (
          <div className="build-failed">
            <Hint>Build “{failed.name}” failed {ago(failed.at)}.{failed.error ? `\n${stripAnsi(failed.error)}` : ""}</Hint>
            {onDone && <Button onClick={() => onDone(failed.id)} title="mark this failure as dealt with; the red chip on the repo goes away">done</Button>}
          </div>
        )}
        <div className="list build-cmds">
          {builds.map((b) => {
            const running = runs.find((r) => r.buildId === b.id && r.status === "running");
            const cue = scheduleCue?.(b) ?? null;
            const built = entryVersions(b, versions);
            const earlier = earlierBuildsLabel(built.length - 1, history === b.id);
            return (
              <Row key={b.id} kind="wrap">
                <div className="build-main">
                <Row as="button" kind="grow" title={b.cmd} onClick={() => { if (running) setSel(running.runId); else fire(b); }}>
                  <RowTitle>{b.name}{running ? <> <Loader size={12} className="spin" /></> : null}</RowTitle>
                  {/* Two lines, then an ellipsis: a forty-line shell script
                      as a row's subtitle was a whole screen of one row. The
                      full command is one tap away, on the pencil. */}
                  <RowSub className="mono build-cmd">{b.dir ? `${b.dir}$ ` : ""}{b.cmd}</RowSub>
                  {/* A button that ASKS is visibly one, before it is tapped. The
                      placeholders are in the command line above, but `{{app}}`
                      in a monospace line is not a promise a reader can act on —
                      this is. */}
                  {b.params?.length ? <RowSub>{paramsRowNote(b)}</RowSub> : null}
                  {localIds?.includes(b.id) ? <RowSub>{BUILD_LOCAL_ROW}</RowSub> : null}
                  {/* Which build this entry last produced, in the words the
                      artifact itself shows — the line to hold beside the app. */}
                  {built[0] ? <RowSub className="build-version">{lastBuildWords(built[0])}</RowSub> : null}
                </Row>
                {earlier && (
                  <button className="linkish build-cue" onClick={() => setHistory(history === b.id ? null : b.id)}>
                    {earlier}
                  </button>
                )}
                {history === b.id && built.slice(1).map((r) => (
                  <RowSub key={`${r.at}-${r.sha ?? ""}`} className="build-version">{buildRecordWords(r)}</RowSub>
                ))}
                {/* The rules that run this entry, in the cards' own words. A
                    sibling of the run button, never inside it (a button in a
                    button), and its tap is the cut it counts: exactly these ids. */}
                {cue && (
                  <button className="linkish build-cue" title="open these schedules"
                    onClick={() => { track("action:build.cue"); onOpenScheduleCut?.(cue); }}>
                    <CalendarClock size={13} /> {cue.words}
                  </button>
                )}
                </div>
                {running
                  ? <Button variant="danger" title="cancel build" onClick={() => onCancel(running.runId)}><Square size={16} /></Button>
                  : <Button title={b.params?.length ? "run build — it asks first" : "run build"} onClick={() => fire(b)}><Play size={16} /></Button>}
                {/* Delete lives in the editor, behind a confirm: a red bin on
                    every row, one thumb-width from Run, was a one-tap way to
                    lose a command somebody wrote. Offline the pencil is absent
                    and the hint above says why. */}
                {online && <Button title="edit or delete" onClick={() => openEditor(b)}><Pencil size={16} /></Button>}
              </Row>
            );
          })}
          {/* Two different nothings. With the link up the host has told us this
              repo has no commands, which is a fact and an invitation to write
              some. Offline it means this device has never seen this repo's
              list — the repo may well have five. Printing the first sentence
              for the second case is what put "no build commands yet" over a
              repo that had them, on the very screen you reach for when the
              tunnel is down. */}
          {builds.length === 0 && (online ? (
            <Empty>
              No build commands yet — tap “set up” or “new”.{" "}
              <Explain of="the two ways to add one" label="what do those do?">
                “set up” opens a session that reads the repo and writes them for you — do it while Claude still has tokens, since this sheet is what you fall back to when it doesn’t. “new” writes one yourself.
              </Explain>
            </Empty>
          ) : (
            <Empty>
              No connection, and this device has no copy of this repo’s build commands — it has not had them since it was last on the link. This says nothing about whether the repo has any. Open this sheet once with the link up and they are cached here from then on.
            </Empty>
          ))}
        </div>

        <ArtifactPolicyRow policy={policy} online={online} onSave={onSavePolicy} />

        {runs.length > 0 && (
          <>
            <div className="section">Runs</div>
            <div className="list build-runs">
              {runs.slice(0, 8).map((r) => {
                const text = stripAnsi(output.get(r.runId) ?? "");
                const log = selRun?.runId === r.runId
                  && <BuildRunLog r={r} text={text} logRef={logRef} onSendLog={onSendLog} />;
                return (
                <div key={r.runId} className="build-run-item">
                <button className={`row ${selRun?.runId === r.runId ? "active" : ""}`}
                  onClick={() => setSel(selRun?.runId === r.runId ? "" : r.runId)}>
                  <RowTitle>
                    {r.status === "running" ? <Loader size={12} className="spin" /> : null} {r.name}
                    {" "}<Tag className={r.status === "done" ? "idle" : r.status === "running" ? "coding" : "dead"}>{r.status}{r.exitCode ? ` ${r.exitCode}` : ""}</Tag>
                  </RowTitle>
                  {/* WHEN, then how long. Five rows all reading "Debug APK ·
                      done · 17s · 2 artifacts" are five rows a reader cannot
                      tell apart: the only thing separating them was a sort
                      order taken on trust, and the artifact underneath carries
                      a date of its own that may disagree with all of them. The
                      stamp is the run's END while there is one — the instant
                      the files below it came to exist — and its START while it
                      is still running, which is the only instant that exists
                      yet. */}
                  {/* …and WHAT it was asked for. With parameters two runs of
                      one button are two different builds, so the values are the
                      only thing separating these rows from each other. */}
                  {r.params && Object.keys(r.params).length > 0 && (
                    <RowSub className="mono">{Object.entries(r.params).map(([k, v]) => `${k}=${v}`).join(" · ")}</RowSub>
                  )}
                  <RowSub>{when(r.finishedAt ?? r.startedAt)} · {durSpan(r.startedAt, r.finishedAt)}{r.artifacts?.length ? ` · ${r.artifacts.length} artifact${r.artifacts.length > 1 ? "s" : ""}` : ""}</RowSub>
                  {selRun?.runId === r.runId ? <ChevronUp size={16} className="build-run-fold" /> : <ChevronDown size={16} className="build-run-fold" />}
                </button>
                {selRun?.runId === r.runId && (
                  <div className="build-run" ref={openRef}>
                    {/* Failed/running is opened for its LOG: right under the row,
                        not after the artifacts. Done is opened for its files. */}
                    {r.status !== "done" && log}
                    {r.artifacts && r.artifacts.length > 0 && (
                      <div className="list">
                        {r.artifacts.map((a) => (
                          <ArtifactRow key={a.relPath} a={a} repoDir={repo.worktreePath} repoName={repo.repoName} onDownload={onDownload} />
                        ))}
                      </div>
                    )}
                    {r.status === "done" && !r.artifacts?.length && (
                      <Empty>Build finished, no downloadable file found (nothing matching apk/aab/zip/… in the repo).</Empty>
                    )}
                    {r.status === "done" && log}
                  </div>
                )}
                </div>
                );
              })}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
