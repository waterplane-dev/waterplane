/**
 * The PR card's routes (`prs.ts`), under `/api/repos/:id/git/prs*`. Own table so
 * `apirepowork.ts` stays under its cap. Not in passive.ts: default-deny stands.
 */
import { json, readJson } from "./apiio.js";
import { route, type ApiEntry, type RepoReq } from "./apitable.js";
import { autoMergePr, cachedPrs, closePr, failingLog, leasePrs, mergePr } from "../prs.js";

export const REPO_PR_ROUTES: readonly ApiEntry<RepoReq>[] = [
  // ── The PR card (prs.ts). The list is polled only while a lease is held;
  // GET answers the cache, never `gh`. Every action is ONE explicit POST from a
  // tap, answers `PrActionResult` (400 when it did not happen). Not in passive.ts.
  route<RepoReq>("GET", "git/prs", async ({ res, wt }) => {
    json(res, cachedPrs(wt));
    return true;
  }),
  // POST: takes/renews the lease (phone: every ~30 s; it lapses after 60 s) and kicks a poll.
  route<RepoReq>("POST", "git/prs/lease", async ({ req, res, wt, target }) => {
    const body = await readJson(req, { optional: true }) as { holder?: unknown } | null;
    const holder = typeof body?.holder === "string" && body.holder ? body.holder.slice(0, 64) : "default";
    json(res, leasePrs(wt, holder, { id: target.id, name: target.isPrimary ? target.repoName : `${target.repoName} (${target.branch})`, branch: target.branch }));
    return true;
  }),
  route<RepoReq>("POST", "git/prs/merge", async ({ req, res, wt }) => {
    const r = await mergePr(wt, (await readJson(req)) ?? {});
    json(res, r, r.ok ? 200 : 400);
    return true;
  }),
  route<RepoReq>("POST", "git/prs/automerge", async ({ req, res, wt }) => {
    const r = await autoMergePr(wt, (await readJson(req)) ?? {});
    json(res, r, r.ok ? 200 : 400);
    return true;
  }),
  route<RepoReq>("POST", "git/prs/close", async ({ req, res, wt }) => {
    const r = await closePr(wt, (await readJson(req)) ?? {});
    json(res, r, r.ok ? 200 : 400);
    return true;
  }),
  // POST: it runs `gh run view --log-failed`, which is a network read.
  route<RepoReq>("POST", "git/prs/log", async ({ req, res, wt }) => {
    const r = await failingLog(wt, (await readJson(req)) ?? {});
    json(res, r, r.ok ? 200 : 400);
    return true;
  }),
];
