/**
 * What a backlog slice is written against: the manager's state and collaborators,
 * as one object. Types only — `BacklogManager` builds the one instance and hands
 * it to every slice function as `c`. Slices read `c.<x>` at CALL time and the
 * by-reference members (`repoSessions`, `openedBy`) are shared, never
 * copied; `auto` and `closeDefault` are the two the slices reassign.
 */
import type { SessionManager } from "../sessions.js";
import type { IntentManager } from "../intents/manager.js";
import type { ReviewStore } from "../review.js";

/**
 * What `<STATE_DIR>/backlog-config.json` holds.
 *
 * `{ auto }` — one boolean. A file written by an older host may also carry a
 * `smartPick` key (the per-repo smart-pick ticks, a feature removed
 * 2026-10-16): it is ignored on read and gone on the next write.
 */
export interface BacklogConfig {
  auto?: boolean;
}

export interface BacklogCore {
  readonly root: string;
  readonly sessions: SessionManager;
  readonly intents: IntentManager;
  readonly reviews: ReviewStore;
  /** `<state dir>/backlog-config.json`. */
  readonly autoPath: string;
  /** The global auto-fire switch. */
  auto: boolean;
  /** repoDir → the session the sheet's *open a session here* last opened. Memory-only. */
  readonly repoSessions: Map<string, string>;
  /** sessionId → the intent that opened it (`openItemSession`'s mark). Memory-only. */
  readonly openedBy: Map<string, string>;
  /** The synced global close-when-done default, read at CALL time. */
  closeDefault: () => boolean;
}
