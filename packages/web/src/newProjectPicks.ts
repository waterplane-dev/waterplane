/**
 * Which boxes are ticked on the new-project sheet. The phone remembers only what a person CHANGED,
 * per desktop, so a box they never touched follows the desktop's own default and a new extension's
 * box starts at what that extension says. Pure, pinned by `newProjectPicks.test.mjs`.
 */
import type { NewProjectOption } from "@waterplane/shared";

export type NewProjectPicks = Record<string, boolean>;

/** What the phone kept, cleaned; nothing when it is absent or the wrong shape. */
export function newProjectPicks(o: unknown): NewProjectPicks {
  if (!o || typeof o !== "object" || Array.isArray(o)) return {};
  return Object.fromEntries(Object.entries(o).filter((e): e is [string, boolean] => typeof e[1] === "boolean"));
}

/** The ids to send: the same answer the boxes draw. */
export function tickedOptions(options: readonly Pick<NewProjectOption, "id" | "on">[], picks: NewProjectPicks): string[] {
  return options.filter((o) => picks[o.id] ?? o.on).map((o) => o.id);
}

export function withPick(picks: NewProjectPicks, id: string, on: boolean): NewProjectPicks {
  return { ...picks, [id]: on };
}
