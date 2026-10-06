/**
 * What a backlog slice is written against: the manager's state and collaborators,
 * as one object. Types only — `BacklogManager` builds the one instance and hands
 * it to every slice function as `c`. Slices read `c.<x>` at CALL time and the
 * by-reference members (`smartPickOn`, `repoSessions`, …) are shared, never
 * copied; `auto` and `closeDefault` are the two the slices reassign.
 */
import type { SessionManager } from "../sessions.js";
import type { IntentManager } from "../intents/manager.js";
import type { ReviewStore } from "../review.js";

/**
 * What `<STATE_DIR>/backlog-config.json` holds.
 *
 * It was `{ auto }` — one boolean. The smart-pick tick joins it rather than
 * getting a file of its own for the reason the file already exists: it is
 * backlog MACHINERY configuration, written by the same manager, broadcast on the
 * same `backlog.list`, with exactly the same lifetime as the global switch. A
 * second file for one boolean per repo is a second thing to write, migrate and
 * keep in step.
 *
 * Keyed by `Intent.cwd`, which is already the containment-resolved realpath of
 * the worktree (`containRepoDir` on the way in), so the same repo reached by two
 * paths is one key. `setAt` rides along because a tick somebody turned on two
 * months ago and a tick they turned on this morning are different facts, and
 * nothing else on the row records when.
 */
export interface BacklogConfig {
  auto?: boolean;
  smartPick?: Record<string, { setAt: number }>;
}

export interface BacklogCore {
  readonly root: string;
  readonly sessions: SessionManager;
  readonly intents: IntentManager;
  readonly reviews: ReviewStore;
  /**
   * The smart pick, for the two things the backlog's own surface needs from
   * it: which rows a merge made and which rows a merge folded away
   * (`rowFacts`), and the undo behind the merged row's button. Optional, so a
   * host or a test that has not built one renders exactly the list it always did.
   */
  readonly smartpick?: {
    rowFacts(id: string): { mergedFrom?: string[]; mergedInto?: string } | undefined;
    undo(mergedId: string): { ok: boolean; reason?: string; detail?: string; ran?: boolean };
  };
  /** `<state dir>/backlog-config.json`. */
  readonly autoPath: string;
  /** The global auto-fire switch. */
  auto: boolean;
  /** The worktrees whose *smart pick* tick is on — a `Set`, because the first guard rung is a membership test. */
  readonly smartPickOn: Set<string>;
  readonly smartPickAt: Map<string, number>;
  /** repoDir → the session the sheet's *open a session here* last opened. Memory-only. */
  readonly repoSessions: Map<string, string>;
  /** sessionId → the intent that opened it (`openItemSession`'s mark). Memory-only. */
  readonly openedBy: Map<string, string>;
  /** The synced global close-when-done default, read at CALL time. */
  closeDefault: () => boolean;
}
