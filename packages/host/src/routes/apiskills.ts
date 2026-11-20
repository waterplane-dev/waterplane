/**
 * Skills and plugins switch, read side (docs/analysis/skills-switch/PLAN.md, P2 + P4). REST, no WebSocket
 * message (the `skills.*` slow jobs, `apijobs.ts`, carry the one frame). NOT in `passive.ts`'s allowlist: a passive token is refused (R-skills-014).
 */
import { join } from "node:path";
import { hostStateDir } from "../branddirs.js";
import { buildInventory } from "../skills/skillinventory.js";
import { repoDoc } from "../skills/skillrepodoc.js";
import { applySkillWrite } from "../skills/skillwrite.js";
import { json, readJson } from "./apiio.js";
import { forgetSkillJobs, joinAndWait, jobsOf } from "./apijobs.js";
import { route, type ApiEntry, type RepoReq } from "./apitable.js";

/** The append-only save record (PLAN.md, "The save record"). */
const logFile = (root: string): string => join(hostStateDir(root), "skillswitch-log.jsonl");

export const SKILLS_HOST_ROUTES: readonly ApiEntry[] = [
  route("GET", "/api/host/skills", async ({ res }) => {
    json(res, (await buildInventory()).doc);
    return true;
  }),
  route("POST", "/api/host/skills/write", async ({ req, res }, ctx) => {
    const body = await readJson(req);
    const { doc } = await buildInventory();
    const r = await applySkillWrite({ logFile: logFile(ctx.root), level: body?.level, revs: body?.revs, changes: body?.changes, allowed: ["global"], doc });
    if (!r.ok) { json(res, r, r.status); return true; }
    forgetSkillJobs(jobsOf(ctx));   // a global write changes every repo's inventory
    json(res, { ...r, doc: (await buildInventory()).doc });
    return true;
  }),
];

export const SKILLS_REPO_ROUTES: readonly ApiEntry<RepoReq>[] = [
  // Both join the slow job of the same kind (`apijobs.ts`): a phone on these and one on
  // `…/jobs/:kind` never run the work twice.
  route<RepoReq>("GET", "skills", async (r, ctx) => {
    json(r.res, await joinAndWait(r, ctx, "skills.inventory"));
    return true;
  }),
  // The one spender here: tapped, never unattended. Answers a suggestion LIST; nothing is applied.
  // A second tap while one call runs JOINS it — one call bought, both taps answered.
  route<RepoReq>("POST", "skills/recommend", async (r, ctx) => {
    json(r.res, await joinAndWait(r, ctx, "skills.recommend"));
    return true;
  }),
  route<RepoReq>("POST", "skills/write", async ({ req, res, wt, target }, ctx) => {
    const body = await readJson(req);
    const { doc } = await buildInventory({ worktree: wt, repoId: target.id });
    const r = await applySkillWrite({ logFile: logFile(ctx.root), repoId: target.id, level: body?.level, revs: body?.revs, changes: body?.changes, allowed: ["global", "repo-local", "repo-shared"], worktree: wt, doc });
    if (!r.ok) { json(res, r, r.status); return true; }
    forgetSkillJobs(jobsOf(ctx), target.id);
    json(res, { ...r, doc: (await repoDoc(ctx.root, wt, target.id)).doc });
    return true;
  }),
];
