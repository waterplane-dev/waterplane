/** A slice of assess.ts — moved whole from assess.ts, see docs/notes/assess-architecture.md (host). */
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import type { AssessRun } from "@waterplane/shared";
import { hostStateDir } from "../branddirs.js";
import { ASSESS_MAX_RUNS } from "./hassknobs.js";
import { readJsonGuarded, writeJsonAtomic } from "../jsonstore.js";

// ── The sidecar ──────────────────────────────────────────────────────────────

/**
 * The proposals, keyed by run (intent) id.
 *
 * `ReviewStore`'s shape exactly, and for `ReviewStore`'s reason: the intent
 * store is the LIFECYCLE — state, trigger, target, result — and a proposal is
 * none of those. It outlives the run that produced it, one sheet reads it, and
 * putting it on `Intent` would mean every consumer of every row carrying a
 * field it will never look at.
 *
 * tmp+rename, because half a JSON document is worse than none.
 */
export class AssessStore {
  private rows = new Map<string, AssessRun>();
  private path: string;

  constructor(root: string, private onChange: (repoDir: string) => void) {
    this.path = join(hostStateDir(root), "assess.json");
    try {
      const raw = readJsonGuarded<any>(this.path, null);
      if (raw && typeof raw === "object") {
        for (const [k, v] of Object.entries(raw)) if (v && typeof v === "object") this.rows.set(k, v as AssessRun);
      }
    } catch { /* fresh host, or a file we could not read — the map still works */ }
    // ── Restart reconciliation ─────────────────────────────────────────────
    //
    // A `running` row on disk is, by construction, a lie: the run is a CHILD
    // PROCESS of this daemon and died with the last one. Believing it costs
    // more than a wrong status — `running()` is what refuses a second run for a
    // repo, so one crash mid-assessment would leave that repo unable to start
    // another one, for ever, with no way back from the phone. The intent store
    // says the same sentence about the same row (`intents/watch.ts`'s reconcile); this
    // is the sidecar's half, and it runs before anything can read it.
    let stale = false;
    for (const [id, r] of this.rows) {
      if (r.status !== "running") continue;
      this.rows.set(id, {
        ...r,
        status: "failed",
        finishedAt: Date.now(),
        detail: "the host restarted while this assessment was running — nothing was applied, run it again if you still want it",
      });
      stale = true;
    }
    if (stale) this.persist();
  }

  get(runId: string): AssessRun | undefined { return this.rows.get(runId); }

  /** Every run for one worktree, newest first — what the sheet lists. */
  forRepo(repoDir: string): AssessRun[] {
    return [...this.rows.values()].filter((r) => r.repoDir === repoDir).sort((a, b) => b.startedAt - a.startedAt);
  }

  /** The run a repo's button opens: its newest, whatever state it is in. */
  latestFor(repoDir: string): AssessRun | undefined { return this.forRepo(repoDir)[0]; }

  /** Every worktree this store holds a run for — what a client asking without
   *  naming a repo is answered with, one frame each. */
  repos(): string[] {
    return [...new Set([...this.rows.values()].map((r) => r.repoDir))];
  }

  /** Is a run for this repo still going? One at a time per repo — two
   *  assessments proposing conflicting verdicts on one list is a merge nobody
   *  can do on a phone. */
  running(repoDir: string): AssessRun | undefined {
    return this.forRepo(repoDir).find((r) => r.status === "running");
  }

  set(runId: string, patch: Partial<AssessRun>): AssessRun {
    const next = { ...this.rows.get(runId), ...patch } as AssessRun;
    this.rows.set(runId, next);
    this.evict();
    this.shedInputs();
    this.persist();
    // The repo, not the run: `drop` can leave a DIFFERENT run as this repo's
    // newest, and the snapshot is "what is this repo's latest" either way. One
    // shape for both callers means the broadcast cannot be right for a change
    // and wrong for a discard.
    this.onChange(next.repoDir);
    return next;
  }

  /**
   * A reading that is only true while the run is ALIVE: memory and the socket,
   * never the disk.
   *
   * Progress arrives every second or two for twenty minutes. Through `set()`
   * that is several hundred whole-file rewrites of a store that carries every
   * run's input snapshot — and for nothing, because a `running` row does not
   * survive a restart by design (the constructor fails every one of them, since
   * the run was a child process of the daemon that died). The last reading is
   * persisted by the `set()` that settles the run, where it becomes the record
   * of what the run did.
   *
   * Silently ignores an unknown id: the run is gone, so there is nothing this
   * could be a reading of.
   */
  setLive(runId: string, patch: Partial<AssessRun>): void {
    const cur = this.rows.get(runId);
    if (!cur) return;
    const next = { ...cur, ...patch };
    this.rows.set(runId, next);
    this.onChange(next.repoDir);
  }

  drop(runId: string): void {
    const gone = this.rows.get(runId);
    if (!gone || !this.rows.delete(runId)) return;
    this.persist();
    this.onChange(gone.repoDir);
  }

  /** What applying decided, recorded on the run — so the row answers "have I
   *  dealt with this?" without re-reading the proposal it came from. */
  recordApplied(runId: string, counts: { dismissed: number; ranked: number; posted: number; requeued: number; named: number }, at: number): void {
    if (!this.rows.get(runId)) return;
    this.set(runId, { status: "applied", appliedAt: at, applied: counts });
  }

  /**
   * Drop the assessed SNAPSHOT from runs that no longer need it.
   *
   * A run carries the whole `AssessInput` — every open prompt and pad note for
   * that repo, un-clipped, because the proposal names ids and the sheet has to
   * show the words those ids meant AT THE TIME. That is the right thing to keep
   * while the proposal is still a decision waiting to be made, and dead weight
   * afterwards: forty retained runs over a repo with eighty-odd long prompts is
   * a multi-megabyte file rewritten whole (tmp+rename) three times per run.
   *
   * So the snapshot is kept exactly where it can still be read: the newest run
   * of each repo (what the sheet opens), and any run that has not been settled
   * yet. An `applied` or `discarded` older run keeps its counts, its verdicts
   * and its status — what it decided — and loses only the copy of words that
   * are still in the intent store and on the pad. Nothing here is the last copy
   * of anything.
   */
  private shedInputs(): void {
    const newest = new Set<string>();
    for (const r of this.rows.values()) {
      const cur = this.latestFor(r.repoDir);
      if (cur) newest.add(cur.runId);
    }
    for (const r of this.rows.values()) {
      if (!r.input) continue;
      if (newest.has(r.runId)) continue;
      if (r.status === "running" || r.status === "done") continue;
      delete r.input;
    }
  }

  private evict(): void {
    if (this.rows.size <= ASSESS_MAX_RUNS) return;
    const keepNewestPerRepo = new Set<string>();
    for (const r of this.rows.values()) {
      const cur = this.latestFor(r.repoDir);
      if (cur) keepNewestPerRepo.add(cur.runId);
    }
    const evictable = [...this.rows.values()]
      .filter((r) => r.status !== "running" && !keepNewestPerRepo.has(r.runId))
      .sort((a, b) => a.startedAt - b.startedAt);
    for (const r of evictable) {
      if (this.rows.size <= ASSESS_MAX_RUNS) break;
      this.rows.delete(r.runId);
    }
  }

  private persist(): void {
    try {
      mkdirSync(dirname(this.path), { recursive: true });
      writeJsonAtomic(this.path, Object.fromEntries(this.rows), { space: 2 });
    } catch { /* best-effort — the in-memory map still works for this boot */ }
  }
}