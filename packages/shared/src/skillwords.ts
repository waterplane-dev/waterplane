/** The sentences of the skills and plugins switch, worded once for phone, host and VS Code. */
import type { SwitchLevel } from "./wire/skills.js";

export const SKILL_NEW_SESSIONS_ONLY =
  "Changes reach new sessions only — a session that is already running keeps what it was started with.";

export function skillFileLine(level: SwitchLevel, path: string): string {
  const who = level === "global" ? "every repo on this desktop" : level === "repo-shared" ? "this repo, shared with everyone who clones it" : "this repo, on this desktop only";
  return `Writes ${path} (${who}).`;
}

export const skillPluginSkillLine = (plugin: string): string => `follows ${plugin}`;
export const skillPluginNotSwitchable = (plugin: string): string =>
  `This skill comes with ${plugin}; the CLI only switches it with the whole plugin.`;
export const SKILL_UNMEASURED = "size not measured";
export const skillLayerUnreadable = (path: string, why: string): string =>
  `${path} was not changed: ${why}`;
export const skillRevConflict = (path: string): string =>
  `${path} changed since this screen read it. Nothing was written; reload and choose again.`;
export const skillSavingsLine = (tokens: number, unmeasured: number): string => {
  const more = unmeasured > 0 ? `, plus ${unmeasured} unmeasured` : "";
  if (tokens === 0) return `No change in the skill listing${more}.`;
  const n = Math.abs(tokens);
  return tokens > 0 ? `Up to about ${n} tokens fewer per turn${more}.` : `Up to about ${n} tokens more per turn${more}.`;
};
