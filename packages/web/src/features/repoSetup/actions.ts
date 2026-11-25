/**
 * The set-up page's doors and Go. Every writer of `store.ts` is here.
 *
 * **No send path of its own.** A paid row is the seed the Opt-ins card would open the Send sheet on,
 * turned into the same backlog item or `schedule.save` (`sendIntent/sendDurable.ts`) and handed to the
 * one queue under a fresh ackId, once: its outcome is written before anything is awaited, and only a
 * row the desktop REFUSED may be posted again.
 */
import type { ComplianceFixResult, RepoTarget, SetupPlan, SetupRow, SetupRowGroup } from "@waterplane/shared";
import { optInLookPrompt } from "@waterplane/shared";
import { api } from "../../api";
import { isDemo } from "../../demoEntry";
import { cachedPassive } from "../../passiveMode";
import { optInOrigin, optInSeed } from "../../optInSeed";
import { turnDownloadsOn } from "../../optInActs";
import { randId } from "../../randId";
import { DEVICE_TZ, repoItemOpts, scheduleEntryOf } from "../../sendIntent";
import { setSlowJobResult } from "../../slowJobs";
import { core, fireFateNow, pullRules, watchFires } from "../../sdk";
import {
  NO_RUN, afterLeave, fixOutcomes, goSteps, mayOffer, picksWords, settled, skipWords, standing, untickPaid, withPicks, type Outcome, type RepoRun,
} from "./logic";
import { openOn, runs } from "./store";

/** How long Go waits for the desktop to say a repo's download rule (it is asked for as the page opens). */
const RULE_WAIT_MS = 5000;

export function runOf(at: string): RepoRun {
  return runs.get().get(at) ?? NO_RUN;
}

function patch(at: string, fn: (r: RepoRun) => RepoRun): void {
  runs.set((prev) => {
    const cur = prev.get(at) ?? NO_RUN;
    const next = fn(cur);
    return next === cur ? prev : new Map(prev).set(at, next);
  });
}

function note(at: string, outcomes: Record<string, Outcome>): void {
  patch(at, (r) => ({ ...r, outcomes: { ...r.outcomes, ...outcomes } }));
}

/** The repos whose page opened in this page load, by anyone: never again by itself, whether or not the mark landed. */
const opened = new Set<string>();

/** The page offered by itself, over a session a person just started (`core/launch/afterStart.ts`). */
export function offerRepoSetup(worktreePath: string): void {
  if (mayOffer({ demo: isDemo(), passive: cachedPassive(), online: core().conn.status === "open", opened: opened.has(worktreePath) })) openRepoSetup(worktreePath);
}

/** Open the set-up page on one repo, by its worktree path. The repo may be so new that the desktop has
 *  not listed it yet; the sheet waits for it. */
export function openRepoSetup(worktreePath: string): void {
  // Another repo's page on top of this one in the same sheet: the first one is left for good.
  if (core().nav.overlay === "repoSetup" && openOn.get() !== worktreePath) leaveRepoSetup();
  opened.add(worktreePath);
  core().say.track("overlay:repoSetup");
  openOn.set(worktreePath);
  core().nav.open("repoSetup");
}

export function closeRepoSetup(): void {
  core().nav.close("repoSetup");
}

export function skipRepoSetup(repoName: string): void {
  core().say.track("action:repoSetup.skip");
  core().say.toast(skipWords(repoName));
  closeRepoSetup();
}

/** Gone for good (Back, skip, done; never a door opened over it): the desktop stops offering the page.
 *  Best effort: with no link it may be offered once more. */
export function leaveRepoSetup(): void {
  const at = openOn.get();
  if (!at) return;
  patch(at, afterLeave);
  openOn.set(null);
  const c = core();
  const repo = c.world.repos.find((r) => r.worktreePath === at);
  if (repo) void api.optInSeen(repo.id).then(() => core().world.refreshRepos(), () => undefined);
}

export function setTick(at: string, key: string, on: boolean): void {
  patch(at, (r) => ({ ...r, ticks: { ...r.ticks, [key]: on } }));
}

/** `use these suggestions`: ticks, and nothing else. */
export function takePicks(at: string, rows: readonly SetupRow[]): void {
  core().say.track("action:repoSetup.picks");
  patch(at, (r) => ({ ...r, ticks: withPicks(r.ticks, rows) }));
  core().say.toast(picksWords(rows));
}

/** *Let an agent look first*: the Send sheet on words that only read and suggest. Nothing is sent here. */
export function seedLook(repo: RepoTarget, ids: readonly { id: string }[]): void {
  const prompt = optInLookPrompt(ids.map(({ id }) => ({ id, relevant: true, state: "off", detail: "" })), repo.repoName);
  if (!prompt) return;
  const c = core();
  c.say.track("action:repoSetup.look");
  c.nav.openSend({
    prompts: [prompt], target: { kind: "repo", cwd: repo.worktreePath }, cwdHint: repo.worktreePath, repoId: repo.id,
    origin: optInOrigin(repo.repoName, "let an agent look first"),
  });
}

/** Run the plan, once. A row with a standing outcome is left out whatever the caller believed. */
export function go(repo: RepoTarget, groups: readonly SetupRowGroup[], plan: SetupPlan): void {
  const left = (rows: SetupRow[]) => rows.filter((r) => !standing(r, runOf(repo.worktreePath).outcomes));
  core().say.track("action:repoSetup.go");
  start(repo, groups, { free: left(plan.free), paid: left(plan.paid) });
}

/** One failed row again: only an outcome that says it may (`retry`). */
export function retry(repo: RepoTarget, groups: readonly SetupRowGroup[], row: SetupRow): void {
  const o = runOf(repo.worktreePath).outcomes[row.key];
  if (o?.s !== "failed" || !o.retry) return;
  core().say.track("action:repoSetup.retry");
  start(repo, groups, { free: row.kind === "free" ? [row] : [], paid: row.kind === "paid" ? [row] : [] });
}

function start(repo: RepoTarget, groups: readonly SetupRowGroup[], plan: { free: SetupRow[]; paid: SetupRow[] }): void {
  const at = repo.worktreePath;
  const rows = [...plan.free, ...plan.paid];
  const before = runOf(at);
  if (before.busy || !rows.length) return;
  // Written before the first await: a second tap, a re-render or a reopened sheet finds every row taken.
  // Nothing paid stays ticked: if its outcome is reset later (its item was cancelled or ended) the row
  // comes back unticked, and only a fresh tap (or *use these suggestions*) can tick it again.
  patch(at, (r) => ({
    ...r, busy: true, kept: groups, said: [], ticks: untickPaid(r.ticks, rows),
    outcomes: { ...r.outcomes, ...Object.fromEntries(rows.map((x) => [x.key, { s: "waiting" } as Outcome])) },
  }));
  void work(repo, plan, before).finally(() => patch(at, (r) => ({ ...r, busy: false })));
}

async function work(repo: RepoTarget, plan: { free: SetupRow[]; paid: SetupRow[] }, before: RepoRun): Promise<void> {
  const at = repo.worktreePath;
  for (const step of goSteps(plan)) {
    if (step.kind === "fix") {
      note(at, Object.fromEntries(step.rows.map((r) => [r.key, { s: "running" } as Outcome])));
      let lost = false;
      const res: ComplianceFixResult = await api.complianceFix(repo.id, step.fixes)
        .catch((e) => { lost = true; return { ok: false, applied: [], notes: [], error: String((e as Error)?.message || e) }; });
      const { outcomes, said } = fixOutcomes(step.rows, res, lost);
      patch(at, (r) => ({ ...r, said, outcomes: { ...r.outcomes, ...outcomes } }));
      if (res.report) setSlowJobResult("setup.check", repo.id, res.report);
    } else if (step.kind === "download") {
      note(at, { [step.row.key]: { s: "running" } });
      note(at, { [step.row.key]: await download(repo) });
    } else {
      const old = before.outcomes[step.row.key];
      const o = post(repo, step.row);
      note(at, { [step.row.key]: o });
      // The refused row is replaced, so nothing can send it as well.
      if (o.s === "queued" && old?.s === "failed" && old.ackId) core().queue.drop(old.ackId);
    }
  }
}

async function download(repo: RepoTarget): Promise<Outcome> {
  const at = repo.worktreePath;
  if (!pullRules.known(at)) pullRules.ask(at);
  for (let t = 0; t < RULE_WAIT_MS && !pullRules.known(at); t += 200) await new Promise((r) => setTimeout(r, 200));
  if (!pullRules.known(at)) return { s: "failed", text: "the desktop did not say what this repo's download rule is", retry: true };
  return turnDownloadsOn(repo) === "saved"
    ? { s: "done", text: "new builds now come to this phone" }
    : { s: "failed", text: "no connection, so the rule was not saved", retry: true };
}

/** One paid row as its own work item. Queued is all it can say: the receipt says the rest (`settleFates`). */
function post(repo: RepoTarget, row: SetupRow): Outcome {
  const c = core();
  const seed = optInSeed(row.key, repo, DEVICE_TZ);
  const target = seed?.target;
  if (!seed?.prompts || target?.kind !== "repo") return { s: "failed", text: "this app version has no words for it", retry: false };
  const ackId = c.queue.mintAckId();
  const after = row.sent?.at ?? 0;
  if (seed.when?.kind === "at") {
    const entry = scheduleEntryOf(target, seed.when, seed.prompts, {
      id: `s_${Date.now().toString(36)}_${randId(4)}`, now: Date.now(), wire: c.launch.wire, usage: c.world.usage ?? undefined,
    });
    c.queue.queueOp({ t: "schedule.save", entry }, `sched:${entry.id}`, entry.name, { ackId, track: true });
    return { s: "queued", ackId, after, rule: true };
  }
  // No `autoFire`: an ordinary row, which the person's own auto switch starts or holds.
  const q = c.queue.queueBacklog({ ...repoItemOpts(target, { kind: "idle" }, seed.prompts, c.launch.wire), ackId, track: true });
  return q === null ? { s: "failed", text: "it could not be queued", retry: true } : { s: "queued", ackId, after };
}

/** Every queued row in every repo, against what the queue says became of it. */
function settleFates(): void {
  for (const [at, run] of runs.get()) {
    const next: Record<string, Outcome> = {};
    for (const [key, o] of Object.entries(run.outcomes)) {
      const s = o.s === "queued" ? settled(o, fireFateNow(o.ackId)) : null;
      if (s) next[key] = s;
    }
    if (Object.keys(next).length) note(at, next);
  }
}

/** Follows the posts for as long as the app runs, sheet or no sheet. */
export function bootRepoSetup(): () => void {
  return watchFires(settleFates);
}
