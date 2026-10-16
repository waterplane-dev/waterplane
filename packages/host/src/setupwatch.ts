/**
 * The setup checklist, asked WITHOUT being asked.
 *
 * `compliance.ts` knows whether a repo is wired the way waterplane expects; until now
 * nothing ever ran it on its own. You found out a repo was missing its
 * gitignore/outbox wiring only by opening the Repo setup sheet and picking that
 * repo from a dropdown — i.e. exactly for the repos you already suspected. The
 * repos that matter are the other ones: a clone you made on the desktop and then
 * drove from the phone, where the first sign of trouble is an inbox photo turning
 * up in `git status`, or an agent that never drops anything in the outbox because
 * its CLAUDE.md never mentioned one.
 *
 * So the host sweeps for itself: every discovered primary worktree is inspected
 * once when first seen, re-inspected when the answer is stale, and inspected
 * again the moment a session opens in it. The verdict is a small rollup hung on
 * `RepoTarget.setup`, which the launcher's repo row badges — one tap into the
 * checklist that already exists.
 *
 * Deliberate boundaries:
 *
 *  - **It never writes into a repo.** Only `inspectRepo()` runs here (pure read);
 *    the fixes stay behind the button they have always been behind. A daemon that
 *    edits the CLAUDE.md of a repo you have not opened yet is a worse surprise
 *    than the misconfiguration it fixes.
 *  - **Absent ≠ clean.** A worktree with no entry has not been checked (fresh
 *    discovery, watcher disabled, git missing); the rollup is simply omitted so
 *    the UI can't read silence as a pass.
 *  - **Host-scope rows don't count** (`summarize()`): one unset GEMINI_API_KEY
 *    would otherwise chip every repo on the machine, and a badge that is always
 *    on is a badge nobody reads.
 *
 * Persisted in `<STATE_DIR>/setup.json` (tmp+rename, like the ack ledger and the
 * schedule store) for two reasons: `/api/repos` must be able to answer from the
 * store instead of shelling out to git per repo per request, and `firstSeenAt`
 * only means anything if it survives the restart that `npm run restart` makes
 * routine.
 */
import { existsSync, mkdirSync, realpathSync } from "node:fs";
import { join } from "node:path";
import type { RepoSetupState } from "@waterplane/shared";
import { inspectRepo, inspectRepoAsync, summarize } from "./compliance.js";
import { discoverTargets } from "./repos.js";
import { env } from "./env.js";
import { logTag } from "@waterplane/shared";
import { hostStateDir } from "./branddirs.js";
import { readJsonGuarded, writeJsonAtomic } from "./jsonstore.js";

/** How often the sweep looks for repos it has never checked. */
const SWEEP_MS = Math.max(5_000, Number(env("SETUP_SWEEP_MS") || 10 * 60_000));
/** How stale a verdict may get before the sweep re-asks. A repo's wiring changes
 *  about never, and each check is a handful of git subprocesses. */
const RECHECK_MS = Math.max(60_000, Number(env("SETUP_RECHECK_MS") || 6 * 60 * 60_000));
/** Checks per sweep pass, so a root with a hundred repos doesn't hold the event
 *  loop hostage on boot. The rest are picked up by the next tick. */
const MAX_PER_SWEEP = Math.max(1, Number(env("SETUP_SWEEP_BATCH") || 12));
/**
 * The version of what COUNTS as an issue (`summarize()` / `isSetupFinding`).
 * Bump it whenever that rule changes: a stored verdict is a count, not the
 * checks behind it, so it cannot be re-summarised — a file written under the
 * old rule is dropped on boot and the sweep re-counts, rather than every badge
 * showing the old number for up to RECHECK_MS. Absent beats wrong.
 * 2 = advisory rows (`context-weight`, `auto-compact`) stopped counting.
 */
const SETUP_RULES = 2;

/**
 * Store key. A worktree reaches us by two routes that spell the same directory
 * differently — `git worktree list` resolves symlinks (macOS `/var` →
 * `/private/var`), a session's `cwd` does not — and two spellings would mean the
 * badge never clears for the repo you just fixed. Realpath is the one spelling.
 */
function key(worktreePath: string): string {
  try {
    return realpathSync(worktreePath);
  } catch {
    return worktreePath;
  }
}

interface StoredEntry extends RepoSetupState {
  /** Kept so a pruned-and-rediscovered repo isn't reported as new twice. */
  repoName: string;
}

export class SetupWatcher {
  private entries = new Map<string, StoredEntry>();
  private path: string;
  private timer: NodeJS.Timeout | null = null;
  private sweeping = false;
  /** A `checkedAt` moved without the verdict changing, not yet written. */
  private unsaved = false;

  constructor(private root: string) {
    this.path = join(hostStateDir(root), "setup.json");
    try {
      const raw = readJsonGuarded<any>(this.path, null);
      if (raw?.rules !== SETUP_RULES) throw new Error("counted under another rule");
      // Every field of `RepoSetupState` is re-read by hand here, because the
      // file is untrusted JSON. The cost is that a field ADDED to the wire type
      // and forgotten here is silently dropped on every boot, and the verdict
      // then says something different from what the sweep concluded until
      // RECHECK_MS (6h) elapses — which is what happened to a short-lived
      // `failing` twin of `ok`: restarts are routine, so a genuinely broken repo
      // wore the "thing to look at" style for a working day. Add a field ⇒ add
      // it here, or don't add the field.
      for (const [wt, v] of Object.entries<any>(raw?.repos ?? {})) {
        if (!v || typeof v !== "object") continue;
        this.entries.set(wt, {
          repoName: String(v.repoName || ""),
          ok: !!v.ok,
          issues: Number(v.issues) || 0,
          fixable: Number(v.fixable) || 0,
          checkedAt: Number(v.checkedAt) || 0,
          firstSeenAt: Number(v.firstSeenAt) || Number(v.checkedAt) || 0,
        });
      }
    } catch { /* no file / bad json → everything is simply unchecked */ }
  }

  /** Start sweeping. Safe to call twice. `WATERPLANE_SETUP_WATCH=0` keeps the store
   *  (and the session-start re-check) but never scans on its own. */
  start(): void {
    if (this.timer || env("SETUP_WATCH") === "0") return;
    this.timer = setInterval(() => void this.sweep(), SWEEP_MS);
    if (typeof this.timer.unref === "function") this.timer.unref();
    void this.sweep();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** What we last concluded about this worktree, or undefined if never checked. */
  stateFor(worktreePath: string): RepoSetupState | undefined {
    const e = this.entries.get(key(worktreePath));
    if (!e) return undefined;
    const { repoName, ...state } = e;
    return state;
  }

  /**
   * Inspect one worktree now and remember the verdict. Used by the sweep, by the
   * session-start re-check, and by the checklist endpoints — so the badge always
   * reflects the last thing anyone actually learned, including a fix applied a
   * second ago.
   */
  check(worktreePath: string, repoName = ""): RepoSetupState | undefined {
    try {
      return this.record(worktreePath, inspectRepo(worktreePath), repoName);
    } catch {
      // A repo that vanished mid-check, or a machine with no git: leave the last
      // verdict alone rather than inventing a clean one.
      return this.stateFor(worktreePath);
    }
  }

  /** `check` with its git run in the background (`inspectRepoAsync`) — the sweep's, which nobody
   *  waits on: a blocking git per path held the loop for minutes on WSL over a Windows drive. */
  private async checkInBackground(worktreePath: string, repoName: string): Promise<void> {
    try {
      this.record(worktreePath, await inspectRepoAsync(worktreePath), repoName);
    } catch { /* as in `check`: the last verdict stands */ }
  }

  /** Remember a checklist someone else already produced (the sheet's GET, a fix's
   *  refreshed report) without paying for a second inspection. */
  record(worktreePath: string, checks: Parameters<typeof summarize>[0], repoName = ""): RepoSetupState {
    const now = Date.now();
    const k = key(worktreePath);
    const prev = this.entries.get(k);
    const entry: StoredEntry = {
      repoName: repoName || prev?.repoName || "",
      ...summarize(checks),
      checkedAt: now,
      firstSeenAt: prev?.firstSeenAt || now,
    };
    const changed = !prev || prev.ok !== entry.ok || prev.issues !== entry.issues;
    this.entries.set(k, entry);
    // An unchanged verdict still moved `checkedAt`; the sweep saves those once per pass. Unsaved,
    // every restart found every repo stale and re-inspected the whole root.
    if (changed) this.persist();
    else this.unsaved = true;
    if (!prev && !entry.ok) {
      // The whole point of the sweep, in one line of the host log: this repo was
      // never opened in the checklist and is not wired up.
      console.log(`${logTag} setup · ${entry.repoName || worktreePath}: ${entry.issues} issue${entry.issues === 1 ? "" : "s"}` +
        `${entry.fixable ? `, ${entry.fixable} fixable` : ""} — open Repo setup`);
    }
    const { repoName: _n, ...state } = entry;
    return state;
  }

  /**
   * One pass: check every primary worktree we have never checked (newest problem
   * first — those are the ones nobody has seen), then any whose verdict has gone
   * stale, capped per pass. Worktrees that no longer exist are dropped so the
   * store stays the size of the root, not of its history.
   */
  async sweep(): Promise<void> {
    if (this.sweeping) return;
    this.sweeping = true;
    try {
      const targets = (await discoverTargets(this.root)).filter((t) => t.isPrimary);
      const live = new Set(targets.map((t) => key(t.worktreePath)));
      let pruned = false;
      for (const wt of [...this.entries.keys()]) {
        if (live.has(wt) || existsSync(wt)) continue;
        this.entries.delete(wt);
        pruned = true;
      }
      if (pruned) this.persist();

      const now = Date.now();
      const fresh = targets.filter((t) => !this.entries.has(t.worktreePath));
      const stale = targets.filter((t) => {
        // `key()`, like every other access to this map. The raw path happens to
        // match today only because `git worktree list --porcelain` already emits
        // realpaths; a discovery path that did not would make every repo read
        // `fresh` on every tick and re-inspect for ever, silently.
        const e = this.entries.get(key(t.worktreePath));
        return e && now - e.checkedAt > RECHECK_MS;
      });
      for (const t of [...fresh, ...stale].slice(0, MAX_PER_SWEEP)) {
        // One repo at a time, its git in the background; the file reads that remain are
        // synchronous, so the loop is handed back between repos too.
        await this.checkInBackground(t.worktreePath, t.repoName);
        await new Promise((r) => setImmediate(r));
      }
    } catch { /* discovery failed (root gone?) — next tick tries again */ } finally {
      if (this.unsaved) this.persist();
      this.sweeping = false;
    }
  }

  private persist(): void {
    this.unsaved = false;
    try {
      mkdirSync(hostStateDir(this.root), { recursive: true });
      const repos: Record<string, StoredEntry> = {};
      for (const [wt, e] of this.entries) repos[wt] = e;
      writeJsonAtomic(this.path, { version: 1, rules: SETUP_RULES, repos }, { space: 2 });
    } catch { /* a store we can't write just means we re-check after a restart */ }
  }
}
