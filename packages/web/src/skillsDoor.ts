/**
 * The doors into the skills & plugins screen (`features/skills`). A feature may not import another
 * feature, and two doors (the Setup sheet's context-weight row, the request breakdown's skill
 * listing card) sit outside it, so the AIM lives here: a door sets it and opens the sheet; the
 * sheet reads it. ONE writer: `openSkillsFor`.
 */
import { core, createStore } from "./sdk";

export interface SkillsAim { repoId: string; backend?: string }

export const skillsAim = createStore<SkillsAim | null>(null);

/** Open the screen on a repo, for the backend the door's session or repo runs. */
export function openSkillsFor(repoId: string, backend?: string): void {
  skillsAim.set({ repoId, backend });
  core().say.track("action:skills.open");
  core().nav.open("skills");
}
