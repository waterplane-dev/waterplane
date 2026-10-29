/**
 * The person's open pull requests, and the actions on them (the PR card, P3).
 *
 * EVERY forge call of this module goes through `forge/` (`forgeOrGh`), never `gh`
 * directly. Git calls are `git()`.
 *
 * The list is polled ONLY while a client holds a LEASE on the repo
 * (`localrt.ts`'s model: no socket-close hook here, so a watcher that stops
 * renewing lapses by itself — the phone renews every ~30 s, a lease lasts 60 s,
 * the poll stops with the last watcher). A request never runs `gh pr list`: it is
 * answered from the cache the poll keeps. The actions (merge, auto-merge, close,
 * failing log) are one explicit POST each, from a tap, and run `gh` once.
 *
 * Notifications (checks failed / changes requested / merged or closed off the
 * phone) are raised from the poll, so they exist ONLY while somebody is looking
 * at the card — by design: a background poller per repo is a cost nobody asked for.
 * They go through the same `notify("git", …)` path, so the push prefs gate them.
 */
import { actionsRunId, prChanges, prViewsFrom, type BranchRules, type PrActionResult, type PrListDoc, type PullRequestView } from "@waterplane/shared";
import { branchRules, cachedBranchRules } from "./branchrules.js";
import { env } from "./env.js";
import { gitDeleteBranch, gitPull, type GitRepoRef } from "./git.js";
import type { NotifyParams } from "./notifytypes.js";
import { dueWatchers } from "./localrt.js";
import { execFileP } from "./proc.js";
import { forgeOrGh, type MergeMethod } from "./forge/index.js";

const NO_PROMPT = { ...process.env, GIT_TERMINAL_PROMPT: "0", GH_PROMPT_DISABLED: "1" };
const git = (wt: string, args: string[]) => execFileP("git", args, { cwd: wt, timeout: 60_000, env: NO_PROMPT, maxBuffer: 4 * 1024 * 1024 });
const msg = (e: unknown) => String((e as { stderr?: string }).stderr || (e as Error)?.message || e).trim().split("\n").slice(-3).join(" ");

// ── timing ───────────────────────────────────────────────────────────────
export let LEASE_MS = 60_000;
let pollMs = (() => { const n = Number(env("PRS_POLL_MS")); return Number.isFinite(n) && n > 0 ? Math.max(5_000, n) : 20_000; })();
/** Test seam: shorten the lease / poll period (no floor). */
export function setPrTiming(t: { leaseMs?: number; pollMs?: number }): void {
  if (t.leaseMs !== undefined) LEASE_MS = t.leaseMs;
  if (t.pollMs !== undefined) pollMs = t.pollMs;
}

/** Test seam: replace (null restores) how branch rules are read (a fake forge has no `gh api`). */
type RulesLookup = (wt: string) => Promise<BranchRules | undefined>;
let rulesLookup: RulesLookup | null = null;
export function setPrRules(fn: RulesLookup | null): void { rulesLookup = fn; }
const rulesOf = (wt: string) => (rulesLookup ? rulesLookup(wt) : branchRules(wt));

// ── notifications ────────────────────────────────────────────────────────
export interface PrNotifyDeps {
  notify(kind: "git", p: NotifyParams): void;
  resolveAttention(key: string, note: string): number;
}
let deps: PrNotifyDeps | null = null;
export function setPrNotify(d: PrNotifyDeps | null): void { deps = d; }
const prKey = (repoId: string, n: number) => `pr:${repoId}:${n}`;

// ── per-worktree state ───────────────────────────────────────────────────
interface Watch {
  holders: Map<string, number>;
  ref?: GitRepoRef;
  timer?: ReturnType<typeof setTimeout>;
  doc: PrListDoc;
  /** Last list the poll itself saw; reset when polling stops so a gap never diffs. */
  prev?: PullRequestView[];
  running?: Promise<void>;
  /** PRs this host just merged/closed on a tap: their disappearance is not news. */
  ours: Set<number>;
}
const watches = new Map<string, Watch>();
const watchOf = (wt: string): Watch => {
  let w = watches.get(wt);
  if (!w) { w = { holders: new Map(), doc: {}, ours: new Set() }; watches.set(wt, w); }
  return w;
};

/** Is anything polling this worktree right now? (tests, diagnostics) */
export function prsPolling(wt: string): boolean { return !!watches.get(wt)?.timer; }

/** The cached reading: never runs `gh`. */
export function cachedPrs(wt: string): PrListDoc { return watches.get(wt)?.doc ?? {}; }

/** One `gh pr list`. Failure of any kind is ABSENT (undefined) with a sentence. */
export async function listPrs(wt: string, rules?: BranchRules): Promise<{ prs?: PullRequestView[]; why?: string }> {
  try {
    const raw = await (await forgeOrGh(wt)).listPrs();
    return { prs: prViewsFrom(raw, rules ?? (rulesLookup ? await rulesLookup(wt) : cachedBranchRules(wt))) };
  } catch (e) {
    const t = msg(e);
    return { why: /ENOENT/.test(t) ? "gh is not installed on this desktop" : `gh could not list pull requests: ${t.slice(0, 160)}` };
  }
}

async function pollOnce(wt: string, w: Watch): Promise<void> {
  // Direct or unread rules: no `gh` call at all — a direct repo's git view costs nothing new.
  const rules = rulesLookup ? await rulesLookup(wt) : cachedBranchRules(wt);
  if (!rules || rules.mode === "direct") { w.doc = {}; w.prev = undefined; return; }
  const r = await listPrs(wt, rules);
  if (!r.prs) {
    // Keep the last good list (it says when it is from); say why the refresh failed.
    w.doc = w.doc.prs ? { ...w.doc, why: r.why } : { why: r.why };
    return;
  }
  const changes = prChanges(w.prev, r.prs);
  w.prev = r.prs;
  w.doc = { prs: r.prs, at: Date.now() };
  for (const c of changes) {
    if (c.kind === "gone") { if (w.ours.delete(c.number)) continue; await goneNews(wt, w, c.number, c.title); continue; }
    if (!deps || !w.ref) continue;
    const key = prKey(w.ref.id, c.number);
    deps.notify("git", {
      title: `${c.kind === "checks-failed" ? "Check failed" : "Changes requested"} · PR #${c.number}`,
      body: c.kind === "checks-failed" ? `${c.detail ?? "A check"} failed on ${c.title}` : `A reviewer asked for changes on ${c.title}`,
      outcome: "failed", key, tag: `pr-${w.ref.id}-${c.number}`, open: { to: "git", repoId: w.ref.id },
    });
  }
}

async function goneNews(wt: string, w: Watch, number: number, title: string): Promise<void> {
  if (!deps || !w.ref) return;
  let state = "";
  try { state = await (await forgeOrGh(wt)).prState(number); } catch { /* worded below */ }
  const word = state === "MERGED" ? "merged" : state === "CLOSED" ? "closed" : "no longer open";
  const key = prKey(w.ref.id, number);
  deps.resolveAttention(key, `PR #${number} was ${word}`);
  deps.notify("git", {
    title: `PR #${number} ${word} · ${w.ref.name}`, body: title,
    outcome: "ok", tag: `pr-${w.ref.id}-${number}`, open: { to: "git", repoId: w.ref.id },
  });
}

function tick(wt: string): void {
  const w = watches.get(wt);
  if (!w) return;
  w.timer = undefined;
  const { live, lapsed } = dueWatchers([...w.holders].map(([h, until]) => [h, { until, open: true }] as const), Date.now());
  for (const h of lapsed) w.holders.delete(h);
  if (live.length === 0) { w.prev = undefined; return; } // stops with its last watcher
  w.running = pollOnce(wt, w).catch(() => undefined).finally(() => {
    w.running = undefined;
    if (w.holders.size > 0 && !w.timer) { w.timer = setTimeout(() => tick(wt), pollMs); w.timer.unref?.(); }
  });
}

/**
 * Take (or renew) a lease. The first lease of a worktree polls at once; the
 * answer is whatever is cached NOW (the phone asks again, or the next frame of
 * its renewal carries the fresh list) — a request never waits on `gh`.
 */
export function leasePrs(wt: string, holder: string, ref?: GitRepoRef): PrListDoc {
  const w = watchOf(wt);
  if (ref) w.ref = ref;
  w.holders.set(holder, Date.now() + LEASE_MS);
  if (!w.timer && !w.running) tick(wt);
  return w.doc;
}

/** Drop everything (tests). */
export function stopAllPrs(): void {
  for (const w of watches.values()) if (w.timer) clearTimeout(w.timer);
  watches.clear();
}

// ── actions ──────────────────────────────────────────────────────────────
const isNum = (n: unknown): n is number => typeof n === "number" && Number.isInteger(n) && n > 0;
const METHOD_FLAG = { merge: 1, squash: 1, rebase: 1 } as const;
type Method = MergeMethod;
const bad = (error: string): PrActionResult => ({ ok: false, error });
const afterAction = (wt: string, n: number, ours: boolean) => {
  const w = watches.get(wt);
  if (w && ours && w.holders.size > 0) w.ours.add(n);
  // Refresh now so the card is not a poll behind the tap (only while somebody watches).
  if (w && w.holders.size > 0 && !w.running) { w.running = pollOnce(wt, w).catch(() => undefined).finally(() => { w.running = undefined; }); }
};

export async function mergePr(wt: string, body: { number?: unknown; method?: unknown }): Promise<PrActionResult> {
  if (!isNum(body.number)) return bad("Which pull request? (number missing)");
  const n = body.number;
  const rules = await rulesOf(wt);
  let method: Method | undefined;
  if (body.method !== undefined) {
    if (typeof body.method !== "string" || !Object.hasOwn(METHOD_FLAG, body.method)) return bad("Merge method must be merge, squash or rebase.");
    method = body.method as Method;
    if (rules?.allowedMerge.length && !rules.allowedMerge.includes(method)) return bad(`This repo does not allow a ${method} merge — it allows ${rules.allowedMerge.join(", ")}.`);
  } else method = rules?.allowedMerge[0];
  let head = "", base = "";
  try {
    const v = await (await forgeOrGh(wt)).prInfo(n);
    head = String(v?.headRefName ?? ""); base = String(v?.baseRefName ?? "");
    if (v?.state && v.state !== "OPEN") return bad(`PR #${n} is ${String(v.state).toLowerCase()}, not open.`);
  } catch (e) { return bad(`Could not read PR #${n}: ${msg(e)}`); }
  try {
    await (await forgeOrGh(wt)).merge(n, method);
  } catch (e) { return bad(`GitHub did not merge PR #${n}: ${msg(e)}`); }
  afterAction(wt, n, true);
  return { ok: true, output: await tidyAfterMerge(wt, n, method ?? "merge", head, base) };
}

/** Pull the base branch if checked out, delete the head branch locally and on origin; say what was and was not done. */
async function tidyAfterMerge(wt: string, n: number, method: string, head: string, base: string): Promise<string> {
  const did: string[] = [`Merged PR #${n} (${method}).`];
  const not: string[] = [];
  let cur = "";
  try { cur = (await git(wt, ["rev-parse", "--abbrev-ref", "HEAD"])).stdout.trim(); } catch { /* unknown */ }
  if (!base) not.push("did not pull (the base branch is unknown)");
  else if (cur !== base) not.push(`did not pull ${base} (this checkout is on ${cur || "no branch"})`);
  else {
    const p = await gitPull(wt);
    if (p.ok) did.push(`Pulled ${base}.`); else not.push(`did not pull ${base}: ${(p.error ?? "").split("\n")[0]}`);
  }
  const safeRef = head && head !== base && /^[A-Za-z0-9._][A-Za-z0-9._/-]*$/.test(head) && !head.includes("..");
  if (!safeRef) { not.push(head ? `kept branch ${head}` : "did not delete the branch (its name is unknown)"); }
  else {
    if (cur === head) not.push(`kept local branch ${head} (it is checked out)`);
    else {
      const d = await gitDeleteBranch(wt, head);
      if (d.ok) did.push(`Deleted local branch ${head}.`);
      else if (/not found|did not match/i.test(d.error ?? "")) did.push(`Local branch ${head} was already gone.`);
      else not.push(`kept local branch ${head} (git says it is not fully merged here — a squash merge looks like that; delete it yourself if you are sure)`);
    }
    try {
      await git(wt, ["push", "origin", "--delete", `refs/heads/${head}`]);
      did.push(`Deleted ${head} on origin.`);
    } catch (e) {
      if (/remote ref does not exist|unable to delete|already|not found/i.test(msg(e))) did.push(`${head} was already gone on origin.`);
      else not.push(`kept ${head} on origin: ${msg(e).slice(0, 120)}`);
    }
  }
  return not.length ? `${did.join(" ")} Not done: ${not.join("; ")}.` : did.join(" ");
}

export async function autoMergePr(wt: string, body: { number?: unknown; on?: unknown; method?: unknown }): Promise<PrActionResult> {
  if (!isNum(body.number)) return bad("Which pull request? (number missing)");
  if (typeof body.on !== "boolean") return bad("Say whether auto-merge goes on or off.");
  const n = body.number;
  if (!body.on) {
    try { await (await forgeOrGh(wt)).autoMerge(n, false); } catch (e) { return bad(`Could not switch auto-merge off for PR #${n}: ${msg(e)}`); }
    afterAction(wt, n, false);
    return { ok: true, output: `Auto-merge is off for PR #${n}.` };
  }
  const rules = await rulesOf(wt);
  if (rules && !rules.autoMerge) return bad("This repo does not allow auto-merge. Turn on \"Allow auto-merge\" in the repo's GitHub settings, or merge by hand when the checks are green.");
  const method: Method | undefined = typeof body.method === "string" && body.method in METHOD_FLAG ? (body.method as Method) : rules?.allowedMerge[0];
  try { await (await forgeOrGh(wt)).autoMerge(n, true, method); } catch (e) { return bad(`Could not switch auto-merge on for PR #${n}: ${msg(e)}`); }
  afterAction(wt, n, false);
  return { ok: true, output: `Auto-merge is on for PR #${n}: it merges once its checks and reviews allow. Nothing else changes until then.` };
}

export async function closePr(wt: string, body: { number?: unknown }): Promise<PrActionResult> {
  if (!isNum(body.number)) return bad("Which pull request? (number missing)");
  try { await (await forgeOrGh(wt)).close(body.number); } catch (e) { return bad(`Could not close PR #${body.number}: ${msg(e)}`); }
  afterAction(wt, body.number, true);
  return { ok: true, output: `Closed PR #${body.number}. Its branch was left alone.` };
}

const TAIL_LINES = 80;
const ANSI = /\u001b\[[0-9;?]*[ -/]*[@-~]/g;

/** The tail of the failing check's Actions log, or the check's own page when it is not an Actions run. */
export async function failingLog(wt: string, body: { number?: unknown; check?: unknown }): Promise<PrActionResult> {
  if (!isNum(body.number)) return bad("Which pull request? (number missing)");
  const n = body.number;
  let pr = (watches.get(wt)?.doc.prs ?? []).find((p) => p.number === n);
  if (!pr) pr = (await listPrs(wt)).prs?.find((p) => p.number === n);
  if (!pr) return bad(`PR #${n} is not in your open list.`);
  const failed = pr.checks.filter((c) => c.state === "failed");
  const check = (typeof body.check === "string" ? failed.find((c) => c.name === body.check) : undefined) ?? failed[0];
  if (!check) return bad(`No check has failed on PR #${n}.`);
  const runId = actionsRunId(check.url);
  if (!runId) return { ok: true, url: check.url, output: `${check.name} is not a GitHub Actions run, so there is no log to show here.${check.url ? " Open its page." : ""}` };
  try {
    const stdout = await (await forgeOrGh(wt)).checksLog(runId);
    const lines = stdout.replace(ANSI, "").split("\n").filter((l, i, a) => l.trim() || i < a.length - 1);
    if (!lines.length) return { ok: true, url: check.url, output: `${check.name}: the run has no failed-step log yet.` };
    return { ok: true, url: check.url, output: lines.slice(-TAIL_LINES).join("\n") };
  } catch (e) {
    return { ok: true, url: check.url, output: `${check.name}: gh could not fetch the log (${msg(e).slice(0, 120)}).${check.url ? " Open its page." : ""}` };
  }
}
