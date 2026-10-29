/**
 * The Review sheet's two SPENDING routes — the commit-message draft
 * (`commitmsg.ts`) and Explain (`explainjob.ts`) — under `/api/repos/:id/git/*`.
 * Own table so `apirepowork.ts` stays under its cap.
 */
import { suggestCommitMessage } from "../commitmsg.js";
import { explainState, startExplain } from "../explainjob.js";
import { json, readJson } from "./apiio.js";
import { route, type ApiEntry, type RepoReq } from "./apitable.js";
import { gitRef } from "./apirepowork.js";

export const REPO_SPEND_ROUTES: readonly ApiEntry<RepoReq>[] = [
  // POST, and not because it writes anything — it writes nothing at all.
  // It SPENDS (one headless model call), and `origin.ts`'s rule is that no
  // /api GET may have an effect; a cross-origin `<img src>` must not be
  // able to run up a bill either.
  route<RepoReq>("POST", "git/message/*", async ({ res, wt }) => {
    json(res, await suggestCommitMessage(wt));
    return true;
  }),
  // POST for the same reason: it spends, and it fetches (refs only).
  // A job like the push (`explainjob.ts`): `{ background: true }` starts the
  // brief (or joins the running one) and answers at once with its state; the
  // phone then asks GET until it ends, and a notification says when it did.
  // Without it the request is held open — what a bundle from before the job asks.
  route<RepoReq>("POST", "git/explain/*", async ({ req, res, wt, target }) => {
    const body = await readJson(req) as { foci?: unknown; note?: unknown; background?: unknown };
    const job = startExplain(wt, body, gitRef(target));
    if (body?.background === true) { json(res, explainState(wt)); return true; }
    json(res, await job.done);
    return true;
  }),
  route<RepoReq>("GET", "git/explain/*", async ({ res, wt }) => {
    json(res, { explain: explainState(wt) });
    return true;
  }),
];
