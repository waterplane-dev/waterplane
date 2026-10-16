/**
 * Every writer of the repo-readings feature's stores, and its doors.
 */
import type { RepoTarget } from "@waterplane/shared";
import type { SendSeed } from "../../sendIntent";
import { core } from "../../sdk";
import { REPO_HEALTH_EVENT } from "../../demoEntry";
import { aimAfterFile, remedySeed } from "./logic";
import { healthRepo, setupAim, setupRepo, type SetupAim } from "./store";

/** The checklist, on a repo (or the sheet's own choice with `null`), aimed. */
export function openSetup(repoId: string | null, aim: SetupAim = {}): void {
  setupRepo.set(repoId);
  setupAim.set(aim);
  core().nav.open("setup");
}

/** Region 2 — the repo-health series — through its own alias key. */
export function openRepoHealth(repo: RepoTarget): void {
  healthRepo.set(repo);
  core().nav.open("repohealth");
}

/**
 * Shared by BOTH doors into the readings sheet (the checklist and the
 * `repohealth` alias, which render the same sheet): inline in one, the other
 * silently lost the verb. It opens the prompt with the repo chosen and sends
 * nothing.
 */
export function remedy(prompt: string, repo: RepoTarget, label: string): void {
  core().say.track("action:setup.remedy");
  seedSend(remedySeed(prompt, repo, label));
}

/**
 * `remedy`'s opener for a seed built whole elsewhere — region 3's opt-ins,
 * whose schedule offer carries a clock and a model as well as words. The
 * Send sheet opens on it; nothing is sent by the tap.
 */
export function seedSend(seed: SendSeed): void {
  setupRepo.set(null);
  healthRepo.set(null);
  core().nav.openSend(seed);
}

/** Region 3's `open captures` — the capture sheet is another feature's, so it
 *  is reached through the core. */
export function openCaptureFromReadings(repo: RepoTarget): void {
  core().nav.openCapture(repo);
}

/** A file from the readings (the longest-files tape), whose close comes back
 *  here — to region 2, the region the tap came from. */
export function openRepoFile(repoId: string, relPath: string): void {
  const c = core();
  c.say.track("action:files.fromReadings");
  const back = c.nav.overlay;
  if (back === "setup") setupAim.set(aimAfterFile(setupAim.get()));
  c.files.browseTo(repoId, relPath, back);
}

export function closeSetup(): void {
  const c = core();
  setupRepo.set(null);
  setupAim.set({});
  c.nav.close("setup");
  c.world.refreshRepos();
}

/** `REPO_HEALTH_EVENT` (`demoEntry.ts`): region 2 for the named repo, else the
 *  active session's, else the first primary one — asked for by a screen outside
 *  this feature (the demo's tour row and closing card). */
export function bootRepoHealthEvent(): () => void {
  const on = (e: Event) => {
    const c = core();
    const id = (e as CustomEvent<{ repoId?: string | null }>).detail?.repoId ?? null;
    const repo = (id ? c.world.repos.find((r) => r.id === id) : null) ?? c.world.activeRepo ?? c.world.repos.find((r) => r.isPrimary) ?? null;
    if (repo) openRepoHealth(repo);
  };
  window.addEventListener(REPO_HEALTH_EVENT, on);
  return () => window.removeEventListener(REPO_HEALTH_EVENT, on);
}

export function closeRepoHealth(): void {
  healthRepo.set(null);
  core().nav.close("repohealth");
}
