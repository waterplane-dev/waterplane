/**
 * Whether a slow job's end is worth a toast, and its one sentence. Pure — `logic.test.mjs`.
 *
 * A toast only for a run a person was waiting on (`asked`: a tap, or a screen that had nothing to
 * show yet) and only when no screen is showing that key (`watched`): on the screen itself the
 * answer simply appears. A background refresh of something already on screen ends silently.
 */
import type { SlowJobKind, SlowJobState } from "@waterplane/shared";

const WHAT: Record<SlowJobKind, string> = {
  "setup.check": "The setup checklist",
  "skills.inventory": "Skills & plugins",
  "skills.uses": "The skill use counts",
  "skills.recommend": "Skill suggestions",
};

export interface SettledFact { kind: SlowJobKind; state: SlowJobState; asked: boolean; watched: boolean; error?: string }

export function toastFor(f: SettledFact, repoName: string): string | null {
  if (!f.asked || f.watched || f.state === "running") return null;
  const what = `${WHAT[f.kind] ?? "A desktop read"} for ${repoName}`;
  if (f.state === "failed") return `${what} did not finish: ${f.error ?? "the desktop gave up on it."} Tap to open.`;
  if (f.kind === "skills.recommend") return `${what} are ready — tap to see them. Nothing is switched until you apply.`;
  return `${what} ${f.kind === "skills.inventory" || f.kind === "skills.uses" ? "are" : "is"} ready — tap to open.`;
}

/** Which screen the toast's tap opens. */
export const screenFor = (kind: SlowJobKind): "setup" | "skills" => (kind === "setup.check" ? "setup" : "skills");
