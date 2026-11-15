/**
 * The lookup probe runner (R-metrics-071): asks this desktop's setup a seeded draw of the repo's
 * committed lookup questions, in a detached scratch worktree at a pinned commit, through the
 * sidecar seam (`sidecar/sidecarprobe.ts` — this file names no `claude` flag), and stores each
 * result per repo with the setup it was measured under. The analysis is shared's (`probe/`).
 *
 * A SPENDER (host-spenders): tap-started only, never scheduled, never fired by a marker. The start
 * is refused unless the estimate the person accepted still covers the estimate now; the halt gate
 * is asked before every question (and the seam's `trackRun` kills one mid-flight); a question past
 * its token cap has its process group killed; the run stops at `PROBE_BUDGET_FACTOR` × the estimate.
 *
 * ── The scratch worktree ─────────────────────────────────────────────────
 * Under the OS tmpdir with our own prefix, made with `git worktree add --detach` at the commit,
 * the pool file deleted from it (the session must not read the answers), removed afterwards — ours
 * only, never a repo-wide `git worktree prune` (a killed daemon's leftovers are swept by prefix).
 * The CLI keys transcripts by cwd, so a probe's logs land in a project folder named after the
 * scratch path, never under the repo's: the agent readings, which take the repo's slug and its
 * `<slug>-…` worktrees, never see them. `scratchStaysOut` asserts that before any money is spent.
 * The CLI maps a worktree to its repo's memory (pilot, 2026-11-14), so memory is part of the setup.
 */
import { execFile } from "node:child_process";
import { createHash, randomInt, randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, join, sep } from "node:path";
import {
  BRAND, HALT_REFUSAL, PROBE_BUDGET_FACTOR, PROBE_DRAW, PROBE_MAX_REPEATS, PROBE_MAX_TURNS, PROBE_POOL_PATH,
  PROBE_REPEATS, PROBE_RUN_TOKEN_CAP, PROBE_SCHEMA, analyzeProbe, drawProbeQuestions, parseProbePool,
  probeAcceptedCovers, probeCorrect, probeEstimate, probeFinalAnswer, probeLeakOf, probeNoPoolText, probeSchedule,
  probeSourceText, transcriptDirName,
  type ProbeArm, type ProbeFingerprint, type ProbeKind, type ProbePool, type ProbeResult, type ProbeResultsView,
  type ProbeRunRecord, type ProbeStartAnswer, type ProbeStartBody, type ProbeStatus, type ProbeView,
} from "@waterplane/shared";
import { repoSpellings, slugBelongs } from "./agentreadings.js";
import { repoOfWorktree } from "./costwindow.js";
import { isHalted } from "./halt.js";
import { readJsonGuarded, writeJsonAtomic } from "./jsonstore.js";
import { hostName } from "./net.js";
import { runProbeAsk, type ProbeAsk, type ProbeAskRequest } from "./sidecar.js";

/** Every probe scratch worktree's folder name starts with this; the sweep removes only these. */
export const PROBE_SCRATCH_PREFIX = `${BRAND.slug}-probe-`;
/** Results kept per repo. */
const KEEP = 30;
const STORE_V = 1;

const gitEnv = (): NodeJS.ProcessEnv => {
  const e: NodeJS.ProcessEnv = { ...process.env };
  for (const k of Object.keys(e)) if (k.startsWith("GIT_")) delete e[k];
  return e;
};
const git = (cwd: string, args: string[]): Promise<string> =>
  new Promise((res, rej) => {
    execFile("git", args, { cwd, env: gitEnv(), timeout: 60_000, maxBuffer: 8 * 1024 * 1024 }, (err, out) => (err ? rej(err) : res(String(out))));
  });

const realTmp = (): string => { try { return realpathSync(tmpdir()); } catch { return tmpdir(); } };
const realOr = (p: string): string => { try { return realpathSync(p); } catch { return p; } };

/**
 * Whether a scratch path's transcripts stay out of the repo's agent readings: its project-folder
 * slug (as given and realpath) is neither the repo's nor one of the repo's `<slug>-…` worktrees'.
 */
export function scratchStaysOut(scratch: string, repo: string): boolean {
  const repoSlugs = repoSpellings(repo).map(transcriptDirName);
  const mine = [scratch, realOr(scratch)].map(transcriptDirName);
  return !mine.some((s) => repoSlugs.some((r) => slugBelongs(s, r)));
}

/** Remove the probe scratch worktrees a killed run left for this repo: our prefix, under the tmpdir, listed by git. */
/** Scratch checkouts a run of this process is using now: another run's sweep must leave them. */
const liveScratch = new Set<string>();

export async function sweepProbeScratch(repo: string): Promise<number> {
  let listed = "";
  try { listed = await git(repo, ["worktree", "list", "--porcelain"]); } catch { return 0; }
  const bases = new Set([tmpdir(), realTmp()]);
  let n = 0;
  for (const line of listed.split("\n")) {
    if (!line.startsWith("worktree ")) continue;
    const p = line.slice("worktree ".length).trim();
    if (!basename(p).startsWith(PROBE_SCRATCH_PREFIX)) continue;
    if (![...bases].some((b) => p.startsWith(b + sep))) continue;
    if (liveScratch.has(p)) continue;
    try { await git(repo, ["worktree", "remove", "-f", "-f", p]); n++; } catch { /* the rm below */ }
    try { rmSync(p, { recursive: true, force: true }); } catch { /* gone */ }
  }
  return n;
}

async function makeScratch(repo: string, commit: string): Promise<string> {
  const dir = mkdtempSync(join(realTmp(), PROBE_SCRATCH_PREFIX));
  liveScratch.add(dir);
  try {
    await git(repo, ["worktree", "add", "--detach", "--force", dir, commit]);
    // The answers are in the pool: the session must not be able to read them.
    rmSync(join(dir, PROBE_POOL_PATH), { force: true });
    return dir;
  } catch (e) {
    await removeScratch(repo, dir);
    throw e;
  }
}

async function removeScratch(repo: string, dir: string): Promise<void> {
  liveScratch.delete(dir);
  try { await git(repo, ["worktree", "remove", "-f", "-f", dir]); } catch { /* the rm below */ }
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* gone */ }
}

const MODEL_RE = /^[A-Za-z0-9][A-Za-z0-9._:[\]-]{0,80}$/;
const median = (xs: number[]): number | undefined => {
  if (!xs.length) return undefined;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m]! : Math.round((s[m - 1]! + s[m]!) / 2);
};

export interface ProbeDeps {
  readonly stateDir: string;
  readonly ask?: (req: ProbeAskRequest) => Promise<ProbeAsk>;
  readonly halted?: () => boolean;
  readonly now?: () => number;
  readonly desktop?: () => string;
  /** For tests: skip the real worktree (the ask is fake too). */
  readonly scratch?: { make(repo: string, commit: string): Promise<string>; remove(repo: string, dir: string): Promise<void> };
}

interface Store { v: number; results: ProbeResult[] }

export class ProbeRunner {
  private running = new Map<string, ProbeStatus & { promise: Promise<void> }>();
  constructor(private deps: ProbeDeps) {}

  private storePath(repo: string): string {
    return join(this.deps.stateDir, "probes", `${createHash("sha1").update(repo).digest("hex").slice(0, 16)}.json`);
  }
  results(repo: string): ProbeResult[] {
    const s = readJsonGuarded<Store | null>(this.storePath(repo), null);
    if (!s || s.v !== STORE_V || !Array.isArray(s.results)) return [];
    return s.results.filter((r) => r && r.schema === PROBE_SCHEMA);
  }
  private save(repo: string, r: ProbeResult): void {
    const next = [...this.results(repo).filter((x) => x.id !== r.id), r].slice(-KEEP);
    mkdirSync(join(this.deps.stateDir, "probes"), { recursive: true });
    writeJsonAtomic(this.storePath(repo), { v: STORE_V, results: next });
  }

  status(repo: string): ProbeStatus {
    const r = this.running.get(repo);
    if (!r) return { state: "idle" };
    const { promise: _p, ...s } = r;
    return s;
  }

  /** The pool at a commit of the repo, or the sentence why none. */
  async pool(repo: string, commit: string): Promise<{ pool: ProbePool } | { refused: string }> {
    let text: string;
    try { text = await git(repo, ["show", `${commit}:${PROBE_POOL_PATH}`]); } catch { return { refused: probeNoPoolText() }; }
    let raw: unknown;
    try { raw = JSON.parse(text); } catch { return { refused: `${PROBE_POOL_PATH} is not valid JSON.` }; }
    return parseProbePool(raw);
  }

  async view(wt: string): Promise<ProbeView> {
    const repo = repoOfWorktree(wt);
    let pool: ProbeView["pool"];
    try {
      const head = (await git(wt, ["rev-parse", "HEAD"])).trim();
      const p = await this.pool(repo, head);
      pool = "pool" in p ? { count: p.pool.questions.length, owner: p.pool.owner } : { absent: p.refused };
    } catch { pool = { absent: probeNoPoolText() }; }
    return { ok: true, status: this.status(repo), pool, defaults: { draw: PROBE_DRAW, repeats: PROBE_REPEATS, maxTurns: PROBE_MAX_TURNS }, source: probeSourceText() };
  }

  resultsView(wt: string): ProbeResultsView {
    const all = this.results(repoOfWorktree(wt));
    const byId = new Map(all.map((r) => [r.id, r]));
    return {
      ok: true,
      results: [...all].reverse().map((result) => ({ result, analysis: analyzeProbe(result, result.against ? byId.get(result.against) ?? null : null) })),
      source: probeSourceText(),
    };
  }

  /** Start a run. Refusals are sentences; the run itself is detached and read back through `status`. */
  async start(wt: string, body: ProbeStartBody | null): Promise<ProbeStartAnswer> {
    const halted = this.deps.halted ?? isHalted;
    if (halted()) return { ok: false, refused: HALT_REFUSAL };
    const repo = repoOfWorktree(wt);
    if (this.running.has(repo)) return { ok: false, refused: "A probe is already running for this repo on this desktop — wait for it to finish." };
    // Claim the slot before the first await: two starts arriving together must not both pass the check.
    const claim: ProbeStatus & { promise: Promise<void> } = { state: "running", id: "", done: 0, of: 0, note: "checking the request", promise: Promise.resolve() };
    this.running.set(repo, claim);
    try {
      const ans = await this.begin(wt, repo, body);
      if (!ans.ok && this.running.get(repo) === claim) this.running.delete(repo);
      return ans;
    } catch (e) {
      if (this.running.get(repo) === claim) this.running.delete(repo);
      throw e;
    }
  }

  private async begin(wt: string, repo: string, body: ProbeStartBody | null): Promise<ProbeStartAnswer> {
    if (!body || typeof body !== "object") return { ok: false, refused: "No probe was described." };
    const kind = body.kind as ProbeKind;
    if (kind !== "models" && kind !== "baseline" && kind !== "against") return { ok: false, refused: `Unknown probe kind ${JSON.stringify(body.kind)}.` };

    let commit: string;
    try { commit = (await git(wt, ["rev-parse", "HEAD"])).trim(); } catch { return { ok: false, refused: "This worktree has no commit to probe." }; }
    const pooled = await this.pool(repo, commit);
    if ("refused" in pooled) return { ok: false, refused: pooled.refused };
    const pool = pooled.pool;

    let arms: ProbeArm[];
    let seed = Number.isInteger(body.seed) && body.seed! >= 0 ? body.seed! : randomInt(0, 2 ** 31);
    let repeats = Number.isInteger(body.repeats) ? Math.min(PROBE_MAX_REPEATS, Math.max(1, body.repeats!)) : PROBE_REPEATS;
    let questions: string[];
    let against: string | undefined;
    const models = Array.isArray(body.models) ? body.models.filter((m): m is string => typeof m === "string") : [];
    if (models.some((m) => !MODEL_RE.test(m))) return { ok: false, refused: "A model name has characters a model id never has." };
    if (kind === "models") {
      if (models.length !== 2 || models[0] === models[1]) return { ok: false, refused: "A model comparison needs two different models." };
      arms = [{ arm: "A", model: models[0]! }, { arm: "B", model: models[1]! }];
      questions = drawProbeQuestions(pool, seed);
    } else if (kind === "baseline") {
      if (models.length !== 1) return { ok: false, refused: "A baseline runs one model." };
      arms = [{ arm: "A", model: models[0]! }];
      questions = drawProbeQuestions(pool, seed);
    } else {
      const base = this.results(repo).find((r) => r.id === body.baselineId);
      if (!base || base.arms.length !== 1) return { ok: false, refused: "That baseline is not stored on this desktop." };
      if (base.void) return { ok: false, refused: `That baseline is void (${base.void}); run a new one.` };
      arms = [{ arm: "B", model: base.arms[0]!.model }];
      seed = base.seed; repeats = base.repeats; against = base.id;
      const have = new Set(pool.questions.map((q) => q.id));
      questions = base.questions.filter((id) => have.has(id));
      if (questions.length === 0) return { ok: false, refused: "None of the baseline's questions is in the pool at this commit." };
    }

    const estimate = probeEstimate(arms.map((a) => a.model), questions.length, repeats);
    const accepted = body.accepted && typeof body.accepted === "object" ? body.accepted : { tokens: NaN };
    if (!probeAcceptedCovers(accepted, estimate)) {
      return { ok: false, refused: `The estimate is now: ${estimate.text} That is more than was accepted, so nothing ran — look at it and tap again.` };
    }

    const now = this.deps.now ?? Date.now;
    const result: ProbeResult = {
      schema: PROBE_SCHEMA, id: randomUUID(), kind, backend: "claude", desktop: (this.deps.desktop ?? hostName)(),
      startedAt: now(), commit, seed, repeats, maxTurns: PROBE_MAX_TURNS, questions, arms, fingerprints: {}, runs: [],
      ...(against ? { against } : {}), estimate: { tokens: estimate.tokens, usd: estimate.usd },
    };
    const steps = probeSchedule(questions, arms, repeats);
    const status: ProbeStatus & { promise: Promise<void> } = { state: "running", id: result.id, done: 0, of: steps.length, note: "making the scratch checkout", promise: Promise.resolve() };
    this.running.set(repo, status);
    status.promise = this.run(repo, pool, result, steps, estimate.tokens * PROBE_BUDGET_FACTOR, status)
      .catch((e) => { console.error(`[probe] ${repo}: ${e instanceof Error ? e.message : String(e)}`); })
      .finally(() => { if (this.running.get(repo) === status) this.running.delete(repo); });
    return { ok: true, id: result.id };
  }

  /** For tests: the running run's promise. */
  settled(repo: string): Promise<void> { return this.running.get(repo)?.promise ?? Promise.resolve(); }

  private async run(repo: string, pool: ProbePool, base: ProbeResult, steps: ReturnType<typeof probeSchedule>, budget: number, status: ProbeStatus & { done?: number; note?: string }): Promise<void> {
    const halted = this.deps.halted ?? isHalted;
    const ask = this.deps.ask ?? runProbeAsk;
    const scratch = this.deps.scratch ?? { make: makeScratch, remove: removeScratch };
    const now = this.deps.now ?? Date.now;
    const qById = new Map(pool.questions.map((q) => [q.id, q]));
    const runs: ProbeRunRecord[] = [];
    let stopped: string | undefined;
    let voidWhy: string | undefined;
    let used = 0;
    let reported = 0;
    const st = status as { done: number; note: string };
    if (!this.deps.scratch) await sweepProbeScratch(repo);
    let dir: string | null = null;
    try {
      dir = await scratch.make(repo, base.commit);
      if (!scratchStaysOut(dir, repo)) {
        stopped = "the scratch checkout's transcripts would land among the repo's own agent readings, so nothing was asked";
      }
      const scope = { worktrees: [dir, realOr(dir)], home: homedir() };
      for (const step of stopped ? [] : steps) {
        if (halted()) { stopped = "halted on this desktop"; break; }
        if (used >= budget) { stopped = `the token budget (${PROBE_BUDGET_FACTOR}× the estimate) was used`; break; }
        const q = qById.get(step.id)!;
        st.note = `${step.id}, ${step.arm} (${step.model}), repeat ${step.rep}`;
        // A question never runs past what is left of the budget: a small run would otherwise overshoot 2× by up to a full cap.
        const cap = Math.min(PROBE_RUN_TOKEN_CAP, Math.max(1, Math.floor(budget - used)));
        const a = await ask({ cwd: dir, repo, model: step.model, question: q.q, maxTurns: base.maxTurns, tokenCap: cap });
        if (a.refused) { stopped = a.halted ? "halted on this desktop" : a.refused; break; }
        // No envelope (cap kill, timeout, crash): the stream's own per-request sum still counts toward the budget.
        const tok = a.usage ? a.usage.in + a.usage.cw + a.usage.cr + a.usage.out : (a.spent ?? 0);
        used += tok;
        reported += a.usd ?? 0;
        // Cut by the budget's remainder, not by the question: not a wrong answer, so not recorded as one.
        if (a.capHit && cap < PROBE_RUN_TOKEN_CAP && used >= budget) { stopped = `the token budget (${PROBE_BUDGET_FACTOR}× the estimate) was used mid-question, so ${step.id} (${step.arm}, repeat ${step.rep}) is left out`; break; }
        let leak: string | undefined;
        for (const t of a.tools) {
          const l = probeLeakOf(t, { ...scope, allowed: a.memoryDirs });
          if (l) { leak = l; break; }
        }
        const final = probeFinalAnswer(a.text);
        runs.push({
          arm: step.arm, rep: step.rep, id: step.id,
          correct: !a.error && probeCorrect(final, q.all, a.capHit), capHit: a.capHit,
          final: final.slice(0, 300), toolCalls: a.tools.length, requests: a.requests,
          ...(a.usage ? { tokens: a.usage } : {}), ...(a.startTok != null ? { startTok: a.startTok } : {}),
          ...(a.turns != null ? { turns: a.turns } : {}), ms: a.ms,
          ...(a.model ? { model: a.model } : {}), ...(a.cli ? { cli: a.cli } : {}),
          ...(leak ? { leak } : {}), ...(a.error ? { error: a.error } : {}),
        });
        st.done += 1;
        if (leak) { voidWhy = `${step.id}: ${leak}`; stopped = "a tool reached outside the scratch checkout, so the run is void"; break; }
        if (a.limited) { stopped = "the account hit a usage limit"; break; }
      }
    } catch (e) {
      stopped = `the scratch checkout could not be made: ${e instanceof Error ? e.message : String(e)}`;
    } finally {
      st.note = "removing the scratch checkout";
      if (dir) await scratch.remove(repo, dir);
    }
    const fingerprints: Record<string, ProbeFingerprint> = {};
    for (const arm of base.arms) {
      const rs = runs.filter((r) => r.arm === arm.arm && !r.error);
      const startTok = median(rs.map((r) => r.startTok).filter((x): x is number => x != null));
      fingerprints[arm.arm] = {
        backend: base.backend, commit: base.commit,
        ...(rs.find((r) => r.model)?.model ? { model: rs.find((r) => r.model)!.model } : {}),
        ...(rs.find((r) => r.cli)?.cli ? { cli: rs.find((r) => r.cli)!.cli } : {}),
        ...(startTok != null ? { startTok } : {}),
      };
    }
    this.save(repo, {
      ...base, finishedAt: now(), runs, fingerprints,
      ...(stopped ? { stopped } : {}), ...(voidWhy ? { void: voidWhy } : {}),
      ...(reported > 0 ? { reportedUsd: Math.round(reported * 100) / 100 } : {}),
    });
  }
}

let shared: ProbeRunner | null = null;
/** The one runner for this host. */
export function probeRunner(stateDir: string): ProbeRunner {
  return (shared ??= new ProbeRunner({ stateDir }));
}
