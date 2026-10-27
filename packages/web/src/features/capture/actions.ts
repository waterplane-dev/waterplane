/**
 * Every writer of the capture feature's stores, and every frame it sends. The
 * wire handlers in `index.ts` and the sheet call these; nothing else writes.
 */
import type { CaptureBackendInfo, CaptureRun, CaptureTarget, RepoTarget } from "@waterplane/shared";
import { core, mapWith, type CoreApi } from "../../sdk";
import { captureLane, captureNameIn, captureSetupPrompt, captureQueueTitle, captureQueuedToast, captureRunToast } from "./logic";
import { captureBackends, captureRepo, captures } from "./store";

/** `capture.list`: the targets and runs, and what this desktop can drive. */
export function onCaptureList(repoDir: string, targets: CaptureTarget[], runs: CaptureRun[], backends: CaptureBackendInfo[]): void {
  captures.onList(repoDir, targets, runs);
  captureBackends.set((prev) => mapWith(prev, repoDir, backends));
}

/** `capture.run`: the run upserted, and the host's verdict said as a toast. */
export function onCaptureRun(run: CaptureRun, c: CoreApi): void {
  captures.onRun(run);
  const said = captureRunToast(run);
  if (said) c.say.toast(said);
}

/** Open the capture sheet for one repo. `openBuildFor`'s shape: the list is
 *  re-asked on every open, so a target the desktop's agent wrote into
 *  `.waterplane/capture.json` since the last visit is there without a refresh. */
export function openCaptureFor(repo: RepoTarget): void {
  const c = core();
  captureRepo.set(repo);
  c.conn.send({ t: "capture.list", repoDir: repo.worktreePath });
  c.nav.open("capture");
}

/** Re-sync an open capture sheet after a reconnect. It also re-reads which
 *  backends this desktop can drive — that answer is never cached, so a
 *  reconnect is the only thing that can refresh it. */
export function resyncCapture(): void {
  const r = captureRepo.get();
  // eslint-disable-next-line local/no-silent-send -- welcome-only re-sync: runs from the welcome handler, nobody tapped anything
  if (r) core().conn.send({ t: "capture.list", repoDir: r.worktreePath });
}

// Save covers both writing a target and DELETING one (the sheet saves the whole
// list either way), so a silent failure reads as "the delete didn't take" — and
// the next open re-asks `capture.list` and brings the row back with nothing
// having said why.
export function saveTargets(repoDir: string, targets: CaptureTarget[]): void {
  core().conn.liveSend({ t: "capture.save", repoDir, targets }, "capture targets saved",
    "no connection — capture targets live on the desktop and can't be edited from here");
}

/**
 * Durable, `build.run`'s argument plus a lease: a replayed run would be a
 * second browser or simulator fighting the first over one screen. The lane is
 * per repo, so two captures of one repo queue rather than interleave.
 * `watch` is the SAME durable op with one flag set — the second verb gets no
 * send path of its own, and a watch tapped on a dead tunnel is kept and started
 * once, on reconnect, exactly like a one-shot.
 */
export function runCapture(repoDir: string, id: string, watch?: boolean): void {
  const c = core();
  const name = captureNameIn(captures.cfgs.get().lists, repoDir, id);
  const offline = c.queue.queueOp({ t: "capture.run", repoDir, targetId: id, watch: watch ? true : undefined },
    captureLane(repoDir), captureQueueTitle(name, !!watch), { cwd: repoDir });
  c.say.toast(captureQueuedToast(offline, !!watch, name));
}

/** NOT durable and never queued: a cancel delivered an hour late calls off a
 *  capture that finished long ago. */
export function cancelCapture(runId: string): void {
  core().conn.liveSend({ t: "capture.cancel", runId }, "stopping the capture…",
    "no connection — the capture is running on the desktop and can't be stopped from here");
}

/**
 * "Set up with AI": the Send sheet, seeded with the setup prompt and aimed at a
 * NEW session in this checkout. A seed, never a send — the person reads the
 * words, can retarget, and taps send themselves.
 */
export function setupCaptureWithAgent(repo: RepoTarget): void {
  const c = core();
  const dir = repo.worktreePath;
  c.say.track("action:capture.setup");
  c.nav.openSend({
    prompts: [captureSetupPrompt(repo.repoName, captureBackends.get().get(dir) ?? [], captures.cfgs.get().lists.get(dir)?.length ?? 0)],
    target: { kind: "repo", cwd: dir },
    when: { kind: "now" },
    cwdHint: dir,
    origin: "From Capture",
  });
}
