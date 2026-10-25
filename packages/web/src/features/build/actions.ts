/**
 * Every writer of the build feature's stores, and every frame it sends. The
 * wire handlers in `index.ts` and the sheet call these; nothing else writes.
 */
import { buildRunTitle, repoBranchLabel, type ArtifactPolicy, type BuildCandidate, type BuildConfig, type BuildRun, type RepoTarget, type ScheduleEntry } from "@waterplane/shared";
import { buildScheduleEntry, buildScheduleToast, type BuildScheduleCue } from "../../buildSchedule";
import type { SendWhen } from "../../sendIntent";
import { core, mapWith, type CoreApi } from "../../sdk";
import { buildLane, buildQueueTitle, buildQueuedToast, buildRunToast } from "./logic";
import { artifactPolicies, buildCands, buildLocalIds, buildNameOf, buildOpts, buildRepo, buildScheduleEdit, builds, type ParamOptions } from "./store";

export function onBuildLocalIds(repoDir: string, localIds: string[] | undefined): void {
  buildLocalIds.set((prev) => mapWith(prev, repoDir, localIds));
}

export function onArtifactsConfig(repoDir: string, policy: ArtifactPolicy): void {
  artifactPolicies.set((prev) => mapWith(prev, repoDir, policy));
}

export function onBuildOptions(repoDir: string, buildId: string, options: ParamOptions[string]): void {
  buildOpts.set((prev) => mapWith(prev, repoDir, { ...(prev.get(repoDir) ?? {}), [buildId]: options }));
}

export function onBuildCandidates(repoDir: string, list: BuildCandidate[], total: number): void {
  buildCands.set((prev) => mapWith(prev, repoDir, { list, total }));
}

/** `build.run`: the run upserted, and a toast only when it SETTLED. */
export function onBuildRun(run: BuildRun, c: CoreApi): void {
  builds.onRun(run);
  const said = buildRunToast(run);
  if (said) c.say.toast(said);
}

/** Open the build-buttons sheet for a repo and fetch its configs + runs. */
export function openBuildFor(repo: RepoTarget, opts?: { schedule?: ScheduleEntry }): void {
  const c = core();
  buildRepo.set(repo);
  // A build rule's card *edit*: the sheet opens that rule's form once the
  // entry is in the list (`BuildButtonsSheet`).
  buildScheduleEdit.set(opts?.schedule ? { entry: opts.schedule, at: Date.now() } : null);
  c.conn.send({ t: "build.list", repoDir: repo.worktreePath });
  // What becomes of what a build produces is read with the list, not on a
  // second tap: it is one small frame, and the answer has to be on screen
  // before a build is started, not after it has already named its output.
  c.conn.send({ t: "artifacts.get", repoDir: repo.worktreePath });
  c.nav.open("build");
}

/** Re-sync an open build sheet after a reconnect (mobile wake): the host
 *  replays each run's retained tail (full:true) so gap chunks aren't lost. */
export function resyncBuild(): void {
  const r = buildRepo.get();
  // eslint-disable-next-line local/no-silent-send -- welcome-only re-sync: runs from the welcome handler, nobody tapped anything
  if (r) core().conn.send({ t: "build.list", repoDir: r.worktreePath });
}

// Save covers both writing a build command and DELETING one (the sheet saves
// the whole list either way), so a silent failure here reads as "the delete
// didn't take" — and the next open re-asks `build.list` and brings the row
// back, with nothing having said why.
export function saveBuilds(repoDir: string, list: BuildConfig[], local?: string[]): void {
  // `local` rides only when the host said which ids are local; absent, the host keeps ids where they are.
  core().conn.liveSend({ t: "build.save", repoDir, builds: list, ...(local ? { local } : {}) }, "build commands saved",
    "no connection — build commands live on the desktop and can't be edited from here");
}

/**
 * Durable: a build is minutes of CPU and a retry that ran it twice would fight
 * itself over the same output dir. The lane is per repo, so two builds of one
 * repo queue behind each other instead of interleaving.
 */
export function runBuild(repoDir: string, id: string, params?: Record<string, string>): void {
  const c = core();
  // The values are part of what ran, so they are part of what the queue row is
  // CALLED — two rows reading `build “Screenshot”` are two rows nobody can tell
  // apart, and this one may sit in the outbox for an hour before it starts.
  const name = buildRunTitle(buildNameOf(repoDir, id), params);
  const offline = c.queue.queueOp({ t: "build.run", repoDir, buildId: id, params },
    buildLane(repoDir), buildQueueTitle(name), { cwd: repoDir });
  c.say.toast(buildQueuedToast(offline, name));
}

export function cancelBuild(runId: string): void {
  core().conn.liveSend({ t: "build.cancel", runId }, "cancelling the build…",
    "no connection — the build is running on the desktop and can't be stopped from here");
}

/**
 * "Set up" opens a real session and hands it the predefined prompt — the
 * ordinary durable create+prompt path, so a tap on a dead tunnel is kept and
 * opens the session on reconnect. The agent writes .waterplane-shared/builds.json itself;
 * the list refreshes the next time this sheet is opened, since `openBuildFor`
 * re-asks `build.list` every time.
 */
export function setupBuilds(repo: RepoTarget, prompt: string): void {
  const c = core();
  c.nav.close("build");
  c.nav.startSessionWithPrompt(repo.worktreePath, repoBranchLabel(repo), [prompt]);
}

export function savePolicy(repoDir: string, policy: ArtifactPolicy): void {
  artifactPolicies.set((prev) => mapWith(prev, repoDir, policy));
  core().conn.liveSend({ t: "artifacts.save", repoDir, policy }, "saved — it applies to every build in this repo",
    "no connection — what a build does with its output lives on the desktop and was not saved");
}

/**
 * The listing behind a parameterised build's drop-downs. A plain `send`: the
 * ask form IS the receipt — it says "reading the list…" until the frame lands,
 * names the no-connection case itself (`online`) and degrades to a typed field
 * with the reason. There is nothing to queue, since a listing delivered on
 * reconnect answers a form that closed an hour ago.
 */
export function askOptions(repoDir: string, buildId: string, approve?: { paramId: string; cmd: string }): void {
  // The receipt for the tap on "Run this listing": drop that parameter's stored
  // answer (the gate card), so the form's own "reading the list…" shows until
  // the frame lands.
  if (approve) {
    buildOpts.set((prev) => {
      const cur = prev.get(repoDir)?.[buildId];
      if (!cur || !(approve.paramId in cur)) return prev;
      const { [approve.paramId]: _gone, ...rest } = cur;
      return mapWith(prev, repoDir, { ...(prev.get(repoDir) ?? {}), [buildId]: rest });
    });
  }
  // eslint-disable-next-line local/no-silent-send -- the ask form is the receipt: it shows "reading the list…" until the frame lands, says so itself when there is no socket (`online`), and falls back to a typed field naming why. A toast would be a second, worse wording of what the form already says.
  core().conn.send(approve ? { t: "build.options", repoDir, buildId, approve: true, paramId: approve.paramId, cmd: approve.cmd } : { t: "build.options", repoDir, buildId });
}

/**
 * The free half of "set up": the host reads this repo's manifests and answers
 * with the commands the project already describes. A plain `send`, not
 * `liveSend`: the editor IS the receipt — it shows "reading the repo…" until
 * the frame lands, names the no-connection case itself, and degrades to the
 * three fields it always had. A scan delivered on reconnect would answer a
 * form that closed an hour ago, so nothing is queued.
 */
export function scanRepo(repoDir: string): void {
  // eslint-disable-next-line local/no-silent-send -- the editor IS the receipt, and a better one than a toast: it shows "reading the repo…" until the frame lands, names the no-connection case itself (`online`), and degrades to the three fields it always had. There is nothing to queue — a scan delivered on reconnect would answer a form that closed an hour ago.
  core().conn.send({ t: "build.scan", repoDir });
}

/**
 * The schedule-a-build form's Save: `schedule.save` through the durable queue
 * (`queueOp`, an ackId, the rule's own `sched:<id>` lane) — the Send sheet's
 * path for a rule, never a second one. `schedule.save` upserts on the id, so
 * an edit re-saves the same rule and an offline replay cannot add a second.
 */
export function saveBuildSchedule(repoDir: string, build: BuildConfig, editing: ScheduleEntry | null,
  when: Extract<SendWhen, { kind: "at" }>, vals: Record<string, string>, preview: number | null): void {
  const c = core();
  const id = editing?.id ?? `s_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
  const entry = buildScheduleEntry({ id, repoDir, build, vals, when, preview, now: Date.now() });
  const offline = c.queue.queueOp({ t: "schedule.save", entry }, `sched:${entry.id}`, entry.name);
  c.say.toast(buildScheduleToast(offline, !!editing));
}

/** The cue's tap: Automation cut to exactly the rules the cue counted. */
export function openBuildScheduleCut(cue: BuildScheduleCue): void {
  core().nav.openScheduleCut(cue.ids, cue.label);
}
