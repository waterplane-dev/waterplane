/**
 * The state snapshot `<slug> update` takes before it switches versions, and the
 * restore `--rollback` puts back (docs/notes/distribution.md, "Self-update").
 *
 * Why: a newer host may convert its stores on first boot (`intents.json`'s
 * `schema`, a moved file). Rolling the CODE back alone then leaves the older
 * host facing files it does not understand — at best read-only
 * (`intents/disk.ts`), at worst a store it starts empty. So the update copies
 * the state dir's top-level stores aside, keyed by the version being LEFT, and
 * a rollback to that version restores them.
 *
 * What is copied: the regular files directly in the state dir ending `.json`,
 * `.jsonl` or `.bak` — the stores. Never a `.corrupt-*` copy (evidence, kept
 * where it is), a `.tmp` file, a dot-file, a symlink or a subdirectory (logs,
 * screen archives: not converted, and large).
 *
 * A restore never deletes: what it replaces is MOVED into
 * `<state dir>/.before-rollback-<ts>/` first, so the work done on the newer
 * version is still on disk for a person to look at.
 *
 * Filesystem only (and `jsonstore.ts` for the one JSON it writes), so
 * `selfupdatestate.test.mjs` drives it on temp dirs.
 */
import { copyFileSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { writeJsonAtomic } from "../jsonstore.js";

/** Is `name` one of the stores a snapshot carries? */
export function isSnapshotFile(name: string): boolean {
  if (name.startsWith(".") || name.includes(".corrupt-") || name.endsWith(".tmp")) return false;
  return /\.(json|jsonl|bak)$/.test(name);
}

export const SNAPSHOT_META = "snapshot.json";

export interface SnapshotMeta { from: string; to: string; at: number; stateDir: string; files: string[] }

/**
 * Copy `stateDir`'s stores into `snapDir`, replacing an older snapshot there.
 * Built in a sibling tmp dir and renamed into place, so a half-copied snapshot
 * never sits under the real name. Throws on failure (the caller refuses the
 * update: no snapshot, no switch). A state dir that does not exist yet is an
 * empty snapshot, not a failure.
 */
export function snapshotState(stateDir: string, snapDir: string, meta: { from: string; to: string }, now = Date.now()): SnapshotMeta {
  const parent = dirname(snapDir);
  mkdirSync(parent, { recursive: true });
  const tmp = join(parent, `.tmp-${basename(snapDir)}-${process.pid}`);
  rmSync(tmp, { recursive: true, force: true });
  // 0700: the stores include auth.json and the device ledger (0600 each, which
  // `copyFileSync` keeps), and the directory should say the same.
  mkdirSync(tmp, { recursive: true, mode: 0o700 });
  try {
    const files: string[] = [];
    let names: string[] = [];
    try { names = readdirSync(stateDir); } catch { names = []; }
    for (const name of names.sort()) {
      if (!isSnapshotFile(name)) continue;
      const src = join(stateDir, name);
      if (!lstatSync(src).isFile()) continue;
      copyFileSync(src, join(tmp, name));
      files.push(name);
    }
    const full: SnapshotMeta = { ...meta, at: now, stateDir, files };
    writeJsonAtomic(join(tmp, SNAPSHOT_META), full, { space: 2, newline: true });
    rmSync(snapDir, { recursive: true, force: true });
    renameSync(tmp, snapDir);
    return full;
  } catch (e) {
    rmSync(tmp, { recursive: true, force: true });
    throw e;
  }
}

/** The snapshot's description, or null when `snapDir` holds none. */
export function readSnapshot(snapDir: string): SnapshotMeta | null {
  try {
    const m = JSON.parse(readFileSync(join(snapDir, SNAPSHOT_META), "utf8")) as SnapshotMeta;
    return Array.isArray(m?.files) ? m : null;
  } catch { return null; }
}

/**
 * Put `snapDir`'s stores back into `stateDir`. Every file the snapshot carries,
 * and every store the state dir holds now that the snapshot does NOT (a file
 * the newer version created), is first moved into `.before-rollback-<ts>/`.
 * Run only with the host STOPPED: a running host flushes its stores on exit
 * and would write the newer state straight back over the restore.
 */
export function restoreState(stateDir: string, snapDir: string, now = Date.now()): { restored: string[]; keptIn: string | null } {
  const meta = readSnapshot(snapDir);
  if (!meta) throw new Error(`no state snapshot in ${snapDir}`);
  mkdirSync(stateDir, { recursive: true });
  const keptIn = join(stateDir, `.before-rollback-${new Date(now).toISOString().replace(/[:.]/g, "-")}`);
  let moved = 0;
  let names: string[] = [];
  try { names = readdirSync(stateDir); } catch { names = []; }
  for (const name of names) {
    if (!isSnapshotFile(name)) continue;
    const p = join(stateDir, name);
    if (!lstatSync(p).isFile()) continue;
    mkdirSync(keptIn, { recursive: true, mode: 0o700 });
    renameSync(p, join(keptIn, name));
    moved++;
  }
  const restored: string[] = [];
  for (const name of meta.files) {
    if (!isSnapshotFile(name)) continue; // a hand-edited meta never names anything else
    const src = join(snapDir, name);
    if (!existsSync(src)) continue;
    copyFileSync(src, join(stateDir, name));
    restored.push(name);
  }
  return { restored, keptIn: moved ? keptIn : null };
}
