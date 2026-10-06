/**
 * The contract between `App.tsx` (the core) and a feature under `features/`.
 *
 * A feature is a folder that DECLARES what it adds — sheets, toolbar commands,
 * wire-message handlers, a boot hook — in one `manifest`, and reaches the rest
 * of the app only through `CoreApi`. Everything here is a TYPE: the values are
 * App's own functions, rebound on every render (`core/api.ts`), so a feature
 * calls the one socket, the one send queue and the one download path rather
 * than a copy of any of them. Reasoning: docs/notes/web-architecture.md.
 */
import type { ComponentType, ReactNode } from "react";
import type {
  AuthState, BackendInfo, BacklogItem, BudgetVerdict, ClientMessage, ClosedSession, HostMessage, Intent, LaunchIntent, LaunchOpts,
  MeterSummary, RecentSession, RepoTarget, ScheduleEntry, SessionBudget, SendBlockReason, SessionInfo, SweepScope, UpdateInfo, UsageBudget, UsageInfo,
} from "@waterplane/shared";
import type { OutboxEntry } from "../outbox.ts";
import type { ResourceState } from "../useRemoteResource.ts";
import type { DayPoint } from "../kit/chart/stats/splotDay.ts";
import type { Overlay } from "../routing.ts";
import type { SettingsGroupId } from "../settingsIndex.ts";
import type { SendSeed, SendTarget } from "../sendIntent.ts";
import type { RenderRetime } from "../RetimeBar.tsx";
import type { capReason, hasCap } from "../backendCaps.ts";
import type { askConfirm } from "../Confirm.tsx";
import type { showToast } from "../toast.ts";
import type { track } from "../usage.ts";

/**
 * The ClientMessages the host answers with `op.ack` — the durable ACTIONS.
 * Everything else stays fire-and-forget: an op is only worth queuing when
 * running it twice would be visibly wrong (two claude processes in one
 * worktree, an N-repo sweep run twice, a second full build).
 *
 * `session.reopen` is NOT one of them: nothing sends it and the host has no
 * handler, so an entry queued as that op would never be acked and would retry
 * until it aged out. Every reopen goes through `session.create` with
 * `resumeSessionId` (which resumes THAT conversation, not just the directory's
 * most recent one).
 */
// `intent.run` joins the set because it IS one host-side (`routes/work.ts`
// declares `durable: true`), and because it is now the ONE message behind
// "run it now" on a launch, a work item, a schedule and a build — four taps
// that were four ops, of which three were already durable and one was not.
// `capture.run` joins for `build.run`'s reason and one of its own: a capture
// takes a lease on a browser, a simulator or the desktop's own screen, so a
// retry that ran it twice would have two runs fighting over one of those.
// `capture.cancel` deliberately does NOT join — a cancel delivered an hour late
// calls off work that has long since run.
// `intent.post` joins because it is the strongest of them host-side: `ok` is
// not sent until the row is on the desktop's DISK, which is the moment the
// phone may forget the words, and that promise is worth nothing if the message
// carrying it is dropped by a socket that was not open. It is the path a
// CHAINED send takes (`when.kind === "after"`) — the one shape whose trigger
// `backlog.add` cannot express — and its `intent.id` is a second at-most-once
// key that outlives the ack ledger, so a replay finds the row rather than
// queueing the work twice.
// `intent.requeue` joins for a reason the others do not have: it is the one
// backlog mutation that is SAFE TO DELIVER LATE. Every other one is live-only
// because a decision replayed an hour on is a decision about a situation that
// has moved on — but the host refuses a re-queue of anything that is not still
// `failed`, so a frame that lands an hour after the tap either finds the row
// exactly as the person left it or is refused outright. That refusal is the
// mechanism, not a courtesy, and it is what lets the button be drawn with the
// tunnel down instead of greyed out with its reason in a `title`.
//
// `backlog.name` joins on the same argument reached from the other end: a
// naming pass never writes over a field whose author is `hand`, and writing the
// same title onto the same row twice is the same row. There is no situation a
// late delivery can have moved on from — the worst it can do is spend one short
// toolless call on rows somebody has named in the meantime, which the pass
// itself then leaves alone.
export type DurableOp = Extract<ClientMessage, { t: "session.create" | "fanout.run" | "fanout.followup" | "build.run" | "capture.run" | "schedule.save" | "schedule.run" | "intent.run" | "intent.post" | "intent.requeue" | "backlog.name" }>;

/** A sheet id: every overlay a feature can own is already a member of `Overlay`
 *  in `routing.ts`, because the route stack and Back key on it. An in-repo
 *  EXTENSION's sheet ids are `feature:<manifest id>/<name>` (`featureSheetId`),
 *  and its `SheetDef.persisted` is always `false`. */
export type SheetId = NonNullable<Overlay>;

export type { SettingsGroupId };

/** What the phone knows about how it reached the desktop — the welcome frame's
 *  facts, for the Connection settings and the host tools. */
export interface ConnInfo {
  tailscaleIp: string | null;
  tailscaleBin: string | null;
  httpsUrl: string | null;
  lanIps: string[];
  hostPort: number;
  root: string;
  auth: AuthState;
}

/** `queueBacklog`'s argument: one backlog item, queued durably. */
export interface QueueBacklogOpts {
  text: string; repoDir: string; label?: string; fire?: boolean; autoFire?: boolean; targetSessionId?: string;
  /**
   * The WHOLE chain, `steps[0]` repeating `text`.
   *
   * A chain used to be N items, one per turn, which the repo's queue then ran
   * in order — right by accident, and wrong once every item opens its own
   * conversation: step 2 would land in a fresh session that had never seen
   * step 1. One item carrying the chain is what the host's `deliverChain`
   * runs, and the repeat of `text` is what keeps an older desktop running turn
   * one instead of nothing.
   */
  steps?: string[];
  /** The new session picks up the repo's last conversation (`--continue`). */
  resume?: boolean;
  /** The item's own *close its session when done*; absent follows the global
   *  setting (`Intent.closeWhenDone`), `false` is a real "keep it open". */
  closeWhenDone?: boolean;
  /** The budget the session this item opens is BORN with (`BacklogItem.budget`).
   *  Absent is none; it is not part of the launch options. */
  budget?: SessionBudget;
}

/** Ordered background-upload buffer for the session image-annotate flow. */
export interface UploadBuf {
  repoId: string;
  /** relPath (or ref with note) per slot, in picked order; null = failed/pending. */
  slots: (string | null)[];
  started: number; // uploads dispatched
  done: number;    // uploads finished
  closed: boolean; // no more images will be added to this batch
  submit: boolean; // fire the compose send once the batch drains
  /** "queue": instead of submitting, add the compose text + refs as an auto-fire
   *  backlog item targeting `target` (runs when that session next goes idle). */
  queue?: boolean;
  ctrl: AbortController; // aborts every in-flight upload in this batch
  /** ackIds of the send-queue entries this batch parked — what "cancel uploads"
   *  has to drop, now that the bytes go through the queue rather than straight
   *  out over HTTP. */
  ackIds: string[];
  target?: { id: string; cwd: string }; // session the images were annotated for (submit target, immune to later nav)
  finalized?: boolean; // guard: refs already dropped into compose/submitted — never twice
  /** Why a slot came back empty. "Upload failed" is the one message here that
   *  says nothing about what to do next — the two real causes (this device
   *  couldn't PARK the bytes, or the image couldn't be read at all) want
   *  different reactions, so the first slot to fail records which it was. */
  fail?: string;
}

/** Byte-level progress of the uploads in flight, for the strip. */
export interface UploadProgress { sent: number; total: number; pct: number; kbps: number | null; waiting: boolean }

/** The upload buffer: image bytes on their way to the desktop's inbox. The
 *  bytes ride the send queue, so this is the queue's, not a feature's. */
export interface UploadApi {
  /** The progress label, null when nothing is in flight. */
  readonly uploading: string | null;
  /** How many uploads are parked — the only upload state Send still waits on. */
  readonly parking: number;
  readonly upProg: UploadProgress | null;
  /** The current batch, if one is open or draining. */
  current(): UploadBuf | null;
  /** The current OPEN batch for this repo, or a new one. */
  ensureUploadBuf(repoId: string): UploadBuf;
  queueUpload(buf: UploadBuf, src: Blob | Promise<Blob>, name: string,
    note?: string | Promise<string | undefined>, size?: { w: number; h: number }): void;
  /** Finish a batch once every slot has landed and it is closed. Idempotent. */
  settleUploads(buf: UploadBuf): void;
  cancelUploads(): void;
}

/**
 * What a feature may ask of the core. Each member IS the function of the same
 * name in `App.tsx`, not a wrapper around it — which is what keeps "one socket",
 * "one send path" and "one download button" true with features in the tree.
 */
export interface CoreApi {
  conn: {
    /** The socket's own status, read live — never a copy taken at render. */
    readonly status: "connecting" | "open" | "closed";
    /** The ONE socket. A bare write from a tap is `local/no-silent-send`'s
     *  business; a tap goes through `liveSend`/`liveAsk` or the queue. */
    send(frame: ClientMessage): void;
    /** Write now or not at all — false, nothing queued, unless the socket is OPEN (a live question). */
    trySend(frame: ClientMessage): boolean;
    liveSend(frame: ClientMessage, done: string, blocked?: string): boolean;
    liveSendAll(frames: ClientMessage[], done: string, blocked?: string): boolean;
    liveAsk(frame: ClientMessage, blocked?: string): boolean;
    /** How the phone reached the desktop, as of the last welcome. */
    readonly info: ConnInfo;
  };
  /** The ONE send path. Durable ops and typed words go nowhere else. */
  queue: {
    /** A fresh ackId for a LIVE op the host acks by it (`assess.run`/`apply`):
     *  never queued, never retried — only what lets `op.ack` name the op. The
     *  queue core's own sends mint theirs inside it. */
    mintAckId(): string;
    /** The repo a queued row was written in, by id (null when unknown). */
    repoIdOf(e: OutboxEntry): string | null;
    /** Retire ONE row with no cascade — its words are safely somewhere else
     *  now (a re-fire made them a work item), and nothing may send it twice. */
    drop(ackId: string): void;
    /** Arm (with `armAll`, every held row too) and send; how many went. */
    flush(armAll?: boolean): number;
    /** Why nothing is sending right now, in words — or `fallback`. */
    idleReason(fallback?: string): string;
    /** New queued opens run one session at a time per repo — the preference
     *  and its switch (written through to the flusher's ref at once). */
    readonly serial: { readonly on: boolean; set(on: boolean): void };
    queueOp(op: DurableOp, laneKey: string, text: string,
      opts?: { cwd?: string; focus?: boolean; frontOfLane?: boolean; ackId?: string; serial?: boolean }): boolean;
    submitInput(id: string, cwd: string, text: string, kind: "prompt" | "command", holdUntilIdle?: boolean): boolean;
    /** The send queue as of the last render. Components read `useQueueEntries()`. */
    readonly entries: readonly OutboxEntry[];
    /** Why each held lane is not sending — named, never a grey. */
    readonly blocked: ReadonlyMap<string, SendBlockReason>;
    /** Lanes whose session the desktop says is gone. */
    goneLanes(): string[];
    /** The one-line description of a queued entry, as the queue strip words it. */
    laneLabel(e: OutboxEntry): string;
    /** Answer a choice box on screen (typed via the queue). */
    answerPrompt(s: SessionInfo, data: string, label: string, submitBox?: boolean, choice?: number): void;
    /** One backlog item, queued durably. null = refused (it names an image that
     *  will never arrive): leave the words where they are. */
    queueBacklog(opts: QueueBacklogOpts): boolean | null;
    /** What a person does to a queued row. Each IS App's function of that name. */
    verbs: {
      sendQueuedNow(ackId: string): void;
      toggleHoldQueued(ackId: string): void;
      toggleSerialQueued(ackId: string): void;
      removeQueued(ackId: string): void;
      editQueued(ackId: string, text: string): void;
      retargetQueued(ackId: string, to: { sessionId: string; cwd: string; mode?: "input" | "backlog"; targetSessionId?: string }): void;
      restoreQueued(ackId: string): void;
      retryFailedQueued(): void;
      moveQueued(ackId: string, dir: -1 | 1): void;
      addPromptToQueuedCreate(ackId: string, text: string): void;
      scheduleQueueRows(scheduleId: string): OutboxEntry[];
      dropScheduleQueue(rows: readonly OutboxEntry[]): void;
    };
    uploads: UploadApi;
    /** Park bytes for a repo's inbox in `lane`; resolves to the path they WILL
     *  have, or null when this device could not hold them. The one upload path
     *  outside the batch buffer (`uploads`). */
    queueImageUpload(repoId: string, blob: Blob, filename: string, lane: string, cwd: string): Promise<{ relPath: string; ackId: string } | null>;
  };
  nav: {
    /** The overlay on top as of the last render — what the chatty-push guards
     *  (`build.output`, `capture.output`) compare against. */
    readonly overlay: Overlay;
    open(o: SheetId): void;
    /** **A sheet may only close ITSELF** (`closeSheet` in App): a close that
     *  lands after the sheet's own action opened the next one is a no-op. */
    close(self: SheetId): void;
    attach(s: SessionInfo): void;
    /** Open a session straight into the READER (the launcher row's own verb,
     *  `useTermFeed`'s `openReader`): read mode set before the attach, and the
     *  turn outline up unless `outline` is false. */
    openReader(s: SessionInfo, outline?: boolean): void;
    /** **The one session close** (`useSessionVerbs`' `closeSession`): a
     *  running session is asked about first (`session.closecheck`, which
     *  confirms only when something would be lost), then `session.remove` —
     *  it lands in *Recently closed*. A person's tap only; never a new path. */
    closeSession(s: SessionInfo): void;
    openRepo(t: RepoTarget): void;
    openSend(seed: SendSeed): void;
    startSessionWithPrompt(cwd: string, title: string, prompts: string[], sequential?: boolean,
      launchOverride?: LaunchOpts, resume?: boolean, onCancel?: () => void, budget?: SessionBudget): void;
    /** The backlog, scoped to one worktree — and, with `ids`, cut to exactly
     *  those rows under `label` (a count is a filter). */
    openBacklogCut(cwd: string, ids?: string[], label?: string): void;
    /** Schedules, cut to exactly these rules under `label`. */
    openScheduleCut(ids: string[], label: string): void;
    /** A backlog row was fired by hand: jump to the session it lands in once
     *  the host says it is running (App's `wantNavRef` + fire-nav effect). */
    followFire(id: string): void;
    /** The pad, scrolled to one note and flashing it. */
    openPadAt(noteId: string): void;
    /** A Send seed is being composed — the sheet the annotator replaced is the
     *  Send sheet's, so closing it goes back there. */
    sendSeeded(): boolean;
    /** Activity, cut to these queue rows (or these row keys) under `label` —
     *  a count is a filter — or the whole list with no cut. */
    openActivity(cut?: { entries: readonly OutboxEntry[]; label: string } | { keys: readonly string[]; label: string }): void;
    /** The git screen (working tree) of one repo. */
    openGit(repoId: string): void;
  };
  /** Session launch options and the one way to open a session in a folder. */
  launch: {
    /** Change the launcher's default options (persisted). */
    setOpt(patch: Partial<LaunchOpts>): void;
    /** The wire gate: strip what this host never described (`launchFor`). */
    wire(o: LaunchOpts): LaunchOpts;
    /** Returns the pending screen's session id it opened, or null when the tap
     *  waits on a launch question — seed that screen's words with
     *  `compose.seedDraft(id, …)`, never `insert` (the box is being left). */
    openCwd(cwd: string, title: string, resume?: boolean, resumeMode?: "continue" | "pick" | "fork",
      launchOverride?: LaunchOpts, resumeSessionId?: string): string | null;
    /** Kill this session and start it again on `patch`, as ONE durable
     *  `session.create` with `replaceSessionId` — the model sheet's relaunch. */
    relaunch(s: SessionInfo, patch: Partial<LaunchOpts>): void;
  };
  /** The terminal on screen. */
  term: {
    /** The local scrollback reconstruction; [] with no xterm mounted. */
    snapshot(): string[];
    /** The terminal's last reported grid — what a spawn is sized to. */
    geom(): { cols: number; rows: number };
  };
  /** The compose bar and the terminal on screen — App's, and read or added to
   *  here, never replaced: typed words are the last copy (`local/no-draft-clobber`). */
  compose: {
    /** The compose draft as of the last render. */
    readonly draft: string;
    /** Add to the draft (App's `insertCompose`) — never overwrites it. */
    insert(text: string): void;
    /** Add to session `sid`'s draft — the box if it is on screen, else its
     *  stored draft, read when that screen comes up. Use it after a navigation
     *  (`nav.attach`, `launch.openCwd`), where `insert` would type into the box
     *  being left and the incoming draft would replace it. Appends. */
    seedDraft(sid: string, text: string): void;
    /** The live terminal grid as text; "" when no xterm is mounted (reader
     *  view, a sheet on top). Read it BEFORE opening a sheet, which unmounts it. */
    gridText(): string;
    /** Record a sent command in the compose history (↑ recalls it). */
    pushHistory(text: string): void;
    /** `outbox.ts`'s `removePadNotes` — the ONE pad delete (a tombstone, so the
     *  delete travels to the other device). */
    removePadNotes(ids: readonly string[]): void;
    /** `outbox.ts`'s sheet drafts — the annotator's and the gallery's round
     *  trip into the Send sheet and the pad goes through the sheet's persisted
     *  draft. `seed` rescues first (`seedSheetDraft`), `append` only adds. */
    loadSheetDraft(key: string): string;
    seedSheetDraft(key: string, text: string, cwd?: string | null): "seeded" | "kept" | "refused";
    appendSheetDraft(key: string, ref: string): void;
  };
  world: {
    readonly sessions: SessionInfo[];
    readonly repos: RepoTarget[];
    readonly visibleRepos: RepoTarget[];
    readonly active: SessionInfo | null;
    readonly activeRepo: RepoTarget | null;
    readonly backends: BackendInfo[] | null;
    readonly recent: RecentSession[];
    readonly closed: ClosedSession[];
    readonly intents: Intent[];
    readonly launches: LaunchIntent[];
    readonly budget: { budget: UsageBudget; verdict: BudgetVerdict } | null;
    readonly meter: MeterSummary | null;
    /** The last `/usage` reading (features/tokens owns it); null until the host has said. */
    readonly usage: UsageInfo | null;
    /** The launcher's current default launch options. */
    readonly launch: LaunchOpts;
    readonly update: UpdateInfo | null;
    /** The rule list (`features/schedule`), for the backlog's schedule chips. */
    readonly schedules: ScheduleEntry[];
    /** The backlog's rows (`features/backlog`) — Activity reads their check verdicts. */
    readonly backlog: BacklogItem[];
    repoForCwd(cwd: string): RepoTarget | null;
    /** Rescan the host root for repos (and their setup badges). */
    refreshRepos(): void;
    /** The screen is a queued `session.create` (the pending session). */
    readonly pending: boolean;
    /** The launcher's visibility rule: not in a hidden repo, inside the focus window. */
    cwdVisible(cwd: string): boolean;
    sessionRepo(s: SessionInfo): RepoTarget | null;
    sessionRowTitle(s: SessionInfo): string;
    /** Absent optional caps INHERIT (`backendCaps.ts`) — ask, never read raw. */
    sessionCan(s: { backend?: string } | null | undefined, cap: Parameters<typeof hasCap>[2]): boolean;
    sessionCant(s: { backend?: string } | null | undefined, cap: Parameters<typeof capReason>[2]): string | null;
  };
  files: {
    /** The ONE download path (`download.ts`'s queue) — never an `<a download>`. */
    downloadArtifact(f: { repoId: string; relPath: string; name: string; size?: number; mtime?: number }): void;
    openArtifact(f: { repoId: string; relPath: string; name?: string; size?: number; mtime?: number }): void;
    viewImage(im: { repoId: string; relPath: string }, sessionId?: string): void;
    /** Upload straight to the repo's inbox; resolves to the refs that landed. */
    attachForInbox(repo: RepoTarget, files: File[]): Promise<string[]>;
    /** Attach files to the session ON SCREEN as the compose bar's paperclip
     *  does: pictures through the annotator, the rest uploaded with their paths
     *  in its box. */
    attachFiles(files: File[], repoId: string): void;
    /** Open the annotator; the result lands back in the send or pad sheet. */
    annotate(repo: RepoTarget, files: File[], returnTo: "send" | "pad"): void;
    /** The outbox/inbox sweep for one repo; its × comes back to `back`. */
    openSweep(repoId: string, scope: SweepScope, back: SheetId): void;
    /** The annotator on an image a backlog row names; the marked copy swaps
     *  the path in the row. */
    editBacklogImage(it: BacklogItem, relPath: string): void;
    /** The repo tree opened straight into `file`, whose close returns to `back`. */
    browseTo(repoId: string, file: string, back: Overlay): void;
    /** Open a picture at a URL in the annotator (the session flow) — a
     *  desktop screenshot, a gallery file. */
    annotateUrl(url: string, name: string, repoId: string): void;
    /** The viewer on a repo file, returning to `back` when it closes. */
    openFileFrom(f: { repoId: string; relPath: string; mtime?: number }, back: SheetId): void;
  };
  /** The send core's pieces a sheet draws or seeds with — the one send surface
   *  (`SendSheet`), never a copy of it. */
  send: {
    /** The When editor for re-timing rows that exist (`SendSheet` in its
     *  re-time mode), drawn by the list that asked. */
    renderRetime: RenderRetime;
    /** A rule, as a send waiting to be re-decided (upserts on its id). */
    seedFromSchedule(e: ScheduleEntry): SendSeed;
    /** The same seed off the durable row (a timed row's *when*, an Activity edit). */
    seedFromIntent(i: Intent): SendSeed;
    /** Where a message that already had a destination should be aimed NOW:
     *  its session while that is live, else the repo it was written in. */
    targetFor(sessionId: string | undefined, cwd: string | undefined): SendTarget | undefined;
  };
  say: {
    toast: typeof showToast;
    track: typeof track;
    /** `Confirm.tsx` — never `window.confirm`. */
    confirm: typeof askConfirm;
  };
}

/** Wire-message handlers, by `t`. They run AFTER App's own switch has handled
 *  the same frame, in registry order; a throw is contained to its feature. */
export type MessageHandlers = {
  [K in HostMessage["t"]]?: (msg: Extract<HostMessage, { t: K }>, core: CoreApi) => void;
};

export interface SheetDef {
  id: SheetId;
  /** Must agree with `PERSISTED_OVERLAYS` in `routing.ts` — `tools/webshape.test.mjs`
   *  checks it. Whether a reload may land back on this sheet is a route fact,
   *  and the route owns it; this is the feature saying which it expects. */
  persisted: boolean;
  /** `null` falls through to the screen underneath, exactly like `overlayViews`. */
  render: (core: CoreApi) => ReactNode | null;
  /** Runs once when this sheet stops being the one on top — clear a scope, drop
   *  a focus. Not on unmount of App. */
  onLeave?: () => void;
}

/** A toolbar entry's action. The item itself (label, icon) is still declared in
 *  `toolbar.ts`, which owns order and pinning; this is what its tap runs. */
export interface CommandDef {
  id: string;
  run: (core: CoreApi) => void;
}

/**
 * Rows a feature adds to one Settings group, in `order` (then registry order):
 * `order < 0` is drawn at the HEAD of the group, before the core's own rows,
 * `order >= 0` at its END; in Tools, `-10 <= order < 0` opens the door rack
 * (`core/settings/SettingsSheet.tsx` says where each band lands). `render` returns an element — any hook goes in
 * the component it returns, because it is called during the settings sheet's
 * render, after App's early return. Every row id it draws must be in
 * `settingsIndex.ts` (`settingsIndex.test.mjs` reads feature `*Settings.tsx`).
 */
export interface SettingsRowsDef {
  group: SettingsGroupId;
  order: number;
  render: (core: CoreApi) => ReactNode;
}

/**
 * A session-toolbar item a feature draws itself (a stateful one — the generic
 * button is `toolbar.ts`'s entry plus a `CommandDef`). The item's id, label and
 * icon are still declared in `toolbar.ts`, which owns order and pinning.
 * `null` = not shown now; the core falls back to its own arm only when no
 * feature declares the id at all.
 */
export interface ToolbarItemDef {
  id: string;
  render: (core: CoreApi, ctx: {
    /** Drawn as a menu line (label shown), not as a header pin. */
    label: boolean;
    /** Shut the menu behind the tap (no-op for a pin). */
    dismiss(): void;
    active: SessionInfo | null;
  }) => ReactNode | null;
}

/** One entry in a repo's "⋯" menu (main worktree only), drawn by the launcher's repo group. */
export interface RepoActionDef {
  id: string;
  icon: ComponentType<{ size?: number | string }>; // wide enough for a lucide-react icon's own propTypes
  /** The menu line, or null = not offered for this repo. Never a grey control: say nothing or say why. */
  label(repo: RepoTarget, core: CoreApi): string | null;
  title?(repo: RepoTarget): string;
  run(repo: RepoTarget, core: CoreApi): void;
}

/** What a repo chip says: a count, the cut it stands for, and the sentence under it. */
export interface RepoChipCount<F> {
  n: number; filter: F; title: string;
  /** A short word drawn before the number ("requirements 111") — a `title` is invisible on a phone. Keep it one word. */
  label?: string;
}

/** A count chip on a repo's group row. A count is a filter: the tap opens exactly those rows. */
export interface RepoChipDef<F = unknown> {
  id: string;
  icon: ComponentType<{ size?: number | string }>; // wide enough for a lucide-react icon's own propTypes
  /** A HOOK, called once per render by the core's chip component. null or n <= 0 = no chip. */
  useCount(repo: RepoTarget): RepoChipCount<F> | null;
  /** Open the sheet cut to `filter`; that sheet says "n of N — clear" (kit `FilterBar`). */
  open(repo: RepoTarget, filter: F, core: CoreApi): void;
}

/**
 * Words a row in a repo's setup checklist uses, contributed by an extension whose HOST half
 * contributes the row (`api.setupCheck`). The core's own fixes and guidance keys are refused.
 */
export interface SetupRowDef {
  /** The check id the host's row carries. */
  check: string;
  /** The fix id that row names — the one the Fix button runs. */
  fix?: string;
  /** The button's verb ("set up"). Absent: the generic "fix". */
  fixVerb?: string;
  /** The hand-to-agent verb ("update the list in this repo"). Absent: the generic one. */
  agentVerb?: string;
  /** What the agent is told for this check (`remedyPrompt`). Absent: the generic fallback. */
  guidance?: string;
  /** When set, the row's single hand-to-agent button calls this instead of opening Send with
   *  `remedyPrompt` — the extension's own path. Bulk hand-over still quotes `guidance`. */
  agent?(repo: RepoTarget, core: CoreApi): void;
}

export interface FeatureManifest {
  /** Equals the folder name under `features/` — `webshape.test.mjs` checks it. */
  id: string;
  sheets?: readonly SheetDef[];
  commands?: readonly CommandDef[];
  messages?: MessageHandlers;
  settings?: readonly SettingsRowsDef[];
  toolbarItems?: readonly ToolbarItemDef[];
  /** Runs once when App mounts. May return a cleanup. */
  boot?: (core: CoreApi) => void | (() => void);
  /** Menu lines in a repo's "⋯" menu. */
  repoActions?: readonly RepoActionDef[];
  /** Count chips on a repo's group row. */
  repoChips?: readonly RepoChipDef<any>[];
  /** Words for setup rows this extension's host half contributes. */
  setupRows?: readonly SetupRowDef[];
  /** `plugin.push` handlers by event, heard only when `msg.plugin === manifest.id`. A handler
   *  writes a store; it never forces an App render. A throw is contained and said once. */
  pushes?: Record<string, (data: unknown, core: CoreApi) => void>;
  /** Token ledgers drawn inside the token statistics sheet, one tab each (`LedgerViewDef`). */
  ledgerViews?: readonly LedgerViewDef<any>[];
}

/**
 * A backend's token ledger as its OWN extension draws it, inside the token statistics sheet
 * (`packages/extensions/token-stats`): a tab beside Claude Code's, a card on "All backends", and the
 * document behind both. The sheet owns the frame — the picker, the overview, the shared "show as"
 * state, the re-read — and the contributing extension owns everything that knows the document's
 * shape, because only it knows its kinds (five for opencode, never folded into claude's four).
 *
 * The document is `GET /api/tokenstats/<id>`, which the host answers generically from the store
 * reader the backend names (`BackendSources.ledger`) — so a view needs no route of its own, and core
 * never reads a field of it. **Never summed with another ledger**: the sheet has no total across
 * tabs, and nothing here hands one view another's document.
 *
 * Read through `ledgers.views()` (registry order; an id of `claude`, or one already taken, is refused
 * and said once). A backend with a view gets no generic ledger tab (`ledgerBackends`).
 */
export interface LedgerViewDef<D = unknown> {
  /** The backend id: the document is `GET /api/tokenstats/<id>`, the phone's copy is keyed by it. */
  id: string;
  /** The chip's and the card's name. */
  label: string;
  /** Whether the tab exists at all: the host answered, and there is something on the other side of
   *  the chip. False ⇒ the chip is ABSENT (never dimmed) and the screen reads as if there were no view. */
  hasData(doc: D | null): boolean;
  /** The "All backends" card's facts, in the ledger's OWN kinds (the sheet totals and splits them;
   *  `absent` is the sentence instead of figures). Drawn whether or not the tab exists. */
  summary(doc: D | null): LedgerSummary;
  /** The re-read button's title while this tab is on screen. */
  rescanTitle: string;
  /** The phone's IndexedDB copy: `shape` versions it (a bump drops every older copy) and `usable`
   *  refuses a truncated or foreign record — a cache MISS, never a document patched up with zeros. */
  cache: { shape: number; usable(doc: unknown): doc is D };
  /** The tab's body. */
  View: ComponentType<LedgerViewProps<D>>;
}

/** What one ledger card states: a sentence, or a total's parts with the last active day. */
export type LedgerSummary =
  | { absent: string }
  | {
      /** Each kind apart, in the ledger's own names — the sheet draws the split, never one kind folded into another. */
      kinds: Record<string, number>;
      turns?: number;
      /** The last local day with anything in it, `YYYY-MM-DD`; null = no dated activity. */
      lastDay: string | null;
      /** The sentence when every kind is zero — readable, nothing counted. */
      nothing: string;
    };

/** What the sheet hands a contributed view. */
export interface LedgerViewProps<D> {
  doc: D | null;
  /** The read, for `Empty`'s wording. */
  res?: { state: ResourceState; age?: number | null; error?: string | null };
  /** The sheet's one chart/values switch, shared by every tab. */
  table: boolean;
  onTable: (v: boolean) => void;
  /** This backend as the host describes it (its model catalogue), when it does. */
  backend?: BackendInfo;
  /** A width to draw at instead of measuring one — static renders only. */
  width?: number;
  /** The sheet's own pieces, so a guest tab reads in the same grammar (an extension cannot import another). */
  parts: LedgerViewParts;
}

/** The token statistics sheet's widgets, lent to a contributed view. */
export interface LedgerViewParts {
  /** One day series as columns, or as a cumulative area. */
  DayChart: ComponentType<{ pts: DayPoint[]; width: number; kind: "area" | "columns"; label?: string }>;
  /** A box whose head is the filter it is cut by. */
  ScopeCard: ComponentType<{ title: string; chips: ReactNode; caption?: ReactNode; children: ReactNode }>;
  /** The span a section is showing, repeated in its head. */
  ScopeTag: ComponentType<{ children: ReactNode; muted?: boolean }>;
}
