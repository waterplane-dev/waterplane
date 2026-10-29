import type { HostPluginApi, PluginCaller } from "./api.js";
import type { PluginMethods } from "./manifest.js";

/** One line of the preflight report a builtin's `doctor` contributes. */
export interface PluginDoctorCheck {
  /** Short stable name, e.g. `opencode-binary`. */
  id: string;
  status: "ok" | "warn" | "fail";
  detail: string;
  fix?: string;
}

/** How long the core holds a hook's HTTP response for a pending answer by default, and at most. */
export const PLUGIN_HOOK_HOLD_DEFAULT_MS = 8_000;
export const PLUGIN_HOOK_HOLD_MAX_MS = 60_000;

/** What an `onHook` handler is handed beside the payload. */
export interface PluginHookHold {
  /** How long the core holds this response before answering `{}` itself. */
  readonly maxHoldMs: number;
  /** Called once when the core answered `{}` instead of the handler: the hold
   *  ran out, or the plugin was switched off. The CLI then goes its own way. */
  onExpired(fn: () => void): void;
}

/**
 * One repo, as a plugin may look at it (`api.repo(repoId)`): its files and git
 * facts through the core's containment guard — a path that leaves the worktree,
 * or names a secret (`.env*`), reads as null, never as an error.
 */
export interface PluginRepoScope {
  readonly id: string;
  readonly name: string;
  readonly branch: string;
  readonly isPrimary: boolean;
  /** Absolute path of the worktree. */
  readonly worktree: string;
  /** A text file inside the worktree; null if absent, outside, binary or a secret. */
  readFile(relPath: string, maxBytes?: number): string | null;
  /** One directory's entries (not recursive); null if absent or outside. Secrets are left out. */
  listDir(relPath?: string): { name: string; dir: boolean }[] | null;
  /** HEAD and the working tree, read now — synchronous subprocesses, not from a setup check. `head` is null in a repo with no commit. */
  git(): { branch: string; head: string | null; changed: number } | null;
}

/** What a contributed setup check or fix is handed: the worktree it is about. */
export interface SetupSubject {
  /** Absolute path of the worktree being checked. */
  worktree: string;
}

/** A contributed fix's outcome: `applied` says whether it changed anything, `note` says what, in words. */
export interface SetupFixOutcome {
  applied: boolean;
  note: string;
}

/** `api.handToAgent`'s answer: the intent id the prompt now waits under, or why not. */
export type HandToAgentResult =
  /** `existing`: the `key` named a row the store already held (nothing new was written); `state`: that row's state then (absent when new). */
  | { ok: true; intentId: string; existing: boolean; state?: string }
  | { ok: false; reason: string };

/**
 * A plugin module's shape. `deactivate` runs on disable and on shutdown
 * (started, never awaited there). `shutdown` runs ONLY as the daemon exits, after
 * every store is flushed, SYNCHRONOUSLY and whether or not the plugin is still
 * switched on — the place to kill child processes it owns (a switched-off
 * plugin's running sessions keep their children until then).
 */
export interface HostPluginModule {
  activate(api: HostPluginApi): void | Promise<void>;
  deactivate?(): void | Promise<void>;
  shutdown?(): void;
  /**
   * Lines for the preflight report (`npm run doctor` and the boot summary), since 1.1. Asked of
   * the IN-REPO extensions only, WITHOUT `activate` — the doctor loads no plugin — so it must
   * stand alone. `usedBackends` are the backend ids this host's recent sessions ran on: a line
   * about a binary nobody asked for says "something is wrong" about nothing, so answer [] then.
   * Never throws; a throw drops the lines.
   */
  doctor?(req: { usedBackends: readonly string[] }): Promise<PluginDoctorCheck[]>;
}

/**
 * Register every method of a typed table with `api.handle`; returns one unregister.
 * Args arrive from the wire UNCHECKED — the types are a convenience, each handler validates.
 */
export function handleAll<M extends PluginMethods>(
  api: Pick<HostPluginApi, "handle">,
  fns: { [K in keyof M & string]: (args: M[K]["args"], caller: PluginCaller) => M[K]["result"] | Promise<M[K]["result"]> },
): () => void {
  const offs = Object.keys(fns).map((k) => api.handle(k, (a, c) => (fns as Record<string, (x: unknown, c: PluginCaller) => unknown>)[k]!(a, c)));
  return () => { for (const off of offs) off(); };
}

