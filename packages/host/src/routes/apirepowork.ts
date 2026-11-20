/**
 * The repo scope's routes that RUN something in the worktree: the verified
 * capture, the setup checklist and its fixes, and git review (the repo-health
 * series and the readings beside it are `apirepohealth.ts`). Relative to `/api/repos/:id/` (the scope in `apirepofiles.ts`
 * resolved the target first). Moved out of `api.ts` (host-architecture.md,
 * "api.ts — the HTTP routes as tables").
 */
import { extname } from "node:path";
import { logTag, type SessionInfo } from "@waterplane/shared";
import { cachedBranchRules } from "../branchrules.js";
import { gitBranches, gitCheckout, gitCommit, gitCreateBranch, gitDeleteBranch, gitBlob, gitDiff, gitPull, gitStage, gitStatus, isSecretFile, pushState, readTextFile, startPush, type GitRepoRef } from "../git.js";
import { gitFetch, gitLog, gitShow } from "../gitlog.js";
import { FIX_SCOPE, confirmGate, fixBind, fixGateRefusal, gateRefusal, withFixConfirms } from "../confirmgate.js";
import { efficiencyState, isEfficiencyTarget, writeEfficiencyRules } from "../efficiencywrite.js";
import { invalidateSetupCheck } from "../setupcheck/store.js";
import { fixRepoCompliance, setCheckAccepted, setCheckIgnored, setCheckTriaged, setRepoContextLimits } from "../compliance.js";
import { inspectOptIns, optInSightings, standingPromptsOf } from "../optins.js";
import { setOptInChoice } from "../setupprefs.js";
import type { ComplianceReport, OptInChoice, OptInReport, RepoTarget } from "@waterplane/shared";
import { removeLeftover, worktreeLeftover, WorktreeGone, type LeftoverInput } from "../worktreeleftover.js";
import { worktreeOwners } from "../worktreeowner.js";
import { MIME, json, readJson, serveRange, treeFileSecurityHeaders } from "./apiio.js";
import { route, type ApiCtx, type ApiEntry, type RepoReq } from "./apitable.js";
import { joinAndWait, recordSetupWrite } from "./apijobs.js";

/** A whole side of a text diff is for reading on a phone; past this it is cut, and says so. */
const TEXT_SIDE_MAX = 1024 * 1024;
/** The `CONFIRM_GATED_FIXES` id the efficiency-rules write is confirmed under. */
const EFFICIENCY_FIX = "efficiency-rules";

function leftoverInput(wt: string, branch: string, sessions: SessionInfo[]): LeftoverInput {
  return { wt, branch, sessions, ownerLive: worktreeOwners(sessions).has(wt) };
}

/** The repo a git run is filed under: the worktree's own id (a worktree is
 *  its own chip), named the way a person tells it apart — the repo, plus the
 *  branch for a linked worktree. */
export function gitRef(t: RepoTarget): GitRepoRef {
  return { id: t.id, name: t.isPrimary ? t.repoName : `${t.repoName} (${t.branch})`, branch: t.branch };
}

/** A POST that changes one setup check; answers with `{ ok, report?, error? }`, the report re-run and recorded. */
function checkWrite<R extends { ok: boolean; report?: ComplianceReport }>(path: string, set: (t: RepoTarget, body: any) => R): ApiEntry<RepoReq> {
  return route<RepoReq>("POST", path, async ({ req, res, target }, ctx) => {
    const r = set(target, await readJson(req));
    recordSetupWrite(ctx, target, r.report);
    // A limit, an ignore, an accept or a triage changes what the Setup check reads: never serve the old finding.
    if (r.ok) invalidateSetupCheck();
    json(res, r.report ? { ...r, report: withFixConfirms(target.worktreePath, r.report) } : r, r.ok ? 200 : 400);
    return true;
  });
}

export const REPO_WORK_ROUTES: readonly ApiEntry<RepoReq>[] = [
  // ── Setup compliance checklist ─────────────────────────────────────
  // Every route here feeds the sweep's store: opening the sheet or applying a fix
  // is the freshest fact anyone has about this repo, and the row badge must
  // not still claim two issues after you just fixed both.
  // Joins the `setup.check` slow job (`apijobs.ts`: walks off the event loop, recorded there).
  route<RepoReq>("GET", "compliance/*", async (r, ctx) => {
    if (r.rest[0]) return false;   // the report is `compliance` itself; `compliance/<x>` is a fix, never a GET
    json(r.res, withFixConfirms(r.wt, await joinAndWait<ComplianceReport>(r, ctx, "setup.check")));
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
    invalidateSetupCheck();
    recordSetupWrite(ctx, target, r.report);
    json(res, r.report ? { ...r, report: withFixConfirms(target.worktreePath, r.report) } : r, r.ok ? 200 : 400);
    return true;
  }),
  // The context-weight thresholds this repo is measured against. A POST
  // because it writes (see origin.ts: no /api GET may change state), and it
  // answers with the re-run report so the row restates itself against the
  // line just set. `reset` clears the override — going back to the host's
  // line has to be one tap, or nobody will risk the first edit.
  checkWrite("compliance/limits/*", (t, b) => setRepoContextLimits(t, b, { reset: b?.reset === true })),
  // Ignore one advisory row in this repo (`{ id, ignore: false }` undoes
  // it). A POST because it writes; answers with the re-run report.
  checkWrite("compliance/ignore/*", (t, b) => setCheckIgnored(t, String(b?.id ?? ""), b?.ignore !== false)),
  // Accept (or stop accepting) one exposure finding (`exposure.ts`): body is a
  // ComplianceAcceptRequest; answers with the re-run report like the ignore above.
  checkWrite("compliance/accept/*", setCheckAccepted),

  // Mark one exposure finding / crash group seen, investigating or fixed (`{ id, state, fixedIn?, commit?, note?, clear? }`);
  // by = the person. Answers with the re-run report like accept.
  checkWrite("compliance/triage/*", setCheckTriaged),

  // ── Opt-ins: offers, never findings (`optins.ts`) ──────────────────
  // Nothing here touches the setup checklist, its badge or the sweep's store.
  // The mutation is a POST because it writes (origin.ts: no /api GET may change state).
  route<RepoReq>("GET", "optins/*", async ({ res, rest, target }, ctx) => {
    if (rest[0]) return false;
    json(res, await optInReport(target, ctx));
    return true;
  }),
  route<RepoReq>("POST", "optins/choice/*", async ({ req, res, target }, ctx) => {
    const body = await readJson(req);
    const r = setOptInChoice(target.worktreePath, String(body?.id ?? ""), (body?.choice ?? null) as OptInChoice | null);
    json(res, r.ok ? { ok: true, report: await optInReport(target, ctx) } : { ok: false, error: r.error }, r.ok ? 200 : 400);
    return true;
  }),

  // The generic efficiency rules into the repo's own CLAUDE.md or AGENTS.md (`efficiencywrite.ts`).
  // The GET draws the confirm and mints its one-shot token, allowed only for the files a write
  // would change; the POST is the second tap (`confirmgate.ts`) and never commits.
  route<RepoReq>("GET", "efficiencyrules", ({ res, wt }) => {
    const doc = efficiencyState(wt);
    const writable = doc.targets.filter((t) => t.plan === "append" || t.plan === "replace").map((t) => t.target);
    json(res, { ok: true, ...doc, ...(writable.length ? { confirm: confirmGate.mint(FIX_SCOPE, fixBind(wt, EFFICIENCY_FIX), writable) } : {}) });
    return true;
  }),
  route<RepoReq>("POST", "efficiencyrules", async ({ req, res, wt, target }) => {
    const body = await readJson(req);
    const file = body?.target;
    if (!isEfficiencyTarget(file)) { json(res, { ok: false, error: "choose CLAUDE.md or AGENTS.md — nothing was written" }, 400); return true; }
    const refused = gateRefusal(req, body?.confirm, FIX_SCOPE, fixBind(wt, EFFICIENCY_FIX), [file]);
    if (refused) {
      console.warn(`${logTag} efficiency rules refused ${target.repoName} · ${file}: ${refused}`);
      json(res, { ok: false, error: `${refused} — nothing was written` }, 403);
      return true;
    }
    const r = writeEfficiencyRules(wt, file, typeof body?.baseSha === "string" ? body.baseSha : "\0");
    if (r.ok) {
      confirmGate.consume(body?.confirm);
      if (r.written) invalidateSetupCheck();
      if (r.written) console.log(`${logTag} efficiency rules ${r.plan === "append" ? "added to" : "updated in"} ${target.repoName}/${file}`);
      json(res, { ...r, state: efficiencyState(wt) });
    } else {
      json(res, r, r.code === "stale" ? 409 : r.code === "refused" ? 400 : 500);
    }
    return true;
  }),

  // ── Git review (Tier 3) ───────────────────────────────────────────
  route<RepoReq>("GET", "git/status/*", async ({ res, wt }) => {
    const status = await gitStatus(wt);
    const branchRules = cachedBranchRules(wt);
    json(res, branchRules ? { ...status, branchRules } : status);
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
  // A pull is seconds (a fetch and a fast-forward or rebase, no hook), so it
  // is one held request, not a job like the push below.
  // Both report their outcome (`gitRef`): a failure is a notification and the
  // repo's red chip until the next success of that verb (`gitnotify.ts`).
  route<RepoReq>("POST", "git/pull/*", async ({ res, wt, target }) => {
    const r = await gitPull(wt, gitRef(target));
    json(res, r, r.ok ? 200 : 400);
    return true;
  }),
  // `{ background: true }` starts the push (or joins the running one) and
  // answers at once with its state; the phone then asks GET until it ends.
  // Without it the request is held open until the push ends — what a bundle
  // from before the job asks for, and it waits on the SAME job.
  route<RepoReq>("POST", "git/push/*", async ({ req, res, wt, target }) => {
    const body = await readJson(req, { optional: true }) as { background?: unknown } | null;
    const job = startPush(wt, gitRef(target));
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
      if (err instanceof WorktreeGone) { json(res, { error: err.message }, 410); return true; }
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

async function optInReport(target: RepoTarget, ctx: ApiCtx): Promise<OptInReport> {
  const rows = await inspectOptIns(target.worktreePath, {
    standingPrompts: (wt) => { try { return standingPromptsOf(ctx.intents.list(), wt); } catch { return null; } },
    sightings: (wt) => optInSightings(wt, ctx.intents.list(), ctx.sessions.list().map((s) => ({ cwd: s.cwd, history: ctx.sessions.getHistory(s.id) }))),
  });
  return { repoId: target.id, repoName: target.repoName, rows, checkedAt: Date.now() };
}
