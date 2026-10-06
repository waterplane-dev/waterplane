import {
  type BlockReason,
  type FanoutRun,
  type Intent,
  type Lifecycle,
  type SendBlockReason,
  type SessionInfo,
} from "@waterplane/shared";
import type { OutboxEntry } from "../outbox";
import type { PullRecord } from "../pull";

// ── The model ───────────────────────────────────────────────────────────────

/**
 * **What a person calls this row** — the vocabulary they think in.
 *
 * It used to be "which of the eight ledgers this came out of", and the action
 * callbacks branched on it because a "cancel" meant a different message per
 * ledger. Five of the eight are one store now, so this is no longer a routing
 * key: it is a LABEL, used for grouping and for the icon. Routing is
 * `subject.source`, which has three members, and the two are deliberately not
 * the same axis — a launch and a work item are different words for the user and
 * the identical `intent.cancel` for the wire.
 */
export type ActivitySource =
  | "queue" | "launch" | "backlog" | "schedule" | "fanout" | "build" | "assess" | "pull";

/** What the row IS to the person who posted it — deliberately not the same axis
 *  as `source`. A prompt is a prompt whether the phone is still holding it, the
 *  desktop is holding it for a file, or it is a work item in a repo. */
export type ActivityKind = "prompt" | "answer" | "upload" | "action" | "sweep" | "build" | "download";

/**
 * What became of a delivery that DID go out — an axis of its own, never
 * interleaved with `Lifecycle`.
 *
 * `intent.ts` states the argument: mixing the two is how `unconfirmed` became a
 * terminal state that ate deliveries. And the three that look alike are three
 * different next actions:
 *   • `refused`     — the host answered, and said no (a stale fingerprint).
 *                     Nothing was written. Safe to redo, once you have decided.
 *   • `unreachable` — the host never answered. It may have run.
 *   • `unknown`     — nobody recorded which of the two it was.
 * Collapsing them is how a permissions problem reads as a bad tunnel for a week.
 */
export type DeliveryTruth = "landed" | "unconfirmed" | "unsubmitted" | "refused" | "unreachable" | "unknown";

/** The filter chips, and the bucket a row is sorted into. `all` is a chip only. */
export type ActivityBucket = "needsYou" | "failed" | "running" | "waiting" | "scheduled" | "done";
export type ActivityFilter = "all" | ActivityBucket | "dismissed";

/**
 * Every action any row can offer. An id rather than a handler, because this
 * module is pure and DOM-free — the sheet maps id → icon, and the caller maps
 * id + row → the message that actually goes out.
 */
export type ActivityActionId =
  /** Release it now (arms the queue entry / fires the backlog item / runs the schedule). */
  | "sendNow"
  /** Park it until the target can take it, or un-park it. */
  | "hold"
  /** Keep the words, change the destination. */
  | "retarget"
  /** Rewrite it in place. */
  | "edit"
  /** Rewrite it AND fix the files it names — the resend editor. Distinct from
   *  `edit` because a message naming a dead upload cannot be re-queued at all. */
  | "fix"
  /** Put it back on the wire as it stands. */
  | "retry"
  /** Answer the question box the target is sitting on. */
  | "answer"
  /** Ask the desktop whether this task is already implemented. */
  | "check"
  /** Open the session this row is about. */
  | "open"
  /** Run it now, ahead of its trigger (a schedule, a launch waiting on files). */
  | "runNow"
  /** Stop it — cancel a run, call off a launch, drop a queued download. */
  | "cancel"
  /** Flip the row's own switch (schedule enabled, item auto-fire). */
  | "toggle"
  /** Fetch the bytes. */
  | "download"
  /** Put the downloaded bytes somewhere the phone can find them. */
  | "save"
  /** Throw the row away. */
  | "discard"
  /** File it under "dismissed" — not now, still here. Same act as the bulk
   *  button, offered per row (`activityRows()` stamps it on every row, not a
   *  builder — see the comment beside `dismissedAt`). */
  | "dismiss"
  /** A person, not the desktop's own detector, says this one actually ran.
   *  Only offered where `delivery === "unconfirmed"` (`activityDone.ts`). */
  | "confirmDone";

export interface ActivityAction {
  id: ActivityActionId;
  /** What the button says. Present even on icon-only buttons: it is the
   *  `title`, and the hint layer builds a card from it. */
  label: string;
  /**
   * Why it cannot be pressed — and the ONLY way to disable it.
   *
   * A greyed button with no explanation is the most expensive way an interface
   * can say "no": it costs a tap, teaches nothing, and on the one screen a
   * person opens when something has already gone wrong it reads as the app
   * being broken too. Absent ⇒ enabled.
   */
  disabledReason?: string;
  /** Destructive or hard to undo. */
  danger?: boolean;
  /** The one action the row exists to offer. At most one per row. */
  primary?: boolean;
  /**
   * Stays on the row's face beside `primary`, never folded into "more".
   *
   * Reported: *"the two circled buttons should not be hidden behind the more
   * button"* — on a row whose primary was "rewrite it" (an unconfirmed send),
   * "discard" and "open the session" sat one tap deeper than the words that
   * said what to do next ("open the session and look, or rewrite it"). Both
   * are the way OUT of a stuck row — look at the truth, or give up on it —
   * and burying the exit behind the same toggle as the row's minor verbs
   * made the escape as many taps as the detail nobody needed yet.
   */
  alwaysShown?: boolean;
  /** What the tap does, as TEXT under the row's buttons while this one is
   *  drawn — a `title` is invisible on a phone. `skipQueueNote`'s promise on
   *  the verbs that skip the queue. */
  note?: string;
}

/** One repo/session inside a sweep. A fan-out is one row; this is what it
 *  expands to, so "3 of 5 done" stays clickable per target. */
export interface ActivityTarget {
  label: string;
  sessionId?: string;
  state: Lifecycle;
  detail?: string;
}

/**
 * The row.
 *
 * `subject` carries the original object back to the caller, discriminated by
 * source, so an action handler never has to look the row up again in the array
 * it came from — and so this module can stay ignorant of what a handler does.
 */
export type ActivitySubject =
  /** Words this phone is still holding. The desktop has never seen them. */
  | { source: "queue"; entry: OutboxEntry }
  /**
   * A durable row on the desktop — all five of the old host-side ledgers.
   *
   * ONE member where there were five, because the five messages they routed to
   * (`launch.cancel`, `backlog.remove`, `schedule.delete`, …) are one message
   * now (`intent.cancel`). `run` is the sweep this row belongs to when it is a
   * fan-out, rebuilt from its siblings; `null` otherwise.
   */
  | { source: "intent"; intent: Intent; run: FanoutRun | null }
  /** Bytes on their way to this phone. Also never the desktop's. */
  | { source: "pull"; record: PullRecord };

export interface ActivityRow {
  /** React key. Unique ACROSS sources — two ledgers can share an id (a launch's
   *  id IS the create op's ackId), and a duplicate key silently drops a row. */
  key: string;
  /** The source's own id: ackId, launchId, item id, schedule id, runId, pull id. */
  id: string;
  source: ActivitySource;
  kind: ActivityKind;
  state: Lifecycle;
  bucket: ActivityBucket;
  /**
   * Why it is blocked, in the shared vocabulary — `null` when the state is not
   * `blocked`, and ALSO when the source's own reason has no honest counterpart
   * (a send waiting out its retry backoff is not any of the ten). A null here
   * with a `verdict` beside it is the correct answer to "which of the ten is
   * this?" being *none of them*; inventing the nearest one would be a lie the
   * ordering would then act on.
   */
  blockReason: BlockReason | null;
  /**
   * The finished sentence. Render it as it is.
   *
   * `intentReasonText` produces it, and its contract is that passing a sentence
   * it already produced is a no-op — so a caller holding only this may re-ask
   * safely. Re-weaving it is not.
   */
  verdict: string;
  /** What it is: the prose, clipped, or the build/sweep/file name. */
  title: string;
  /** `title` is a head, not the whole thing. */
  clipped: boolean;
  /** The un-clipped words, when this row still has them. `null` is a FACT here
   *  (the ledger head is the last copy), never a "we didn't look". */
  fullText: string | null;
  /**
   * The text whose transport-dir file mentions this row is about — what an
   * `AttachStrip` is handed. `null` when the row cannot name a file at all.
   *
   * Deliberately NOT `fullText`, and the difference is the entire point on an
   * upload row: its words are the label `file · 1000074690-mtmw2965bdb334.jpg`,
   * minted for the queue to have something to print, and that string names no
   * path at all — the path it is actually carrying is on `upload.relPath`.
   * `QueueSheet` has drawn that distinction since the strip existed
   * (`isUpload ? e.upload!.relPath : e.text`); a row that passed its own prose
   * here would show nothing for exactly the files somebody opened this screen
   * to look at.
   *
   * `null` is a claim, not a shrug: an answer is keystrokes ("2\r"), a build is
   * a shell command and a download is already a file with a row of its own, so
   * none of the three has a text whose file mentions mean anything. The view
   * renders no strip rather than an empty one.
   */
  attachText: string | null;
  /** Where it is going: a session title, a repo, "5 repos", a phone folder. */
  where: string;
  /** The repo its words were written for — what makes a retry need no picker. */
  cwd: string | null;
  /** What makes the row tappable through to a terminal. */
  sessionId: string | null;
  /** The other axis. `null` when the row has not been delivered at all yet. */
  delivery: DeliveryTruth | null;
  /** Sort instant: the most recent thing that HAPPENED to this row. */
  at: number;
  createdAt: number;
  /** When it is next due. Sorted ascending inside the `scheduled` bucket, and
   *  rendered as a countdown — a wall-clock instant alone does not answer "is
   *  that before or after I go to bed". */
  dueAt: number | null;
  /**
   * This row is LAST KNOWN, not live, and this is when it was last true.
   *
   * Set only for host-sourced rows with the socket down. The phone's own rows
   * (the send queue, the give-ups ledger, the download records) are never
   * stale: they are the original, not a copy of one.
   */
  asOf: number | null;
  /** How far along, when that is a number and not a state. */
  progress: { done: number; total: number; label?: string } | null;
  /** A sweep's repos. Empty for everything else. */
  targets: ActivityTarget[];
  /** What happened the last time it ran (a recurring schedule keeps the newest). */
  lastRun: { at: number; ok: boolean; detail: string; late?: boolean } | null;
  /** Delivery attempts spent, when the source counts them. */
  attempts: number;
  actions: ActivityAction[];
  subject: ActivitySubject;
  /**
   * When the user filed this row as seen-and-not-wanted. Absent = not filed.
   *
   * OPTIONAL, and stamped by `activityRows()` from an injected map rather than
   * by the eight builders, because dismissal is not a fact any source knows: it
   * is a DECISION about a row, taken on this phone, and the row's own ledger has
   * no field for it. Absent means "not dismissed" and nothing else — there is no
   * second meaning to collapse here.
   *
   * It is not a delete. The row keeps its words, its verdict and its actions;
   * it moves under the `dismissed` chip and stops being counted by the others,
   * which is the whole and only thing the user asked "clean it up" to mean.
   */
  dismissedAt?: number;
  /**
   * When a person, not the desktop, established this row actually ran.
   *
   * Only ever set on a row whose `delivery` was `"unconfirmed"` — the
   * desktop's own detector degraded and never settled it. Present ⇒ the
   * bucket reads `done` and the verdict says whose call it was; `delivery`
   * itself is left alone, because it is a true fact about what the desktop
   * itself established, and a person's read of the terminal is a different
   * fact rather than a correction of it.
   */
  confirmedDoneAt?: number;
}

// ── What the rule cannot know on its own ────────────────────────────────────

/**
 * The facts that live in a module this one may not import.
 *
 * Injected rather than re-implemented, for the reason the header gives: reaching
 * `./outbox` for `isEditableEntry` would drag in `./settings`, which patches a
 * browser global at module load. Re-writing the two predicates here instead
 * would be worse — a second copy of "may this be edited" drifts from the one
 * the queue sheet enforces, and the drift shows up as a button that does
 * nothing.
 */
export interface ActivityDeps {
  /** `outbox.ts`'s rule. */
  isEditableEntry: (e: OutboxEntry) => boolean;
  /** `outbox.ts`'s rule: is this the op that OPENS a session? */
  isCreateOp: (e: OutboxEntry) => boolean;
  /** Lane id → human label. App's `laneLabel`. */
  laneLabel: (e: OutboxEntry) => string;
  /** Absolute worktree path → the name a person reads. */
  repoName: (cwd: string) => string;
}

export interface ActivityInput {
  now: number;
  /** A socket is open. Everything host-sourced is last-known without it. */
  online: boolean;
  /**
   * When host state last arrived ON THIS CONNECTION.
   *
   * `netsync.ts`'s rule, and the reason it is a parameter: a part counts only
   * if it landed after the current connection came up, and this module cannot
   * see connections.
   */
  hostSeenAt: number | null;
  deps: ActivityDeps;

  outbox?: readonly OutboxEntry[];
  /**
   * ackId → the ladder branch that refused it, from `selectSendable().blocked`.
   *
   * An input and not a recomputation: `SendPlan.blocked`'s own doc says the
   * reason is emitted BY the ladder that decided and never re-derived by a
   * second reading of the state. Deriving it here would produce a sheet that
   * explains a decision the flusher did not make.
   */
  queueBlocked?: ReadonlyMap<string, SendBlockReason>;
  /** App's `goneLanes()` — lane keys whose session no longer exists. Also an
   *  input: App waits for a session list that landed on the CURRENT connection,
   *  and this module has no way to know that. */
  goneLanes?: ReadonlySet<string>;
  /**
   * **Every piece of deferred work the desktop is holding, in one list.**
   *
   * This replaced five: `launches`, `backlog`, `schedules`, `fanoutRuns` and
   * `buildRuns` — five lossy projections of these very rows, shipped in the
   * same frame burst as the rows themselves. It also replaced
   * `backlogWaiting`, the host's per-item sentence, which is `blockDetail` on
   * the row and never needed a map beside it; and `autoFire`, the global
   * switch, whose only job here was to help GUESS a verdict the host had
   * already written.
   */
  intents?: readonly Intent[];
  pulls?: readonly PullRecord[];
  sessions?: readonly SessionInfo[];
  /**
   * Row key → when it was filed away (`activityDismiss.ts`).
   *
   * An input for the same reason `queueBlocked` is: this module cannot read
   * `localStorage`, and the decision is the phone's, not any source's.
   */
  dismissed?: ReadonlyMap<string, number>;
  /** Row key → when a person marked it actually run (`activityDone.ts`). Same
   *  shape and the same reason as `dismissed`: the decision lives on this
   *  phone, not in any source. */
  confirmedDone?: ReadonlyMap<string, number>;
}
