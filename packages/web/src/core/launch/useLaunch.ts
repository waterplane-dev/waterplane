/**
 * **The launch core: every way a session is started, and the two questions a
 * fresh start may have to ask first.**
 *
 * Moved out of `App.tsx` whole (WP6). What lives here is what there must be
 * ONE of: `createOp` (the one `session.create` constructor, through
 * `wireLaunch`), `askLaunchFirst` + `hostedGate` (the one seam every fresh
 * start passes), the start sites themselves (`openRepo`/`openRepoWith`,
 * `openCwd`, `startSessionWithPrompt`, `runForkRequest`, `relaunch`), the
 * launcher's default launch opts and the capability readers built on
 * `backends`. The sheets that finish a deferred tap are `LaunchSheets.tsx`
 * and `ModelSheet.tsx`.
 *
 * **The inner functions stay at TWO-space indent, as methods of this hook.**
 * `createOp.test.mjs` attributes every createOp call to the enclosing
 * `  function name(` and fails a create site that is in neither FRESH_STARTS
 * nor NOT_FRESH; top-level exports would lose that attribution.
 *
 * `newAckId()` is minted here three times (`openRepoWith`, `openCwd`,
 * `startSessionWithPrompt`): each names the create's own ack so the pending
 * screen and the prompt chain can address it before the queue has sent it.
 * `core/queue/queue.test.mjs` counts them by file.
 */
import { createElement, useRef, useState } from "react";
import type { BackendInfo, LaunchOpts, RepoTarget, SessionBudget, SessionInfo } from "@waterplane/shared";
import { repoBranchLabel } from "@waterplane/shared";
import { newAckId } from "../../outbox.ts";
import { loadLaunch, saveReposSnap } from "../../localState.ts";
import { askConfirm } from "../../Confirm.tsx";
import { CantInline } from "../../Unavailable.tsx";
import { noteSynced } from "../../link.ts";
import { launchLabel, resumeIdOf } from "../../sessionFacts.tsx";
import { backendIdOf, backendMark, isShellBackend, backendUnavailable, capReason, hasCap, launchFor, shellBackend, shouldAskLaunch } from "../../backendCaps.ts";
import { needsHostedAck, readHostedAck } from "../../hostedAck.ts";
import { showToast } from "../../toast.ts";
import { track } from "../../usage.ts";
import { api } from "../../api.ts";
import { LS, lsSetJson } from "../../storage.ts";
import type { ForkRequest } from "../../ForkTurn.tsx";
import type { Overlay } from "../../routing.ts";
import { core, type DurableOp } from "../../sdk/index.ts";
import type { QueueApi } from "../queue/useQueue.ts";
import { launchSheets, type AskedBudget, type LaunchSheets } from "./LaunchSheets.tsx";
import { pendingLaneId } from "../queue/logic.ts";
import { prefRef } from "../prefs.ts";

/** How long a reset's confirm waits for the worktree's drift before it opens
 *  without that line (`resetFileDrift`). */
const DIRTY_PEEK_MS = 1200;

export interface LaunchDeps {
  /** What this host said it can launch — `null` means it never said. App owns
   *  it (the `welcome`/`backends` cases write it). */
  backends: BackendInfo[] | null;
  setOverlay(o: Overlay): void;
  /** The live terminal geometry (`useTermFeed`): every create is sized by it. */
  geomRef: { readonly current: { cols: number; rows: number } };
  /** The one send path. */
  queue: Pick<QueueApi, "queueOp" | "enterPending" | "queueSessionPrompt" | "submitInput">;
  /** `refreshRepos`' writers — the listing is App's world state. */
  setRepos(r: RepoTarget[]): void;
  setReposAt(ts: number): void;
  setReposFailAt(ts: number): void;
  /** The host root (`NewMenu`) and this render's repo listing. */
  root: string;
  repos: RepoTarget[];
  /** The session on screen (a pending one included) — the model sheet's subject. */
  active: SessionInfo | null | undefined;
  /** Getters, because App derives both after this hook runs: the opens already
   *  in flight per repo (`openRepo`'s toast) and a cwd's repo (`resetFileDrift`). */
  openingCwds(): ReadonlyMap<string, { status: string; n: number }>;
  repoForCwd(cwd: string): RepoTarget | null | undefined;
}

export function useLaunch(deps: LaunchDeps) {
  const { backends, setOverlay, geomRef, setRepos, setReposAt, setReposFailAt } = deps;
  /** The launch-ask switch (`waterplane.launchAsk`), as a ref: the gate is read
   *  from timers and the queue pump, where a closure can be a render behind. */
  const launchAskRef = prefRef("launchAsk");
  const { queueOp, enterPending, queueSessionPrompt } = deps.queue;
  const repoForCwd = deps.repoForCwd;
  /**
   * The open that is WAITING on that question: what the sheet says it is about,
   * and the RESUMPTION — the rest of the tap, as a thunk taking the answer.
   *
   * A thunk and not a `{ cwd, title }`, because there is no single create to
   * re-enter. Three different taps start a fresh session and each carries
   * something the others do not — the launcher row's toast about what is
   * already opening in that repo, the Start sheet's prompt chain and its
   * `needs`, a bare open's resume flags — and reducing them to a cwd here would
   * mean rebuilding whichever one it was afterwards, wrongly. The question is
   * the only thing this state owns; everything else stays where it was written.
   *
   * Never persisted and never in the route: a reload here is an answer of "not
   * now", and a restored sheet would offer to start something the person had
   * already navigated away from — with a thunk from a previous page, at that.
   * Nothing is queued until Start is pressed, so dropping it costs nothing.
   */
  /** `onCancel` is what the deferred tap has to UNDO if the question is
   *  dismissed. The words a person typed were already handed over by the sheet
   *  that posed this (the Send sheet clears its draft the moment `onSend`
   *  returns true), so a cancel with nothing to run is a delete unless the
   *  caller is given its chance to put them back — see `startSessionWithPrompt`. */
  const [launchAskFor, setLaunchAskFor] = useState<
    { title: string; run: (launch: LaunchOpts, budget?: AskedBudget) => void; onCancel?: () => void; budget?: SessionBudget } | null
  >(null);
  /**
   * The launch held at the hosted-model gate — the same state shape, and held
   * here for the same three reasons (`launchAskFor` above).
   *
   * One thing is different and it is the point: what is kept is the EXACT opts
   * that were gate-checked, not a cwd to re-derive them from. The per-launch ask
   * may have answered a different model two taps ago, and resuming on a fresh
   * read of the defaults would start something other than the thing the person
   * was just shown a warning about.
   */
  const [hostedAskFor, setHostedAskFor] = useState<
    { title: string; launch: LaunchOpts; run: (launch: LaunchOpts, budget?: AskedBudget) => void; onCancel?: () => void; budget?: AskedBudget } | null
  >(null);
  const [launch, setLaunch] = useState<LaunchOpts>(loadLaunch);
  /** The worktree row whose branch picker is open (`branches`). */
  const [branchPick, setBranchPick] = useState<RepoTarget | null>(null);
  /** The model sheet's typed id — kept across opens, as it always was. */
  const [modelInput, setModelInput] = useState("");
  /** …read by `hostedGate`, which runs from a callback the launch-ask sheet
   *  holds across renders: the list can arrive on `hello` while that question
   *  is up, and a closure captured before it would read a hosted model as a
   *  host that described nothing. */
  const backendsRef = useRef(backends);
  backendsRef.current = backends;
  // The repo listing is one of the two halves of a "full sync" (`netsync.ts`) —
  // it is a separate HTTP call, so it can be hours stale while the socket is
  // perfectly healthy, and only a landed one may stamp the clock.
  /**
   * Re-read the repo listing — an HTTP call, separate from the socket, which is
   * why it can be stale while everything else on the launcher looks live.
   *
   * A failure keeps the last snapshot (the launcher must not empty itself over
   * one bad request) but no longer keeps QUIET about it: `reposAt` is the
   * moment the listing last came from the host, and the section head says so
   * once it is old enough to matter. A spinner that counts upward — which is
   * all the activity strip could offer — tells you the app has given up without
   * admitting it; a row that says "as of 20 min ago" is the same fact, acted on.
   */
  function refreshRepos() {
    api.repos()
      .then((r) => { setRepos(r); saveReposSnap(r); setReposAt(Date.now()); noteSynced("repos"); })
      .catch(() => { setReposFailAt(Date.now()); /* keep the last snapshot — `reposAt` stays where it was, so its age keeps growing */ });
  }
  function setLaunchOpt(patch: Partial<LaunchOpts>) {
    setLaunch((l) => {
      const n: LaunchOpts = { ...l, ...patch };
      // Drop empty selections so we fall back to Claude Code defaults.
      (Object.keys(n) as (keyof LaunchOpts)[]).forEach((k) => { if (!n[k]) delete n[k]; });
      lsSetJson(LS.launch, n);
      return n;
    });
  }
  /**
   * The launch opts as they may go on the wire (`backendCaps.launchFor`).
   *
   * Every `session.create` goes through this, and not as a tidy-up: `launch`
   * is persisted AND synced, so a `backend` chosen on one desktop is in
   * localStorage when this phone next talks to a host that has never heard of
   * backends. Stripping it here is the gate — an old desktop is never asked to
   * spawn a binary it does not know, and a backend that has no effort knob is
   * never handed `--effort`.
   *
   * Reads `backendsRef`, never the render's `backends`: the launch-ask sheet
   * holds a thunk from the TAP, and `hello` can land while it is up — a cold
   * start (no list yet) answered with opencode + `ollama/…` would otherwise be
   * stripped against `null` and spawn `claude --model ollama/…`.
   */
  const wireLaunch = (o: LaunchOpts) => launchFor(o, backendsRef.current);
  /**
   * **The one place a `session.create` is built.**
   *
   * "Every create goes through `wireLaunch`" was written in three comments and
   * true at three of five call sites. The two that opted out were the worktree
   * start-point row and the Start sheet — the PRIMARY offline entry point —
   * and both sent the raw persisted `launch`. `launch` is synced, so a
   * `backend` + `provider/model` pair picked on one desktop sits in another
   * phone's localStorage; point that phone at a host that predates backends
   * (no `backends` frame, so the picker is correctly absent and the user never
   * chose anything) and the create carries `backend: "opencode"`,
   * `model: "ollama/qwen3-coder:30b"`. The old host drops the unknown field and
   * spawns `claude --model ollama/qwen3-coder:30b` — exactly the spawn the
   * picker gate exists to prevent.
   *
   * So the rule is not a comment any more. There is one constructor, it applies
   * `wireLaunch` itself, and it also owns the two fields every site repeated
   * identically (`cols`/`rows` — a create measured from anywhere but the live
   * geometry is a session the CLI cannot draw a composer in). A sixth create
   * site inherits all of it by having nowhere else to get an op from, and
   * `createOp.test.mjs` fails the build if one is written by hand anyway.
   */
  function createOp(o: Omit<Extract<DurableOp, { t: "session.create" }>, "t" | "cols" | "rows" | "ackId">): DurableOp {
    const { launch: l, ...rest } = o;
    return {
      t: "session.create",
      ...rest,
      cols: geomRef.current.cols,
      rows: geomRef.current.rows,
      ...(l ? { launch: wireLaunch(l) } : null),
    };
  }
  /**
   * **The one gate for "ask which backend and model first"** — and the reason it
   * is a helper rather than three copies of an `if`.
   *
   * A fresh session starts from three different taps, and only one of them is
   * `openCwd`: the launcher's repo row (`openRepo`) and the Start sheet
   * (`startSessionWithPrompt`) each build their own `createOp` because each
   * carries something the others do not — a toast about what is already opening
   * in that repo, a prompt chain with `needs` riding in the same lane. Gating
   * only `openCwd` is exactly what shipped first, and the switch then did
   * nothing at all for the tap people actually use. So the rule lives here, the
   * caller hands over the REST of its own tap, and adding a fourth start means
   * one line rather than remembering a rule written three screens away.
   *
   * Returns true when the tap has been DEFERRED — the caller must return
   * immediately and do nothing else; `run` gets the answer and finishes the job.
   * Returns false when nothing is being asked, and the caller carries on.
   *
   * **It is now TWO questions through one seam**, and that is deliberate: the
   * hosted-model acknowledgement (`hostedAck.ts`) has to fire on exactly the
   * same set of taps, and a second helper beside this one is a second list of
   * start sites to keep in sync — which is the failure this helper exists for,
   * repeated. So the launch-ask asks first, and whichever launch comes out of
   * that branch — the answered one, or the caller's own — goes through the
   * hosted gate before anything is queued. `createOp.test.mjs` fails by name on
   * a start site that stops handing its launch over.
   */
  function askLaunchFirst(
    title: string,
    /** `launch` is what this caller WOULD otherwise run — the override it was
     *  handed, or the stored defaults. The hosted gate has nothing to check
     *  without it. */
    /** `onCancel`: what to do if the question is DISMISSED rather than
     *  answered. A caller that was holding words for this tap passes the way
     *  back to them; one that was holding nothing passes nothing. */
    opts: { resume?: boolean; override?: boolean; launch?: LaunchOpts; onCancel?: () => void; budget?: SessionBudget },
    run: (launch: LaunchOpts, budget?: AskedBudget) => void,
  ): boolean {
    // **A backend the host says cannot start now is not started.** The launch ask
    // is off by default, so its Start-replacing sentence is not on the path most
    // taps take; without this the create is queued and the session dies inside
    // its pane with nothing said. Said here, at the one seam every start site
    // goes through (the ask's own sheet shows the same sentence in place of its
    // Start button). Nothing is queued, and a caller holding words gets them back.
    const dead = backendUnavailable(backendsRef.current, opts.launch?.backend);
    if (dead && !shouldAskLaunch(launchAskRef.current, !!opts.resume, !!opts.override)) {
      showToast(`Not started — ${dead}`);
      opts.onCancel?.();
      return true;
    }
    if (shouldAskLaunch(launchAskRef.current, !!opts.resume, !!opts.override)) {
      // The ANSWER is what gets gate-checked, not the defaults the sheet
      // started from — the whole point of that sheet is that they differ. The
      // wrapper matters most for `openRepo`, whose `run` goes to
      // `openRepoWith` and never re-enters this helper.
      setLaunchAskFor({
        title,
        run: (l, b) => { if (!hostedGate(title, l, run, opts.onCancel, b)) run(l, b); },
        onCancel: opts.onCancel,
        budget: opts.budget,
      });
      setOverlay("launchask");
      return true;
    }
    // **A resume SKIPS the gate.** The acknowledgement is about the FIRST
    // hosted launch: a resumed conversation already sent its prompts and its
    // files to that operator, and stopping the continuation to warn about
    // something that has already happened is a dialog with nothing behind it.
    if (opts.resume) return false;
    return hostedGate(title, opts.launch, run, opts.onCancel, undefined);
  }
  /**
   * "Does this launch need the hosted notice first?" — the deferral half.
   *
   * Returns true when the tap has been DEFERRED, on `askLaunchFirst`'s contract,
   * so a caller reads the two the same way. The decision itself is
   * `needsHostedAck`, which is pure, node-tested, and refuses to read an unknown
   * model as a hosted one.
   *
   * Nothing here refuses anything: an un-acknowledged device is not blocked from
   * launching, the host is never told, and a queued create draining from another
   * phone is not gated by this one's answer. It is a sentence somebody reads.
   */
  function hostedGate(
    title: string,
    l: LaunchOpts | undefined,
    run: (launch: LaunchOpts, budget?: AskedBudget) => void,
    onCancel?: () => void,
    budget?: AskedBudget,
  ): boolean {
    if (!l || !needsHostedAck(backendsRef.current, l, readHostedAck())) return false;
    track("overlay:hostedack");
    setHostedAskFor({ title, launch: l, run, onCancel, budget });
    setOverlay("hostedack");
    return true;
  }
  /** Which backend a session runs, and whether it can do a given thing. Absent
   *  `backend` is claude; an undescribed host answers "yes" to everything,
   *  which is exactly today's UI. */
  const sessionCan = (s: { backend?: string } | null | undefined, cap: Parameters<typeof hasCap>[2]) =>
    hasCap(backends, s ? backendIdOf(s) : undefined, cap);
  /** …and the sentence that stands where the control would have been, or null
   *  when the control is drawn. Never a greyed button, never a `title`. */
  const sessionCant = (s: { backend?: string } | null | undefined, cap: Parameters<typeof capReason>[2]) =>
    capReason(backends, s ? backendIdOf(s) : undefined, cap);
  /**
   * What a reopen/resume ROW has to say for itself before it is tapped.
   *
   * The `resumePick` sentence — "no pick-an-older-conversation list this desktop
   * knows how to drive; reopening carries on the folder's own conversation
   * instead" — is a fact about a DECISION, and it was only ever reachable from
   * inside a session that had already been opened. That is the wrong screen and
   * the wrong moment: by the time the strip under the toolbar says it, the
   * folder's conversation is the one you are in.
   *
   * So it is rendered on the row, and only where it is BOTH true and load-
   * bearing: a backend with no picker (claude, and every host that never
   * described a backend, answer null — those rows keep their exact pixels) AND
   * no id on this row to resume exactly. A row that carries an id gets an exact
   * reopen and nothing to warn about.
   *
   * `CantInline` rather than `Unavailable` because a launcher row is a flex
   * line with no room for a block of its own, which is the case that component
   * exists for. It is still a SENTENCE and still not a dimmed control — the
   * reopen button beside it works, it is simply less precise than it looks.
   */
  const reopenCant = (r: { cwd: string; launch?: LaunchOpts; claudeSessionId?: string; backendSessionId?: string; unadopted?: string }) => {
    // A still-running pane the host could not take back (its backend's plugin is
    // not running) says so, in the host's own sentence, before anything else.
    if (r.unadopted) return createElement(CantInline, null, r.unadopted);
    if (isShellBackend(backends, r.launch?.backend)) return null; // a fresh shell, nothing approximate about it
    if (resumeIdOf(r)) return null;
    const reason = capReason(backends, r.launch?.backend, "resumePick");
    return reason ? createElement(CantInline, null, reason) : null;
  };
  /* What the NEW-SESSION model control may offer now lives in `ModelField`,
     which the per-session ask shares. The pair that stood here offered
     `aliases || ids` — never both — so claude's version list was in the table,
     shipped, and unreachable from the control that is supposed to show it. */
  /** Choose the backend new sessions run — and drop the model and effort with
   *  it, which belonged to the catalogue being left behind. */
  const pickBackend = (id: string | undefined) => setLaunchOpt({ backend: id, model: undefined, effort: undefined });

  function openRepo(t: RepoTarget) {
    // A create already in flight here is NOT a reason to refuse this one. The
    // impatient double-tap this used to guard against was a symptom of the tap
    // showing nothing; it lands on a pending session screen now, immediately,
    // so the remaining reading of "+ again" is the honest one: a SECOND session
    // in this repo, with its own prompt, posted when the link is back. Both
    // creates share the `create:<cwd>` lane, so they are delivered one at a
    // time, and `serialSessions` is what keeps two agents out of one worktree.
    // With no link there is nothing to show but the queue, so say what is
    // already in it before adding to it.
    const inFlight = deps.openingCwds().get(t.worktreePath);
    if (inFlight) {
      showToast(inFlight.status === "pending"
        ? `${inFlight.n > 1 ? `${inFlight.n} already opening` : "one already opening"} in ${t.repoName} — this is another`
        : `${inFlight.n > 1 ? `${inFlight.n} already queued` : "one already queued"} in ${t.repoName} — this is another`);
    }
    // With no link, "open a session here" queues an EMPTY terminal for later —
    // which is nothing anyone wanted: the session isn't the goal, the work that
    // runs in it is, and by the time it opens you may not be looking. So the
    // offline tap goes to the start sheet instead, where the prompts that
    // should fire once the CLI is up are written first and ride in the same
    // lane as the create. Online, tapping still opens straight away.
    //
    // "Connecting" is NOT that outage, though: a tab-switch or a radio blip
    // reconnects in a fraction of a second, and hijacking the launcher into a
    // prompt sheet for it is the opposite of responsive. Take the detour only
    // once the disconnect has outlived the banner's own grace window
    // (`connVisible`) — a blip queues the create durably, which is what the
    // queue is for, and says so.
    // Durable: the tap survives a dead tunnel and the host de-dupes the retry,
    // so this can never leave two claude processes in one worktree. The screen
    // opens on the tap — offline included, which is what this branch used to
    // divert to the Send sheet for. The sheet answered a real complaint (an
    // empty terminal queued for later is not what anyone wanted) with a second,
    // poorer surface; the pending session answers it with the SAME surface,
    // where the prompts can be written, chained and given files while the link
    // is still down.
    // Asked BEFORE the pending screen, not after: the screen is the session, and
    // one that appears while the question is still up is a session already
    // started under the defaults the question exists to override.
    const name = repoBranchLabel(t);
    if (askLaunchFirst(name, { launch }, (l, b) => openRepoWith(t, l, b ?? undefined))) return;
    openRepoWith(t, launch);
  }
  /** The rest of `openRepo`, once the launch is settled — by the defaults, or by
   *  the answer to `askLaunchFirst`. */
  function openRepoWith(t: RepoTarget, launch: LaunchOpts, budget?: SessionBudget) {
    const createAck = newAckId();
    const offline = queueOp(
      createOp({ cwd: t.worktreePath, title: repoBranchLabel(t), launch, ...(budget ? { budget } : {}) }),
      `create:${t.worktreePath}`, `open ${repoBranchLabel(t)}`, { cwd: t.worktreePath, focus: true, ackId: createAck },
    );
    if (offline) track("action:repo.new.offline");
    enterPending(createAck);
  }
  /**
   * "Open a shell here" — a plain login shell in the repo's worktree, through
   * the same `openCwd` (one create path). The launch is passed as an OVERRIDE,
   * which is what keeps the launch-ask from posing "which model?" to a binary
   * that has none, and `shouldAskLaunch` never asks over a caller that decided.
   * Only offered where the host's `backends` frame lists a `kind: "shell"`
   * backend (`backendCaps.shellBackend`); `launchFor` would otherwise strip it
   * and spawn claude.
   */
  function openShell(t: RepoTarget): string | null {
    const sh = shellBackend(backendsRef.current);
    if (!sh) { showToast("This desktop can’t open a shell — it needs an update."); return null; }
    track("action:shell.new");
    return openCwd(t.worktreePath, `shell · ${repoBranchLabel(t)}`, false, undefined, { backend: sh.id });
  }
  /**
   * A temporary companion shell for session `s`: a plain shell in its folder,
   * opened as its own tab, that the HOST closes when `s` is closed
   * (`companionOf`, host `drive.remove`). `openShell`'s path exactly — the
   * launch is an override, so nothing asks which model.
   */
  function openCompanionShell(s: SessionInfo): string | null {
    const sh = shellBackend(backendsRef.current);
    if (!sh) { showToast("This desktop can’t open a shell — it needs an update."); return null; }
    track("action:shell.companion");
    return openCwd(s.cwd, `shell · ${s.title}`, false, undefined, { backend: sh.id }, undefined, undefined, s.id);
  }
  /** Open a session in `cwd`. Returns the PENDING screen's session id it put
   *  on screen (`pending:<createAck>`), or null when the tap was deferred to a
   *  launch question — so a caller that owes that screen words can seed its
   *  draft (`compose.seedDraft`) rather than typing into the box it is leaving. */
  function openCwd(cwd: string, title: string, resume = false, resumeMode?: "continue" | "pick" | "fork", launchOverride?: LaunchOpts, resumeSessionId?: string, budget?: SessionBudget, companionOf?: string): string | null {
    // Not a RESUME (a resumed conversation carries the launch it was recorded
    // with; asking offers to continue it under a different binary) and not over
    // an OVERRIDE (the archive's explicit claude, a relaunch, a worktree row
    // replaying its own opts — each has answered this by passing it in).
    // Re-entered with the answer as the override, which is also what stops the
    // second pass asking again.
    // A shell has no conversation: "resume" of a shell row is a FRESH shell in
    // the same folder, never `--continue` (which would be a claude flag, and a
    // recorded conversation id that does not exist).
    if (resume && isShellBackend(backendsRef.current, launchOverride?.backend)) {
      resume = false; resumeMode = undefined; resumeSessionId = undefined;
    }
    if (askLaunchFirst(title, { resume, override: !!launchOverride, launch: launchOverride ?? launch },
      (l, b) => { openCwd(cwd, title, resume, resumeMode, l, resumeSessionId, b === undefined ? budget : b ?? undefined, companionOf); })) return null;
    track(resume ? "action:session.resume" : "action:session.new");
    const createAck = newAckId();
    queueOp(
      createOp({ cwd, title, resume, resumeMode, resumeSessionId, launch: launchOverride ?? launch, ...(budget ? { budget } : {}), ...(companionOf ? { companionOf } : {}) }),
      `create:${cwd}`, `${resume ? "resume" : "open"} ${title}`, { cwd, focus: true, ackId: createAck },
    );
    // Same screen for a resume as for a fresh open: what is being waited for is
    // a PTY either way, and the wait is the thing that had no home.
    enterPending(createAck);
    return pendingLaneId(createAck);
  }
  /**
   * The one thing a reset's confirm can say that the conversation cannot tell it:
   * what the turns being discarded already did to the WORKTREE.
   *
   * "No file in the repo is touched" is true and is the sentence people need
   * first — but it has a corollary that is easy to read past, and it is the only
   * way a reset can surprise you: the edits those turns made are still on disk,
   * and the reopened session has no memory of making them. A clean tree makes
   * that a non-event; a dirty one means the next turn starts by reading code its
   * own conversation never mentions. So the line is drawn only when there IS
   * drift, and it names the count — a warning that fires every time is furniture.
   *
   * `api.gitStatus` and not `session.closecheck`, which is the precedent for
   * asking this question but not a reusable one: its reply frame carries only a
   * session id, and App's handler for it unconditionally treats an answer as
   * "the user is closing this session" — a clean tree there sends
   * `session.remove` on the spot. Borrowing it would mean archiving the very
   * session the reset is about to reopen. The HTTP read has no such second
   * meaning, and it is a read.
   *
   * Never blocks the dialog: an unknown repo, a refusal, or a link too slow to
   * answer within `DIRTY_PEEK_MS` all mean "no extra line". The other four
   * sentences stand on their own, and a confirm that waits on the network is a
   * button that looks broken at exactly the moment the user is being careful.
   */
  async function resetFileDrift(cwd: string): Promise<string | null> {
    const id = repoForCwd(cwd)?.id;
    if (!id) return null;
    try {
      const st = await Promise.race([
        api.gitStatus(id),
        new Promise<null>((r) => setTimeout(() => r(null), DIRTY_PEEK_MS)),
      ]);
      const n = st?.files.length ?? 0;
      if (!st || st.clean || n === 0) return null;
      return `The worktree has ${n} uncommitted change${n === 1 ? "" : "s"} — those edits stay exactly as they are, but the reopened session won't remember making them.`;
    } catch {
      return null; // not a git repo, git not on the PATH, host refused — no line
    }
  }
  /**
   * "Fork from here" / "reset to here", composed in the reader.
   *
   * Both are ONE `session.create`: the host copies the conversation up to just
   * before that turn into a new log and resumes THAT (`forkAtTurn`, host/convfork.ts). The
   * only difference is `replaceSessionId` — reset kills the session it came
   * from, fork leaves it running — which is exactly the relaunch op above, so
   * the kill and the create cannot be separated by a dropped socket.
   *
   * Reset therefore goes through `askConfirm`: it is the one of the two that
   * destroys something (a running PTY, and a turn in flight with it). What it
   * does NOT destroy is worth saying in the dialog, because "reset" reads like
   * a delete: the discarded turns stay on disk under the original conversation
   * id, stay listed in the archive, and `deleteArchived` remains the only way to
   * lose a conversation. Neither verb touches a file in the repo.
   *
   * The reader disables both while the socket is down, so this is composed
   * online; `queueOp` is still the path, because the ack ledger is what makes a
   * retry that races the first delivery harmless.
   */
  async function runForkRequest(cur: SessionInfo, req: ForkRequest) {
    if (req.mode === "reset") {
      const drift = await resetFileDrift(cur.cwd);
      const lines = [
        `This session reopens holding the conversation up to just before turn #${req.n}. #${req.n} and everything after it are left behind.`,
        ...(cur.turnActive ? ["A turn is running right now — it will be interrupted."] : []),
        "Nothing is deleted: the later turns stay on disk under this conversation and stay listed in the archive. Deleting one is a separate act.",
        "No file in the repo is touched — only the conversation is rewound.",
        ...(drift ? [drift] : []),
      ];
      if (!(await askConfirm({ title: `Reset to before #${req.n}?`, lines, confirmLabel: "Reset" }))) return;
    }
    // The fork is a different conversation and needs a name that says where it
    // came from. A reset IS this conversation, rewound, so it keeps its title.
    const title = req.mode === "fork" ? `${cur.title} (before #${req.n})` : cur.title;
    // The flags THIS session ran with, not whatever the launcher currently
    // offers: a fork is the same conversation continued, and reopening it on a
    // different model silently changes the thing being compared. Same rule
    // `sessions.fork()` follows on the host.
    // …including the BACKEND. A fork that reopened this conversation under a
    // different binary would not be the same conversation continued, which is
    // the one thing both verbs promise.
    const flags: LaunchOpts = { model: cur.model, effort: cur.effort, permissionMode: cur.permissionMode, remoteControlled: cur.remoteControlled, backend: cur.backend };
    const offline = queueOp(
      createOp({
        cwd: cur.cwd, title,
        launch: flags, resumeMode: "fork", resumeSessionId: req.sourceId, forkAtTurn: req.turnId,
        ...(req.mode === "reset" ? { replaceSessionId: cur.id } : null),
      }),
      `create:${cur.cwd}`,
      req.mode === "fork" ? `fork ${cur.title} before #${req.n}` : `reset ${cur.title} to before #${req.n}`,
      { cwd: cur.cwd, focus: true },
    );
    showToast(offline
      ? "queued — the link dropped; it runs when it is back"
      : req.mode === "fork"
        ? `forking before #${req.n} — a new session opens here`
        : `resetting to before #${req.n}…`);
  }
  /**
   * The model sheet's relaunch — handed an explicit launch, so NOT a fresh
   * start (`createOp.test.mjs`'s NOT_FRESH): kill THIS session and start it
   * again on `patch`, as ONE durable op.
   */
  function relaunch(cur: SessionInfo, patch: Partial<LaunchOpts>) {
    // This session's own backend, not the launcher's current default: a
    // relaunch replaces THIS session, and swapping the binary under it
    // because the new-session picker has moved on since is not a relaunch.
    const next: LaunchOpts = wireLaunch({ ...launch, backend: cur.backend, ...patch });
    setLaunchOpt(patch);
    // Kill + create as ONE durable op (`replaceSessionId`), never a bare
    // `session.kill` beside a queued create: the kill is a plain socket write
    // the ws layer DROPS while the tunnel is down, while the create survives
    // in localStorage — so an offline relaunch whose tab then dies replays
    // only the create and leaves two claude processes in the same worktree.
    // Inside the op the host kills first and the pair is at-most-once on one
    // ackId; a target that is already gone is not an error.
    // …and the SAME conversation. The process is what a relaunch replaces, not
    // the conversation: `--resume <id>` reopens exactly the one this session was
    // in, so a model switch or a restart onto a newer CLI keeps every turn. With
    // no id known there is nothing exact to resume, and `--continue` would pick
    // whichever conversation in this directory is newest — so that relaunch
    // starts clean rather than land in somebody else's.
    const rid = resumeIdOf(cur);
    queueOp(
      createOp({ cwd: cur.cwd, title: cur.title, launch: next, replaceSessionId: cur.id,
        ...(rid ? { resumeMode: "continue" as const, resumeSessionId: rid } : {}) }),
      `create:${cur.cwd}`, `relaunch ${cur.title} · ${launchLabel(next, backendMark(backends, next.backend), backends)}`, { cwd: cur.cwd, focus: true },
    );
    setOverlay(null);
    showToast(`relaunch · ${launchLabel(next, backendMark(backends, next.backend), backends)}`);
  }
  /**
   * "Open a session here and run this first" — ONE durable op.
   *
   * The prompt travels INSIDE `session.create` rather than as a `session.input`
   * queued after it, because offline there is no session id to address: the
   * phone cannot name a session the host hasn't made yet. The host types it
   * through the same at-most-once `deliverPrompt()` the fan-out uses, and the
   * op ledger de-dupes create+prompt as a pair, so a reconnect retry can never
   * produce two sessions or two copies of the instruction.
   *
   * The lane is `create:<cwd>`, which is also where `queueImageUpload` parks any
   * attached images — so the pictures are on disk before the prompt naming them
   * is typed.
   */
  /** `resume` is the *pick up its last conversation* chip: `claude --continue`
   *  in that repo, so the new session starts holding whatever the last one
   *  there knew. Absent (the default) is a clean process, which is the cheaper
   *  side of `shared/sessioncost.ts`'s break-even for anything that does not
   *  need that context. */
  /** `onCancel` is for a caller whose WORDS are in `prompts` and nowhere else
   *  by the time this is called — the Send sheet clears its draft the moment
   *  the send is accepted. Nothing is queued while the launch question is up,
   *  so a dismissal there has to hand them back (`askLaunchFirst`). A caller
   *  whose prompt is generated (the build sheet's *set up*) passes none. */
  function startSessionWithPrompt(cwd: string, title: string, prompts: string[], sequential?: boolean, launchOverride?: LaunchOpts, resume?: boolean, onCancel?: () => void, budget?: SessionBudget) {
    // The prompt chain and its `needs` are rebuilt on the way back in rather
    // than carried through the sheet: they are cheap to derive and the strings
    // are still the caller's, where a half-built op parked in a state field
    // would be a second copy of this function's rules.
    // The caller's budget STARTS the ask's field and the ask's answer wins
    // (`null` is "asked, and none"); a launch that was never asked keeps it.
    if (askLaunchFirst(title, { override: !!launchOverride, launch: launchOverride ?? launch, onCancel, budget },
      (l, b) => startSessionWithPrompt(cwd, title, prompts, sequential, l, resume, onCancel, b === undefined ? budget : b ?? undefined))) return;
    const opts = launchOverride ?? launch;
    track("action:session.newprompt");
    const list = prompts.map((p) => p.trim()).filter(Boolean);
    const [first, ...rest] = list;
    // The files this prompt names travel with the op as `needs`, and the op goes
    // to the FRONT of its lane — ahead of the very uploads it depends on.
    //
    // That inversion is the fix for the failure this queue kept producing: the
    // ordering used to be enforced here, on a phone, by parking the create
    // behind its images. Thirty minutes of bad tunnel and the upload failed, and
    // the create and every prompt behind it failed with it — while the desktop,
    // which had nothing else to do, had never been told any of it was supposed
    // to happen. Now the intent is handed over first and the HOST holds the
    // session until the last file lands (`launch.ts`), for six hours if it has
    // to, with this tab closed.
    const needs = inboxNeeds(first ?? "");
    // Minted here rather than inside `queueOp` because the chain has to name
    // it: the lane is per REPO, so a second "start with a plan" queued for the
    // same repo (exactly what the Start sheet is for offline) would otherwise
    // have its prompts bound to the FIRST session and run there.
    const createAck = newAckId();
    const offline = queueOp(
      createOp({
        cwd, title, prompt: first, launch: opts, needs: needs.length ? needs : undefined,
        // Born with its cap: a field on the create, not part of the launch options.
        ...(budget ? { budget } : {}),
        // `resumeMode: "continue"` is `claude --continue` — the repo's last
        // conversation, no session id needed, which is exactly what the chip
        // promises. Only sent when it is on: an absent pair is a clean start,
        // and passing `resume: false` explicitly would say the same thing in a
        // field an older host has to read to find out.
        ...(resume ? { resume: true, resumeMode: "continue" as const } : {}),
      }),
      `create:${cwd}`, first ?? `open ${title}`,
      { cwd, focus: true, frontOfLane: needs.length > 0, ackId: createAck, serial: sequential },
    );
    // Everything after the first waits in the same lane for the session to
    // exist (see `queueSessionPrompt`), so a whole plan can be written on a
    // train and delivered a step at a time when the link is back.
    for (const text of rest) queueSessionPrompt(cwd, text, createAck);
    // The screen comes up now, online or off — the whole point of the pending
    // session. `focus` still fires on the ack, and `adoptPendingSession` is
    // what turns this screen into that one.
    enterPending(createAck);
    const many = rest.length > 0;
    showToast(offline
      ? many ? `queued — the session opens and runs ${list.length} prompts when the link is back` : "queued — the session opens and runs this when the link is back"
      : many ? `starting… ${rest.length} more queued behind it` : "starting…");
  }

  const sheets: LaunchSheets = launchSheets({
    backends, launch, root: deps.root, repos: deps.repos, active: deps.active,
    launchAskFor, setLaunchAskFor, hostedAskFor, setHostedAskFor, branchPick, setBranchPick,
    modelInput, setModelInput, setOverlay, submitInput: deps.queue.submitInput,
    refreshRepos, openCwd, pickBackend, setLaunchOpt, relaunch, sessionCan, sessionCant,
    recheckBackends: () => { core().conn.send({ t: "backends.recheck" }); },
  });

  // Only what is read OUTSIDE this hook and its sheets: `createOp`,
  // `askLaunchFirst` and `hostedGate` stay inside on purpose — an exported
  // constructor is an invitation to a second create path.
  return {
    launch, setLaunch, setLaunchOpt, pickBackend, wireLaunch,
    sessionCan, sessionCant, reopenCant, refreshRepos,
    openRepo, openShell, openCompanionShell, openCwd, runForkRequest, startSessionWithPrompt, relaunch, setBranchPick,
    sheets,
  };
}

export type Launch = ReturnType<typeof useLaunch>;

/**
 * The inbox paths a prompt names — what a `session.create` must not run
 * without.
 *
 * Matched on the shape of the path rather than looked up in the queue on
 * purpose: the text may name a file this device is uploading, one another
 * device uploaded, or one an earlier attempt already landed, and the host is
 * the only end that can tell those apart. It stats them itself. All this has
 * to do is say which paths the sentence depends on.
 */
function inboxNeeds(text: string): string[] {
  const out = new Set<string>();
  for (const m of text.matchAll(/\.claude\/inbox\/[A-Za-z0-9._-]+/g)) out.add(m[0]);
  return [...out];
}
