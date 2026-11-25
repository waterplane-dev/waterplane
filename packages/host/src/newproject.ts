/**
 * What a person may tick when creating a project from the phone, beside the seed files every project
 * gets (`scaffold.ts`): core's own choice (the auto-compact window) and whatever an extension or
 * plugin offers with `setupFix(id, fn, { newProject })`. Core names no extension here, so a private
 * one adds its box without this file learning of it.
 *
 * Only an id on the list offered NOW ever runs: a fix that is not a checkbox cannot be reached from
 * the create route. Each option runs on its own, so one that throws costs its own sentence and
 * nothing else; a failure is a `problem` (the phone shows it before opening the session).
 */
import type { NewProjectOption } from "@waterplane/shared";
import { writeAutoCompact } from "./compliance.js";
import { contributedFixes, contributedNewProjectOptions } from "./plugins/setupcontrib.js";
import { autoCompactChosen, autoCompactDefault } from "./setupprefs.js";

const AUTO_COMPACT = "auto-compact";

/** Core's boxes first, then the contributed ones in load order. */
export function newProjectOptions(): NewProjectOption[] {
  return [
    {
      id: AUTO_COMPACT,
      label: `compact long sessions at ${autoCompactDefault()}`,
      hint: "Writes autoCompactWindow to .claude/settings.json, so a long session does not re-read a 1M window on every step.",
      // Choosing a window is a setting, not a repair: ticked only for a person who chose one in Settings.
      on: autoCompactChosen(),
    },
    ...contributedNewProjectOptions(),
  ];
}

/** Run the ticked options on a project just seeded, in list order. */
export function applyNewProjectOptions(dir: string, ids: readonly string[]): { notes: string[]; problems: string[] } {
  const notes: string[] = [], problems: string[] = [];
  const offered = newProjectOptions();
  for (const id of new Set(ids)) if (!offered.some((o) => o.id === id)) problems.push(`"${id}" is no longer offered on this desktop`);
  for (const o of offered) {
    if (!ids.includes(o.id)) continue;
    try {
      const r = o.id === AUTO_COMPACT && !o.from ? writeAutoCompact(dir) : contributedFixes([o.id], dir)[0]?.outcome;
      if (!r) problems.push(`${o.label}: nothing on this desktop answers it any more`);
      else (r.applied ? notes : problems).push(r.applied ? r.note : `${o.label}: ${r.note || "not applied"}`);
    } catch (err) {
      problems.push(`${o.label}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return { notes, problems };
}
