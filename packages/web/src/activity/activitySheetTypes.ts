import type { BacklogItem, Intent, RepoTarget, SendBlockReason, SessionInfo } from "@waterplane/shared";
import type { OutboxEntry } from "../outbox";
import type { PullRecord } from "../pull";
import type { ActivityActionId, ActivityRow } from "../activityRows";

/**
 * The check verdict as this screen renders it — `BacklogItem`'s own four
 * fields, named once so the sheet does not depend on a whole DTO for four
 * strings. `review.ts` is where they come from and where they live.
 */
export type ReviewMarks = Pick<BacklogItem, "checkStatus" | "checkNote" | "checkDetail" | "checkedAt">;

export interface ActivitySheetProps {
  // ── The seven sources, raw. The sheet builds the row model itself so App
  //    does not have to import the selector's dependency bundle. ──
  outbox: readonly OutboxEntry[];
  /** ackId → the ladder branch that refused it (`selectSendable().blocked`).
   *  Emitted BY the flusher, never re-derived — see `activityRows.ts`. */
  queueBlocked: ReadonlyMap<string, SendBlockReason>;
  /** App's `goneLanes()`. */
  goneLanes: readonly string[];
  /**
   * Everything the desktop is holding, as the durable rows themselves.
   *
   * Five props (`launches`, `backlog`, `schedules`, `fanoutRuns`, `buildRuns`)
   * plus `backlogWaiting` — the host's per-item sentence, which is `blockDetail`
   * on the row — collapsed to this one. They were five lossy projections of
   * these rows, arriving in the same frame burst as the rows.
   */
  intents: readonly Intent[];
  /**
   * Implementation-check verdicts, by intent id.
   *
   * A sidecar on the way in as well as on the host (`review.ts`): a check
   * verdict is not lifecycle, so it rides beside a row rather than on it, and
   * `activityRows.ts` never sees it — nothing on this screen DECIDES anything
   * from it.
   */
  reviews?: Readonly<Record<string, ReviewMarks>>;
  pulls: readonly PullRecord[];
  sessions: readonly SessionInfo[];
  /** The destinations a row can be re-aimed at. Passed through to the shared
   *  `RepoPicker`, which is the one place "which repo?" is asked. */
  repos: readonly RepoTarget[];

  /**
   * Open showing ONLY these rows (by `ActivityRow.key`), because the caller
   * knows which ones the person came here to find.
   *
   * The queue bar counts failures ("2 messages not delivered") and its Manage
   * button used to land on `all`, which on a real phone is 200 rows — the
   * count named a set the next screen could not show. So the caller hands the
   * set over.
   *
   * It is a FILTER and therefore says so on screen, in the loudest way this
   * sheet has: a chip naming what is hidden with one tap to drop it. Nothing on
   * a screen whose job is proving nothing was lost may quietly show a subset.
   */
  focus?: { keys: readonly string[]; label: string } | null;

  /** false = no socket. Host rows become last-known and say their age. */
  online: boolean;
  /** When host state last arrived ON THIS CONNECTION (`netsync.ts`'s rule). */
  hostSeenAt: number | null;

  // ── The facts the selector may not compute for itself ──
  /** Lane id → human label. App's `laneLabel`. */
  laneLabel: (e: OutboxEntry) => string;
  /** Absolute worktree path → the name a person reads. */
  repoName: (cwd: string) => string;
  /**
   * Absolute worktree path → the repo id the artifact endpoints take.
   *
   * A row carries the `cwd` its words were written for; `AttachStrip` wants an
   * id. `PadSheet` already asks App this exact question for exactly this reason
   * (`repoIdForCwd`, wired to App's one `repoForCwd`), and inventing a second
   * cwd→repo mapping here — matching on `repos[].worktreePath` — would be a
   * copy that drifts the day a worktree resolves differently. Null is a real
   * answer: nothing on the host can be looked up, so the strip falls back to
   * this phone's own bytes and reports `unknown` rather than `missing`.
   */
  repoIdForCwd: (cwd: string) => string | null;

  /**
   * Do the thing.
   *
   * ONE callback rather than sixteen, because the row already carries its
   * `subject` discriminated by source and the routing is a `switch` App is
   * better placed to write than this file is. Every id the sheet can emit is in
   * `ActivityActionId`, so an unhandled one is a type error and not a dead
   * button.
   *
   * The caller MUST say something — a toast, a row change, a navigation. Every
   * control here is pressed by someone who has already lost track of a piece of
   * work once; a tap that produces silence is how they lose track of it twice.
   */
  onAction: (id: ActivityActionId, row: ActivityRow) => void;
  /**
   * Keep the words, change the destination.
   *
   * Its own callback rather than an `onAction("retarget")`, because a re-aim
   * needs an ANSWER and the question is asked here: the row already knows the
   * repo its words were written for, so the picker opens with that answer
   * first, labelled, and never preselected. Routing this through the generic
   * handler would mean App owning a picker for a row it cannot see.
   *
   * Reached only from rows whose `retarget` action is enabled.
   */
  onRetarget: (row: ActivityRow, to: { sessionId: string; cwd: string; mode?: "input" | "backlog" }) => void;
  /** Open one of a sweep's per-repo sessions. */
  onOpenSession: (sessionId: string) => void;

  /** Row key → when it was filed away. App owns the store (`activityDismiss.ts`);
   *  this sheet only ever asks for a change. */
  dismissed: ReadonlyMap<string, number>;
  /** Row key → when a person marked it "save as done". App owns the store
   *  (`activityDone.ts`); same read-only relationship as `dismissed`. */
  confirmedDone: ReadonlyMap<string, number>;
  /**
   * A decision taken over MANY rows at once.
   *
   * Its own callback rather than an `onAction` per row, and the reason is the
   * one thing that makes this screen usable at 84 rows: a bulk act must produce
   * ONE sentence, one confirmation and one undo — never 84 toasts and 84
   * chances for half of them to fail silently. The sheet decides WHICH rows
   * (`refireBlocker` / `dismissBlocker` partition the selection, and the skipped
   * ones keep saying why on their own rows); App decides what happens to them,
   * asks `askConfirm` with the count and a sample, and says what it did.
   *
   * `restore` is the undo, and it is why `dismiss` is allowed to be a bulk
   * button at all.
   */
  onBulk: (kind: "refire" | "dismiss" | "restore", rows: ActivityRow[]) => void;
  onClose: () => void;
}
