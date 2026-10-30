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
 *
 * A MERGE'S OUTCOME IS OWNED BY THE READINGS, never by the merge call returning. GitHub may report
 * the merge late (a lagging read), only enqueue it (a merge queue), or merge it after the host's gh
 * gave up waiting. So a merge the person asked for is a RECORD on the watch (`asked`), and whichever
 * read first sees MERGED — the one right after the call, or any later poll — runs `tidyAfterMerge`
 * exactly once (`settleMerged`: the claim is synchronous, the second reader awaits the first's receipt).
 * The "merged off the phone" notice is not sent; instead a tidy no tap is waiting for is said as its
 * own notice carrying the receipt (`tidyNews`), and a tidy that left something needing the person
 * is filed as attention whether or not a tap is waiting.
 * CLOSED-not-merged, or an OPEN record ageing out, drops it and lets the normal notice through.
 * Records are kept on disk (`prmergestore.ts`), so a restart — frequent here — does not turn a
 * queued merge back into somebody else's news.
 */
import { actionsRunId, prAttentionKey, prChanges, prViewsFrom, type BranchRules, type PrActionResult, type PrListDoc, type PullRequestView } from "@waterplane/shared";
import { branchRules, cachedBranchRules } from "./branchrules.js";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { env, ROOT, STATE_DIR } from "./env.js";
import { gitDeleteBranch, gitPull, gitRemoteUrl, type GitRepoRef } from "./git.js";
import { discoverTargets } from "./repos.js";
import type { NotifyParams } from "./notifytypes.js";
import { dueWatchers } from "./localrt.js";
import { execFileP } from "./proc.js";
import { forgeOrGh, type MergeMethod } from "./forge/index.js";
import { loadAskedMerges, originKey, rehomeTarget, saveAskedMerges } from "./prmergestore.js";

const NO_PROMPT = { ...process.env, GIT_TERMINAL_PROMPT: "0", GH_PROMPT_DISABLED: "1" };
const git = (wt: string, args: string[]) => execFileP("git", args, { cwd: wt, timeout: 60_000, env: NO_PROMPT, maxBuffer: 4 * 1024 * 1024 });
const msg = (e: unknown) => String((e as { stderr?: string }).stderr || (e as Error)?.message || e).trim().split("\n").slice(-3).join(" ");

// ── timing ───────────────────────────────────────────────────────────────
export let LEASE_MS = 60_000;
/**
 * How long a merge the person asked for is awaited. A queue normally lands within hours; a PR the queue
 * ejected stays open, and past a day a later merge is somebody's new decision, so it is news again and
 * its branches are not tidied for the person.
 */
let askedMs = 24 * 3600_000;
/**
 * No record outlives this many bounds (a week), whatever a reading would say: an unreadable state is
 * let go, and a MERGED first read after it is no longer assumed the person's — without the merge time
 * the host cannot tell their queued merge from somebody's later one. One bound for a running host
 * (`settleAsked`) and for the file read back after a restart (`loadAsked`), so a restart neither keeps
 * nor loses more than staying up would; it also bounds a record no poll ever reads (nobody opened the card).
 */
const UNREAD_BOUND = 7;
const expired = (rec: { at: number }): boolean => Date.now() - rec.at > askedMs * UNREAD_BOUND;
let pollMs = (() => { const n = Number(env("PRS_POLL_MS")); return Number.isFinite(n) && n > 0 ? Math.max(5_000, n) : 20_000; })();
/** Test seam: shorten the lease / poll period (no floor). */
export function setPrTiming(t: { leaseMs?: number; pollMs?: number; askedMs?: number }): void {
  if (t.leaseMs !== undefined) LEASE_MS = t.leaseMs;
  if (t.askedMs !== undefined) askedMs = t.askedMs;
  if (t.pollMs !== undefined) pollMs = t.pollMs;
}

/** Test seam: replace (null restores) how branch rules are read (a fake forge has no `gh api`). */
type RulesLookup = (wt: string) => Promise<BranchRules | undefined>;
let rulesLookup: RulesLookup | null = null;
export function setPrRules(fn: RulesLookup | null): void { rulesLookup = fn; }
const rulesOf = (wt: string) => (rulesLookup ? rulesLookup(wt) : branchRules(wt));

/** Test seam: replace (null restores) the tidy's pull — the one git call of the tidy that can throw. */
let pullFn: typeof gitPull | null = null;
export function setPrGitPull(fn: typeof gitPull | null): void { pullFn = fn; }

// ── notifications ────────────────────────────────────────────────────────
export interface PrNotifyDeps {
  notify(kind: "git", p: NotifyParams): void;
  resolveAttention(key: string, note: string): number;
}
let deps: PrNotifyDeps | null = null;
export function setPrNotify(d: PrNotifyDeps | null): void { deps = d; }

// ── per-worktree state ───────────────────────────────────────────────────
interface Watch {
  holders: Map<string, number>;
  ref?: GitRepoRef;
  timer?: ReturnType<typeof setTimeout>;
  doc: PrListDoc;
  /** Last list the poll itself saw; reset when polling stops so a gap never diffs. */
  prev?: PullRequestView[];
  /** The ONE poll in flight: a timer, a lease and an action's refresh never start a second. */
  running?: Promise<void>;
  /** An action asked for a refresh while a poll was in flight: poll again the moment it ends. */
  again?: boolean;
  /** Monotonic poll sequence: only the newest poll started may apply its result (a stop bumps it,
   *  so a result read before the watch stopped never lands after it). */
  seq: number;
  /** PRs whose disappearance is not news: closed on a tap (added BEFORE the forge call), or a merge the
   *  person asked for once a read saw it MERGED. Read only through `goneIsOurs`; pruned to the open list. */
  ours: Set<number>;
  /** Merges the person asked for whose outcome no read has settled yet. Added BEFORE the forge call. */
  asked: Map<number, AskedMerge>;
  /** What tidies the poll ran (newest last, a few kept): the receipt of a merge that landed later. */
  tidied: string[];
}
interface AskedMerge {
  method: string; head: string; base: string; at: number; tidy?: Promise<Tidy>;
  /** The repo the PR belongs to, whatever the checkout's path (`prmergestore.ts`' `originKey`). */
  origin?: string;
  /** The tap's own merge call is still waiting: whatever tidy settles now reaches the person as its receipt. */
  tap?: boolean;
}
const watches = new Map<string, Watch>();
const newWatch = (wt: string): Watch => {
  let w = watches.get(wt);
  if (!w) { w = { holders: new Map(), doc: {}, seq: 0, ours: new Set(), asked: new Map(), tidied: [] }; watches.set(wt, w); }
  return w;
};
const watchOf = (wt: string): Watch => { loadAsked(); return newWatch(wt); };

// ── asked merges on disk (prmergestore.ts): a restart must not forget a queued merge ──
/** undefined ⇒ `<state dir>/pr-merges-asked.json`; null ⇒ memory only (tests). */
let storePath: string | null | undefined;
let loaded = false;
/** Test seam: where the asked merges are kept; also re-arms the load, as a restart would. */
export function setPrMergeStore(path: string | null | undefined): void { storePath = path; loaded = false; }
const storeFile = (): string | null => (storePath === undefined ? join(STATE_DIR, "pr-merges-asked.json") : storePath);
/** Once per process (or per `setPrMergeStore`), before any watch is read: the records a previous run kept. */
function loadAsked(): void {
  if (loaded) return;
  loaded = true;
  const p = storeFile();
  if (!p) return;
  let dropped = false;
  const gone: string[] = [];
  for (const [wt, m] of loadAskedMerges(p)) {
    for (const [n, a] of m) {
      if (expired(a)) { dropped = true; continue; }
      const w = newWatch(wt);
      if (!w.asked.has(n)) w.asked.set(n, { ...a });
    }
    if (watches.get(wt)?.asked.size && !existsSync(wt)) gone.push(wt);
  }
  if (dropped) keepAsked();
  if (gone.length) rehoming = rehomeAsked(gone).catch((e) => console.warn(`[prs] could not look for moved checkouts: ${msg(e)}`));
}

// ── a checkout renamed or moved: its records follow the repo, not the path ──
type RepoLister = () => Promise<{ path: string; primary: boolean }[]>;
let repoLister: RepoLister | null = null;
/** Test seam: which checkouts a record whose folder is gone may move to (null restores: the primary
 *  checkouts discovered under ROOT). */
export function setPrRepoLister(fn: RepoLister | null): void { repoLister = fn; }
const listRepos: RepoLister = async () => (await discoverTargets(ROOT)).map((t) => ({ path: t.worktreePath, primary: t.isPrimary }));
let rehoming: Promise<void> = Promise.resolve();
/** Test seam: resolves once the records loaded for a vanished folder have been moved (or left). */
export function prMergesRehomed(): Promise<void> { return rehoming; }

/**
 * A record whose checkout folder is gone (renamed, moved) goes to the ONE listed primary checkout
 * whose origin is the record's (`rehomeTarget`); several or none ⇒ it stays where it was, said once,
 * and ages out as before. A record without an origin is left exactly as before. A record already
 * under the new path for the same PR is a newer tap's and wins.
 */
async function rehomeAsked(gone: string[]): Promise<void> {
  const listed = (await (repoLister ?? listRepos)()).filter((r) => r.primary && existsSync(r.path));
  const repos = await Promise.all(listed.map(async (r) => ({ path: r.path, origin: originKey(await gitRemoteUrl(r.path)) })));
  let moved = false;
  for (const wt of gone) {
    const from = watches.get(wt);
    if (!from) continue;
    for (const [n, rec] of [...from.asked]) {
      if (!rec.origin) continue;
      const { to, matches } = rehomeTarget(rec, wt, repos);
      if (!to) {
        console.warn(`[prs] the merge asked for PR #${n} (${rec.origin}) was asked in ${wt}, which is gone, and ${matches ? `${matches} listed checkouts have` : "no listed checkout has"} that origin; it is kept until it ages out`);
        continue;
      }
      from.asked.delete(n);
      const into = newWatch(to);
      if (!into.asked.has(n)) into.asked.set(n, rec);
      moved = true;
      console.log(`[prs] the merge asked for PR #${n} moved with its checkout: ${wt} → ${to}`);
    }
    if (!from.asked.size && !from.holders.size) watches.delete(wt);
  }
  if (moved) keepAsked();
}
function keepAsked(): void {
  const p = storeFile();
  if (p) saveAskedMerges(p, new Map([...watches].map(([wt, w]) => [wt, w.asked] as const)));
}
/** The one way a record goes: only this record (a newer tap's is left), and the file follows. */
function forgetAsked(w: Watch, n: number, rec: AskedMerge): void {
  if (w.asked.get(n) !== rec) return;
  w.asked.delete(n);
  keepAsked();
}

/** Is anything polling this worktree right now? (tests, diagnostics) */
export function prsPolling(wt: string): boolean { return !!watches.get(wt)?.timer; }

/** Merges asked for and not yet settled; and the receipts of tidies the poll ran (tests, diagnostics). */
export function prMergesAsked(wt: string): number[] { loadAsked(); return [...(watches.get(wt)?.asked.keys() ?? [])]; }
export function prTidyReceipts(wt: string): string[] { return [...(watches.get(wt)?.tidied ?? [])]; }

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

async function pollOnce(wt: string, w: Watch, seq: number): Promise<void> {
  // Direct or unread rules: no `gh` call at all — a direct repo's git view costs nothing new.
  const rules = rulesLookup ? await rulesLookup(wt) : cachedBranchRules(wt);
  if (seq !== w.seq) return;
  if (!rules || rules.mode === "direct") { w.doc = {}; w.prev = undefined; return; }
  const r = await listPrs(wt, rules);
  if (seq !== w.seq) return; // a newer poll (or a stop) owns the reading now
  if (!r.prs) {
    // Keep the last good list (it says when it is from); say why the refresh failed.
    w.doc = w.doc.prs ? { ...w.doc, why: r.why } : { why: r.why };
    return;
  }
  const changes = prChanges(w.prev, r.prs);
  const titles = new Map((w.prev ?? []).map((p) => [p.number, p.title] as const));
  w.prev = r.prs;
  w.doc = { prs: r.prs, at: Date.now() };
  const open = new Set(r.prs.map((p) => p.number));
  for (const c of changes) {
    if (c.kind === "gone") {
      if (goneIsOurs(w, c.number)) continue;
      await goneNews(wt, w, c.number, c.title);
      continue;
    }
    if (!deps || !w.ref) continue;
    const key = prAttentionKey(w.ref.id, c.number);
    deps.notify("git", {
      title: `${c.kind === "checks-failed" ? "Check failed" : "Changes requested"} · PR #${c.number}`,
      body: c.kind === "checks-failed" ? `${c.detail ?? "A check"} failed on ${c.title}` : `A reviewer asked for changes on ${c.title}`,
      outcome: "failed", key, tag: `pr-${w.ref.id}-${c.number}`, open: { to: "git", repoId: w.ref.id },
    });
  }
  await settleAsked(wt, w, open, seq, titles);
  // A mark for a PR this reading no longer lists can never meet a "gone" change again: let it go.
  if (seq === w.seq) for (const x of w.ours) if (!open.has(x)) w.ours.delete(x);
}

/**
 * The ONE answer to "is this PR's disappearance the person's own doing?": a merge still asked for
 * (settled by `settleAsked`), or a mark left by the person's close or by a read that saw their merge
 * MERGED. Consumes the mark, so a disappearance is answered once.
 */
function goneIsOurs(w: Watch, n: number): boolean {
  return w.ours.delete(n) || w.asked.has(n);
}

/**
 * Settle every asked merge this reading can: MERGED tidies (once) and is not news; CLOSED drops the
 * record and IS news; OPEN or unreadable keeps it for a later poll; OPEN past `askedMs` is dropped quietly.
 * Runs inside the one poll in flight, so two polls never settle the same record at once.
 */
async function settleAsked(wt: string, w: Watch, open: Set<number>, seq: number, titles: Map<number, string>): Promise<void> {
  for (const [n, rec] of [...w.asked]) {
    if (seq !== w.seq) return;
    if (rec.tidy) continue; // a tidy is under way: it owns the record until it settles
    if (expired(rec)) { forgetAsked(w, n, rec); continue; }
    // The age bound is applied to what the reading SAYS, never instead of reading it. Polling runs
    // only while a card holds a lease, so a PR that landed at hour 10 may first be read at hour 30:
    // that MERGED is still the person's merge and is tidied. Only a PR still OPEN past the bound is
    // dropped — a later merge of it is somebody's new decision, so it is news again. An unreadable
    // state (expired gh auth) is kept until it reads, within UNREAD_BOUND bounds of the asking (above).
    const age = Date.now() - rec.at;
    if (open.has(n)) { if (age > askedMs) forgetAsked(w, n, rec); continue; }
    const state = await readState(wt, n);
    if (w.asked.get(n) !== rec) continue; // the merge call's own read settled it meanwhile
    if (state === "OPEN" && age > askedMs) {
      forgetAsked(w, n, rec);
      continue;
    }
    if (state === "MERGED") {
      // What reaches the person is decided by the tidy itself when it settles (settleMerged).
      const out = await settleMerged(wt, w, n, rec);
      w.tidied = [...w.tidied, out.receipt].slice(-5);
      console.log(`[prs] PR #${n} merged after the tap: ${out.receipt}`);
    } else if (state === "CLOSED") {
      forgetAsked(w, n, rec);
      await goneNews(wt, w, n, titles.get(n) ?? `PR #${n}`, state);
    }
  }
}

const readState = async (wt: string, n: number): Promise<string> => {
  try { return (await (await forgeOrGh(wt)).prState(n)).toUpperCase(); } catch { return ""; }
};

/** The ONE place an asked merge is tidied: the claim is synchronous, so a second reader gets the first's receipt. */
function settleMerged(wt: string, w: Watch, n: number, rec: AskedMerge): Promise<Tidy> {
  // The record goes, but its PR may still be in a list a poll is fetching right now: the mark keeps
  // that list's "gone" the person's, not news (review A2c M1).
  w.ours.add(n);
  // The record leaves the disk only once the tidy has settled: a restart mid-tidy finds it and runs
  // the tidy again, which is safe — each step of `tidyAfterMerge` reads "already gone" the second time.
  // Whether a tap is still waiting is read when the tidy SETTLES, not at the claim: a tap that
  // answered "not merged yet" in the gap before its flag dropped is not waiting for this receipt.
  // A tidy that throws (a git read outside any guard) is a not-done tidy like any other: said once,
  // through tidyNews, and never a rejection out of the tap's answer or the poll's other records.
  rec.tidy ??= tidyAfterMerge(wt, n, rec.method, rec.head, rec.base, w.ref)
    .catch((e): Tidy => {
      const what = `the tidy stopped: ${msg(e)}`;
      return { receipt: `Merged PR #${n} (${rec.method}). ${NOT_DONE} ${what}.`, notDone: [{ what, routine: false }] };
    })
    .then((tidy) => { tidyNews(w, n, tidy, rec.tap === true); return tidy; })
    .finally(() => forgetAsked(w, n, rec));
  return rec.tidy;
}

/**
 * A tidy a later poll ran reaches the person (R-git-025): the tap's receipt promised it, and a
 * partial tidy carries an instruction they need (a squash merge always keeps the local head —
 * "delete it yourself if you are sure"). Read off the tidy's own structured result, never its words:
 * something left that needs the person ⇒ attention, with the receipt as detail; a routine leftover
 * only rides in the receipt of an ok notice.
 *
 * `byTap` (the tap's merge call is waiting and returns this receipt itself) suppresses ONLY the ok
 * notice. Something that needs the person ALWAYS goes through notify: the tap's answer may never
 * reach the phone (its 180 s timeout, a dropped link), and even when it does it is a toast, where
 * the attention item is the durable copy of the instruction — never zero times, never transient only.
 */
function tidyNews(w: Watch, n: number, tidy: Tidy, byTap: boolean): void {
  if (!deps || !w.ref) return;
  const key = prAttentionKey(w.ref.id, n);
  const receipt = tidy.receipt;
  // A leftover another owner already filed (the git sink's failed pull) is said in the receipt, never a second item.
  const failed = tidy.notDone.some((x) => !x.routine && !x.filed);
  if (!failed) deps.resolveAttention(key, `PR #${n} was merged`);
  if (byTap && !failed) return;
  deps.notify("git", {
    title: `PR #${n} merged · ${w.ref.name}`, body: receipt,
    outcome: failed ? "failed" : "ok", key, tag: `pr-${w.ref.id}-${n}`, open: { to: "git", repoId: w.ref.id },
    ...(failed ? { detail: receipt } : {}),
  });
}

async function goneNews(wt: string, w: Watch, number: number, title: string, known?: string): Promise<void> {
  if (!deps || !w.ref) return;
  const state = known ?? await readState(wt, number);
  const word = state === "MERGED" ? "merged" : state === "CLOSED" ? "closed" : "no longer open";
  const key = prAttentionKey(w.ref.id, number);
  deps.resolveAttention(key, `PR #${number} was ${word}`);
  deps.notify("git", {
    title: `PR #${number} ${word} · ${w.ref.name}`, body: title,
    outcome: "ok", tag: `pr-${w.ref.id}-${number}`, open: { to: "git", repoId: w.ref.id },
  });
}

/** Start a poll unless one is in flight (then ask for one more right after it). The only place a poll starts. */
function startPoll(wt: string, w: Watch): void {
  if (w.running) { w.again = true; return; }
  const seq = ++w.seq;
  w.running = pollOnce(wt, w, seq).catch(() => undefined).finally(() => {
    w.running = undefined;
    if (w.again) {
      w.again = false;
      if (w.timer) { clearTimeout(w.timer); w.timer = undefined; }
      tick(wt);
      return;
    }
    if (w.holders.size > 0 && !w.timer) { w.timer = setTimeout(() => tick(wt), pollMs); w.timer.unref?.(); }
  });
}

function tick(wt: string): void {
  const w = watches.get(wt);
  if (!w) return;
  w.timer = undefined;
  const { live, lapsed } = dueWatchers([...w.holders].map(([h, until]) => [h, { until, open: true }] as const), Date.now());
  for (const h of lapsed) w.holders.delete(h);
  // Stops with its last watcher; the bump drops a reading still in flight, so a gap never diffs.
  if (live.length === 0) { w.prev = undefined; w.seq++; w.again = false; return; }
  if (w.running) return; // the poll in flight re-arms the timer when it ends
  startPoll(wt, w);
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
  for (const w of watches.values()) { if (w.timer) clearTimeout(w.timer); w.holders.clear(); w.seq++; w.again = false; }
  watches.clear();
}

// ── actions ──────────────────────────────────────────────────────────────
const isNum = (n: unknown): n is number => typeof n === "number" && Number.isInteger(n) && n > 0;
const METHOD_FLAG = { merge: 1, squash: 1, rebase: 1 } as const;
type Method = MergeMethod;
const bad = (error: string): PrActionResult => ({ ok: false, error });
/** The ONE reading of a requested merge method, for a merge and for auto-merge alike (R-git-023):
 *  the person's pick when the repo allows it, refused in words when not, else the first allowed. */
function methodOf(asked: unknown, rules: BranchRules | undefined): { method?: Method; error?: string } {
  if (asked === undefined) return { method: rules?.allowedMerge[0] };
  if (typeof asked !== "string" || !Object.hasOwn(METHOD_FLAG, asked)) return { error: "Merge method must be merge, squash or rebase." };
  const method = asked as Method;
  if (rules?.allowedMerge.length && !rules.allowedMerge.includes(method)) return { error: `This repo does not allow a ${method} merge — it allows ${rules.allowedMerge.join(", ")}.` };
  return { method };
}
/** Refresh now so the card is not a poll behind the tap (only while somebody watches; never a second poll). */
const afterAction = (wt: string) => {
  const w = watches.get(wt);
  if (w && w.holders.size > 0) startPoll(wt, w);
};
/**
 * Mark a PR as the person's own BEFORE the forge call: a poll landing while gh is still
 * merging must not report the tap as news (R-git-025). Returns the undo for a failed call.
 */
const markOurs = (wt: string, n: number): (() => void) => {
  const w = watches.get(wt);
  if (!w || w.holders.size === 0 || w.ours.has(n)) return () => undefined;
  w.ours.add(n);
  return () => { w.ours.delete(n); };
};

export async function mergePr(wt: string, body: { number?: unknown; method?: unknown }): Promise<PrActionResult> {
  if (!isNum(body.number)) return bad("Which pull request? (number missing)");
  const n = body.number;
  const rules = await rulesOf(wt);
  const picked = methodOf(body.method, rules);
  if (picked.error) return bad(picked.error);
  const method = picked.method;
  let head = "", base = "";
  // What the PR belongs to, whatever this checkout's path later becomes (a folder rename).
  const origin = originKey(await gitRemoteUrl(wt));
  try {
    const v = await (await forgeOrGh(wt)).prInfo(n);
    head = String(v?.headRefName ?? ""); base = String(v?.baseRefName ?? "");
    if (v?.state && v.state !== "OPEN") return bad(`PR #${n} is ${String(v.state).toLowerCase()}, not open.`);
  } catch (e) { return bad(`Could not read PR #${n}: ${msg(e)}`); }
  // Recorded BEFORE the forge call: a poll landing while gh is still merging settles it as the
  // person's own (R-git-025), and any later read that sees MERGED tidies it (R-git-023).
  const w = watchOf(wt);
  const rec: AskedMerge = { method: method ?? "merge", head, base, at: Date.now(), tap: true, ...(origin ? { origin } : {}) };
  w.asked.set(n, rec);
  keepAsked();
  try { return await mergeAsked(wt, w, n, rec, method, rules); } finally { rec.tap = false; }
}

async function mergeAsked(wt: string, w: Watch, n: number, rec: AskedMerge, method: Method | undefined, rules: BranchRules | undefined): Promise<PrActionResult> {
  const drop = () => forgetAsked(w, n, rec);
  let noAnswer = false;
  try {
    await (await forgeOrGh(wt)).merge(n, method);
  } catch (e) {
    // gh ended by a signal (our 60 s timeout) never said what GitHub did: keep the record and read.
    // A worded gh failure is a refusal: drop it, so the PR's later fate is news again — unless a
    // poll already saw it MERGED and tidied it while gh was failing: then that receipt is the answer.
    const x = e as { killed?: boolean; signal?: string | null };
    if (!x.killed && !x.signal) {
      if (rec.tidy) return { ok: true, output: (await rec.tidy).receipt };
      drop(); return bad(`GitHub did not merge PR #${n}: ${msg(e)}`);
    }
    noAnswer = true;
  }
  afterAction(wt);
  // gh's exit code is NOT the outcome: in a merge-queue repo (or where gh fell back to
  // auto-merge) it exits 0 having only enqueued the PR. Only GitHub's own MERGED lets the
  // host pull the base and delete the head — deleting a queued PR's head closes it.
  const state = await readState(wt, n);
  if (state === "MERGED") return { ok: true, output: (await settleMerged(wt, w, n, rec)).receipt };
  if (state === "CLOSED") { drop(); if (w.holders.size > 0) w.ours.add(n); return { ok: true, output: `PR #${n} was closed, not merged. No branch was touched.` }; }
  if (rec.tidy) return { ok: true, output: (await rec.tidy).receipt }; // a poll saw it merged while this read lagged
  return { ok: true, output: notMergedYet(n, state, rules?.mergeQueue === true, noAnswer) };
}

/** No read has seen the PR merged yet: say what is known; the record keeps the promise (settleAsked). */
function notMergedYet(n: number, state: string, queue: boolean, noAnswer: boolean): string {
  const later = "the base is pulled and the head deleted — the PR card checks while it is open, for up to a day.";
  if (noAnswer) return `gh did not answer in time on PR #${n}; it may still have merged. No branch was touched yet; if it did merge, ${later}`;
  if (state === "OPEN" && queue) return `PR #${n} is queued. No branch was touched; when it lands, ${later}`;
  if (state === "OPEN") return `GitHub took the merge of PR #${n} but does not report it merged yet. No branch was touched; when it does, ${later}`;
  return `GitHub accepted the merge of PR #${n}, but its state could not be read back, so no branch was touched yet. Once it reads as merged, ${later}`;
}

/**
 * What a tidy did, as data: `receipt` is the sentence for the person; `notDone` is what decides a
 * notice's outcome. A ROUTINE leftover is the expected shape of a normal merge — this checkout is on
 * another branch (a linked worktree), the head is checked out, or `git branch -d` refuses a squash
 * merge's head (almost every squash) — and is said in the receipt but needs no attention to clear:
 * an attention item on nearly every merge is one the person learns to ignore. Anything else (a pull
 * that failed, origin refusing the delete, a branch name not known) needs the person.
 *
 * `filed` marks a leftover another owner has ALREADY filed as attention and will clear itself: a pull
 * run with the repo ref goes to the git outcome sink (`git:<id>:pull`, resolved by the next good pull).
 * The receipt still says it; `tidyNews` never counts it, or the person gets a second item no pull clears.
 */
export interface Tidy { receipt: string; notDone: { what: string; routine: boolean; filed?: boolean }[] }

/** Pull the base branch if checked out, delete the head branch locally and on origin; say what was and was not done. */
const NOT_DONE = "Not done:";
async function tidyAfterMerge(wt: string, n: number, method: string, head: string, base: string, ref?: GitRepoRef): Promise<Tidy> {
  const did: string[] = [`Merged PR #${n} (${method}).`];
  const notDone: Tidy["notDone"] = [];
  const not = (what: string, routine = false, filed = false): void => { notDone.push({ what, routine, ...(filed ? { filed } : {}) }); };
  let cur = "";
  try { cur = (await git(wt, ["rev-parse", "--abbrev-ref", "HEAD"])).stdout.trim(); } catch { /* unknown */ }
  if (!base) not("did not pull (the base branch is unknown)");
  // `HEAD` is git's answer on a detached head — a rebase stopped part-way, or a commit checked out:
  // not the routine "another branch" of a linked worktree, so it needs the person.
  else if (cur === "HEAD") not(`did not pull ${base} (this checkout is not on a branch — a rebase may have stopped part-way; finish or abort it, then pull)`);
  else if (cur !== base) not(`did not pull ${base} (this checkout is on ${cur || "no branch"})`, !!cur);
  else {
    const p = await (pullFn ?? gitPull)(wt, ref); // with the ref, a refused pull is filed like the phone's own (git outcome sink)
    if (p.ok) did.push(`Pulled ${base}.`); else not(`did not pull ${base}: ${(p.error ?? "").split("\n")[0]}`, false, !!ref);
  }
  const safeRef = head && head !== base && /^[A-Za-z0-9._][A-Za-z0-9._/-]*$/.test(head) && !head.includes("..");
  if (!safeRef) { not(head ? `kept branch ${head}` : "did not delete the branch (its name is unknown)"); }
  else {
    if (cur === head) not(`kept local branch ${head} (it is checked out)`, true);
    else {
      const d = await gitDeleteBranch(wt, head);
      if (d.ok) did.push(`Deleted local branch ${head}.`);
      else if (/not found|did not match/i.test(d.error ?? "")) did.push(`Local branch ${head} was already gone.`);
      else not(`kept local branch ${head} (git says it is not fully merged here — a squash merge looks like that; delete it yourself if you are sure)`, true);
    }
    try {
      await git(wt, ["push", "origin", "--delete", `refs/heads/${head}`]);
      did.push(`Deleted ${head} on origin.`);
    } catch (e) {
      if (/remote ref does not exist|unable to delete|already|not found/i.test(msg(e))) did.push(`${head} was already gone on origin.`);
      else not(`kept ${head} on origin: ${msg(e).slice(0, 120)}`);
    }
  }
  const receipt = notDone.length ? `${did.join(" ")} ${NOT_DONE} ${notDone.map((x) => x.what).join("; ")}.` : did.join(" ");
  return { receipt, notDone };
}

export async function autoMergePr(wt: string, body: { number?: unknown; on?: unknown; method?: unknown }): Promise<PrActionResult> {
  if (!isNum(body.number)) return bad("Which pull request? (number missing)");
  if (typeof body.on !== "boolean") return bad("Say whether auto-merge goes on or off.");
  const n = body.number;
  if (!body.on) {
    try { await (await forgeOrGh(wt)).autoMerge(n, false); } catch (e) { return bad(`Could not switch auto-merge off for PR #${n}: ${msg(e)}`); }
    afterAction(wt);
    return { ok: true, output: `Auto-merge is off for PR #${n}.` };
  }
  const rules = await rulesOf(wt);
  if (rules && !rules.autoMerge) return bad("This repo does not allow auto-merge. Turn on \"Allow auto-merge\" in the repo's GitHub settings, or merge by hand when the checks are green.");
  const picked = methodOf(body.method, rules);
  if (picked.error) return bad(picked.error);
  const method = picked.method;
  try { await (await forgeOrGh(wt)).autoMerge(n, true, method); } catch (e) { return bad(`Could not switch auto-merge on for PR #${n}: ${msg(e)}`); }
  afterAction(wt);
  return { ok: true, output: `Auto-merge is on for PR #${n}: it merges once its checks and reviews allow. Nothing else changes until then.` };
}

export async function closePr(wt: string, body: { number?: unknown }): Promise<PrActionResult> {
  if (!isNum(body.number)) return bad("Which pull request? (number missing)");
  const unmark = markOurs(wt, body.number);
  try { await (await forgeOrGh(wt)).close(body.number); } catch (e) { unmark(); return bad(`Could not close PR #${body.number}: ${msg(e)}`); }
  afterAction(wt);
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
