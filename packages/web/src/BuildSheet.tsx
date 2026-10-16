import { useEffect, useRef, useState } from "react";
import {
  AlertTriangle, Check, CloudOff, Download, Hammer, HelpCircle, Loader, Minus, Package, Pencil, Play,
  Plus, Search, Square, Trash2, Wand2, X, ChevronDown, ChevronUp,
} from "lucide-react";
import type { ArtifactPolicy, BuildArtifact, BuildCandidate, BuildConfig, BuildParam, BuildRun, RepoTarget } from "@waterplane/shared";
import {
  MAX_ARTIFACT_KEEP, artifactPolicyText, branchLabel, cleanBuildParams, cleanParamValue, filterCandidates,
  missingParamsText, paramEnvName, paramLabel, resolveParamValues, unknownParamRefs,
} from "@waterplane/shared";
import {
  ONE_BUILD_ASK, ONE_BUILD_ASK_NOTE, ONE_BUILD_LABEL, ONE_BUILD_NOTHING, ONE_BUILD_PLACEHOLDER,
  ONE_BUILD_TITLE, SETUP_PROMPT, oneBuildPrompt, paramsRowNote, type BuildDraftSeed,
} from "./buildPrompt";
import { PromptComposer } from "./PromptComposer";
import { DownloadButton } from "./DownloadButton";
import { track } from "./usage";
import { ago, durSpan, fmtSize, seqId, stripAnsi, when } from "./format";
import { SheetHead } from "./Sheet";
import { BuildRunLog } from "./BuildRunLog";
import { ConfirmButton } from "./Confirm";
import { useBackStep } from "./backStep";
import { Empty } from "./Empty";
import { Unavailable } from "./Unavailable";
import { Explain } from "./Explain";
import { SetSwitch } from "./SettingsKit";
import { BUILD_LOCAL_ROW, localAfterSave } from "./buildScope";
import { BuildScopeChoice } from "./BuildScopeChoice";

interface Props {
  repo: RepoTarget;
  builds: BuildConfig[];
  runs: BuildRun[];                       // this repo's runs, newest first
  output: ReadonlyMap<string, string>;    // runId → retained output
  outTick: number;                        // bumps when `output` mutates (force re-render)
  /** `local`: ids to keep in this desktop's file; only when the host sent `localIds`. */
  onSave: (next: BuildConfig[], local?: string[]) => void;
  /** `build.list`'s `localIds`; `undefined` = older host: no scope control, no attribution. */
  localIds?: string[];
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
  paramOptions?: Record<string, Record<string, { options?: string[]; total?: number; error?: string }>>;
  /** Run this build's `optionsCmd`s on the desktop. Called when the ask form
   *  opens — a listing, not the build. */
  onAskOptions: (buildId: string) => void;
  onClose: () => void;
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
export function BuildSheet({ repo, builds, runs, output, outTick, onSave, localIds, onRun, onCancel, onDownload, onSetup, onSendLog, onScan, onAskOptions, onClose, candidates = null, candidatesTotal = 0, paramOptions, online = true, listAt = 0, policy, onSavePolicy }: Props) {
  const [editing, setEditing] = useState<BuildConfig | null>(null);
  /* The build whose questions are being answered. A tap on a parameterised
     button opens this instead of running — the values ARE part of the command,
     so there is no honest way to start without them. */
  const [asking, setAsking] = useState<BuildConfig | null>(null);
  /* Which run is open: `null` = the newest (so a run just started is the one
     you see), `""` = none, because the open run's detail sits UNDER its own
     row now and a person who has read it should be able to fold it away.
     It used to be a pane at the foot of the list, attached to nothing: a
     screen of eight runs and three files below them did not say which run
     the files were from. */
  const [sel, setSel] = useState<string | null>(null);
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
  if (editing) {
    return <BuildEditor draft={editing} candidates={candidates} candidatesTotal={candidatesTotal} online={online}
      saved={builds.some((b) => b.id === editing.id)}
      scope={localIds ? { local: localIds.includes(editing.id) } : null}
      onDelete={() => remove(editing.id)} onAssist={(seed: BuildDraftSeed) => { track("action:build.one"); onSetup(oneBuildPrompt(seed, repo.repoName)); }}
      onCancel={() => setEditing(null)} onSave={upsert} />;
  }

  if (asking) {
    return <BuildRunAsk build={asking} options={paramOptions?.[asking.id]} online={online}
      onCancel={() => setAsking(null)}
      onRun={(values) => { track("action:build.run"); onRun(asking.id, values); setAsking(null); }} />;
  }

  return (
    <div className="sheet">
      <SheetHead title={<><Hammer size={16} /> Build · {repo.repoName}</>} onClose={onClose}>
        {branchLabel(repo) && <span className="row-sub head-branch">{branchLabel(repo)}</span>}
        <button className="key" title="ask Claude to work out this repo's build commands"
          onClick={() => { track("action:build.setup"); onSetup(SETUP_PROMPT); }}><Wand2 size={16} /> set up</button>
        {/* Writing the list is `build.save`, a live-only frame: it edits a file
            on the desktop and there is no honest way to hold one. Opening the
            editor offline would take a typed-out gradle line and answer it with
            a toast — so offline the verb is ABSENT and the hint below says
            why, never a dimmed button whose reason lives in a `title`. */}
        {online && <button className="key" title="add a build command"
          onClick={() => openEditor({ id: seqId("b"), name: "", cmd: "", dir: "" })}><Plus size={16} /> new</button>}
      </SheetHead>
      {/* One line, and the rest behind a `?`: three always-on paragraphs
          stood between the head and the first build. */}
      <div className="form-hint">
        Runs in a shell on the desktop, no tokens spent{" "}
        <Explain of="the build sheet">Works while Claude is rate-limited. What it produces is offered for download under its run.</Explain>
      </div>
      {/* Offline is never folded: it is why `new` and the pencils are absent.
          The second line says the rows came off this device, not the host, and
          when — the commands are cached, the RUN is what needed the link. */}
      {!online && (
        <div className="form-hint">
          <CloudOff size={13} style={{ verticalAlign: "-2px" }} />{" "}
          No connection: a tap is queued and the build starts once the link is back. Adding, editing or deleting a command needs the link.
          {builds.length > 0 && (listAt
            ? ` These commands are this device's copy, last confirmed ${ago(listAt)} ago.`
            : " These commands are this device's copy.")}
        </div>
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
        <div className="list build-cmds">
          {builds.map((b) => {
            const running = runs.find((r) => r.buildId === b.id && r.status === "running");
            return (
              <div key={b.id} className="row-wrap">
                <button className="row grow" title={b.cmd} onClick={() => { if (running) setSel(running.runId); else fire(b); }}>
                  <span className="row-title">{b.name}{running ? <> <Loader size={12} className="spin" /></> : null}</span>
                  {/* Two lines, then an ellipsis: a forty-line shell script
                      as a row's subtitle was a whole screen of one row. The
                      full command is one tap away, on the pencil. */}
                  <span className="row-sub mono build-cmd">{b.dir ? `${b.dir}$ ` : ""}{b.cmd}</span>
                  {/* A button that ASKS is visibly one, before it is tapped. The
                      placeholders are in the command line above, but `{{app}}`
                      in a monospace line is not a promise a reader can act on —
                      this is. */}
                  {b.params?.length ? <span className="row-sub">{paramsRowNote(b)}</span> : null}
                  {localIds?.includes(b.id) ? <span className="row-sub">{BUILD_LOCAL_ROW}</span> : null}
                </button>
                {running
                  ? <button className="key danger" title="cancel build" onClick={() => onCancel(running.runId)}><Square size={16} /></button>
                  : <button className="key" title={b.params?.length ? "run build — it asks first" : "run build"} onClick={() => fire(b)}><Play size={16} /></button>}
                {/* Delete lives in the editor, behind a confirm: a red bin on
                    every row, one thumb-width from Run, was a one-tap way to
                    lose a command somebody wrote. Offline the pencil is absent
                    and the hint above says why. */}
                {online && <button className="key" title="edit or delete" onClick={() => openEditor(b)}><Pencil size={16} /></button>}
              </div>
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
                  <span className="row-title">
                    {r.status === "running" ? <Loader size={12} className="spin" /> : null} {r.name}
                    {" "}<span className={`tag ${r.status === "done" ? "idle" : r.status === "running" ? "coding" : "dead"}`}>{r.status}{r.exitCode ? ` ${r.exitCode}` : ""}</span>
                  </span>
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
                    <span className="row-sub mono">{Object.entries(r.params).map(([k, v]) => `${k}=${v}`).join(" · ")}</span>
                  )}
                  <span className="row-sub">{when(r.finishedAt ?? r.startedAt)} · {durSpan(r.startedAt, r.finishedAt)}{r.artifacts?.length ? ` · ${r.artifacts.length} artifact${r.artifacts.length > 1 ? "s" : ""}` : ""}</span>
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

/**
 * Add or edit one build command — and the reason this screen is not three blank
 * boxes any more.
 *
 * Typing `./gradlew assembleRelease -PbuildDir=…` into a phone keyboard is the
 * exact friction this app exists to remove, and the sheet's "set up" button —
 * which spends a whole agent turn reading the repo — is the wrong size of tool
 * for adding ONE more command. So the fields arrive with the repo's own answer
 * beside them: every command this project already describes, off its manifests,
 * its CI workflows and its scripts (`shared/buildscan.ts`). Free, instant, and
 * available while rate-limited, which is the state this sheet exists for.
 *
 * Three rules it follows, each of them load-bearing:
 *
 *  • **A suggestion is typing, not saving.** Tapping a row fills these fields
 *    and nothing else happens — the Save tap is still yours, the command is
 *    still editable, and nothing this list offers has run. That is what lets it
 *    be generous: a row you disagree with is a row you don't tap.
 *  • **The query is the fields you already typed.** Naming the button "release
 *    apk" narrows the list to the release APK, so the search box and the form
 *    are not two places to say one thing.
 *  • **Nothing here is dimmed to mean "no".** A repo whose manifests describe
 *    nothing gets a sentence saying exactly that, and one that has not answered
 *    yet gets a different one — an empty list and an unanswered one are not the
 *    same claim.
 */
function BuildEditor({ draft, candidates, candidatesTotal, online, saved, scope, onAssist, onDelete, onCancel, onSave }: {
  draft: BuildConfig;
  candidates: BuildCandidate[] | null;
  candidatesTotal: number;
  online: boolean;
  /** Is this entry already in the repo's builds file? The wand's prompt says "edit
   *  this id in place" or "add one entry" off exactly this, and getting it
   *  wrong is how a sheet ends up with two buttons called "Release APK". */
  saved: boolean;
  /** Where this entry lives now; `null` = older host (no `localIds`), no control. */
  scope: { local: boolean } | null;
  /** Spend ONE agent turn on THIS entry, seeded with whatever is typed. The
   *  sheet's other wand reads the whole repo; this one is the right size for
   *  "the same as the release APK but for the other flavour". */
  onAssist: (seed: BuildDraftSeed) => void;
  /** Remove this entry from the repo's builds file. Drawn only for a `saved` one. */
  onDelete: () => void;
  onCancel: () => void;
  onSave: (b: BuildConfig, local: boolean) => void;
}) {
  const [local, setLocal] = useState(scope?.local ?? false);
  const [name, setName] = useState(draft.name);
  const [cmd, setCmd] = useState(draft.cmd);
  const [dir, setDir] = useState(draft.dir ?? "");
  const [params, setParams] = useState<BuildParam[]>(draft.params ?? []);
  /*
   * The wand's own question, asked HERE and not in the prompt.
   *
   * It read "ask me what I want before writing anything" and the session did
   * what a session does: it started working, on a button nobody had described.
   * A rule a model may decline is not a gate — so the question is a box in front
   * of the person now, `null` while it is shut, and NOTHING is spent until the
   * button under it is tapped.
   */
  const [brief, setBrief] = useState<string | null>(null);
  // The suggest list is open on a NEW build (nothing typed, everything to
  // offer) and shut on an edit, where the answer is already in the fields and
  // a list of sixty alternatives is just noise over them.
  const isNew = !draft.cmd && !draft.name;
  const [open, setOpen] = useState(isNew);

  // What is typed IS the query. An edit starts with its own command in the
  // boxes, which would filter the list down to itself, so the query only
  // follows the fields while this is a new build.
  const shown = filterCandidates(candidates ?? [], isNew ? `${name} ${dir}`.trim() : "");

  function use(c: BuildCandidate) {
    track("action:build.suggest.use");
    setName(c.name);
    setCmd(c.cmd);
    setDir(c.dir ?? "");
    setOpen(false);
  }

  // Placeholders the command (or the dir) names that no question answers. Not a
  // refusal and never a dimmed Save: the two ways to get here are a typo and a
  // half-finished edit, and both are cheaper to see now than in a shell error
  // twenty minutes later. The command runs with the braces still in it, which
  // is the loud failure `applyParams` deliberately keeps.
  const unknown = unknownParamRefs({ cmd, dir, params });

  return (
    <div className="sheet">
      <SheetHead title={<>{draft.cmd || draft.name ? "Edit build" : "New build"}</>} onClose={onCancel}>
        {/* The sheet's "set up" reads the whole repo and rewrites the list; this
            one is about the entry in front of you. Not gated on the link: it is
            the ordinary durable create-and-prompt path, so a tap on a dead
            tunnel opens the session when the link is back. */}
        <button className="key" title={ONE_BUILD_TITLE}
          onClick={() => setBrief((b) => (b === null ? "" : null))}>
          <Wand2 size={16} /> {ONE_BUILD_LABEL}
        </button>
      </SheetHead>
      <div className="form">
        <input className="search" placeholder="Name (e.g. Release APK)" value={name} onChange={(e) => setName(e.target.value)} autoFocus />
        <textarea className="search" rows={3} placeholder="Command (e.g. ./gradlew assembleRelease)" value={cmd}
          onChange={(e) => setCmd(e.target.value)} style={{ resize: "vertical", fontFamily: "monospace" }} />
        <input className="search" placeholder="Working sub-dir (optional, relative to repo root)" value={dir} onChange={(e) => setDir(e.target.value)} style={{ fontFamily: "monospace" }} />
      </div>
      {brief === null ? (
        <div className="form-hint">
          Tap <Wand2 size={12} style={{ verticalAlign: "-2px" }} /> {ONE_BUILD_LABEL} to say what you want in a sentence and have Claude work this one command out of the repo — one turn, this entry only.
        </div>
      ) : (
        <div className="build-assist">
          <div className="section">{ONE_BUILD_ASK}</div>
          {/* The one prompt-writing surface, inline — not a fifth textarea.
              `chain={false}`: this is a brief, not a conversation, and the
              session it opens is where anything further gets said. */}
          <PromptComposer inline rows={3} placeholder={ONE_BUILD_PLACEHOLDER}
            prompts={[brief]} onChange={(next) => setBrief(next[0] ?? "")} autoFocus />
          <div className="form-hint">{ONE_BUILD_ASK_NOTE}</div>
          <div className="sheet-actions">
            <button className="key" onClick={() => setBrief(null)}><X size={16} /> cancel</button>
            <span className="spacer" />
            {/* Nothing said and nothing typed ⇒ there is nothing to work out, and
                the verb is a SENTENCE rather than a dimmed button. A session
                opened on silence starts guessing, which is the bug this box is. */}
            {brief.trim() || name.trim() || cmd.trim()
              ? <button className="send" onClick={() => onAssist({ id: draft.id, brief, name, cmd, dir, existing: saved })}>
                <Wand2 size={14} /> {ONE_BUILD_LABEL}
              </button>
              : <Unavailable cants={[{ label: ONE_BUILD_LABEL, reason: ONE_BUILD_NOTHING }]} />}
          </div>
        </div>
      )}

      <ParamsEditor params={params} cmd={cmd} dir={dir} unknown={unknown} onChange={setParams} />

      {/* The count on the control is the count of what a tap opens — the
          filtered list, not the whole scan — so the number and the list cannot
          disagree. While the host has not answered, the control says it is
          reading rather than claiming a number. */}
      <div className="sheet-actions">
        <button className="key" onClick={() => { if (!open) track("action:build.suggest.open"); setOpen(!open); }}>
          {/* A spinner is a promise that something is coming. The link can
              drop between opening this editor and the host answering, and a
              "reading the repo…" that spins for ever is the one thing this
              control must not become — so with no socket it says what is
              actually true instead. */}
          {candidates !== null
            ? <><Search size={16} /> {open ? "hide" : "suggest"} ({shown.length})</>
            : online
              ? <><Loader size={16} className="spin" /> reading the repo…</>
              : <><CloudOff size={16} /> no connection</>}
        </button>
      </div>

      {open && (
        <div className="build-suggest">
          <div className="form-hint">
            From this repo’s own files — package.json scripts, gradle tasks, Makefile targets, CI workflow steps, scripts.
            Tap one to fill the fields above; nothing is saved or run until you tap Save.
            {candidates !== null && candidatesTotal > candidates.length && ` Showing the top ${candidates.length} of ${candidatesTotal} found.`}
          </div>
          <div className="list">
            {shown.map((c) => (
              <button key={`${c.dir ?? ""}|${c.cmd}`} className="row" onClick={() => use(c)}>
                <span className="row-title">
                  {c.name}
                  {c.already ? <> <span className="tag idle"><Check size={11} /> already a button</span></> : null}
                </span>
                <span className="row-sub mono">{c.dir ? `${c.dir}$ ` : ""}{c.cmd}</span>
                <span className="row-sub">{c.source}</span>
                {/* A publishing command is offered, not hidden — a release
                    script is a legitimate thing to want on a phone. What it is
                    NOT allowed to be is a surprise, since these run later with
                    nobody watching. */}
                {c.note ? <span className="row-sub warn"><AlertTriangle size={12} /> {c.note}</span> : null}
              </button>
            ))}
            {/* Three different nothings, and they are not interchangeable: the
                host has not answered; it answered and this repo describes no
                build at all; or it described plenty and the words in the Name
                box match none of them. Only the last one is undone by clearing
                a filter, and only the middle one says anything about the
                repo. */}
            {shown.length === 0 && (candidates === null ? (
              online
                ? <Empty>Reading this repo’s manifests…</Empty>
                : <Empty>
                    No connection, so this repo’s files could not be read — the scan happens on the desktop.
                    Type the command above; it is saved when the link is back.
                  </Empty>
            ) : candidates.length === 0 ? (
              <Empty>
                Nothing in this repo describes a build — no package.json scripts, no gradle or Make targets, no CI steps.
                Type the command above, or close this and tap “set up” to have Claude work it out from the repo.
              </Empty>
            ) : (
              <Empty>
                None of this repo’s {candidates.length} known commands match “{`${name} ${dir}`.trim()}”. Clear the Name field to see all of them.
              </Empty>
            ))}
          </div>
        </div>
      )}

      {scope && <BuildScopeChoice local={local} wasShared={saved && !scope.local} onChange={setLocal} />}

      <div className="sheet-actions">
        <button className="key" onClick={onCancel}><X size={16} /> cancel</button>
        {/* Delete is here and not on the sheet's rows: you are looking at the
            whole command you are about to lose, and it takes two taps. */}
        {saved && (
          <ConfirmButton title="delete this build command" confirm={<><Trash2 size={16} /> delete it?</>}
            onConfirm={() => { track("action:build.delete"); onDelete(); }}><Trash2 size={16} /> delete</ConfirmButton>
        )}
        <span className="spacer" />
        <button className="send" disabled={!cmd.trim()} onClick={() => { track("action:build.save"); onSave({ ...draft, name, cmd, dir, params: cleanBuildParams(params) }, local); }}>Save</button>
      </div>
    </div>
  );
}


/**
 * What this button will ASK for — the editor's half of parameters.
 *
 * Five fields per question is a lot of form for a phone, which is why the wand
 * above it exists and why this section is SHUT until there is something to show
 * or somebody opens it: the common case is a button with no questions at all,
 * and it should cost nothing to look at.
 *
 * Nothing here is validated into silence. An id the rules refuse is kept in the
 * box exactly as typed and the row says what an id may be — `cleanBuildParams`
 * runs on Save, so a refused row is dropped from the file and a person who
 * cannot see why would have no way to tell that from a bug.
 */
function ParamsEditor({ params, cmd, dir, unknown, onChange }: {
  params: BuildParam[];
  cmd: string;
  dir: string;
  unknown: string[];
  onChange: (next: BuildParam[]) => void;
}) {
  const [open, setOpen] = useState(params.length > 0 || unknown.length > 0);
  const set = (i: number, patch: Partial<BuildParam>) =>
    onChange(params.map((p, j) => (j === i ? { ...p, ...patch } : p)));

  return (
    <>
      <div className="sheet-actions">
        <button className="key" onClick={() => setOpen(!open)}>
          <HelpCircle size={16} /> {open ? "hide" : "asks for"} ({params.length})
        </button>
        {open && (
          <button className="key" onClick={() => onChange([...params, { id: "", kind: "text" }])}>
            <Plus size={16} /> question
          </button>
        )}
      </div>

      {/* A placeholder nothing answers, said where it can still be fixed. It is
          not an error: the command runs with the braces in it and fails loudly,
          which is the only outcome readable off a build log afterwards. */}
      {unknown.length > 0 && (
        <div className="form-hint warn">
          <AlertTriangle size={13} style={{ verticalAlign: "-2px" }} />{" "}
          {unknown.map((u) => `{{${u}}}`).join(", ")} {unknown.length === 1 ? "is" : "are"} in the command but nothing here answers {unknown.length === 1 ? "it" : "them"} — the shell will see the braces. Add a question with that id, or fix the spelling.
        </div>
      )}

      {open && (
        <div className="build-params">
          <div className="form-hint">
            A question is asked when you tap run. Its value is put into the command at <span className="mono">{"{{id}}"}</span> — and into the environment as <span className="mono">{paramEnvName("id")}</span>, whether the command names it or not. One question beats one button per app.
          </div>
          {params.map((p, i) => (
            <div key={i} className="build-param">
              <div className="set-row">
                <label>id
                  <input className="search mono" placeholder="app" value={p.id}
                    onChange={(e) => set(i, { id: e.target.value.trim() })} />
                </label>
                <label>label
                  <input className="search" placeholder="Garmin app" value={p.label ?? ""}
                    onChange={(e) => set(i, { label: e.target.value })} />
                </label>
                <label>kind
                  <select value={p.kind} onChange={(e) => set(i, { kind: e.target.value as BuildParam["kind"] })}>
                    <option value="text">typed in</option>
                    <option value="choice">picked from a list</option>
                  </select>
                </label>
                {p.kind === "choice" && (
                  <>
                    <label>list command
                      <input className="search mono" placeholder="ls -1 apps" value={p.optionsCmd ?? ""}
                        onChange={(e) => set(i, { optionsCmd: e.target.value })} />
                    </label>
                    <span className="set-note">Run in the repo root when the form opens, one option per line. Leave it empty and type the options below instead — a list that can change is better read than transcribed.</span>
                    <label>or fixed options
                      <input className="search" placeholder="debug, release" value={(p.options ?? []).join(", ")}
                        onChange={(e) => set(i, { options: e.target.value.split(",").map((x) => x.trim()).filter(Boolean) })} />
                    </label>
                  </>
                )}
                <label>default
                  <input className="search mono" placeholder="(none — an unattended run is refused)" value={p.default ?? ""}
                    onChange={(e) => set(i, { default: e.target.value })} />
                </label>
                <span className="set-note">
                  With no default, a run nobody is watching — a schedule, a chain, “run it now” — is refused in words rather than guessing this value.
                </span>
              </div>
              <div className="sheet-actions">
                {/* What this question is actually wired to, so an id that is in
                    the form but not in the command is visible here rather than
                    at run time. */}
                <span className="row-sub">
                  {p.id && (cmd + " " + dir).includes(`{{${p.id}}}`)
                    ? <>in the command as <span className="mono">{`{{${p.id}}}`}</span></>
                    : p.id
                      ? <>only in the environment — the command does not name <span className="mono">{`{{${p.id}}}`}</span></>
                      : <>an id is <span className="mono">app</span>, <span className="mono">flavour</span> — a letter, then letters, digits or underscores</>}
                </span>
                <span className="spacer" />
                <button className="key danger" title="remove this question"
                  onClick={() => onChange(params.filter((_, j) => j !== i))}><Trash2 size={16} /></button>
              </div>
            </div>
          ))}
          {params.length === 0 && <Empty>This button asks nothing — every tap runs the same command. Add a question to run it against one app, flavour or target.</Empty>}
        </div>
      )}
    </>
  );
}

/**
 * What becomes of what a build produces — the two switches, and the number.
 *
 * It is here rather than in a settings screen because it is read in the second
 * before a build is tapped — right under the commands it governs — and because
 * what it governs is visible nowhere else: a name in the download list, and
 * files that stop existing.
 *
 * The two switches are the Settings kit's `SetSwitch`, so the state is the
 * `on`/`off` at the row's edge and never a sentence on a button ("✓ collect +
 * name: on"). What the next build will do, in full, is one tap away behind the
 * head's `?`, so a switch never has to be decoded from its own label. The keep
 * count is a stepper on ONE line: the number is prose between two buttons, not
 * a third button, and a button at an end of the ladder is absent, never dimmed.
 *
 * Offline it is the sentence, drawn, and nothing else. The policy lives with
 * the project on the desktop; a switch that cannot save is not drawn as a
 * dimmed one (a `title` is invisible on a phone) — the reason is said instead.
 */
function ArtifactPolicyRow({ policy, online, onSave }: {
  policy?: ArtifactPolicy;
  online: boolean;
  onSave?: (p: ArtifactPolicy) => void;
}) {
  if (!policy || !onSave) return null;
  const set = (patch: Partial<ArtifactPolicy>) => onSave({ ...policy, ...patch });
  const sentence = <>Every build here: {artifactPolicyText(policy)}.</>;
  return (
    <div className="artifact-policy">
      <div className="section ap-head">
        What a build leaves
        {online && (
          <Explain of="what a build leaves">
            {sentence} <b>collect + name</b> copies what a build produces into .claude/outbox under a name carrying
            the repo, the variant and the version; <b>remove older</b> then deletes older builds of the same artifact
            from the outbox — never anything else.
          </Explain>
        )}
      </div>
      {online ? (
        <>
          <SetSwitch label="collect + name" icon={Package} on={policy.collect}
            onChange={() => { track("action:build.collect"); set({ collect: !policy.collect }); }} />
          {policy.collect && (
            <SetSwitch label="remove older" icon={Trash2} on={policy.prune}
              onChange={() => { track("action:build.prune"); set({ prune: !policy.prune }); }} />
          )}
          {policy.collect && policy.prune && (
            <div className="ap-keep">
              keep
              {policy.keep > 1 && (
                <button className="key" aria-label="keep one fewer" title="keep one fewer build of each artifact"
                  onClick={() => set({ keep: policy.keep - 1 })}><Minus size={14} /></button>
              )}
              <span className="ap-keep-n" aria-live="polite">{policy.keep}</span>
              {policy.keep < MAX_ARTIFACT_KEEP && (
                <button className="key" aria-label="keep one more" title="keep one more build of each artifact"
                  onClick={() => set({ keep: policy.keep + 1 })}><Plus size={14} /></button>
              )}
            </div>
          )}
        </>
      ) : (
        <div className="form-hint">
          <div><Package size={13} style={{ verticalAlign: "-2px" }} /> {sentence}</div>
          <div><CloudOff size={13} style={{ verticalAlign: "-2px" }} /> this is this device's copy — changing it needs the desktop, where the policy lives with the project.</div>
        </div>
      )}
    </div>
  );
}

/**
 * The form between the tap and the build: what this run is for.
 *
 * It exists because a parameterised command has no honest default run. Two
 * rules, both from `shared/buildparams.ts` and both re-asserted on the host:
 *
 *  • **Nothing is picked for you.** A choice with no answer yet shows no
 *    selection, and the run verb is REPLACED by the sentence saying what it
 *    still needs (`Unavailable.tsx` — never a dimmed button).
 *  • **A list that could not be read says so.** An `optionsCmd` that failed, or
 *    a phone with no link, falls back to a typed field WITH the reason. An empty
 *    drop-down and a broken one look identical, and only one of them is about
 *    this repo.
 */
function BuildRunAsk({ build, options, online, onCancel, onRun }: {
  build: BuildConfig;
  options?: Record<string, { options?: string[]; total?: number; error?: string }>;
  online: boolean;
  onCancel: () => void;
  onRun: (values: Record<string, string>) => void;
}) {
  // Seeded from the defaults and nothing else. A remembered "last value" is the
  // one thing that would make this form lie: the point of asking is that this
  // run may not be the last one.
  const [vals, setVals] = useState<Record<string, string>>(() => {
    const seed: Record<string, string> = {};
    for (const p of build.params ?? []) if (p.default) seed[p.id] = p.default;
    return seed;
  });
  const { values, missing } = resolveParamValues(build.params, vals);

  return (
    <div className="sheet">
      <SheetHead title={<><Play size={16} /> {build.name}</>} onClose={onCancel} />
      <div className="form-hint mono">{build.dir ? `${build.dir}$ ` : ""}{build.cmd}</div>
      <div className="build-params">
        {(build.params ?? []).map((p) => (
          <ParamField key={p.id} p={p} value={vals[p.id] ?? ""} answer={options?.[p.id]} online={online} asked={options !== undefined}
            onChange={(v) => setVals((prev) => ({ ...prev, [p.id]: cleanParamValue(v) }))} />
        ))}
      </div>
      <div className="sheet-actions">
        <button className="key" onClick={onCancel}><X size={16} /> cancel</button>
        <span className="spacer" />
        {missing.length === 0
          ? <button className="send" onClick={() => onRun(values)}><Play size={14} /> Run</button>
          : <Unavailable cants={[{ label: "run", reason: missingParamsText(missing) }]} />}
      </div>
      {!online && (
        <div className="form-hint">
          <CloudOff size={13} style={{ verticalAlign: "-2px" }} /> No connection: the run is queued and starts with these values once the link is back.
        </div>
      )}
    </div>
  );
}

/** One question, in whichever of its four states it is actually in. */
function ParamField({ p, value, answer, online, asked, onChange }: {
  p: BuildParam;
  value: string;
  answer?: { options?: string[]; total?: number; error?: string };
  online: boolean;
  /** Has the host been asked at all yet? Un-asked and answered-with-nothing are
   *  two different claims, and only the second is about this repo. */
  asked: boolean;
  onChange: (v: string) => void;
}) {
  const discovered = answer?.options;
  const list = discovered ?? p.options ?? [];
  const waiting = p.kind === "choice" && !!p.optionsCmd && !answer && !p.options?.length;
  const typed = p.kind === "text" || (!list.length && !waiting);

  return (
    <div className="build-param">
      <div className="set-row">
        <label>{paramLabel(p)}
          {typed
            ? <input className="search mono" value={value} autoFocus={!value} onChange={(e) => onChange(e.target.value)} />
            : waiting
              ? <span className="set-note">{online
                ? <><Loader size={13} className="spin" style={{ verticalAlign: "-2px" }} /> reading the list…</>
                : <><CloudOff size={13} style={{ verticalAlign: "-2px" }} /> no connection — the list is read on the desktop</>}</span>
              : <select value={value} onChange={(e) => onChange(e.target.value)}>
                {/* No selection until there is one. The first option is not an
                    answer somebody gave. */}
                <option value="">— pick one —</option>
                {list.map((o) => <option key={o} value={o}>{o}</option>)}
              </select>}
        </label>
        {p.hint && <span className="set-note">{p.hint}</span>}
        {/* Where the list came from, shown because it is a command out of the
            build config that ran when this form opened — before anybody
            confirmed a run. Never a surprise. */}
        {p.optionsCmd && !p.options?.length && (
          <span className="set-note">from <span className="mono">{p.optionsCmd}</span> in the repo{answer?.total && answer.total > list.length ? ` · showing ${list.length} of ${answer.total}` : ""}</span>
        )}
        {answer?.error && (
          <span className="set-note warn">
            <AlertTriangle size={12} style={{ verticalAlign: "-2px" }} /> {answer.error} — type the value instead.
          </span>
        )}
        {typed && !p.optionsCmd && p.kind === "choice" && asked && !list.length && (
          <span className="set-note">no options to offer — type the value.</span>
        )}
      </div>
    </div>
  );
}

/**
 * One produced file: what it is, and what its download is doing.
 *
 * The row used to be a bare button that fired a download and looked identical
 * afterwards — so a 90 MB APK on a bad link invited a second tap, and a file
 * already on the phone offered no way to save it out. The verb is the app's one
 * download button now (`DownloadButton.tsx`); the row keeps the naming.
 */
function ArtifactRow({ a, repoDir, repoName, onDownload }: {
  a: BuildArtifact;
  repoDir: string;
  repoName: string;
  onDownload: (a: BuildArtifact) => void;
}) {
  return (
    <div className="row-wrap">
      <button className="row grow" title={a.relPath} onClick={() => { track("action:build.artifact"); onDownload(a); }}>
        <span className="row-title"><Download size={14} /> {a.name}</span>
        {/* A build whose outputs were already current writes no file — gradle
            says UP-TO-DATE and the APK it would have produced is right there,
            older than the run. The host offers those anyway rather than
            reporting nothing; the row has to say which kind it is, because
            "download this" and "this run made this" are different claims. */}
        {/* The file's OWN date, beside its size. For a stale artifact this is
            the entire point: "unchanged by this run" says the bytes predate the
            run without saying by how much, and a phone showing two same-sized
            APKs has nothing else to separate them. */}
        <span className="row-sub">{fmtSize(a.size)}{a.mtime ? ` · ${when(a.mtime)}` : ""}{a.stale ? " · unchanged by this run (already up to date)" : ""}</span>
      </button>
      <DownloadButton compact trackId="action:build.artifact"
        target={{ repoId: a.repoId, relPath: a.relPath, name: a.name, size: a.size, mtime: a.mtime, repoDir, repoName }} />
    </div>
  );
}
