/**
 * The pre-push hook alone, on HEAD or a chosen commit, and a push of only the commits up to one,
 * under `/api/repos/:id/git/*`. Routes of their own, never a field on `git/push`: an older host
 * would ignore the field and push the whole branch. Not in passive.ts: default-deny stands.
 */
import { pushState, startPush } from "../git.js";
import { isSha } from "../prepushcheck.js";
import { json, readJson } from "./apiio.js";
import { route, type ApiEntry, type RepoReq } from "./apitable.js";
import { gitRef } from "./apirepowork.js";

export const REPO_CHECK_ROUTES: readonly ApiEntry<RepoReq>[] = [
  route<RepoReq>("POST", "git/check/*", async ({ req, res, wt, target }) => {
    const sha = (await readJson(req, { optional: true }) as { sha?: unknown } | null)?.sha;
    if (sha !== undefined && !isSha(sha)) return json(res, { error: "not a commit id" }, 400), true;
    startPush(wt, gitRef(target), { check: sha });
    json(res, pushState(wt));
    return true;
  }),
  route<RepoReq>("POST", "git/pushto/*", async ({ req, res, wt, target }) => {
    const sha = (await readJson(req) as { sha?: unknown } | null)?.sha;
    if (!isSha(sha)) return json(res, { error: "not a commit id" }, 400), true;
    startPush(wt, gitRef(target), { upTo: sha });
    json(res, pushState(wt));
    return true;
  }),
];
