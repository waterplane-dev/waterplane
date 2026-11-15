/**
 * The repo scope's READINGS routes: the repo-health series (read, scopes,
 * refresh, and reading the repo's own readings back), the health score and the
 * agent readings beside it. Relative to `/api/repos/:id/` (the scope in
 * `apirepofiles.ts` resolved the target first). Cut out of `apirepowork.ts`
 * when that table passed its 500-line cap (host-architecture.md, "api.ts —
 * the HTTP routes as tables").
 */
import { realpathSync } from "node:fs";
import { healthSpendWeeks } from "@waterplane/shared";
import { repoOfWorktree } from "../tokenstats.js";
import { agentLedger, agentReadingsFor, agentReadingsStore } from "../agentreadings.js";
import { REPOHEALTH_TIMEOUT_MS, backfillOwnReadings, readRepoHealth, refreshRepoHealth } from "../repohealth.js";
import { approveWithConsent, withApproveToken } from "../repohealthapproval.js";
import { cleanScope, writeScopes } from "../repohealthscopes.js";
import { json, readJson } from "./apiio.js";
import { route, type ApiEntry, type RepoReq } from "./apitable.js";

export const REPO_HEALTH_ROUTES: readonly ApiEntry<RepoReq>[] = [
  // ── The repo-health series: /api/repos/:id/repohealth ──────────────
  //
  // GET reads and spawns only the tool's `status` subcommand, which touches
  // nothing: opening the sheet must not move the series it is about to draw.
  //
  // The refresh is a POST because it spawns and writes (origin.ts: no /api
  // GET may change state), and `capture/run`'s rule applies to its wait — the
  // cap bounds how long the RESPONSE is held, never the run. Past it the run
  // carries on and the answer says `run.state: "running"` with the progress
  // line the tool last printed; a caller told "failed" would be wrong, and a
  // backfill of four hundred commits is exactly the case this happens in.
  //
  // Always 200 with an `ok` field, as `sweep` does. Exit 3 is the tool
  // declining to append to a series measured under two definitions — it ran,
  // it looked, and it said no in four sentences on stderr. A non-2xx would
  // collapse that into the phone's generic error state and lose the only
  // words that say what to run instead.
  //
  // Deliberately NOT in `origin.ts`'s `OPAQUE_READ_ROUTES`: nothing loads
  // either of these outside a transport.
  route<RepoReq>("GET", "repohealth", async ({ res, url, wt }) => {
    // `?scope=apps/ba3-web` reads that subtree's own series instead of the
    // repo's. Validated against the worktree here and again in the engine —
    // two checks and not one, because what this accepts becomes a spawn
    // argument. A scope that does not clean is REFUSED rather than silently
    // read as the repo: answering with the whole tree under a name the
    // caller asked for is the misreading this route exists to avoid.
    const asked = url.searchParams.get("scope");
    const scope = asked ? cleanScope(wt, asked) : null;
    if (asked && !scope) {
      json(res, { ok: false, error: `${asked} is not a directory inside this repo` }, 400);
      return true;
    }
    // `ok: true` on the read as well, so the phone never has to look at a
    // status code to know whether it was told something. A read cannot
    // refuse: an unmeasured repo, a series it could not parse and a repo
    // without the tool are all ANSWERS, and each of them is a different
    // field of the view rather than a failure of the request.
    json(res, { ok: true, ...withApproveToken(wt, await readRepoHealth(wt, {}, scope)) });
    return true;
  }),
  // Which subtrees this repo measures separately. A write, so POST, and the
  // answer is what was actually STORED — a scope the client asked for and
  // this dropped (renamed away, outside the tree, past the cap) is a row it
  // would otherwise keep drawing against a series nobody is measuring.
  // The health score (`healthwatch.ts`): computed from the series file on
  // demand, no engine run — a pure read, so GET.
  // `spend` rides along off the token ledger (a warm read, never a rescan per
  // request); a ledger that fails costs the line, never the score.
  route<RepoReq>("GET", "healthindex", async ({ res, wt }, ctx) => {
    const r = ctx.health ? ctx.health.respond(wt) : { series: null, move: null, words: null, lastRefresh: null, reason: "health index unavailable" };
    let spend;
    try {
      let real = wt;
      try { real = realpathSync(wt); } catch { /* the path as given */ }
      const doc = await ctx.tokenStats.read(5 * 60_000);
      spend = healthSpendWeeks(doc.days, [...new Set([wt, real].map(repoOfWorktree))]);
    } catch { spend = undefined; }
    json(res, spend ? { ...r, spend } : r);
    return true;
  }),
  // Agent readings (`agentreadings.ts`): what only this desktop's conversation
  // logs can say about the repo, weekly. A read of the repo's own logs, swept
  // incrementally (stat, re-read only what moved) — never a full re-scan.
  route<RepoReq>("GET", "agentreadings", async ({ res, wt }, ctx) => {
    let items = null;
    try { items = ctx.backlog.list(); } catch { /* the bug count says it could not be read */ }
    const ledger = await agentLedger(() => ctx.tokenStats.read(5 * 60_000));
    json(res, await agentReadingsFor(agentReadingsStore(ctx.root), wt, items, undefined, undefined, ledger));
    return true;
  }),
  route<RepoReq>("POST", "repohealth/scopes", async ({ req, res, wt }) => {
    const body = await readJson(req) as { scopes?: unknown } | null;
    const asked = Array.isArray(body?.scopes) ? body.scopes : [];
    json(res, { ok: true, scopes: writeScopes(wt, asked) });
    return true;
  }),
  route<RepoReq>("POST", "repohealth/refresh", async ({ req, res, wt }, ctx) => {
    // READ, not merely drained: the body may name a scope, which is the one
    // thing a caller chooses here. It must be consumed either way — a body
    // left unread is still a body, and node answers and then destroys the
    // socket, which the NEXT request on that pooled connection fails on
    // ("other side closed") with nothing in this daemon's log to explain it.
    const body = await readJson(req, { optional: true }) as { scope?: unknown; approveEngine?: unknown; approveToken?: unknown; recut?: unknown } | null;
    // The one tap that lets a repo's OWN committed code run on this desktop —
    // its engine, or the commands its health.json declares. Consent, so it goes
    // through the confirm gate: a browser Origin and the token the read minted.
    if (body?.approveEngine === true) {
      const why = approveWithConsent(req, wt, body.approveToken);
      if (why) {
        json(res, { ok: false, error: why }, 403);
        return true;
      }
    }
    const askedScope = typeof body?.scope === "string" ? body.scope : null;
    const scope = askedScope ? cleanScope(wt, askedScope) : null;
    if (askedScope && !scope) {
      json(res, { ok: false, error: `${askedScope} is not a directory inside this repo` }, 400);
      return true;
    }
    res.setTimeout(REPOHEALTH_TIMEOUT_MS + 30_000);
    // Single-flight lives in `repohealth.ts`, not here: a second tap while a
    // run is in flight JOINS it. Two concurrent `update`s would both append
    // rows for the same shas to an append-only file, permanently.
    // `recut`: the person's tap on the refusal's remedy. The engine MOVES the
    // old series aside (never deletes it) and only when it really holds a
    // different definition — so a stray flag cannot discard a good series.
    const running = refreshRepoHealth(wt, {}, scope, { recut: body?.recut === true }).then(
      (view) => ({ view, error: null as string | null }),
      (err: unknown) => ({ view: null, error: err instanceof Error ? err.message : String(err) }),
    );
    const waited = await Promise.race([
      running,
      new Promise<null>((r) => { setTimeout(() => r(null), REPOHEALTH_TIMEOUT_MS).unref?.(); }),
    ]);
    if (!waited) {
      // The run was NOT called off. The view carries the live run row, whose
      // `note` is the tool's own progress line.
      const view = withApproveToken(wt, await readRepoHealth(wt, {}, scope));
      json(res, {
        ok: false,
        ...view,
        timedOut: true,
        waitedMs: REPOHEALTH_TIMEOUT_MS,
        note: `still running after ${Math.round(REPOHEALTH_TIMEOUT_MS / 1000)}s — it was NOT called off. Ask again for where it got to.`,
      }, 200);
      return true;
    }
    if (!waited.view) {
      json(res, { ok: false, error: waited.error ?? "the repo-health run did not answer" }, 200);
      return true;
    }
    // A repo-level run that finished moves the index: recompute the cache and stamp the refresh.
    if (!scope && waited.view.last?.ok === true) ctx.health?.refreshed(wt);
    json(res, { ok: waited.view.last?.ok === true, ...withApproveToken(wt, waited.view) }, 200);
    return true;
  }),

  // The repo's OWN readings read back over older commits (R-metrics-065). A
  // POST: it spawns, checks commits out into a scratch worktree and rewrites
  // the series file. Refused in words unless the repo's commands are already
  // approved — this route never approves anything (that is the refresh's
  // consent tap). Single-flight with the refresh, in `repohealth.ts`. The
  // only body field is a commit COUNT, clamped to an integer there. Always
  // 200 with `ok`, like the refresh: a refusal is an answer, not a failure.
  route<RepoReq>("POST", "repohealth/own-backfill", async ({ req, res, wt }, ctx) => {
    const body = await readJson(req, { optional: true }) as { commits?: unknown } | null;
    res.setTimeout(REPOHEALTH_TIMEOUT_MS + 30_000);
    let answer;
    try {
      answer = await backfillOwnReadings(wt, typeof body?.commits === "number" ? body.commits : undefined);
    } catch (err) {
      json(res, { ok: false, error: err instanceof Error ? err.message : String(err) }, 200);
      return true;
    }
    // Filled rows can move the index's history: recompute the cache. Not
    // `refreshed` — a backfill measured nothing new, so the weekly clock stays.
    if (answer.ok && (answer.summary?.read ?? 0) > 0) ctx.health?.recompute(wt);
    json(res, answer.view ? { ...answer, view: withApproveToken(wt, answer.view) } : answer, 200);
    return true;
  }),
];
