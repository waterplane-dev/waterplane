/**
 * The repo scope's routes that RUN something in the worktree: the verified
 * capture, the setup checklist and its fixes, the repo-health series, and git
 * review. Relative to `/api/repos/:id/` (the scope in `apirepofiles.ts`
 * resolved the target first). Moved out of `api.ts` (host-architecture.md,
 * "api.ts — the HTTP routes as tables").
 */
import { realpathSync } from "node:fs";
import { extname } from "node:path";
import { healthSpendWeeks, logTag, type SessionInfo } from "@waterplane/shared";
import { repoOfWorktree } from "../tokenstats.js";
import { suggestCommitMessage } from "../commitmsg.js";
import { gitBranches, gitCheckout, gitCommit, gitCreateBranch, gitDeleteBranch, gitBlob, gitDiff, gitPull, gitStage, gitStatus, isSecretFile, pushState, readTextFile, startPush } from "../git.js";
import { gitFetch, gitLog, gitShow } from "../gitlog.js";
import { confirmGate, fixGateRefusal, withFixConfirms } from "../confirmgate.js";
import { checkRepoCompliance, fixRepoCompliance, setCheckIgnored, setRepoContextLimits } from "../compliance.js";
import { inspectOptIns, standingPromptsOf } from "../optins.js";
import { setOptInChoice } from "../setupprefs.js";
import type { OptInChoice, OptInReport, RepoTarget } from "@waterplane/shared";
import { REPOHEALTH_TIMEOUT_MS, readRepoHealth, refreshRepoHealth } from "../repohealth.js";
import { approveWithConsent, withApproveToken } from "../repohealthapproval.js";
import { cleanScope, writeScopes } from "../repohealthscopes.js";
import { removeLeftover, worktreeLeftover, type LeftoverInput } from "../worktreeleftover.js";
import { worktreeOwners } from "../worktreeowner.js";
import { MIME, json, readJson, serveRange, treeFileSecurityHeaders } from "./apiio.js";
import { route, type ApiCtx, type ApiEntry, type RepoReq } from "./apitable.js";

/**
 * How long `POST /api/repos/:id/capture/run` with `{"wait":true}` holds the
 * response open. A settle loop may wait `settleMs` per pass across several
 * viewports, and a cold Playwright launch is seconds on its own.
 *
 * Five minutes is a real number rather than an aspiration: it fits inside
 * Node's default 300 s `requestTimeout` (which covers request RECEIPT, not the
 * response) and this host sets no `server.timeout`. Past it the caller is told
 * the run is STILL RUNNING — never that it failed.
 */
const CAPTURE_WAIT_MS = 5 * 60_000;
/** How often that wait re-reads the run row. Cheap: it is a filter over rows
 *  already in memory. */
const CAPTURE_POLL_MS = 300;
/** A whole side of a text diff is for reading on a phone; past this it is cut, and says so. */
const TEXT_SIDE_MAX = 1024 * 1024;

function leftoverInput(wt: string, branch: string, sessions: SessionInfo[]): LeftoverInput {
  return { wt, branch, sessions, ownerLive: worktreeOwners(sessions).has(wt) };
}

export const REPO_WORK_ROUTES: readonly ApiEntry<RepoReq>[] = [
  // ── Verified capture: POST /api/repos/:id/capture/run ─────────────
  //
  // The agent's trigger, and the one path into `capture.ts` that costs no
  // tokens on the way in: body `{ target, wait? }`, answer the VERDICT LINE.
  // An agent working in this repo asks for the screen it just changed and is
  // handed a sentence, not a PNG — the picture is in `.claude/outbox/` for a
  // person to look at, and the sentence is what the agent reasons over.
  //
  // POST, for `/api/host/screenshot`'s reason exactly: it has a side effect,
  // and a cross-origin GET carries no `Origin` header for the guard to see.
  // Deliberately NOT in `origin.ts`'s `OPAQUE_READ_ROUTES` — that list is for
  // reads the Android shell loads outside a transport (`<img src>`,
  // `<a download>`), and nothing loads this one.
  //
  // `wait` is the only interesting part. Node's `server.requestTimeout`
  // (300 s, the default this host never overrides) bounds receiving the
  // REQUEST, not producing the response — measured, not assumed — and
  // `server.timeout` is 0, so nothing here cuts a slow answer short. The wait
  // is still capped, and `res.setTimeout` is set past that cap so a future
  // global socket timeout could not silently shorten it. When the cap is hit
  // the run is NOT called off and the answer says so, with the real number in
  // it: a caller that concluded "the capture failed" would be wrong, and a
  // promise of five minutes that delivered ninety seconds would be worse.
  route<RepoReq>("POST", "capture/run/*", async ({ req, res, wt }, ctx) => {
    const body = await readJson(req, { optional: true });
    // No `watch` here, deliberately: watch mode runs for up to ten minutes
    // and emits a frame per change, which is the phone's mode. An agent asks
    // for ONE picture of the screen it just changed.
    const started = ctx.capture.run(wt, String(body?.target ?? ""));
    if ("error" in started) return json(res, { ok: false, error: started.error }, 400), true;
    const runId = started.runId;
    if (body?.wait !== true) {
      return json(res, {
        ok: true,
        runId,
        status: started.status,
        waited: false,
        note: `started — the frames and the verdict land in .claude/outbox/capture-*.png and .claude/outbox/capture-*.json. Pass {"wait":true} to be answered with the verdict instead.`,
      }), true;
    }

    res.setTimeout(CAPTURE_WAIT_MS + 30_000);
    let clientGone = false;
    res.on("close", () => { clientGone = true; });
    const deadline = Date.now() + CAPTURE_WAIT_MS;
    let run = started;
    while (Date.now() < deadline && !clientGone) {
      await new Promise((r) => setTimeout(r, CAPTURE_POLL_MS));
      const cur = ctx.capture.runsFor(wt).find((x) => x.runId === runId);
      if (cur) run = cur;
      if (run.status !== "running") break;
    }
    if (clientGone) return true;   // the run carries on; there is nobody to tell
    if (run.status === "running") {
      return json(res, {
        ok: false,
        runId,
        status: "running",
        timedOut: true,
        waitedMs: CAPTURE_WAIT_MS,
        note: `still running after ${Math.round(CAPTURE_WAIT_MS / 60_000)} minutes — it was NOT called off. Its verdict will be written to .claude/outbox/capture-*.json when it settles.`,
      }, 200), true;
    }
    return json(res, {
      ok: run.status === "done",
      runId,
      status: run.status,
      verdict: run.verdict,
      verification: run.verification,
      score: run.score,
      sidecarRelPath: run.sidecarRelPath,
      files: run.files?.map((f) => f.relPath),
    }), true;
  }),

  // ── Setup compliance checklist ─────────────────────────────────────
  // Every route here feeds the sweep's store: opening the sheet or applying a fix
  // is the freshest fact anyone has about this repo, and the row badge must
  // not still claim two issues after you just fixed both.
  route<RepoReq>("GET", "compliance/*", ({ res, rest, target }, ctx) => {
    if (rest[0]) return false;   // the report is `compliance` itself; `compliance/<x>` is a fix, never a GET
    const report = checkRepoCompliance(target);
    ctx.setup.record(target.worktreePath, report.checks, target.repoName);
    json(res, withFixConfirms(target.worktreePath, report));
    return true;
  }),
  route<RepoReq>("POST", "compliance/fix/*", async ({ req, res, target }, ctx) => {
    const { fixes, confirm } = await readJson(req);
    const list = Array.isArray(fixes) ? fixes.map(String) : [];
    // The consent fixes need the phone's confirm, checked HERE (`confirmgate.ts`).
    const refused = fixGateRefusal(req, target.worktreePath, list, confirm);
    if (refused) {
      console.warn(`${logTag} compliance fix refused ${target.repoName} · ${list.join(",")}: ${refused.error}`);
      json(res, { ok: false, applied: [], notes: [], error: refused.error }, refused.status);
      return true;
    }
    const r = fixRepoCompliance(target, list);
    confirmGate.consume(confirm);
    if (r.report) ctx.setup.record(target.worktreePath, r.report.checks, target.repoName);
    json(res, r.report ? { ...r, report: withFixConfirms(target.worktreePath, r.report) } : r, r.ok ? 200 : 400);
    return true;
  }),
  // The context-weight thresholds this repo is measured against. A POST
  // because it writes (see origin.ts: no /api GET may change state), and it
  // answers with the re-run report so the row restates itself against the
  // line just set. `reset` clears the override — going back to the host's
  // line has to be one tap, or nobody will risk the first edit.
  route<RepoReq>("POST", "compliance/limits/*", async ({ req, res, target }, ctx) => {
    const body = await readJson(req);
    const r = setRepoContextLimits(target, body, { reset: body?.reset === true });
    if (r.report) ctx.setup.record(target.worktreePath, r.report.checks, target.repoName);
    json(res, r.report ? { ...r, report: withFixConfirms(target.worktreePath, r.report) } : r, r.ok ? 200 : 400);
    return true;
  }),
  // Ignore one advisory row in this repo (`{ id, ignore: false }` undoes
  // it). A POST because it writes; answers with the re-run report.
  route<RepoReq>("POST", "compliance/ignore/*", async ({ req, res, target }, ctx) => {
    const body = await readJson(req);
    const r = setCheckIgnored(target, String(body?.id ?? ""), body?.ignore !== false);
    if (r.report) ctx.setup.record(target.worktreePath, r.report.checks, target.repoName);
    json(res, r.report ? { ...r, report: withFixConfirms(target.worktreePath, r.report) } : r, r.ok ? 200 : 400);
    return true;
  }),

  // ── Opt-ins: offers, never findings (`optins.ts`) ──────────────────
  // Nothing here touches the setup checklist, its badge or the sweep's store.
  // The mutation is a POST because it writes (origin.ts: no /api GET may change state).
  route<RepoReq>("GET", "optins/*", ({ res, rest, target }, ctx) => {
    if (rest[0]) return false;
    json(res, optInReport(target, ctx));
    return true;
  }),
  route<RepoReq>("POST", "optins/choice/*", async ({ req, res, target }, ctx) => {
    const body = await readJson(req);
    const r = setOptInChoice(target.worktreePath, String(body?.id ?? ""), (body?.choice ?? null) as OptInChoice | null);
    json(res, r.ok ? { ok: true, report: optInReport(target, ctx) } : { ok: false, error: r.error }, r.ok ? 200 : 400);
    return true;
  }),

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
    const body = await readJson(req, { optional: true }) as { scope?: unknown; approveEngine?: unknown; approveToken?: unknown } | null;
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
    const running = refreshRepoHealth(wt, {}, scope).then(
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

  // ── Git review (Tier 3) ───────────────────────────────────────────
  route<RepoReq>("GET", "git/status/*", async ({ res, wt }) => {
    json(res, await gitStatus(wt));
    return true;
  }),
  route<RepoReq>("GET", "git/diff/*", async ({ res, url, wt }) => {
    const p = url.searchParams.get("path") || undefined;
    const staged = url.searchParams.get("staged") === "1";
    json(res, { diff: await gitDiff(wt, { path: p, staged }) });
    return true;
  }),
  // One side of a changed file as bytes (`gitBlob`), for the media a text diff
  // can only call "Binary files differ". Fetched through the transport and
  // shown from a blob URL, so it is NOT an `OPAQUE_READ_ROUTES` entry.
  route<RepoReq>("GET", "git/blob/*", async ({ req, res, url, wt }) => {
    const p = url.searchParams.get("path") || "";
    // Media only: this is the picture beside a diff, not a second file server.
    const mime = MIME[extname(p).toLowerCase()] || "";
    if (!/^(image|video|audio)\//.test(mime)) return json(res, { error: "only images, video and audio are shown this way" }, 415), true;
    const side = url.searchParams.get("side") === "old" ? "old" : "new";
    const buf = await gitBlob(wt, p, side, url.searchParams.get("staged") === "1");
    if (!buf) return json(res, { error: "no such file on that side" }, 404), true;
    serveRange(req, res, buf, mime, { "cache-control": "no-store", ...treeFileSecurityHeaders(mime) });
    return true;
  }),
  // One side of a changed TEXT file, whole — the diff view's "before" / "after"
  // and the side-by-side's full columns. Same sides as `git/blob`, same secret
  // guard (inside `gitBlob`); a binary side is refused, never sent as mojibake.
  route<RepoReq>("GET", "git/text/*", async ({ res, url, wt }) => {
    const p = url.searchParams.get("path") || "";
    if (isSecretFile(p)) {
      return json(res, { error: "this app doesn't display .env files — see the secrets sheet" }, 403), true;
    }
    const side = url.searchParams.get("side") === "old" ? "old" : "new";
    const buf = await gitBlob(wt, p, side, url.searchParams.get("staged") === "1");
    if (!buf) return json(res, { error: "no such file on that side" }, 404), true;
    if (buf.includes(0)) return json(res, { error: "binary file — no text to show" }, 415), true;
    const cut = buf.length > TEXT_SIDE_MAX;
    json(res, { body: (cut ? buf.subarray(0, TEXT_SIDE_MAX) : buf).toString("utf8"), truncated: cut });
    return true;
  }),
  route<RepoReq>("GET", "git/file/*", async ({ res, url, wt }) => {
    const p = url.searchParams.get("path") || "";
    if (isSecretFile(p)) {
      return json(res, { error: "this app doesn't display .env files — see the secrets sheet" }, 403), true;
    }
    const body = await readTextFile(wt, p);
    if (body == null) return json(res, { error: "not found or binary" }, 404), true;
    json(res, { path: p, body });
    return true;
  }),
  route<RepoReq>("POST", "git/stage/*", async ({ req, res, wt }) => {
    const { path: p, unstage } = await readJson(req);
    json(res, await gitStage(wt, String(p || ""), !!unstage));
    return true;
  }),
  route<RepoReq>("POST", "git/commit/*", async ({ req, res, wt }) => {
    const { message, all } = await readJson(req);
    const r = await gitCommit(wt, String(message || ""), all !== false);
    json(res, r, r.ok ? 200 : 400);
    return true;
  }),
  // POST, and not because it writes anything — it writes nothing at all.
  // It SPENDS (one headless model call), and `origin.ts`'s rule is that no
  // /api GET may have an effect; a cross-origin `<img src>` must not be
  // able to run up a bill either.
  route<RepoReq>("POST", "git/message/*", async ({ res, wt }) => {
    json(res, await suggestCommitMessage(wt));
    return true;
  }),
  // A pull is seconds (a fetch and a fast-forward or rebase, no hook), so it
  // is one held request, not a job like the push below.
  route<RepoReq>("POST", "git/pull/*", async ({ res, wt }) => {
    const r = await gitPull(wt);
    json(res, r, r.ok ? 200 : 400);
    return true;
  }),
  // `{ background: true }` starts the push (or joins the running one) and
  // answers at once with its state; the phone then asks GET until it ends.
  // Without it the request is held open until the push ends — what a bundle
  // from before the job asks for, and it waits on the SAME job.
  route<RepoReq>("POST", "git/push/*", async ({ req, res, wt }) => {
    const body = await readJson(req, { optional: true }) as { background?: unknown } | null;
    const job = startPush(wt);
    if (body?.background === true) { json(res, pushState(wt)); return true; }
    const r = await job.done;
    json(res, r, r.ok ? 200 : 400);
    return true;
  }),
  route<RepoReq>("GET", "git/push/*", async ({ res, wt }) => {
    json(res, { push: pushState(wt) });
    return true;
  }),
  // The branch against its upstream: incoming, outgoing, shared history.
  route<RepoReq>("GET", "git/log/*", async ({ res, wt }) => {
    json(res, await gitLog(wt));
    return true;
  }),
  route<RepoReq>("GET", "git/show/*", async ({ res, url, wt }) => {
    const body = await gitShow(wt, url.searchParams.get("sha") || "");
    if (body == null) return json(res, { error: "no such commit" }, 404), true;
    json(res, { body });
    return true;
  }),
  // POST: it moves remote-tracking refs (never the branch or the tree).
  route<RepoReq>("POST", "git/fetch/*", async ({ res, wt }) => {
    const r = await gitFetch(wt);
    json(res, r, r.ok ? 200 : 400);
    return true;
  }),
  route<RepoReq>("GET", "git/branches/*", async ({ res, wt }) => {
    json(res, { branches: await gitBranches(wt) });
    return true;
  }),
  route<RepoReq>("POST", "git/checkout/*", async ({ req, res, wt }) => {
    const { branch } = await readJson(req);
    const r = await gitCheckout(wt, String(branch || ""));
    json(res, r, r.ok ? 200 : 400);
    return true;
  }),
  route<RepoReq>("POST", "git/branch/*", async ({ req, res, wt }) => {
    const { name, from, checkout } = await readJson(req);
    const r = await gitCreateBranch(wt, String(name || ""), { from: from ? String(from) : undefined, checkout: checkout !== false });
    json(res, r, r.ok ? 200 : 400);
    return true;
  }),
  route<RepoReq>("DELETE", "git/branch/*", async ({ req, res, wt }) => {
    const { name, force } = await readJson(req);
    const r = await gitDeleteBranch(wt, String(name || ""), !!force);
    json(res, r, r.ok ? 200 : 400);
    return true;
  }),

  // ── A worktree nobody is using: can it go, and remove it ──────────
  //
  // The read is what the launcher shows under a worktree with no session; the
  // remove re-derives it and refuses on any blocker (`worktreeleftover.ts`).
  // Never for the primary checkout. POST, because it deletes.
  route<RepoReq>("GET", "worktree/leftover", async ({ res, target, wt }, ctx) => {
    if (target.isPrimary) { json(res, { error: "This is the repo's main checkout, not a worktree." }, 400); return true; }
    try {
      json(res, await worktreeLeftover(leftoverInput(wt, target.branch, ctx.sessions.list())));
    } catch (err) {
      json(res, { error: `Could not check the worktree: ${(err as Error).message}` }, 500);
    }
    return true;
  }),
  route<RepoReq>("POST", "worktree/remove", async ({ res, target, wt }, ctx) => {
    if (target.isPrimary) { json(res, { ok: false, error: "This is the repo's main checkout, not a worktree." }, 400); return true; }
    const r = await removeLeftover(leftoverInput(wt, target.branch, ctx.sessions.list()));
    if (r.ok) console.log(`${logTag} worktree removed ${wt} (${target.branch}${r.branchDeleted ? ", branch deleted" : ""})`);
    json(res, r, r.ok ? 200 : 409);
    return true;
  }),
];

function optInReport(target: RepoTarget, ctx: ApiCtx): OptInReport {
  const rows = inspectOptIns(target.worktreePath, {
    standingPrompts: (wt) => { try { return standingPromptsOf(ctx.intents.list(), wt); } catch { return null; } },
  });
  return { repoId: target.id, repoName: target.repoName, rows, checkedAt: Date.now() };
}
