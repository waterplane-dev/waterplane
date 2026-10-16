/**
 * Where a build entry LIVES: the committed file every checkout shares, or this
 * desktop's own. Pure, so `buildScope.test.mjs` pins it without a DOM.
 */
import { BRAND } from "@waterplane/shared";

const SHARED_FILE = `${BRAND.sharedDirName}/builds.json`;
const LOCAL_FILE = `${BRAND.stateDirName}/builds.json`;

/**
 * `build.save`'s `local`: which ids stay in THIS desktop's file after an edit.
 * `localIds` is what `build.list` said (`undefined` = an older host with no such
 * file: send nothing, draw nothing). `list` is the whole list being saved, so a
 * deleted id leaves the local file with it. `edit` is the entry just saved and
 * where its author put it; every other id stays where it was.
 */
export function localAfterSave(
  localIds: readonly string[] | undefined,
  list: readonly { id: string }[],
  edit?: { id: string; local: boolean },
): string[] | undefined {
  if (!localIds) return undefined;
  const alive = new Set(list.map((b) => b.id));
  const out = new Set(localIds.filter((id) => alive.has(id)));
  if (edit) {
    if (edit.local && alive.has(edit.id)) out.add(edit.id);
    else out.delete(edit.id);
  }
  return [...out];
}

/** The editor's one sentence under the two choices. */
export function buildScopeNote(local: boolean, wasShared: boolean): string {
  if (!local) return `Committed in ${SHARED_FILE}, so every checkout of this repo gets it.`;
  return wasShared
    ? `This desktop gets its own version, kept in ${LOCAL_FILE}; other checkouts keep the shared one.`
    : `Kept in ${LOCAL_FILE} on this desktop only, never committed.`;
}

/** The quiet row label for the minority case; shared rows say nothing. */
export const BUILD_LOCAL_ROW = "this desktop only";
