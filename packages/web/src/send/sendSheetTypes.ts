/** The props of the send sheet. Split from `SendSheet.tsx` (docs/notes/send-architecture.md). */
import type { BackendInfo, Intent, LaunchOpts, RepoTarget, SessionInfo, WindowResets } from "@waterplane/shared";
import { type OutboxEntry } from "../outbox";
import { type SendIntent, type SendResume, type SendSeed } from "../sendIntent";

export interface SendSheetProps {
  seed: SendSeed;
  sessions: SessionInfo[];
  repos: RepoTarget[];
  outbox: OutboxEntry[];
  online: boolean;
  /** The usage reading this phone already has, so a rule anchored to a reset
   *  resolves to a real instant here instead of to "not armed yet". Absent
   *  until the host has scraped the meter once — that absence is a state the
   *  sheet WORDS, never a refusal. */
  usage?: WindowResets | null;
  /**
   * Every piece of work this desktop is holding — what the *after another…*
   * picker offers, and nothing else.
   *
   * The sheet reads the store directly rather than being handed a pre-made list
   * of `{id, title}` pairs, for the reason `ActivitySheet` reads it directly:
   * the title of a row is a rule (`intentTitle`), the state of a row decides
   * whether it may be chained behind at all (`chainCandidates`), and a caller
   * that flattened both into a list would be a third opinion about which rows
   * exist. Empty is a real answer and is WORDED — the segment is never dimmed.
   */
  intents: Intent[];
  /** What this host said it can launch (null: it never said) and the stored
   *  new-session defaults — what the *model* row's picker starts from. Optional
   *  only for re-time mode, which draws no *To* row (absent reads as an
   *  undescribed host and Claude Code's own defaults). */
  backends?: BackendInfo[] | null;
  launchDefaults?: LaunchOpts;
  /** What a build id is called, for a seeded shell target. */
  buildName: (cwd: string, buildId: string) => string;
  /** Park picked files in a repo's inbox; resolves to the path each WILL have. */
  onAttach: (files: File[], repo: RepoTarget) => Promise<string[]>;
  /** Hand images to the annotator (which REPLACES this sheet — the draft is
   *  persisted per keystroke and the marked path is appended to it). */
  onAnnotate: (files: File[], repo: RepoTarget) => void;
  /**
   * Browse what is ALREADY in the repo and put a path into the prompt.
   *
   * The two attach buttons both park NEW bytes. Naming a file the repo already
   * holds was a capability only the deleted backlog add form had, and what was
   * left of it was the clipboard — which needs a secure context, and a plain
   * `http://100.x` tunnel is not one. So on the APK, over the tunnel this app
   * is normally used on, there was no route at all. Same round trip as the
   * annotator's: the gallery replaces this sheet and the path comes back
   * through the persisted draft.
   */
  onBrowseRepoFiles?: (repo: RepoTarget) => void;
  /** The decision this sheet was last showing, for the round trip through the
   *  annotator. The WORDS survive that trip in the draft; WHERE, WHEN and HOW
   *  MANY AT ONCE used to be re-read from the seed, so a schedule set before
   *  attaching a picture came back as "now" — silently, on the one send whose
   *  whole point was that it was not now. */
  resume?: SendResume | null;
  /** Report that decision as it changes, so the caller can hand it back. */
  onDecide?: (d: SendResume) => void;
  /** Repair mode: put this phone's retained copy back in the send queue. */
  onReattach?: (relPath: string, repoId: string, cwd: string) => Promise<void>;
  /** Repair mode: pick a different file for one mention; resolves to its path. */
  onReplace?: (relPath: string, repoId: string, cwd: string) => Promise<string | null>;
  /** Post it. True = it went (or queued); false = refused, keep the sheet up. */
  onSend: (intent: SendIntent) => boolean;
  /** Throw the original away without sending (a repair only). */
  onDiscard?: () => void;
  onClose: () => void;
  /** Re-time mode: the budget verdict holding automatic work, when it does, and
   *  WHICH ticked rows it holds (`budgetHeldIds` — the count and the action). */
  budgetHeld?: { note: string; resumeAt?: number | null; ids: string[] } | null;
  /** Re-time mode: let exactly those rows past the BUDGET and nothing else
   *  (`intent.waive`) — they still wait their turn. Never `intent.run`. */
  onPastBudget?: (ids: string[]) => void;
}
