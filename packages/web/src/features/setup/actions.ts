/**
 * Every writer of the repo-readings feature's stores, and its doors.
 */
import type { RepoTarget } from "@waterplane/shared";
import type { SendSeed } from "../../sendIntent";
import { core } from "../../sdk";
import { REPO_HEALTH_EVENT } from "../../demoEntry";
import { aimAfterFile, remedySeed } from "./logic";
import { healthRepo, setupAim, setupRepo, type SetupAim } from "./store";
import { healthPlace, leaveHealth, placeHealth, regionOfSection, sectionOfRegion, switchHealth, type HealthPlace } from "../../setupHealth";

/** Setup & health on a readings section (the region a door names), on a repo (or the sheet's own choice with `null`). */
export function openSetup(repoId: string | null, aim: SetupAim = {}): void {
  setupRepo.set(repoId);
  setupAim.set(aim);
  placeHealth("setup", { tab: "repo", section: sectionOfRegion(aim.region) });
  core().nav.open("setup");
}

/** Setup & health on Health score — through the `repohealth` alias key (stored routes still name it). */
export function openRepoHealth(repo: RepoTarget): void {
  healthRepo.set(repo);
  setupRepo.set(repo.id);
  setupAim.set({ region: "series" });
  placeHealth("repohealth", { tab: "repo", section: "score" });
  core().nav.open("repohealth");
}

/** The frame's readings body: aimed at a repo and a section by a section tap (`setupHealth.ts`). */
export function enterReadings(repoId: string | null, place: HealthPlace): void {
  const w = core().world;
  const id = repoId ?? setupRepo.get() ?? healthRepo.get()?.id ?? w.activeRepo?.id ?? w.repos.find((r) => r.isPrimary)?.id ?? null;
  setupRepo.set(id);
  setupAim.set({ region: regionOfSection(place.section) });
}

/** The Sessions section's skills door: the Skills section of the same screen, never a second sheet. */
export function toSkillsSection(repoId: string): void {
  const c = core();
  setupRepo.set(repoId);
  const self = c.nav.overlay;
  const at = healthPlace.get();
  const from: HealthPlace = at && at.self === self ? at.place : { tab: "repo", section: "sessions" };
  switchHealth(self, from, { tab: "repo", section: "skills" });
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

/** A file from the readings (the longest-files tape), whose close comes back
 *  here — to region 2, the region the tap came from. */
export function openRepoFile(repoId: string, relPath: string): void {
  const c = core();
  c.say.track("action:files.fromReadings");
  const back = c.nav.overlay;
  if (back === "setup" || back === "repohealth" || back === "health") setupAim.set(aimAfterFile(setupAim.get()));
  c.files.browseTo(repoId, relPath, back);
}

export function closeSetup(): void {
  const c = core();
  setupRepo.set(null);
  setupAim.set({});
  leaveHealth("setup");
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

/** The `health` id's own close (a stored route or a door that named the merged screen). */
export function closeHealth(): void {
  setupRepo.set(null);
  setupAim.set({});
  leaveHealth("health");
  core().nav.close("health");
  core().world.refreshRepos();
}

export function closeRepoHealth(): void {
  healthRepo.set(null);
  setupRepo.set(null);
  leaveHealth("repohealth");
  core().nav.close("repohealth");
}

/**
 * The context-weight row's always-on list opens a repo file: Back lands on the checklist region the
 * tap came from (`openRepoFile` re-aims at the series, where the longest-files tape lives).
 */
export function openInstructionFile(repoId: string, relPath: string): void {
  const c = core();
  c.say.track("action:files.fromReadings");
  const back = c.nav.overlay;
  if (back === "setup" || back === "repohealth" || back === "health") setupAim.set({ ...setupAim.get(), region: "agents" });
  c.files.browseTo(repoId, relPath, back);
}

/** The always-on list's door into ONE live session's context sheet: what its first request carried. */
export function openSessionContext(sessionId: string): void {
  core().say.track("action:setup.ctxFromRow");
  core().nav.openContext(sessionId);
}

/** The always-on list's door to the all-sessions token screen. */
export function openAllSessions(): void {
  core().say.track("action:setup.allSessions");
  core().nav.open("tokens");
}

/** This repo's live sessions as the always-on list's doors (a pending create has no log yet). */
export function sessionDoorsFor(repoId: string): { id: string; title: string; open: () => void }[] {
  const w = core().world;
  return w.sessions
    .filter((s) => s.running && !s.id.startsWith("pending:") && w.sessionRepo(s)?.id === repoId)
    .map((s) => ({ id: s.id, title: w.sessionRowTitle(s), open: () => openSessionContext(s.id) }));
}
