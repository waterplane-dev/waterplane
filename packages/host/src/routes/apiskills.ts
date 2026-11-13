/**
 * Skills and plugins switch, read side (docs/analysis/skills-switch/PLAN.md, P2 + P4). REST, no WebSocket
 * message. NOT in `passive.ts`'s allowlist: a passive token is refused (R-skills-014).
 */
import { join } from "node:path";
import type { SkillRow } from "@waterplane/shared";
import { hostStateDir } from "../branddirs.js";
import { claudeProjectDir } from "../claudeconfig.js";
import { gitWorktrees } from "../repos.js";
import { SkillUseStore } from "../skills/skilluse.js";
import { buildInventory, type InventoryOut } from "../skills/skillinventory.js";
import { recommendSkills } from "../skills/skillrecommend.js";
import { applySkillWrite } from "../skills/skillwrite.js";
import { json, readJson } from "./apiio.js";
import { route, type ApiEntry, type RepoReq } from "./apitable.js";

let useStore: SkillUseStore | null = null;
const store = (root: string): SkillUseStore => (useStore ??= new SkillUseStore({ file: join(hostStateDir(root), "skilluse.json") }));

/** The append-only save record (PLAN.md, "The save record"). */
const logFile = (root: string): string => join(hostStateDir(root), "skillswitch-log.jsonl");

/** The repo's inventory with this repo's use counts filled in (kicks the background scan). */
async function repoDoc(root: string, wt: string, repoId: string): Promise<InventoryOut> {
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
  return out;
}

export const SKILLS_HOST_ROUTES: readonly ApiEntry[] = [
  route("GET", "/api/host/skills", async ({ res }) => {
    json(res, (await buildInventory()).doc);
    return true;
  }),
  route("POST", "/api/host/skills/write", async ({ req, res }, ctx) => {
    const body = await readJson(req);
    const { doc } = await buildInventory();
    const r = applySkillWrite({ logFile: logFile(ctx.root), level: body?.level, revs: body?.revs, changes: body?.changes, allowed: ["global"], doc });
    if (!r.ok) { json(res, r, r.status); return true; }
    json(res, { ...r, doc: (await buildInventory()).doc });
    return true;
  }),
];

export const SKILLS_REPO_ROUTES: readonly ApiEntry<RepoReq>[] = [
  route<RepoReq>("GET", "skills", async ({ res, wt, target }, ctx) => {
    json(res, (await repoDoc(ctx.root, wt, target.id)).doc);
    return true;
  }),
  // The one spender here: tapped, never unattended. Answers a suggestion LIST; nothing is applied.
  route<RepoReq>("POST", "skills/recommend", async ({ res, wt, target }, ctx) => {
    const { doc, files } = await repoDoc(ctx.root, wt, target.id);
    json(res, await recommendSkills(wt, doc, files));
    return true;
  }),
  route<RepoReq>("POST", "skills/write", async ({ req, res, wt, target }, ctx) => {
    const body = await readJson(req);
    const { doc } = await buildInventory({ worktree: wt, repoId: target.id });
    const r = applySkillWrite({ logFile: logFile(ctx.root), repoId: target.id, level: body?.level, revs: body?.revs, changes: body?.changes, allowed: ["global", "repo-local", "repo-shared"], worktree: wt, doc });
    if (!r.ok) { json(res, r, r.status); return true; }
    json(res, { ...r, doc: (await repoDoc(ctx.root, wt, target.id)).doc });
    return true;
  }),
];
