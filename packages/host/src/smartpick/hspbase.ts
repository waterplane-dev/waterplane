/** A slice of smartpick.ts — moved whole from smartpick.ts, see docs/notes/smartpick-architecture.md (host). */
import type { SmartPickCandidate, SmartPickFacts, SmartPickSummary } from "@waterplane/shared";
import { gitRecentSubjects, gitStatus } from "../git.js";
import { SmartPickStore } from "./hspstore.js";
import { type InFlight, type SmartPickDeps } from "./hspdeps.js";
import { isCandidateRow, toCandidate } from "./hsphelpers.js";
import { FACTS_TTL_MS, MAX_DIRTY } from "./hspknobs.js";

export abstract class SmartPickBase {
  readonly store: SmartPickStore;
  /** One pass per worktree, keyed by cwd and NOT by row — `serial` bites only
   *  once something has been claimed, and a held row claims nothing, so the
   *  second row of the same repo reaches `hold()` in the same pass. */
  protected inflight = new Map<string, InFlight>();
  /**
   * Worktrees whose backlog this feature is in the middle of MUTATING.
   *
   * The second half of rung 4, and it is not a nicety. `intents.post()` kicks
   * the tick SYNCHRONOUSLY, so posting the merged row re-enters `pass()` — and
   * therefore `hold()` — from inside `performMerge`, in the two statements
   * between the post and the archive of its originals. The in-flight entry is
   * already gone by then (the answer has landed), so without this the
   * re-entrant call reads a HALF-APPLIED backlog: the merged row AND both of
   * the rows it was made from, all still waiting. It buys a second completion
   * against that list, is handed the same merge again, and applies it a second
   * time — two merged rows for one pair, and an `undo` that unwinds only the
   * newer of them.
   *
   * Measured, not imagined: `scripts/e2e-smartpick.mjs` found exactly that,
   * 3 ms apart, with the second pass reporting it had looked at four items in a
   * repo that had three. The same re-entrancy reaches `undo` (whose refusal is
   * recorded at the END, so a pass started in the middle of one is free to
   * propose the merge being undone) and boot's `finishApplying`, and all three
   * are held the same way.
   */
  protected applying = new Set<string>();
  protected factsCache = new Map<string, { at: number; facts: SmartPickFacts }>();

  /**
   * Run a mutation with this repo's ladder closed, and kick once it is open.
   *
   * Released on the next TURN of the event loop rather than at the end of the
   * statement, and that is the whole subtlety. A tick is created INSIDE this
   * window (the kicks above are synchronous), and it asks `hold()` about each
   * row in turn with an `await` between them — microtasks, every one. Clearing
   * the flag as this returns therefore lands in the MIDDLE of that walk: the
   * row it asked about first stays held, the next one is let through, and the
   * item that fires is the one the pass has just sorted out of the way. That
   * is not theory either — with the flag cleared synchronously, the repo whose
   * pass had picked the third item ran the second.
   *
   * A macrotask lands after every one of those awaits. The tick in flight
   * holds every row, and the single kick below starts a clean one over the
   * list as it now is. `TICK_MS` is the backstop if that kick lands on a tick
   * that is still running.
   */
  protected whileApplying<T>(cwd: string, fn: () => T): T {
    this.applying.add(cwd);
    try { return fn(); } finally {
      const t = setTimeout(() => { this.applying.delete(cwd); this.deps.intents.kick(); }, 0);
      // Never hold the process open for a grooming pass — `npm run restart` is
      // routine here.
      t.unref?.();
    }
  }

  /** Kick the tick, unless a mutation is in progress — in which case the kick
   *  belongs on the other side of it, and `whileApplying` issues exactly one. */
  protected kick(cwd: string): void {
    if (!this.applying.has(cwd)) this.deps.intents.kick();
  }

  constructor(protected deps: SmartPickDeps) {
    this.store = new SmartPickStore(deps.root);
  }

  protected now(): number { return this.deps.now?.() ?? Date.now(); }

  // ── Reading the repo ──────────────────────────────────────────────────────

  /**
   * This repo's waiting items, in the order they would run.
   *
   * Exactly `isCandidateRow`'s set: what a pass may sort, merge and pick among.
   * An archived row is not in it (it is set aside, not waiting), nor is anything
   * already running, terminal, chained, pinned or aimed at a named session.
   */
  candidates(cwd: string): SmartPickCandidate[] {
    return this.deps.intents.list()
      .filter((r) => r.cwd === cwd && isCandidateRow(r))
      .sort((a, b) => (a.order ?? a.createdAt) - (b.order ?? b.createdAt))
      .map((r) => toCandidate(r, this.now()));
  }

  /**
   * Branch, uncommitted files, recent commit subjects — the cheap facts the
   * brief allows, and no repo scan.
   *
   * Cached for five seconds per worktree so the confirming tick right after an
   * apply pays no second `git` spawn. **Facts DEGRADE, they are never invented**:
   * a worktree that is not a repo, a `git` that failed, a detached checkout —
   * each answers empty, and the pass still runs on the words alone. A `branch`
   * of `"?"` says "nobody could tell you", which is a different claim from
   * naming the wrong branch.
   */
  async repoFacts(cwd: string): Promise<SmartPickFacts> {
    const hit = this.factsCache.get(cwd);
    const now = this.now();
    if (hit && now - hit.at < FACTS_TTL_MS) return hit.facts;
    if (this.deps.facts) {
      const facts = await this.deps.facts(cwd);
      this.factsCache.set(cwd, { at: now, facts });
      return facts;
    }
    let facts: SmartPickFacts = { branch: "?", dirty: [], commits: [] };
    try {
      const [status, commits] = await Promise.all([gitStatus(cwd), gitRecentSubjects(cwd, 10)]);
      const dirty = status.files.map((f) => `${f.code} ${f.path}`).sort();
      facts = {
        branch: status.branch,
        dirty: dirty.length > MAX_DIRTY ? [...dirty.slice(0, MAX_DIRTY), `+${dirty.length - MAX_DIRTY} more`] : dirty,
        commits,
      };
    } catch { /* degraded, and the pass runs on the words */ }
    this.factsCache.set(cwd, { at: now, facts });
    return facts;
  }

  // ── What the phone reads ──────────────────────────────────────────────────

  summaries(): Record<string, SmartPickSummary> { return this.store.summaries(); }
  summary(cwd: string): SmartPickSummary | undefined { return this.store.lastPass(cwd)?.summary; }
  rowFacts(id: string): { mergedFrom?: string[]; mergedInto?: string } | undefined { return this.store.rowFacts(id); }

  // ── Bookkeeping ───────────────────────────────────────────────────────────

  protected record(cwd: string, fp: string, summary: SmartPickSummary): void {
    this.store.recordPass(cwd, { fp, summary });
    this.deps.onChange?.();
  }

  /** Every optional field of a summary is dropped when it is absent rather than
   *  sent as a zero — CLAUDE.md's rule about a heuristic degrading to absent,
   *  applied to a cost line a person reads in dollars. */
  protected summaryOf(s: SmartPickSummary): SmartPickSummary {
    const out: Record<string, unknown> = { ...s };
    for (const k of Object.keys(out)) if (out[k] === undefined) delete out[k];
    return out as unknown as SmartPickSummary;
  }
}