/**
 * The backlog's own persistence and boot: the config file (the auto switch),
 * the legacy items-file migration, and the switch that writes it. Split out of `BacklogManager` (move only): the methods are functions over
 * `BacklogCore` now.
 */
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Intent } from "@waterplane/shared";
import { BRAND, legacyStateDirNames } from "@waterplane/shared";
import { backlogReviews, backlogToDrafts, isBacklogRow } from "../intents/adapters.js";
import { discoverTargets } from "../repos.js";
import { hostStateDir } from "../branddirs.js";
import type { BacklogConfig, BacklogCore } from "./backlogcore.js";
import { readJsonGuarded, writeJsonAtomic } from "../jsonstore.js";

/** Backlog rows, oldest position first — `order` IS the run order. */
export function backlogRows(c: BacklogCore): Intent[] {
  return c.intents.list().filter(isBacklogRow).sort((a, b) => (a.order ?? a.createdAt) - (b.order ?? b.createdAt));
}

/**
 * Read the auto-fire switch, then fold every repo's old items file into the
 * store.
 *
 * Async because it discovers repos. The migration is the same non-destructive
 * shape the launches and schedules got: a row whose id is already in the store
 * is skipped, and the source file is RENAMED to `*.migrated` rather than
 * deleted — a conversion nobody can check is a conversion nobody can trust.
 * It also closes the hole the per-repo file had all along, which is that a
 * `writeFileSync` with no tmp+rename can leave half a JSON document where a
 * backlog used to be.
 */
export async function init(c: BacklogCore): Promise<void> {
  try {
    if (existsSync(c.autoPath)) {
      const cfg = readJsonGuarded<any>(c.autoPath, null) as BacklogConfig;
      // Only `auto` is read: a `smartPick` key an older host wrote is ignored
      // and dropped by the next `saveConfig`.
      c.auto = !!cfg?.auto;
    }
  } catch { /* fresh */ }
  // The pre-per-repo global store, if a host this old is being upgraded: its
  // items already carry their own `repoDir`, so it converts the same way.
  // Every state-dir name, current and legacy: a repo whose legacy-named dir was
  // never moved (`branddirs.ts` moves per-repo dirs only on a tap) still has
  // its old file there, and a name already converted is `.migrated`, so a
  // legacy name that is our own symlink back reads nothing twice.
  const legacyFiles = (dir: string) => legacyStateDirNames.map((name) => join(dir, name, "backlog.json"));
  for (const p of [join(hostStateDir(c.root), "backlog.json"), ...legacyFiles(c.root)]) migrateFile(c, p, null);
  let dirs: string[] = [];
  try { dirs = (await discoverTargets(c.root)).map((t) => t.worktreePath); } catch { /* none */ }
  for (const dir of dirs) {
    for (const p of [join(dir, BRAND.stateDirName, "backlog.json"), ...legacyFiles(dir)]) migrateFile(c, p, dir);
  }
}

/** One legacy items file. `repoDir` null ⇒ the old global store, whose rows
 *  name their own repo. */
export function migrateFile(c: BacklogCore, path: string, repoDir: string | null): void {
  if (!existsSync(path)) return;
  // The verdicts travel separately: they are about the work, not about when
  // it runs, and `review.ts` is where they live now.
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")); // a legacy file: left where it is, never moved aside
    if (typeof raw?.auto === "boolean" && !repoDir) { c.auto = raw.auto; saveConfig(c); }
    c.reviews.importAll(backlogReviews(raw));
  } catch { /* unreadable → the store's own import will say so by importing nothing */ }
  c.intents.migrateFileAt(path, path, (raw, now) => backlogToDrafts(raw, repoDir, now));
}

/**
 * The whole config file, written at once.
 *
 * **tmp+rename.** This was a bare `writeFileSync`, and a torn one is silent in
 * exactly the worst way: `init()` wraps the read in `try { … } catch {
 * /* fresh *\/ }`, so half a JSON document reads back as `auto: false` —
 * auto-fire OFF on the next boot, with nothing said. "Half a JSON document
 * where a backlog used to be" is this repo's recorded failure for exactly this.
 */
export function saveConfig(c: BacklogCore): void {
  try {
    mkdirSync(hostStateDir(c.root), { recursive: true });
    const cfg: BacklogConfig = { auto: c.auto };
    writeJsonAtomic(c.autoPath, cfg, { space: 2 });
  } catch { /* non-fatal */ }
}

export function setAuto(c: BacklogCore, enabled: boolean): void {
  c.auto = enabled;
  saveConfig(c);
  // The switch is rung 1 of the ladder, so flipping it re-answers every queued
  // row at once — including the ones that are now free to go.
  c.intents.kick();
  c.intents.emitChanged();
}
