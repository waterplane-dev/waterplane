/**
 * Slow jobs over HTTP (`slowjobs.ts`; `shared/wire/slowjob.ts`; design
 * `.claude/outbox/slow-jobs-host.md`). A screen STARTS a job (or joins the running one) and
 * may leave; the host keeps the answer for a while and says so on the one socket
 * (`slowjob.state`). NOT in `passive.ts`'s allowlist — neither are the routes these wrap.
 *
 * - `POST /api/repos/:id/jobs/:kind` — start or join; answers `{ job, joined }`, the job
 *   carrying `result` only when it settled before the answer was written (it never waits).
 * - `GET  /api/repos/:id/jobs/:kind` — the running or kept run, with its result; `{ job: null }`
 *   when there is none (start one).
 * - `GET  /api/jobs` — every running and kept run, without results (a reconnecting phone).
 * - `GET  /api/jobs/:id` — one run by id, with its result; 404 once replaced or expired.
 *
 * The old routes (`GET …/skills`, `POST …/skills/recommend`, `GET …/compliance`) are thin
 * wrappers that join the same job and wait for it, so a phone on the old routes and one on
 * these never run the work twice.
 */
import type { ComplianceReport, SkillInventoryDoc, SlowJob, SlowJobKind } from "@waterplane/shared";
import { isSlowJobKind } from "@waterplane/shared";
import { checkRepoCompliance, inspectRepoAsync } from "../compliance.js";
import { withFixConfirms } from "../confirmgate.js";
import { recommendSkills } from "../skills/skillrecommend.js";
import { SlowJobs, type SlowJobReport, type SlowJobSpec } from "../slowjobs.js";
import { repoDoc } from "../skills/skillrepodoc.js";
import { json } from "./apiio.js";
import { route, type ApiCtx, type ApiEntry, type RepoReq } from "./apitable.js";

/** How often the use-count job re-reads the scan it is waiting on. */
const USES_POLL_MS = 1_000;
/** The recommend call has its own 60 s bound (`SKILLS_TIMEOUT_MS`); this is the job's outer one. */
const RECOMMEND_TIMEOUT_MS = 5 * 60_000;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** True while either count (this repo, all repos) is still reading logs. */
export function usesSettled(doc: Pick<SkillInventoryDoc, "usage">): boolean {
  const u = doc.usage;
  const all = u.allRepos;
  return u.state !== "counting" && !u.refreshing && (!all || (all.state !== "counting" && !all.refreshing));
}

/** The two scans' progress summed; absent while neither has said how big it is. */
export function usesProgress(doc: Pick<SkillInventoryDoc, "usage">): { done: number; total: number } | null {
  let done = 0, total = 0;
  for (const r of [doc.usage, doc.usage.allRepos]) {
    if (r && r.state === "counting" && typeof r.total === "number" && typeof r.done === "number") { done += r.done; total += r.total; }
  }
  return total > 0 ? { done, total } : null;
}

/** Only the target travels into a run — never the request or response it was started from. */
type JobTarget = Pick<RepoReq, "wt" | "target">;
type Runner = (r: JobTarget, ctx: ApiCtx, report: SlowJobReport) => Promise<unknown>;

/** What each kind runs. Reads and suggestions only — nothing here writes a setting. */
const RUNNERS: Record<SlowJobKind, Runner & { timeoutMs?: number }> = {
  "skills.inventory": async ({ wt, target }, ctx) => (await repoDoc(ctx.root, wt, target.id)).doc,
  // Waits for both use counts to finish (the screen polled every 3 s before) and answers the doc with them.
  "skills.uses": async ({ wt, target }, ctx, report) => {
    for (;;) {
      const { doc } = await repoDoc(ctx.root, wt, target.id);
      if (usesSettled(doc)) return doc;
      const p = usesProgress(doc);
      if (p) report(p.done, p.total);
      await sleep(USES_POLL_MS);
    }
  },
  // The one spender here (host-spenders: one tapped call, halt-gated inside). Joining is what keeps
  // a second tab or a retried tap from buying a second call. The answer is a list a person ticks.
  "skills.recommend": Object.assign(async ({ wt, target }: JobTarget, ctx: ApiCtx) => {
    const { doc, files } = await repoDoc(ctx.root, wt, target.id);
    return recommendSkills(wt, doc, files);
  }, { timeoutMs: RECOMMEND_TIMEOUT_MS }),
  // The setup checklist, its walks off the event loop; recorded into the sweep's store like the GET.
  "setup.check": async ({ target }, ctx) => {
    const report = checkRepoCompliance(target, await inspectRepoAsync(target.worktreePath));
    ctx.setup.record(target.worktreePath, report.checks, target.repoName);
    return report;
  },
};

/** The registry the routes use: the host's (`ctx.slowJobs`), else one per process (tests, tools). */
let fallback: SlowJobs | null = null;
export const jobsOf = (ctx: Pick<ApiCtx, "slowJobs">): SlowJobs => ctx.slowJobs ?? (fallback ??= new SlowJobs());

/**
 * A skills write changed what the inventory and its use counts read: drop their kept runs (this
 * repo's, or every repo's with no id). The model's suggestion list stays — it is a paid answer a
 * person is still ticking from, and nothing applies itself.
 */
export function forgetSkillJobs(jobs: SlowJobs, repoId?: string): void {
  jobs.forget("skills.inventory", repoId);
  jobs.forget("skills.uses", repoId);
}

/**
 * A setup write (a fix, an ignore, an accept, a triage, new limits) answered with the re-run report:
 * it feeds the sweep's store like the read does, and the kept `setup.check` run — the PRE-write
 * report — is dropped, so no later read serves it over the newer state.
 */
export function recordSetupWrite(ctx: ApiCtx, target: RepoReq["target"], report: ComplianceReport | undefined): void {
  if (report) ctx.setup.record(target.worktreePath, report.checks, target.repoName);
  jobsOf(ctx).forget("setup.check", target.id);
}

/** Start or join `kind` for this repo. */
export function startJob(r: JobTarget, ctx: ApiCtx, kind: SlowJobKind, quiet = false) {
  const runner = RUNNERS[kind];
  const t: JobTarget = { wt: r.wt, target: r.target };
  const spec: SlowJobSpec<unknown> = {
    kind, repoId: r.target.id, run: (report) => runner(t, ctx, report),
    meta: { worktree: r.target.worktreePath }, quiet,
    ...(runner.timeoutMs ? { timeoutMs: runner.timeoutMs } : {}),
  };
  return jobsOf(ctx).start(spec);
}

/** A job as an HTTP answer: a setup report gets its confirm tokens minted HERE, per read. */
export function presentJob(job: SlowJob | null, worktree: string | null): SlowJob | null {
  if (!job || job.state !== "done" || job.kind !== "setup.check" || !worktree || !job.result) return job;
  return { ...job, result: withFixConfirms(worktree, job.result as ComplianceReport) };
}

/** The old routes: join the job and answer its result as before (a throw is the same 500 as before). */
export async function joinAndWait<R>(r: JobTarget, ctx: ApiCtx, kind: SlowJobKind): Promise<R> {
  return (await startJob(r, ctx, kind, true).promise) as R;
}

export const JOBS_HOST_ROUTES: readonly ApiEntry[] = [
  route("GET", "/api/jobs", ({ res }, ctx) => {
    json(res, { jobs: jobsOf(ctx).list() });
    return true;
  }),
  route("GET", "/api/jobs/:id", ({ res, params }, ctx) => {
    const jobs = jobsOf(ctx);
    const id = decodeURIComponent(params.id ?? "");
    const job = jobs.getById(id);
    if (!job) return json(res, { error: "No such job: it finished over half an hour ago, or the host restarted since." }, 404), true;
    json(res, { job: presentJob(job, jobs.metaOf(id)?.worktree ?? null) });
    return true;
  }),
];

const kindOr400 = (raw: string | undefined, res: RepoReq["res"]): SlowJobKind | null => {
  const k = decodeURIComponent(raw ?? "");
  if (isSlowJobKind(k)) return k;
  json(res, { error: `Unknown job kind "${k.slice(0, 40)}".` }, 400);
  return null;
};

export const JOBS_REPO_ROUTES: readonly ApiEntry<RepoReq>[] = [
  route<RepoReq>("POST", "jobs/:kind", (r, ctx) => {
    const kind = kindOr400(r.params.kind, r.res);
    if (!kind) return true;
    const { job, joined } = startJob(r, ctx, kind);
    json(r.res, { job: presentJob(jobsOf(ctx).getById(job.id) ?? job, r.wt), joined });
    return true;
  }),
  route<RepoReq>("GET", "jobs/:kind", (r, ctx) => {
    const kind = kindOr400(r.params.kind, r.res);
    if (!kind) return true;
    json(r.res, { job: presentJob(jobsOf(ctx).get(kind, r.target.id), r.wt) });
    return true;
  }),
];
