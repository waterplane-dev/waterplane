/**
 * Per-repo overrides for the context-weight thresholds.
 *
 * `compliance.ts`'s `context-weight` row asks what a repo costs to have OPEN,
 * and compares it to a line. Until now that line was three env vars
 * (`WATERPLANE_CONTEXT_WARN_CHARS` / `_HARD_CHARS` / `_MAX_SKILLS`), host-wide and
 * invisible from the phone — so the only way to disagree with it was to export
 * a variable on the desktop and restart, which changed the line for *every*
 * repo at once. The two repos that most need a different number are exactly the
 * ones that must not share one: a scratch project where 16k of instructions is
 * already absurd, and a repo whose invariants are genuinely load-bearing and
 * which will sit amber for ever otherwise.
 *
 * Deliberate shape:
 *
 *  - **A host store, keyed by worktree — never a file written into the repo.**
 *    `setupwatch.ts` sweeps repos the user has not opened, and the one rule that
 *    path holds is that it never writes into a repo. A threshold is also not a
 *    fact about the source tree: it is this desktop's opinion about a directory
 *    on it. `<STATE_DIR>/contextlimits.json`, beside `setup.json`.
 *  - **The key is the REALPATH**, the same spelling rule and for the same reason
 *    as `setupwatch.ts`: a worktree arrives spelled two ways (`git worktree
 *    list` resolves symlinks, a session's `cwd` does not) and two spellings
 *    would mean the override you just saved is not the one the sweep reads.
 *  - **A partial is a partial.** An entry holds only the fields that were set;
 *    the rest keep falling through to env and then to the default. Storing all
 *    three would freeze the other two at whatever today's default happens to be,
 *    so a later change to a shipped default would silently not reach the repo.
 *  - **Unset is a silent no-op**, like `clihealth.ts`: `inspectRepo()` is a free
 *    function with no root in hand, and a test or a tool that calls it without
 *    booting a daemon must get env+defaults, never a throw.
 */
import { existsSync, mkdirSync, realpathSync } from "node:fs";
import { join } from "node:path";
import type { ContextWeightLimits } from "@waterplane/shared";
import { sanitizeContextLimits } from "@waterplane/shared";
import { hostStateDir } from "./branddirs.js";
import { readJsonGuarded, writeJsonAtomic } from "./jsonstore.js";

/** One repo's override, plus when it was set — the stamp is only ever shown
 *  ("set 3 days ago"), never used to decide anything. */
export interface ContextLimitEntry {
  limits: Partial<ContextWeightLimits>;
  setAt: number;
}

type Doc = Record<string, ContextLimitEntry>;

/** The one spelling of a worktree path. Falls back to the given path when the
 *  directory is gone — a stale entry keyed on a name we can still read beats
 *  throwing inside a checklist. */
function key(worktree: string): string {
  try {
    return realpathSync(worktree);
  } catch {
    return worktree;
  }
}

export class ContextLimitsStore {
  private path: string;
  private doc: Doc = {};

  constructor(root: string) {
    this.path = join(hostStateDir(root), "contextlimits.json");
    try {
      if (existsSync(this.path)) {
        const parsed = readJsonGuarded<any>(this.path, null) as unknown;
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
          for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
            const rec = v as { limits?: unknown; setAt?: unknown };
            // Sanitise on the way IN as well as out: this file is plain JSON and
            // a hand-edit must not be able to put a zero or a string where a
            // threshold goes and have every reading taken against it.
            const { limits } = sanitizeContextLimits(rec?.limits);
            if (Object.keys(limits).length) {
              this.doc[k] = { limits, setAt: Number(rec?.setAt) || Date.now() };
            }
          }
        }
      }
    } catch { /* corrupt or unreadable → no overrides, which is the safe reading */ }
  }

  /** This repo's override, or null. Null means "nothing on file", which is a
   *  different thing from "all three at their defaults" and must stay so: the
   *  editor opens on what was saved. */
  get(worktree: string): Partial<ContextWeightLimits> | null {
    const e = this.doc[key(worktree)];
    return e && Object.keys(e.limits).length ? { ...e.limits } : null;
  }

  /** When this repo's override was last written, or null when it has none. */
  setAt(worktree: string): number | null {
    const e = this.doc[key(worktree)];
    return e ? e.setAt : null;
  }

  /**
   * Replace this repo's override. An empty patch CLEARS the entry — "back to
   * the host's line" is a state the user must be able to get back to, and a
   * lingering `{}` would keep answering `null` anyway while cluttering the file.
   */
  set(worktree: string, limits: Partial<ContextWeightLimits>): void {
    const k = key(worktree);
    if (!limits || !Object.keys(limits).length) delete this.doc[k];
    else this.doc[k] = { limits: { ...limits }, setAt: Date.now() };
    this.save();
  }

  clear(worktree: string): void {
    this.set(worktree, {});
  }

  private save(): void {
    try {
      mkdirSync(join(this.path, ".."), { recursive: true });
      writeJsonAtomic(this.path, this.doc, { space: 2 });
    } catch { /* a threshold that could not be persisted is not worth a crash */ }
  }
}

// ── The module-level singleton ──────────────────────────────────────────────
//
// `inspectRepo(worktree)` takes a path and nothing else, and is called from the
// sweep, from the HTTP route and from tests. Threading a store through all of
// them to reach one row would be the wrong trade; `clihealth.ts` already
// established the shape here — a settable singleton whose unset state is a
// silent no-op.

let current: ContextLimitsStore | null = null;

export function setContextLimitsStore(store: ContextLimitsStore | null): void {
  current = store;
}

export function contextLimitsStore(): ContextLimitsStore | null {
  return current;
}

/** This repo's override, or null when there is none — or when no store has been
 *  installed at all, which reads the same way on purpose. */
export function repoContextLimits(worktree: string): Partial<ContextWeightLimits> | null {
  return current?.get(worktree) ?? null;
}
