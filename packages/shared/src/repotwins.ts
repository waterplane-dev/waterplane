/**
 * Two discovered repos with one name, told apart in words.
 *
 * A repo's name is its folder's name, so a second clone — a history-rewrite
 * leftover at `~/dev/waterplane-rewrite/out-ciqkit/ciqkit` beside the real
 * `~/dev/garmin/ciqkit` — reads exactly like the first on the phone. On
 * 2026-10-28 that sent three unattended week-end burn sessions to the leftover.
 *
 * The host computes `RepoTarget.where` with `twinWheres` over the CLONE dirs
 * (every worktree of one clone carries its clone's `where`, so they still list
 * together), and every surface that names a repo reads `repoLabel`. Absent
 * `where` = no twin (or an older host): the label is the bare name, unchanged.
 */

/** A clone as discovery found it: its folder name and its primary checkout dir. */
export interface RepoClone { name: string; dir: string }

const segs = (dir: string): string[] => dir.split(/[/\\]+/).filter(Boolean);

/**
 * `dir` → the shortest trailing part of its PARENT path that no other clone of
 * the same name shares, with a trailing `/` (`garmin/`, `out-ciqkit/`). Only
 * clones whose name another clone carries get an entry. When no tail is unique
 * (one parent ends the other) the whole parent path is the answer — longer, but
 * never two rows that read the same.
 */
export function twinWheres(clones: readonly RepoClone[]): Map<string, string> {
  const out = new Map<string, string>();
  const byName = new Map<string, string[]>();
  for (const c of clones) {
    const dirs = byName.get(c.name) ?? [];
    if (!dirs.includes(c.dir)) dirs.push(c.dir);
    byName.set(c.name, dirs);
  }
  for (const dirs of byName.values()) {
    if (dirs.length < 2) continue;
    const parents = dirs.map((d) => segs(d).slice(0, -1));
    parents.forEach((mine, i) => {
      for (let n = 1; n <= mine.length; n++) {
        const tail = mine.slice(-n).join("/");
        if (parents.every((o, j) => j === i || o.slice(-n).join("/") !== tail)) { out.set(dirs[i], `${tail}/`); return; }
      }
      out.set(dirs[i], `/${mine.join("/")}${mine.length ? "/" : ""}`);
    });
  }
  return out;
}

/** The ONE wording of a repo's name on both ends: `ciqkit`, or `ciqkit · garmin/` for a twin. */
export function repoLabel(r: { repoName: string; where?: string }): string {
  return r.where ? `${r.repoName} · ${r.where}` : r.repoName;
}
