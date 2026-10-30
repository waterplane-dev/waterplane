/**
 * The one shape a notification takes on its way into the feed — every module
 * that raises one declares `notify: Notify` instead of spelling its own copy,
 * so a new field touches the sender and `server/clients.ts`, nothing between.
 * Flat on purpose: a flat module never imports `routes/` (`routes/types.ts`
 * re-exports it for the routes).
 */
import type { NotificationKind, NotifyLevel, NotifyOpen, NotifyOutcome } from "@waterplane/shared";

/**
 * What a call site hands `notify()`. The level is `notifyLevel(kind, outcome,
 * level)` — pass `outcome` when the call site knows how a run ended, `level`
 * only to override the kind's default. An attention item is persisted and
 * counted until handled; give it a `key` (`gitAttentionKey`,
 * `buildAttentionKey`, `prompt:<sid>`, `followup:<sid>`, `undelivered:<sid>`)
 * so its cause can `resolveAttention(key, note)` it and so a newer item under
 * the same key replaces the older one.
 */
export interface NotifyParams {
  title: string; body: string; sessionId?: string; tag?: string;
  image?: { repoId: string; relPath: string };
  file?: { repoId: string; relPath: string; name: string; size: number; mtime?: number };
  pull?: string;
  backlog?: { cwd: string; ids: string[] };
  /** Id of the plugin that posted it (host-filled); a tap opens that plugin. */
  plugin?: string;
  open?: NotifyOpen;
  /** Explicit level; wins over `outcome` and the kind's default. */
  level?: NotifyLevel;
  /** How the run this is about ended: failed ⇒ attention, ok ⇒ info. */
  outcome?: NotifyOutcome;
  /** The cause key (see above). Kept on the wire item. */
  key?: string;
  /** HOST-ONLY: the full failure text. Kept beside an attention item for the
   *  repo listing; never on the wire item, never in a push. */
  detail?: string;
  /** HOST-ONLY: the build entry a failed build was (`RepoTarget.buildFailed`). */
  build?: { id: string; name: string };
  /** HOST-ONLY: a failed push's branch and commit — what resolves it (`attentionstore.ts`). */
  pushHead?: { branch: string; sha: string };
}

/** `notify()` as every dependency bag spells it. */
export type Notify = (kind: NotificationKind, p: NotifyParams) => void;
