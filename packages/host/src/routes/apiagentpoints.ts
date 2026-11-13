/**
 * Session points (`agentreadings.ts`'s `agentPointsFor`; DTO `shared/wire/agentreadings.ts`): one
 * point per conversation and subagent log, for one repo or for every repo the host discovers. Read-only
 * GETs over the same incremental sweep as the weekly readings.
 */
import { discoverTargets } from "../repos.js";
import { agentPointsFor, agentReadingsStore } from "../agentreadings.js";
import { addLocalDays, derivedMarkers, collapseMarkers } from "@waterplane/shared";
import { repoOfWorktree } from "../costwindow.js";
import { join } from "node:path";
import { hostStateDir } from "../branddirs.js";
import { instructionMarkers, readSwitchLog, switchMarkers } from "../agentmarkers.js";
import { json } from "./apiio.js";
import { route, type ApiEntry, type RepoReq } from "./apitable.js";

/** `GET /api/repos/:id/agentpoints`. */
export const AGENT_POINTS_REPO_ROUTES: readonly ApiEntry<RepoReq>[] = [
  route<RepoReq>("GET", "agentpoints", async ({ res, wt }, ctx) => {
    json(res, await agentPointsFor(agentReadingsStore(ctx.root), [wt]));
    return true;
  }),
  /** `GET /api/repos/:id/agentmarkers`: instruction commits and tags, skills-switch saves, plus model/CLI/listing steps read off the points. */
  route<RepoReq>("GET", "agentmarkers", async ({ res, wt, target }, ctx) => {
    const pts = await agentPointsFor(agentReadingsStore(ctx.root), [wt]);
    if (!pts.ok) { json(res, { ok: false, error: pts.error }); return true; }
    // The points above are the WHOLE repo's (`repoSpellings` folds a linked worktree into its primary
    // repo), so git reads the primary repo too: from a worktree's branch tip the instruction commits
    // would be that branch's, not the history the readings were made under.
    const repo = repoOfWorktree(wt);
    const since = pts.points.reduce((m, p) => Math.min(m, p.t0), addLocalDays(Date.now(), -90));
    const instr = await instructionMarkers(repo, since, { repo });
    const markers = collapseMarkers([...instr.markers, ...derivedMarkers(pts.points, { repo }),
      ...switchMarkers(await readSwitchLog(join(hostStateDir(ctx.root), "skillswitch-log.jsonl")), since, { repoId: target.id, repo })]);
    json(res, { ok: true, markers, absent: instr.absent });
    return true;
  }),
];

/** `GET /api/agentpoints`: every discovered repo's project directories, each point naming its repo. */
export const AGENT_POINTS_ROUTES: readonly ApiEntry[] = [
  route("GET", "/api/agentpoints", async ({ res }, ctx) => {
    const targets = await discoverTargets(ctx.root);
    json(res, await agentPointsFor(agentReadingsStore(ctx.root), targets.map((t) => t.worktreePath)));
    return true;
  }),
];
