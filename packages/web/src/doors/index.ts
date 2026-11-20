/**
 * The door registry: every control that opens a screen, one file per area so packages built in
 * parallel never edit one file (whole-app journey spec D1, §8). Data only; see `types.ts`.
 */
import type { Door, NoDoor } from "./types.ts";
import { area as home } from "./home.ts";
import { area as files } from "./files.ts";
import { area as waiting } from "./waiting.ts";
import { area as health } from "./setuphealth.ts";
import { area as settings } from "./settings.ts";
import { area as session } from "./session.ts";
import { area as connection } from "./connection.ts";
import { area as extensions } from "./extensions.ts";

export type { Door, DoorArea, DoorFrom, NoDoor } from "./types.ts";

const AREAS = { home, files, waiting, health, settings, session, connection, extensions };
export type AreaName = keyof typeof AREAS;

export const DOORS: readonly (Door & { area: AreaName })[] = Object.entries(AREAS)
  .flatMap(([name, a]) => a.doors.map((d) => ({ ...d, area: name as AreaName })));

/** Ids with no door on purpose, with the reason; an id two areas explain keeps the first. */
export const NO_DOOR: NoDoor = Object.assign({}, ...Object.values(AREAS).map((a) => a.noDoor ?? {}).reverse());

/**
 * Does `label` say `title`? Equal, or the start of it ending at a word boundary, case-insensitive;
 * a leading count ("3 blocked", "N blocked") is not part of the label (glossary §2).
 */
export function labelSaysTitle(label: string, title: string): boolean {
  const l = label.trim().replace(/^(\d+|N)\s+/, "").toLowerCase();
  const t = title.trim().toLowerCase();
  if (!l) return false;
  if (l === t) return true;
  return t.startsWith(l) && !/[\p{L}\p{N}]/u.test(t[l.length]);
}
