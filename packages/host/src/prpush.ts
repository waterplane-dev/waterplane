/**
 * "Push & open PR" — the push job's path for a repo whose remote rules demand a
 * pull request (`branchrules.ts`: mode pr / pr-checks). Direct and absent rules
 * never come here: `gitPush` runs its own plain path for them, unchanged.
 *
 * EVERY forge call of this flow goes through `forge/` (`forgeOrGh`), never `gh` directly. Outcome text ("opened PR #N" / "updated PR #N"
 * + url) travels as the push job's `output`, the field the phone already reads.
 *
 * Moving local default back (the dance): the new branch is created at HEAD, pushed
 * and the PR opened FIRST. Only then — re-read at that moment: the checkout is still on
 * default and HEAD is still the pushed tip, else local is left alone and the sentence says
 * why — is local default moved, with `git reset --keep origin/<default>`:
 * it moves HEAD to the remote's tip but REFUSES (changing nothing) if a locally
 * modified file would be overwritten, so uncommitted edits are never lost and a
 * commit is never lost (it lives on the branch). If it refuses, the PR still
 * stands, local default keeps its commits, and the sentence says so. After the reset, the
 * default branch's own reflog says what the reset moved from: a commit that landed between the
 * re-check and the reset is named by its sha in the sentence, never left to the reflog unsaid.
 */
import { execFileP } from "./proc.js";
import type { BranchRules } from "@waterplane/shared";
import { reportLocalCi } from "./localcistatus.js";
import { forgeOrGh } from "./forge/index.js";

type Result = { ok: boolean; output?: string; error?: string };
export interface PrPushIo {
  /** The streamed `git push` (local-CI hook output feeds the progress parser). */
  push(args: string[]): Promise<{ stdout: string; stderr: string }>;
  /** Turn a failed push's output into the sentence the phone shows. */
  failText(stdout: string, stderr: string): string;
}

type Lookup = (wt: string) => Promise<BranchRules | undefined>;
let lookup: Lookup | null = null;
/** Test seam: replace (or, with null, restore) how the rules are read. */
export function setRulesLookup(fn: Lookup | null): void { lookup = fn; }
/** What a push decides on: the CACHED reading only — a push never waits on `gh`, so a
 *  direct repo's push is exactly as fast as before. Not read yet = plain push; a rule
 *  refusal then re-reads (git.ts) and the next push opens the PR. */
export async function rulesFor(wt: string): Promise<BranchRules | undefined> {
  if (lookup) return lookup(wt);
  const { cachedBranchRules } = await import("./branchrules.js");
  return cachedBranchRules(wt);
}

const NO_PROMPT = { ...process.env, GIT_TERMINAL_PROMPT: "0", GH_PROMPT_DISABLED: "1" };
const git = (wt: string, args: string[]) => execFileP("git", args, { cwd: wt, timeout: 60_000, env: NO_PROMPT, maxBuffer: 8 * 1024 * 1024 });
const msg = (e: unknown) => String((e as { stderr?: string }).stderr || (e as Error)?.message || e).trim().split("\n").slice(-3).join(" ");
const out = async (wt: string, args: string[]) => (await git(wt, args)).stdout.trim();
const ok = async (wt: string, args: string[]) => { try { await git(wt, args); return true; } catch { return false; } };

/** `wp/<slug>` body: lowercase [a-z0-9-], at most 40 chars. */
export function branchSlug(subject: string): string {
  const s = subject.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40).replace(/-+$/g, "");
  return s || "changes";
}

async function uniqueBranch(wt: string, slug: string): Promise<string> {
  for (let n = 1; n < 100; n++) {
    const name = `wp/${slug}${n === 1 ? "" : `-${n}`}`;
    if (await ok(wt, ["show-ref", "--verify", "--quiet", `refs/heads/${name}`])) continue;
    let remote = "";
    try { remote = await out(wt, ["ls-remote", "--heads", "origin", name]); } catch { /* offline: the push will say */ }
    if (!remote) return name;
  }
  throw new Error("no free branch name");
}

/**
 * The default branch, from ONE source: the forge's answer when it gave one; origin/HEAD only when
 * the forge could not answer (offline), and then only that. `refs/remotes/origin/HEAD` is a
 * clone-time cache `git fetch` never refreshes (it still says `master` after a master → main
 * rename, or `develop` after the default moved off a still-live develop), so a guard trusting
 * the UNION refused pushes from that branch for ever. `cached` is returned only so a stale clone
 * can be told what to fix — it is never a default.
 */
type Defaults = { def: string; names: Set<string>; cached?: string };
async function defaultBranch(wt: string): Promise<Defaults | undefined> {
  const [cached, forge] = await Promise.all([
    out(wt, ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"]).then((s) => s.replace(/^origin\//, "") || undefined, () => undefined),
    forgeOrGh(wt).then((f) => f.defaultBranch()).catch(() => undefined),
  ]);
  const def = forge || cached;
  if (!def) return undefined;
  return { def, names: new Set([def]), cached };
}

/** The one-time fix for a clone made before origin renamed `old` → `def`. */
const renameFix = (old: string, def: string) =>
  `\`git branch -m ${old} ${def}; git fetch origin; git branch -u origin/${def} ${def}; git remote set-head origin -a\``;

/** Does origin still hold branch `name`? undefined = origin could not be read. */
async function originHas(wt: string, name: string): Promise<boolean | undefined> {
  // Bounded: asked on a push before any byte moves, so a hanging remote gives up fast (unreadable).
  try { return !!(await execFileP("git", ["ls-remote", "--heads", "origin", `refs/heads/${name}`], { cwd: wt, timeout: 15_000, env: NO_PROMPT, maxBuffer: 1024 * 1024 })).stdout.trim(); } catch { return undefined; }
}

/**
 * THE one place a PR-mode refspec is built. In PR mode a push never targets a default branch —
 * whatever tracking config, `push.default` or a stale cache says — so a target any source
 * names as default throws here instead of landing commits on it without a PR.
 */
export function prRefspec(branch: string, head: string, defaults: ReadonlySet<string>): string {
  if (defaults.has(head)) throw new Error(`refusing to push ${branch} onto the default branch ${head} — in PR mode it gets a branch and a pull request`);
  return `${branch}:${head}`;
}

/** Append the local-ci receipt (when the switch is on) as a second sentence. */
const withNote = (r: Result, note: string | null): Result => {
  if (!note) return r;
  return r.ok ? { ...r, output: `${r.output ?? ""} ${note}`.trim() } : { ...r, error: `${r.error ?? ""} ${note}`.trim() };
};

const prNumber = (url: string) => /\/pull\/(\d+)/.exec(url)?.[1];
/** `on`: the remote branch the PR lives on, named when it is not the local branch pushed. */
const done = (verb: string, url: string, on?: string): Result => {
  const n = prNumber(url);
  return { ok: true, output: `${verb} PR${n ? ` #${n}` : ""}${on ? ` on ${on}` : ""} — ${url}` };
};

/** The OPEN PR for `branch`, if one exists — read from the forge, never inferred from a branch being on origin. */
async function existingPr(wt: string, branch: string): Promise<{ url: string; number?: number } | undefined> {
  return (await forgeOrGh(wt)).existingPr(branch);
}

/**
 * Run the PR flow. `null` = nothing for it to do (not in PR mode, detached, or
 * default branch with nothing ahead): the caller runs the plain push. Every other exit
 * in PR mode is a Result — an unknown default or an uncountable "ahead" is refused in
 * words, never handed to a plain push of what may be the default branch.
 */
export async function pushForPr(wt: string, rules: BranchRules | undefined, io: PrPushIo): Promise<Result | null> {
  if (!rules || rules.mode === "direct") return null;
  let cur: string;
  try { cur = await out(wt, ["rev-parse", "--abbrev-ref", "HEAD"]); } catch { return null; }
  if (!cur || cur === "HEAD") return null;
  const d = await defaultBranch(wt);
  // Never a plain push here: in PR mode, the branch it would move might BE the default.
  if (!d) return { ok: false, error: "Not pushed — this repo takes changes through a pull request, and origin's default branch could not be read: the forge did not answer and this clone has no origin/HEAD. `git remote set-head origin -a` records it once; then push again. Nothing was changed." };
  try {
    // A branch the person calls by its own upstream name (or the stale origin/HEAD name) that origin
    // no longer has is EITHER a renamed default (its commits are commits on the default under its old
    // name: they take the default's own path, never a push that recreates the dead name) OR a feature
    // branch whose PR merged and was auto-deleted (an ordinary branch: recreate it, open feat -> default).
    // The forge is the one source for which: it follows its own rename redirect. Only when it cannot
    // answer does the old signal decide: this clone still calls the branch what origin/HEAD cached.
    if (cur !== d.def && (cur === d.cached || await tracksOwnName(wt, cur))) {
      const live = await originHas(wt, cur);
      if (live === undefined && cur !== d.cached) return await onBranch(wt, cur, d.def, d.names, io);
      if (live === undefined) {
        return { ok: false, error: `Not pushed — origin's default is ${d.def}, this clone still calls ${cur} the default, and origin could not be read to tell whether ${cur} was renamed. If it was, fix this clone once with ${renameFix(cur, d.def)}, then push again. Nothing was changed.` };
      }
      if (!live) {
        const now = await (await forgeOrGh(wt)).branchNow(cur).catch(() => undefined);
        const renamed = now === undefined ? cur === d.cached : now === d.def;
        if (renamed) {
          const r = await fromDefault(wt, cur, d.def, d.names, io);
          return withNote(r ?? { ok: true, output: `Nothing on ${cur} is ahead of origin/${d.def}.` },
            `origin renamed ${cur} to ${d.def}; this clone still calls it ${cur} — ${renameFix(cur, d.def)} fixes it once.`);
        }
      }
    }
    if (cur !== d.def) return await onBranch(wt, cur, d.def, d.names, io);
    return await fromDefault(wt, d.def, d.def, d.names, io);
  } catch (e) {
    return { ok: false, error: `The pull request could not be opened — ${msg(e)}. Nothing else was changed.` };
  }
}

/**
 * Where a branch's push goes, and whether its tracking is set — ONE rule, always an explicit
 * refspec (the target never comes from `push.default`):
 * - it tracks `origin/X`, X not a default branch, AND X has an OPEN PR → push `branch:X` and leave
 *   tracking: the person pointed it at that PR, which keeps updating (never a second PR). Config alone
 *   cannot tell this from `checkout -b mine origin/theirs` (git's default autoSetupMerge tracks a
 *   start point too), so only the open PR makes it "push into X" — X with no open PR is someone's
 *   start point, a merged-and-deleted branch, or a moved one, and is never moved or recreated;
 * - otherwise, tracking `origin/<anything>` or nothing → push `branch:branch` with `--set-upstream`,
 *   so it tracks `origin/branch` afterwards (the git sheet's ↑N and `pushedAlready` read `@{u}`; a
 *   branch made off `origin/main` would otherwise count its pushed commits as unpushed for ever);
 * - it tracks anything else (another remote, a local branch) → push `branch:branch`, tracking
 *   left exactly as the person set it.
 */
type Target = { head: string; setUpstream: boolean; pr?: { url: string; number?: number } };
async function branchTarget(wt: string, branch: string, defaults: ReadonlySet<string>): Promise<Target> {
  const cfg = async (k: string) => { try { return await out(wt, ["config", "--get", `branch.${branch}.${k}`]); } catch { return ""; } };
  const remote = await cfg("remote");
  const merge = await cfg("merge");
  if (!remote || !merge) return { head: branch, setUpstream: true };
  if (remote !== "origin" || !merge.startsWith("refs/heads/")) return { head: branch, setUpstream: false };
  const x = merge.slice("refs/heads/".length);
  if (x === branch || defaults.has(x)) return { head: branch, setUpstream: x !== branch };
  const pr = await existingPr(wt, x);
  return pr ? { head: x, setUpstream: false, pr } : { head: branch, setUpstream: true };
}

/** The branch's upstream is `origin/<itself>` — the shape a renamed default leaves behind. */
async function tracksOwnName(wt: string, branch: string): Promise<boolean> {
  const cfg = async (k: string) => { try { return await out(wt, ["config", "--get", `branch.${branch}.${k}`]); } catch { return ""; } };
  return (await cfg("remote")) === "origin" && (await cfg("merge")) === `refs/heads/${branch}`;
}

async function onBranch(wt: string, branch: string, def: string, defaults: ReadonlySet<string>, io: PrPushIo): Promise<Result> {
  const { head, setUpstream, pr } = await branchTarget(wt, branch, defaults);
  const refspec = prRefspec(branch, head, defaults);
  let pushed: { stdout: string; stderr: string };
  try { pushed = await io.push(["push", "--porcelain", ...(setUpstream ? ["--set-upstream"] : []), "origin", refspec]); }
  catch (e) { return { ok: false, error: io.failText(String((e as any)?.stdout ?? ""), String((e as any)?.stderr ?? "") || String(e)) }; }
  const note = await reportLocalCi(wt, pushed, head);
  // A push into another name says which: the PR it updated is on X, not on the local branch.
  const have = pr ?? await existingPr(wt, head);
  if (have) return withNote(done("updated", have.url, head === branch ? undefined : head), note);
  try { return withNote(done("opened", await (await forgeOrGh(wt)).openPr({ head, base: def })), note); }
  catch (e) { return withNote({ ok: false, error: `${branch} is pushed to origin${head === branch ? "" : ` as ${head}`}, but opening the pull request failed — ${msg(e)}. Nothing else was changed.` }, note); }
}

/** A local `wp/*` branch at `tip` that origin also holds at `tip` (read now, from origin), or undefined. */
async function pushedBranchAt(wt: string, tip: string): Promise<string | undefined> {
  let local: string[];
  try { local = (await out(wt, ["for-each-ref", "--format=%(refname:short)", "--points-at", tip, "refs/heads/wp/"])).split("\n").filter(Boolean); }
  catch { return undefined; }
  for (const name of local) {
    let remote = "";
    try { remote = await out(wt, ["ls-remote", "--heads", "origin", `refs/heads/${name}`]); } catch { return undefined; }
    if (remote.split(/\s+/)[0] === tip) return name;
  }
  return undefined;
}

/**
 * Why local `def` must NOT be moved back now, or undefined when it may: the checkout is
 * still on `def` and HEAD is still the tip that was pushed. Read at the moment of the move,
 * never carried across an await — a commit made or a branch switched during the push
 * would otherwise be reset away (`reset --keep` acts on whatever HEAD is checked out).
 */
async function movedSince(wt: string, def: string, tip: string): Promise<string | undefined> {
  let cur = "", head = "";
  try { cur = await out(wt, ["rev-parse", "--abbrev-ref", "HEAD"]); head = await out(wt, ["rev-parse", "HEAD"]); }
  catch { return "this checkout could not be read"; }
  if (cur !== def) return `this checkout moved to ${cur === "HEAD" ? "a detached HEAD" : cur} during the push`;
  if (head !== tip) return `${def} got new commits during the push`;
  return undefined;
}

/**
 * What our `reset --keep origin/<def>` moved `branch` FROM, or undefined when that cannot be read
 * or does not matter. Read off the BRANCH's own reflog (it records every update, also one not
 * made through HEAD), never `HEAD@{1}`: a commit made just AFTER the reset makes `HEAD@{1}` the
 * reset's target, and the sentence would then offer a `reset --keep` that rewinds that commit.
 * Only when the reset is still the newest entry is the one before it read; a later entry means
 * a commit landed on top of the reset — safe, nothing to say.
 */
async function resetMovedFrom(wt: string, branch: string, def: string): Promise<string | undefined> {
  let lines: string[];
  try { lines = (await out(wt, ["log", "-g", "-n", "2", "--format=%H%x09%gs", `refs/heads/${branch}`])).split("\n").filter(Boolean); }
  catch { return undefined; }
  const [newest, before] = lines.map((l) => { const i = l.indexOf("\t"); return { sha: l.slice(0, i), subject: l.slice(i + 1) }; });
  if (!newest || newest.subject !== `reset: moving to origin/${def}`) return undefined;
  return before?.sha || undefined;
}

/** `local` is the checked-out branch holding the commits: `def` itself, or the default under its
 *  pre-rename name in a stale clone. The PR goes into `def`; `local` is what gets moved back. */
async function fromDefault(wt: string, local: string, def: string, defaults: ReadonlySet<string>, io: PrPushIo): Promise<Result | null> {
  await git(wt, ["fetch", "--quiet", "origin", def]).catch(() => undefined); // best effort
  let ahead: string[];
  try { ahead = (await out(wt, ["rev-list", "--reverse", `origin/${def}..HEAD`])).split("\n").filter(Boolean); }
  catch {
    // Not "nothing ahead": null would hand back to the caller's plain push of the default branch.
    return { ok: false, error: `Not pushed — the commits on ${local} ahead of origin/${def} could not be counted: this clone has no origin/${def} (a single-branch or shallow clone fetches only what it was made with). \`git config --add remote.origin.fetch +refs/heads/${def}:refs/remotes/origin/${def}; git fetch origin\`, then push again. Nothing was changed.` };
  }
  if (!ahead.length) return null;
  const tip = await out(wt, ["rev-parse", "HEAD"]);
  // A retry after a failed PR open: the commits are already on origin as a wp/ branch — reuse
  // it (no second hook run, no orphaned first branch) instead of minting `-2`.
  const reused = await pushedBranchAt(wt, tip);
  let branch: string;
  let note: string | null = null;
  if (reused) branch = reused;
  else {
    branch = await uniqueBranch(wt, branchSlug(await out(wt, ["log", "-1", "--format=%s", ahead[0]])));
    const refspec = prRefspec(branch, branch, defaults);
    await git(wt, ["branch", branch, tip]);
    let pushed: { stdout: string; stderr: string };
    try { pushed = await io.push(["push", "--porcelain", "--set-upstream", "origin", refspec]); }
    catch (e) {
      // Nothing reached the remote and main still holds every commit: drop the branch we made.
      await git(wt, ["branch", "-D", branch]).catch(() => undefined);
      return { ok: false, error: io.failText(String((e as any)?.stdout ?? ""), String((e as any)?.stderr ?? "") || String(e)) };
    }
    note = await reportLocalCi(wt, pushed, branch, tip);
  }
  let url: string;
  let verb = "opened";
  try {
    const have = reused ? await existingPr(wt, branch) : undefined;
    if (have) { url = have.url; verb = "updated"; }
    else url = await (await forgeOrGh(wt)).openPr({ head: branch, base: def });
  }
  catch (e) {
    return withNote({ ok: false, error: `Your ${ahead.length} commit${ahead.length === 1 ? " is" : "s are"} pushed to origin as ${branch} and still on ${local} here, but opening the pull request failed — ${msg(e)}. Nothing else was changed; push again to retry.` }, note);
  }
  // The push and the PR took minutes: re-read, at the moment of the move, what the move rests on.
  const moved = await movedSince(wt, local, tip);
  if (moved) {
    return withNote({ ok: true, output: `${done(verb, url).output}. Local ${local} was left as it is — ${moved}; every pushed commit is on ${branch}.` }, note);
  }
  if (await ok(wt, ["reset", "--keep", `origin/${def}`])) {
    // The re-check and the reset are separate spawns: a commit can land between them, and the
    // reset then moves past it. Say where that commit is — read off what the reset moved FROM.
    // The reset acts on whatever HEAD is on — normally `local`, the switched-to branch if one won the window.
    const now = await out(wt, ["rev-parse", "--abbrev-ref", "HEAD"]).catch(() => local);
    const from = await resetMovedFrom(wt, now === "HEAD" ? local : now, def);
    if (from && from !== tip) {
      return withNote({ ok: true, output: `${done(verb, url).output}. Local ${now} moved just before it was set back to origin/${def}: it was at ${from}, which is not on ${branch} — \`git reset --keep ${from}\` brings it back (it is in the reflog).` }, note);
    }
    return withNote(done(verb, url), note);
  }
  return withNote({ ok: true, output: `${done(verb, url).output}. Local ${local} still has the commits — edited files in the tree stopped moving it back; they are all on ${branch} too.` }, note);
}
