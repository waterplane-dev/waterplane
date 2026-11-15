/**
 * One repo's skills inventory with its use counts filled in — what `GET …/skills`, its write's
 * answer and the `skills.*` slow jobs (`routes/apijobs.ts`) all read. A leaf both route tables
 * import, so neither imports the other.
 */
import { dirname, join } from "node:path";
import type { SkillRow } from "@waterplane/shared";
import { hostStateDir } from "../branddirs.js";
import { claudeProjectDir } from "../claudeconfig.js";
import { gitWorktrees } from "../repos.js";
import { SkillUseStore } from "./skilluse.js";
import { buildInventory, type InventoryOut } from "./skillinventory.js";

let useStore: SkillUseStore | null = null;
const store = (root: string): SkillUseStore => (useStore ??= new SkillUseStore({ file: join(hostStateDir(root), "skilluse.json") }));

/** The repo's inventory with this repo's use counts filled in (kicks the background scan). */
export async function repoDoc(root: string, wt: string, repoId: string): Promise<InventoryOut> {
  const out = await buildInventory({ worktree: wt, repoId });
  const doc = out.doc;
  // The primary checkout plus every linked worktree: "in this repo" by construction.
  const trees = await gitWorktrees(wt);
  const dirs = [...new Set([wt, ...trees.map((t) => t.path)].map((p) => claudeProjectDir(p)))];
  const uses = store(root);
  uses.kick(repoId, dirs);
  const r = uses.read(repoId, dirs, doc.rows.map((x) => x.id));
  doc.usage = { ...doc.usage, state: r.state, ...(r.done !== undefined ? { done: r.done, total: r.total } : {}), ...(r.why ? { why: r.why } : {}), ...(r.refreshing ? { refreshing: true } : {}) };
  if (r.state === "ready" && r.uses) {
    for (const row of doc.rows) {
      if (row.kind !== "skill") continue;
      const c = r.uses[row.id];
      if (c) (row as SkillRow).uses = c;
    }
  }
  // Every repo on this desktop: one walk of the CLI's whole projects folder, so the All-repos half of
  // a suggestion stands on counts from all repos, not this one. Files are cached by mtime+size.
  const all = uses.readAll(dirname(dirs[0]!), doc.rows.map((x) => x.id));
  doc.usage.allRepos = { state: all.state, ...(all.done !== undefined ? { done: all.done, total: all.total } : {}), ...(all.why ? { why: all.why } : {}), ...(all.refreshing ? { refreshing: true } : {}) };
  if (all.state === "ready" && all.uses) {
    for (const row of doc.rows) {
      if (row.kind !== "skill") continue;
      const c = all.uses[row.id];
      if (c) (row as SkillRow).usesEverywhere = c;
    }
  }
  return out;
}
