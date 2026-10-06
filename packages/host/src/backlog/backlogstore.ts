/**
 * The backlog's own persistence and boot: the config file (auto switch + smart
 * pick ticks), the legacy items-file migration, and the two switches that write
 * it. Split out of `BacklogManager` (move only): the methods are functions over
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
      c.auto = !!cfg?.auto;
      // Absent is the old file, and the old file is every host that predates
      // the feature: no repo has the tick, which is also the default.
      for (const [cwd, v] of Object.entries(cfg?.smartPick ?? {})) {
        if (!cwd) continue;
        c.smartPickOn.add(cwd);
        c.smartPickAt.set(cwd, Number(v?.setAt) || 0);
      }
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
 * `saveAuto()` as was, renamed because it writes two things now — and it
 * writes them TOGETHER on purpose: a partial write of one key would drop the
 * other, and "the tick turned itself off when I toggled auto-fire" is the
 * exact failure a second writer of one file produces.
 *
 * **tmp+rename, for the same reason `SmartPickStore.persist` is.** This was a
 * bare `writeFileSync`, and a torn one is silent in exactly the worst way:
 * `init()` wraps the read in `try { … } catch { /* fresh *\/ }`, so half a JSON
 * document reads back as `auto: false` with no repo ticked — auto-fire OFF and
 * every smart-pick tick off, on the next boot, with nothing said. "Half a JSON
 * document where a backlog used to be" is this repo's recorded failure for
 * exactly this, and the file now holds two settings instead of one, which is
 * when a torn write costs most.
 */
export function saveConfig(c: BacklogCore): void {
  try {
    mkdirSync(hostStateDir(c.root), { recursive: true });
    const smartPick: Record<string, { setAt: number }> = {};
    for (const cwd of c.smartPickOn) smartPick[cwd] = { setAt: c.smartPickAt.get(cwd) ?? 0 };
    const cfg: BacklogConfig = { auto: c.auto, ...(c.smartPickOn.size ? { smartPick } : {}) };
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

/**
 * Turn it on or off for one worktree.
 *
 * `cwd` has already been through `containRepoDir` (the route declares
 * `contain`), so the key stored here is the same realpath every `Intent.cwd`
 * carries — which is what makes the lookup above a plain `has`.
 *
 * It kicks, because turning it ON changes what the very next tick does with
 * this repo's ready rows, and turning it OFF frees anything the pass is
 * holding right now: a row blocked `picking` re-asks the ladder and, with the
 * dep now answering `null`, fires. Nothing has to wait out an in-flight pass
 * to be allowed to run again.
 */
export function setSmartPick(c: BacklogCore, cwd: string, enabled: boolean): void {
  if (enabled) {
    if (c.smartPickOn.has(cwd)) return;
    c.smartPickOn.add(cwd);
    c.smartPickAt.set(cwd, Date.now());
  } else {
    if (!c.smartPickOn.delete(cwd)) return;
    c.smartPickAt.delete(cwd);
  }
  saveConfig(c);
  c.intents.kick();
  c.intents.emitChanged();
}

