/**
 * The PR card's host half (prs.ts): a fake `gh` first on PATH records its args and
 * prints fixtures; a temp clone + local bare origin takes the real git. Never a real forge.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, realpathSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = realpathSync(mkdtempSync(join(tmpdir(), "prs-")));
const bin = join(root, "bin"); mkdirSync(bin);
const F = (n) => join(root, n);
const log = F("gh.log");
writeFileSync(join(bin, "gh"), `#!/bin/sh
echo "$@" >> "${log}"
pwd -P >> "${log}.cwd"
case "$1 $2" in
  "pr list") if [ -f "${F("list.sh")}" ]; then sh "${F("list.sh")}"; else cat "${F("list.json")}"; fi;;
  "pr view") if [ "$4" = "state" ] || [ "$5" = "state" ]; then cat "${F("state.json")}"; else cat "${F("view.json")}"; fi;;
  "pr merge") if [ -f "${F("merge.sh")}" ]; then sh "${F("merge.sh")}" || exit 1; fi; exit 0;;
  "pr close") exit 0;;
  "run view") cat "${F("runlog.txt")}";;
  *) exit 1;;
esac
`);
chmodSync(join(bin, "gh"), 0o755);
process.env.PATH = `${bin}:${process.env.PATH}`;
after(() => execFileSync("rm", ["-rf", root]));
const calls = () => { try { return readFileSync(log, "utf8").split("\n").filter(Boolean); } catch { return []; } };
const put = (n, v) => writeFileSync(F(n), typeof v === "string" ? v : JSON.stringify(v));

const prs = await import("../dist/prs.js");
const gitmod = await import("../dist/git.js");
const STORE = F("pr-merges-asked.json");
prs.setPrMergeStore(STORE); // never the real state dir
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/** Wait for a condition instead of a fixed sleep: a loaded machine stretches every timer. */
const until = async (fn, ms = 5000) => { const end = Date.now() + ms; while (!fn()) { if (Date.now() > end) return false; await sleep(20); } return true; };
const callsIn = (wt) => { try { return readFileSync(`${log}.cwd`, "utf8").split("\n").filter((d) => d === wt); } catch { return []; } };
const RULES = { mode: "pr", requiredChecks: [], requiredApprovals: 1, allowedMerge: ["squash", "merge"], autoMerge: false };
let rules = RULES;
prs.setPrRules(async () => rules);
after(() => prs.stopAllPrs());

const run = (id, name, conclusion, url) => ({ __typename: "CheckRun", name, status: "COMPLETED", conclusion, detailsUrl: url });
const raw = (extra = {}) => ({ number: 7, title: "Add x", headRefName: "wp/x", url: "https://github.com/o/r/pull/7", reviewDecision: "REVIEW_REQUIRED", mergeable: "MERGEABLE", autoMergeRequest: null, statusCheckRollup: [], ...extra });

test("listPrs maps the gh JSON and asks for the author's open PRs", async () => {
  put("list.json", [raw({ statusCheckRollup: [run(1, "ci", "FAILURE", "https://github.com/o/r/actions/runs/55/job/1")] })]);
  const r = await prs.listPrs(root);
  assert.equal(r.prs.length, 1);
  assert.equal(r.prs[0].blockedBy, "check ci failed");
  const c = calls().at(-1);
  assert.match(c, /pr list --author @me --state open/);
  assert.match(c, /--json number,title,headRefName,url,reviewDecision,statusCheckRollup,mergeable,autoMergeRequest/);
});

test("a gh failure is absent with a sentence, never an empty list", async () => {
  put("list.json", "not json");
  const r = await prs.listPrs(root);
  assert.equal(r.prs, undefined);
  assert.match(r.why, /gh could not list/);
});

test("the lease polls while held and stops by itself once it lapses", async () => {
  put("list.json", [raw()]);
  prs.setPrTiming({ leaseMs: 400, pollMs: 40 });
  try {
    const wt = join(root, "lease"); mkdirSync(wt);
    prs.leasePrs(wt, "phone");
    assert.ok(await until(() => callsIn(wt).length >= 2), "polled repeatedly");
    prs.leasePrs(wt, "phone"); // renewal
    assert.ok(prs.prsPolling(wt) || callsIn(wt).length >= 2);
    assert.equal(prs.cachedPrs(wt).prs[0].number, 7);
    // No timer is also the state DURING a poll in flight, so "stopped" is a quiet window:
    // no timer and no new call across 250 ms, reached within a few seconds of the lapse.
    let n = -1;
    const quiet = async () => { if (prs.prsPolling(wt)) { await sleep(20); return false; } const m = callsIn(wt).length; await sleep(250); return !prs.prsPolling(wt) && callsIn(wt).length === m && (n = m) >= 0; };
    let stopped = false;
    for (const end = Date.now() + 5000; !stopped && Date.now() < end;) stopped = await quiet();
    assert.ok(stopped, "stops once the lease lapsed");
    await sleep(300);
    assert.equal(callsIn(wt).length, n, "no poll after the lease lapsed");
  } finally { prs.setPrTiming({ leaseMs: 60_000, pollMs: 20_000 }); }
});

test("a direct or unread repo is never polled with gh, even under a lease", async () => {
  put("list.json", [raw()]);
  prs.setPrTiming({ leaseMs: 200, pollMs: 40 });
  try {
    for (const r of [{ ...RULES, mode: "direct" }, undefined]) {
      rules = r;
      const wt = join(root, `direct-${r ? "d" : "u"}`); mkdirSync(wt);
      prs.leasePrs(wt, "phone");
      await sleep(150);
      assert.equal(callsIn(wt).length, 0, "no gh call");
      assert.deepEqual(prs.cachedPrs(wt), {});
      await until(() => !prs.prsPolling(wt));
    }
  } finally { rules = RULES; prs.setPrTiming({ leaseMs: 60_000, pollMs: 20_000 }); }
});

test("poll notifies once on a new failing check, on changes requested, and on merge off-phone", async () => {
  const sent = [], resolved = [];
  prs.setPrNotify({ notify: (k, p) => sent.push([k, p]), resolveAttention: (k, n) => { resolved.push([k, n]); return 1; } });
  prs.setPrTiming({ leaseMs: 5_000, pollMs: 30 });
  const wt = join(root, "news"); mkdirSync(wt);
  put("list.json", [raw({ statusCheckRollup: [{ __typename: "CheckRun", name: "ci", status: "IN_PROGRESS" }] })]);
  prs.leasePrs(wt, "p", { id: "repo1", name: "Repo" });
  await sleep(120);
  assert.equal(sent.length, 0, "first reading is silent");
  put("list.json", [raw({ reviewDecision: "CHANGES_REQUESTED", statusCheckRollup: [run(1, "ci", "FAILURE")] })]);
  await sleep(200);
  assert.deepEqual(sent.map(([k, p]) => [k, p.outcome, p.title]), [["git", "failed", "Check failed · PR #7"], ["git", "failed", "Changes requested · PR #7"]]);
  assert.deepEqual(sent[0][1].open, { to: "git", repoId: "repo1" });
  put("state.json", { state: "MERGED" });
  put("list.json", []);
  await sleep(200);
  assert.equal(sent.length, 3);
  assert.equal(sent[2][1].outcome, "ok");
  assert.match(sent[2][1].title, /merged/);
  assert.equal(resolved[0][0], "pr:repo1:7");
  prs.stopAllPrs();
  prs.setPrNotify(null);
  prs.setPrTiming({ leaseMs: 60_000, pollMs: 20_000 });
});

// ── merge ────────────────────────────────────────────────────────────────
const sh = (cwd, ...a) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", ...a], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
let n = 0;
function fixture() {
  const d = join(root, `m${++n}`); mkdirSync(d);
  const bare = join(d, "o.git"), a = join(d, "a"), b = join(d, "b");
  sh(d, "init", "--bare", "-b", "main", bare);
  sh(d, "clone", bare, a);
  sh(a, "checkout", "-b", "main");
  writeFileSync(join(a, "f"), "1"); sh(a, "add", "f"); sh(a, "commit", "-m", "one");
  sh(a, "push", "-u", "origin", "main");
  sh(a, "branch", "wp/x"); sh(a, "push", "origin", "wp/x");
  sh(d, "clone", bare, b);
  // the "forge" merges: a commit lands on origin/main
  writeFileSync(F("merge.sh"), `cd "${b}" && git -c user.name=t -c user.email=t@t -c commit.gpgsign=false commit --allow-empty -m merged -q && git push -q origin main`);
  put("view.json", { headRefName: "wp/x", baseRefName: "main", state: "OPEN" });
  put("state.json", { state: "MERGED" }); // what GitHub says once the merge really landed
  return { a, b, bare };
}

test("merge: pulls the base, deletes the branch locally and on origin, and receipts it", async () => {
  const { a, bare } = fixture();
  const r = await prs.mergePr(a, { number: 7 });
  assert.equal(r.ok, true, r.error);
  assert.match(r.output, /^Merged PR #7 \(squash\)\. Pulled main\. Deleted local branch wp\/x\. Deleted wp\/x on origin\.$/);
  assert.match(calls().filter((c) => c.startsWith("pr merge")).at(-1), /^pr merge 7 --squash$/);
  assert.equal(sh(a, "log", "-1", "--format=%s"), "merged");
  assert.equal(sh(a, "branch", "--list", "wp/x"), "");
  assert.equal(sh(bare, "branch", "--list", "wp/x"), "");
});

test("merge: not on the base branch says so and keeps what it cannot touch", async () => {
  const { a } = fixture();
  sh(a, "checkout", "wp/x");
  const r = await prs.mergePr(a, { number: 7, method: "merge" });
  assert.equal(r.ok, true, r.error);
  assert.match(r.output, /did not pull main \(this checkout is on wp\/x\)/);
  assert.match(r.output, /kept local branch wp\/x \(it is checked out\)/);
  assert.match(r.output, /Deleted wp\/x on origin/);
  assert.match(calls().filter((c) => c.startsWith("pr merge")).at(-1), /--merge$/);
});

test("merge: gh exiting 0 is not the outcome — a queued PR touches no branch and says so (bughunt 2026-10-29 PR-3)", async () => {
  const { a, bare } = fixture();
  writeFileSync(F("merge.sh"), "true"); // the queue took it: nothing landed on origin/main yet
  put("state.json", { state: "OPEN" });
  rules = { ...RULES, mergeQueue: true };
  let r;
  try { r = await prs.mergePr(a, { number: 7 }); } finally { rules = RULES; }
  assert.equal(r.ok, true, r.error);
  assert.match(r.output, /queued/i);
  assert.match(r.output, /when it lands, the base is pulled and the head deleted/);
  assert.doesNotMatch(r.output, /^Merged/);
  assert.notEqual(sh(a, "branch", "--list", "wp/x"), "", "local head kept");
  assert.notEqual(sh(bare, "branch", "--list", "wp/x"), "", "origin head kept");
  assert.equal(sh(a, "log", "-1", "--format=%s"), "one", "base not pulled");
});

test("merge: a state that cannot be read touches no branch either", async () => {
  const { a, bare } = fixture();
  put("state.json", "not json");
  const r = await prs.mergePr(a, { number: 7 });
  assert.equal(r.ok, true, r.error);
  assert.doesNotMatch(r.output, /^Merged/);
  assert.match(r.output, /no branch was touched/i);
  assert.notEqual(sh(bare, "branch", "--list", "wp/x"), "");
});

test("merge: a method the repo does not allow is refused before gh", async () => {
  const { a } = fixture();
  const before = calls().length;
  const r = await prs.mergePr(a, { number: 7, method: "rebase" });
  assert.equal(r.ok, false);
  assert.match(r.error, /does not allow a rebase merge — it allows squash, merge/);
  assert.equal(calls().length, before);
});

// ── poll ordering (bughunt 2026-10-29 PR-8) ──────────────────────────────
test("one poll at a time: a timer firing while an action's refresh is in flight waits for it", async () => {
  const conc = F("conc.log");
  writeFileSync(conc, "");
  // Every list takes 200 ms and marks its start and end, so two in flight show as start,start.
  put("list.sh", `echo start >> "${conc}"; sleep 0.2; cat "${F("list.json")}"; echo end >> "${conc}"`);
  put("list.json", [raw()]);
  prs.setPrTiming({ leaseMs: 5_000, pollMs: 150 });
  try {
    const wt = join(root, "order"); mkdirSync(wt);
    prs.leasePrs(wt, "p");
    const marks = () => readFileSync(conc, "utf8").split("\n").filter(Boolean);
    for (let i = 0; i < 3; i++) {
      // Right after a poll ends the timer is armed for 150 ms; the close's refresh starts inside that gap.
      const seen = marks().length;
      assert.ok(await until(() => marks().length > seen && marks().at(-1) === "end"), "a poll finished");
      await prs.closePr(wt, { number: 7 });
      await sleep(250);
    }
    const m = marks();
    for (let i = 1; i < m.length; i++) assert.ok(!(m[i] === "start" && m[i - 1] === "start"), `two polls overlapped: ${m.join(",")}`);
  } finally {
    prs.stopAllPrs();
    execFileSync("rm", ["-f", F("list.sh")]);
    prs.setPrTiming({ leaseMs: 60_000, pollMs: 20_000 });
  }
});

test("the person's own merge is never news, even when a poll lands while gh is still merging", async () => {
  const sent = [];
  prs.setPrNotify({ notify: (k, p) => sent.push([k, p]), resolveAttention: () => 1 });
  prs.setPrTiming({ leaseMs: 5_000, pollMs: 30 });
  try {
    const { a } = fixture();
    put("list.json", [raw()]);
    prs.leasePrs(a, "p", { id: "repo2", name: "Repo" });
    assert.ok(await until(() => prs.cachedPrs(a).prs?.length === 1), "first reading");
    // GitHub merges, the list drops the PR, and gh takes a while longer to return: polls land in between.
    const merged = readFileSync(F("merge.sh"), "utf8");
    writeFileSync(F("merge.sh"), `${merged}\necho '[]' > "${F("list.json")}"\nsleep 0.4`);
    const r = await prs.mergePr(a, { number: 7 });
    assert.equal(r.ok, true, r.error);
    await sleep(200);
    assert.deepEqual(sent.map(([, p]) => p.title), [], "no notification for a merge the phone made");
  } finally {
    prs.stopAllPrs();
    prs.setPrNotify(null);
    prs.setPrTiming({ leaseMs: 60_000, pollMs: 20_000 });
  }
});

test("a merge that fails leaves the PR's later disappearance as news", async () => {
  const sent = [];
  prs.setPrNotify({ notify: (k, p) => sent.push([k, p]), resolveAttention: () => 1 });
  prs.setPrTiming({ leaseMs: 5_000, pollMs: 30 });
  try {
    const { a } = fixture();
    put("list.json", [raw()]);
    prs.leasePrs(a, "p", { id: "repo3", name: "Repo" });
    assert.ok(await until(() => prs.cachedPrs(a).prs?.length === 1), "first reading");
    writeFileSync(F("merge.sh"), "exit 1");
    const r = await prs.mergePr(a, { number: 7 });
    assert.equal(r.ok, false);
    put("list.json", []); // merged somewhere else afterwards
    assert.ok(await until(() => sent.length > 0), "merged elsewhere is news");
    assert.match(sent[0][1].title, /PR #7 merged/);
  } finally {
    execFileSync("rm", ["-f", F("merge.sh")]);
    prs.stopAllPrs();
    prs.setPrNotify(null);
    prs.setPrTiming({ leaseMs: 60_000, pollMs: 20_000 });
  }
});

// ── the poll owns a merge's outcome (review A2: M1, M2, L3, L4) ─────────
/** A leased fixture repo whose notifications are collected; `land(b)` is GitHub merging later. */
async function watched(id, extraRules = {}) {
  const sent = [];
  prs.setPrNotify({ notify: (k, p) => sent.push([k, p]), resolveAttention: () => 1 });
  prs.setPrTiming({ leaseMs: 5_000, pollMs: 30 });
  rules = { ...RULES, ...extraRules };
  const fx = fixture();
  put("list.json", [raw()]);
  prs.leasePrs(fx.a, "p", { id, name: "Repo" });
  assert.ok(await until(() => prs.cachedPrs(fx.a).prs?.length === 1), "first reading");
  return { ...fx, sent };
}
const land = (b) => sh(b, "commit", "--allow-empty", "-m", "merged", "-q") + sh(b, "push", "-q", "origin", "main");
const headOnOrigin = (bare) => sh(bare, "branch", "--list", "wp/x") !== "";
const done = () => {
  execFileSync("rm", ["-f", F("merge.sh")]);
  prs.stopAllPrs(); prs.setPrNotify(null); rules = RULES;
  prs.setPrTiming({ leaseMs: 60_000, pollMs: 20_000 });
};

test("M1: a lagging OPEN read right after a direct merge — the next poll that sees MERGED tidies, and says what it did — not as news", async () => {
  try {
    const { a, bare, sent } = await watched("rm1");
    put("state.json", { state: "OPEN" }); // GitHub merged (merge.sh) but the read lags
    const r = await prs.mergePr(a, { number: 7 });
    assert.equal(r.ok, true, r.error);
    assert.doesNotMatch(r.output, /^Merged/);
    assert.doesNotMatch(r.output, /queued/i, "no queue in this repo");
    assert.match(r.output, /when it does, the base is pulled and the head deleted/i);
    assert.ok(headOnOrigin(bare), "nothing touched on a lagging read");
    put("state.json", { state: "MERGED" });
    put("list.json", []);
    assert.ok(await until(() => !headOnOrigin(bare)), "the poll that saw MERGED deleted the head");
    assert.equal(sh(a, "log", "-1", "--format=%s"), "merged", "and pulled the base");
    await sleep(150);
    // Not "merged off the phone" news: ONE notice saying what the tidy did (nobody waits on the tap any more).
    assert.equal(prs.prTidyReceipts(a).length, 1, "tidied exactly once");
    const receipt = prs.prTidyReceipts(a)[0];
    assert.deepEqual(sent.map(([k, p]) => [k, p.title, p.body, p.outcome, p.key]), [["git", "PR #7 merged · Repo", receipt, "ok", "pr:rm1:7"]]);
    assert.doesNotMatch(receipt, /Not done/);
    assert.deepEqual(prs.prMergesAsked(a), []);
  } finally { done(); }
});

test("M2: a queued merge that later lands is tidied by the poll, and its one notice is the receipt", async () => {
  try {
    const { a, b, bare, sent } = await watched("rm2", { mergeQueue: true });
    writeFileSync(F("merge.sh"), "true"); // enqueued only
    put("state.json", { state: "OPEN" });
    const r = await prs.mergePr(a, { number: 7 });
    assert.match(r.output, /queued/i);
    await sleep(150);
    assert.ok(headOnOrigin(bare));
    land(b);
    put("state.json", { state: "MERGED" });
    put("list.json", []);
    assert.ok(await until(() => !headOnOrigin(bare)), "landed ⇒ head deleted");
    await sleep(150);
    assert.equal(prs.prTidyReceipts(a).length, 1);
    assert.deepEqual(sent.map(([, p]) => [p.title, p.body, p.outcome]), [["PR #7 merged · Repo", prs.prTidyReceipts(a)[0], "ok"]]);
  } finally { done(); }
});

test("M1 (A2b): a queued squash merge that lands later says what the tidy left undone, in the receipt", async () => {
  const pulls = [];
  gitmod.setGitOutcomeSink((o) => { pulls.push(o); });
  try {
    const { a, b, bare, sent } = await watched("rm7", { mergeQueue: true });
    // The head holds a commit main never gets as such (a squash): `git branch -d` refuses it.
    sh(a, "checkout", "-q", "wp/x"); writeFileSync(join(a, "g"), "2"); sh(a, "add", "g"); sh(a, "commit", "-q", "-m", "work");
    sh(a, "push", "-q", "origin", "wp/x"); sh(a, "checkout", "-q", "main");
    writeFileSync(F("merge.sh"), "true");
    put("state.json", { state: "OPEN" });
    const r = await prs.mergePr(a, { number: 7 });
    assert.match(r.output, /queued/i);
    land(b);
    put("state.json", { state: "MERGED" });
    put("list.json", []);
    assert.ok(await until(() => sent.length > 0), "the later tidy is said");
    await sleep(150);
    assert.equal(sent.length, 1, "once");
    const [k, p] = sent[0];
    assert.equal(k, "git");
    assert.equal(p.title, "PR #7 merged · Repo");
    assert.equal(p.outcome, "ok", "a squash's kept local head is routine (review A2c L3)");
    assert.equal(p.key, "pr:rm7:7");
    assert.match(p.body, /Not done: kept local branch wp\/x .*delete it yourself if you are sure/);
    assert.equal(p.detail, undefined);
    assert.deepEqual(p.open, { to: "git", repoId: "rm7" });
    assert.ok(!headOnOrigin(bare), "origin's head still deleted");
    // The tidy's pull is filed like the phone's own: the git outcome sink sees it, with the repo.
    assert.deepEqual(pulls.filter((o) => o.wt === a).map((o) => [o.verb, o.repo.id, o.ok]), [["pull", "rm7", true]]);
  } finally { gitmod.setGitOutcomeSink(null); done(); }
});

test("M2: a queued merge that someone else closes is news, and the record is gone", async () => {
  try {
    const { a, bare, sent } = await watched("rm3", { mergeQueue: true });
    writeFileSync(F("merge.sh"), "true");
    put("state.json", { state: "OPEN" });
    await prs.mergePr(a, { number: 7 });
    put("state.json", { state: "CLOSED" });
    put("list.json", []);
    assert.ok(await until(() => sent.length > 0), "closed elsewhere is news");
    assert.match(sent[0][1].title, /PR #7 closed/);
    assert.ok(headOnOrigin(bare), "a closed PR's head is not deleted");
    assert.deepEqual(prs.prMergesAsked(a), []);
  } finally { done(); }
});

test("L3: a state that cannot be read keeps the record until a later poll can read it", async () => {
  try {
    const { a, bare, sent } = await watched("rm4");
    writeFileSync(F("merge.sh"), `${readFileSync(F("merge.sh"), "utf8")}\necho '[]' > "${F("list.json")}"`);
    put("state.json", "not json");
    const r = await prs.mergePr(a, { number: 7 });
    assert.match(r.output, /could not be read back/);
    await sleep(200); // several polls, all unreadable
    assert.ok(headOnOrigin(bare));
    assert.deepEqual(prs.prMergesAsked(a), [7]);
    assert.deepEqual(sent, [], "an unread state is not news either");
    put("state.json", { state: "MERGED" });
    assert.ok(await until(() => !headOnOrigin(bare)), "resolved by the later poll");
    await sleep(100);
    assert.deepEqual(sent.map(([, p]) => [p.title, p.outcome]), [["PR #7 merged · Repo", "ok"]], "the tidy is said, once");
  } finally { done(); }
});

test("L4: gh killed after a real merge — the later MERGED reading is the person's merge, not news", async () => {
  try {
    const { a, bare, sent } = await watched("rm5");
    // GitHub merges, then gh is ended before it answers (what the 60 s execFile timeout does).
    writeFileSync(F("merge.sh"), `${readFileSync(F("merge.sh"), "utf8")}\necho '[]' > "${F("list.json")}"\nkill -TERM $PPID; sleep 1`);
    put("state.json", { state: "OPEN" }); // and the read right after lags
    const r = await prs.mergePr(a, { number: 7 });
    assert.equal(r.ok, true, r.error);
    assert.doesNotMatch(r.output, /did not merge/);
    assert.match(r.output, /may still have merged/);
    put("state.json", { state: "MERGED" });
    assert.ok(await until(() => !headOnOrigin(bare)), "tidied once seen merged");
    await sleep(100);
    assert.deepEqual(sent.map(([, p]) => p.title), ["PR #7 merged · Repo"], "said as the tidy's notice, not as news");
    assert.equal(sent[0][1].body, prs.prTidyReceipts(a)[0]);
  } finally { done(); }
});

test("an asked merge that never resolves ages out, and a later disappearance is news again", async () => {
  try {
    const { a, sent } = await watched("rm6");
    prs.setPrTiming({ askedMs: 100 });
    writeFileSync(F("merge.sh"), "true");
    put("state.json", { state: "OPEN" });
    await prs.mergePr(a, { number: 7 });
    assert.deepEqual(prs.prMergesAsked(a), [7]);
    assert.ok(await until(() => prs.prMergesAsked(a).length === 0), "aged out");
    put("state.json", { state: "MERGED" });
    put("list.json", []);
    assert.ok(await until(() => sent.length > 0), "merged later, by someone, after the bound: news");
  } finally { prs.setPrTiming({ askedMs: 24 * 3600_000 }); done(); }
});

test("L2 (A2b): two readers both seeing MERGED — the poll's and the tap's own — run ONE tidy and share its receipt", async () => {
  try {
    const { a, bare, sent } = await watched("rm9");
    // GitHub merges and the list drops the PR while gh is still returning: a poll reads MERGED first.
    writeFileSync(F("merge.sh"), `${readFileSync(F("merge.sh"), "utf8")}\necho '[]' > "${F("list.json")}"\nsleep 0.6`);
    const r = await prs.mergePr(a, { number: 7 }); // ...and the tap's own read then sees MERGED too
    assert.equal(r.ok, true, r.error);
    assert.equal(prs.prTidyReceipts(a).length, 1, "the poll claimed it while gh was still merging");
    assert.equal(r.output, prs.prTidyReceipts(a)[0], "the tap answers with the one tidy's receipt");
    assert.match(r.output, /^Merged PR #7 \(squash\)\. Pulled main\. Deleted local branch wp\/x\. Deleted wp\/x on origin\.$/, "a second tidy would say 'already gone'");
    assert.ok(!headOnOrigin(bare));
    await sleep(150);
    assert.deepEqual(sent, [], "the waiting tap is the receipt; no notice beside it");
  } finally { done(); }
});

test("L1 (A2b): a queued merge survives a host restart — the record is on disk and the later landing is tidied", async () => {
  try {
    const { a, b, bare, sent } = await watched("rm10", { mergeQueue: true });
    writeFileSync(F("merge.sh"), "true");
    put("state.json", { state: "OPEN" });
    const r = await prs.mergePr(a, { number: 7 });
    assert.match(r.output, /queued/i);
    const kept = JSON.parse(readFileSync(STORE, "utf8"));
    assert.deepEqual(Object.keys(kept[a] ?? {}), ["7"], "kept on disk the moment it was asked");
    assert.equal(kept[a]["7"].head, "wp/x");
    // The restart: every watch and record in memory is gone; the file is read again.
    prs.stopAllPrs();
    prs.setPrMergeStore(STORE);
    assert.deepEqual(prs.prMergesAsked(a), [7], "loaded back");
    land(b);
    put("state.json", { state: "MERGED" });
    put("list.json", []);
    prs.leasePrs(a, "p", { id: "rm10", name: "Repo" }); // the card opens again after the restart
    assert.ok(await until(() => !headOnOrigin(bare)), "the landing is the person's merge: tidied");
    await sleep(150);
    assert.deepEqual(sent.map(([, p]) => p.title), ["PR #7 merged · Repo"], "said as the tidy, not as merged-elsewhere news");
    assert.deepEqual(JSON.parse(readFileSync(STORE, "utf8"))[a] ?? {}, {}, "settled ⇒ gone from disk");
  } finally { done(); }
});

test("the asked-merge store drops a row that does not clean and survives a corrupt file", async () => {
  const st = await import("../dist/prmergestore.js");
  const p = F("store-clean.json");
  writeFileSync(p, JSON.stringify({ "/w": { "7": { method: "squash", head: "h", base: "main", at: 5 }, "x": { method: "squash", head: "h", base: "main", at: 5 }, "8": { head: "h" } } }));
  assert.deepEqual([...st.loadAskedMerges(p).get("/w").keys()], [7]);
  writeFileSync(p, "{ not json");
  assert.equal(st.loadAskedMerges(p).size, 0);
});

test("L4 (A2b): a merge first read MERGED past the age bound is still the person's — tidied, not dropped", async () => {
  try {
    const { a, bare, sent } = await watched("rm8");
    writeFileSync(F("merge.sh"), `${readFileSync(F("merge.sh"), "utf8")}\necho '[]' > "${F("list.json")}"`);
    put("state.json", "not json"); // unreadable for longer than the bound (expired gh auth, or nobody looking)
    await prs.mergePr(a, { number: 7 });
    prs.setPrTiming({ askedMs: 100 });
    await sleep(350); // several polls past the bound, none could read the state
    assert.deepEqual(prs.prMergesAsked(a), [7], "not dropped on age before a reading");
    put("state.json", { state: "MERGED" });
    assert.ok(await until(() => !headOnOrigin(bare)), "tidied once it reads MERGED");
    await sleep(100);
    assert.deepEqual(sent.map(([, p]) => p.title), ["PR #7 merged · Repo"], "the tidy's notice, not merged-elsewhere news");
  } finally { prs.setPrTiming({ askedMs: 24 * 3600_000 }); done(); }
});

// ── review A2c: one place says "was this ours"; the record outlives the tidy; never zero ──
/** origin answers a delete of the head with `script` (a pre-receive hook): slow, or refused. */
const onHeadDelete = (bare, script) => {
  writeFileSync(join(bare, "hooks", "pre-receive"), `#!/bin/sh
while read old new ref; do
  if [ "$ref" = "refs/heads/wp/x" ] && [ "$new" = "0000000000000000000000000000000000000000" ]; then ${script}; fi
done
exit 0
`);
  chmodSync(join(bare, "hooks", "pre-receive"), 0o755);
};

test("M1 (A2c): the tap reads MERGED before the poll's list comes back — the tap's receipt is the only word, never 'merged' news beside it", async () => {
  try {
    const { a, bare, sent } = await watched("rc1");
    put("list.sh", `sleep 0.6; echo '[]'`); // the heavier list call returns after the tap's light state read
    const r = await prs.mergePr(a, { number: 7 });
    assert.match(r.output, /^Merged PR #7/);
    assert.ok(!headOnOrigin(bare));
    assert.ok(await until(() => prs.cachedPrs(a).prs?.length === 0), "the slow list landed without #7");
    await sleep(150);
    assert.deepEqual(sent, [], "the tap's receipt only");
  } finally { execFileSync("rm", ["-f", F("list.sh")]); done(); }
});

test("L2 (A2c): the record stays on disk until the tidy settles — a restart mid-tidy finds it and retries", async () => {
  try {
    const { a, bare, sent } = await watched("rc2");
    onHeadDelete(bare, "sleep 0.8");
    writeFileSync(F("merge.sh"), `${readFileSync(F("merge.sh"), "utf8")}\necho '[]' > "${F("list.json")}"`);
    const tap = prs.mergePr(a, { number: 7 });
    const onDisk = () => Object.keys(JSON.parse(readFileSync(STORE, "utf8"))[a] ?? {});
    assert.ok(await until(() => sh(a, "branch", "--list", "wp/x") === ""), "the tidy is under way");
    await sleep(200); // inside the slow origin delete
    assert.deepEqual(onDisk(), ["7"], "mid-tidy the record is still kept");
    const r = await tap;
    assert.match(r.output, /Deleted wp\/x on origin/);
    assert.deepEqual(onDisk(), [], "settled ⇒ gone from disk");
    assert.deepEqual(sent, []);
  } finally { done(); }
});

test("L3 (A2c): a squash merge's kept local head is routine — an ok notice with the receipt, never attention", async () => {
  const resolved = [];
  try {
    const { a, b, sent } = await watched("rc3", { mergeQueue: true });
    prs.setPrNotify({ notify: (k, p) => sent.push([k, p]), resolveAttention: (k) => { resolved.push(k); return 1; } });
    sh(a, "checkout", "-q", "wp/x"); writeFileSync(join(a, "g"), "2"); sh(a, "add", "g"); sh(a, "commit", "-q", "-m", "work");
    sh(a, "push", "-q", "origin", "wp/x"); sh(a, "checkout", "-q", "main");
    writeFileSync(F("merge.sh"), "true");
    put("state.json", { state: "OPEN" });
    await prs.mergePr(a, { number: 7 });
    land(b);
    put("state.json", { state: "MERGED" });
    put("list.json", []);
    assert.ok(await until(() => sent.length > 0));
    await sleep(150);
    assert.equal(sent.length, 1);
    const p = sent[0][1];
    assert.equal(p.outcome, "ok", "nothing here needs the person");
    assert.match(p.body, /kept local branch wp\/x .*delete it yourself if you are sure/, "the note still rides in the receipt");
    assert.equal(p.detail, undefined);
    assert.deepEqual(resolved, ["pr:rc3:7"], "an earlier check-failed attention is cleared");
  } finally { done(); }
});

test("L1 (A2c): a tap whose tidy left something needing the person also files it as attention — never only the transient answer", async () => {
  try {
    const { a, bare, sent } = await watched("rc4");
    onHeadDelete(bare, `echo "policy says no" >&2; exit 1`);
    const r = await prs.mergePr(a, { number: 7 });
    assert.match(r.output, /Not done: kept wp\/x on origin/);
    assert.ok(await until(() => sent.length > 0), "said through notify too");
    await sleep(150);
    assert.equal(sent.length, 1, "once");
    const p = sent[0][1];
    assert.equal(p.outcome, "failed");
    assert.equal(p.key, "pr:rc4:7");
    assert.equal(p.body, r.output);
    assert.equal(p.detail, r.output);
  } finally { done(); }
});

// ── review A2d: one owner for "who is told" ──
/** Attention as the tray keeps it: a failed notice opens its key, resolveAttention closes it. */
function attention() {
  const open = new Set(), sent = [];
  const notify = (k, p) => { sent.push([k, p]); if (p.outcome === "failed" && p.key) open.add(p.key); };
  const resolveAttention = (key) => (open.delete(key) ? 1 : 0);
  return { open, sent, notify, resolveAttention };
}

test("F1 (A2d): a tidy's failed pull is the git sink's alone — one attention item, and a later good pull leaves none", async () => {
  const gitnotify = await import("../dist/gitnotify.js");
  const at = attention();
  gitmod.setGitOutcomeSink((o) => gitnotify.reportGitOutcome(o, at));
  try {
    const { a } = await watched("re1");
    prs.setPrNotify(at);
    sh(a, "branch", "--unset-upstream"); // the tidy's pull is refused
    const r = await prs.mergePr(a, { number: 7 });
    assert.match(r.output, /Not done: did not pull main/, "the receipt still says it");
    assert.ok(await until(() => at.open.size > 0));
    await sleep(150);
    assert.deepEqual([...at.open], ["git:re1:pull"], "one attention item, owned by the git sink");
    sh(a, "branch", "-u", "origin/main");
    const p = await gitmod.gitPull(a, { id: "re1", name: "Repo" });
    assert.equal(p.ok, true, p.error);
    assert.ok(await until(() => at.open.size === 0), `none left: ${[...at.open]}`);
  } finally { gitmod.setGitOutcomeSink(null); done(); }
});

test("F3 (A2d): a detached HEAD during the tidy is attention, worded, never a routine leftover", async () => {
  try {
    const { a, sent } = await watched("re2");
    sh(a, "checkout", "-q", "--detach");
    const r = await prs.mergePr(a, { number: 7 });
    assert.match(r.output, /did not pull main \(this checkout is not on a branch/);
    assert.ok(await until(() => sent.length > 0), "filed as attention, not only the tap's toast");
    await sleep(150);
    assert.deepEqual(sent.map(([, p]) => [p.outcome, p.key]), [["failed", "pr:re2:7"]]);
  } finally { done(); }
});

test("F4 (A2d): a tidy that throws is said once as not done, and the tap answers in words", async () => {
  try {
    const { a, sent } = await watched("re3");
    prs.setPrGitPull(async () => { throw new Error("rev-list exploded"); });
    const r = await prs.mergePr(a, { number: 7 });
    assert.equal(r.ok, true);
    assert.match(r.output, /^Merged PR #7 \(squash\)\. Not done: the tidy stopped: rev-list exploded\.$/);
    assert.ok(await until(() => sent.length > 0));
    await sleep(150);
    assert.deepEqual(sent.map(([, p]) => [p.outcome, p.key, p.body]), [["failed", "pr:re3:7", r.output]]);
    assert.deepEqual(prs.prMergesAsked(a), []);
  } finally { prs.setPrGitPull(null); done(); }
});

test("F4 (A2d): a poll whose tidy throws files it and still settles the other asked records", async () => {
  try {
    const { a, sent } = await watched("re4", { mergeQueue: true });
    writeFileSync(F("merge.sh"), "true");
    put("state.json", { state: "OPEN" });
    put("view.json", { headRefName: "wp/x", baseRefName: "main", state: "OPEN" });
    await prs.mergePr(a, { number: 7 });
    put("view.json", { headRefName: "wp/y", baseRefName: "main", state: "OPEN" });
    await prs.mergePr(a, { number: 8 });
    assert.deepEqual(prs.prMergesAsked(a).sort(), [7, 8]);
    prs.setPrGitPull(async () => { throw new Error("status exploded"); });
    put("state.json", { state: "MERGED" });
    put("list.json", []);
    assert.ok(await until(() => sent.length >= 2), "both records are said");
    await sleep(150);
    assert.deepEqual(sent.map(([, p]) => [p.outcome, p.key]).sort(), [["failed", "pr:re4:7"], ["failed", "pr:re4:8"]]);
    assert.deepEqual(prs.prMergesAsked(a), []);
  } finally { prs.setPrGitPull(null); done(); }
});

test("L6 (A2c): the asked-merge store is a live file in the host-store catalogue, never 'unknown'", async () => {
  const { hostStoreReport } = await import("../dist/hoststore.js");
  const { BRAND } = await import("@waterplane/shared");
  const dir = mkdtempSync(join(tmpdir(), "prs-hs-"));
  try {
    mkdirSync(join(dir, BRAND.stateDirName));
    writeFileSync(join(dir, BRAND.stateDirName, "pr-merges-asked.json"), "{}");
    const rows = hostStoreReport(dir).rows;
    assert.equal(rows.find((r) => r.id === "unknown")?.count ?? 0, 0);
    assert.equal(rows.find((r) => r.id === "live")?.count, 1);
  } finally { execFileSync("rm", ["-rf", dir]); }
});

test("L4 (A2c): a record asked longer ago than the unread bound (7 × a day) is dropped on load; a younger one is kept", async () => {
  const p = F("store-age.json");
  const day = 24 * 3600_000;
  writeFileSync(p, JSON.stringify({
    "/old": { "7": { method: "squash", head: "h", base: "main", at: Date.now() - 8 * day } },
    "/young": { "7": { method: "squash", head: "h", base: "main", at: Date.now() - 6 * day } },
  }));
  try {
    prs.stopAllPrs();
    prs.setPrMergeStore(p);
    assert.deepEqual(prs.prMergesAsked("/old"), [], "past the bound it is no longer assumed the person's");
    assert.deepEqual(prs.prMergesAsked("/young"), [7]);
    assert.deepEqual(Object.keys(JSON.parse(readFileSync(p, "utf8"))), ["/young"], "and the file follows");
  } finally { prs.stopAllPrs(); prs.setPrMergeStore(STORE); }
});

// ── auto-merge, close, log ───────────────────────────────────────────────
test("auto-merge is refused in words when the repo does not allow it; off is always allowed", async () => {
  const before = calls().length;
  const r = await prs.autoMergePr(root, { number: 7, on: true });
  assert.equal(r.ok, false);
  assert.match(r.error, /does not allow auto-merge/);
  assert.equal(calls().length, before);
  const off = await prs.autoMergePr(root, { number: 7, on: false });
  assert.equal(off.ok, true);
  assert.match(calls().at(-1), /^pr merge 7 --disable-auto$/);
  rules = { ...RULES, autoMerge: true };
  const on = await prs.autoMergePr(root, { number: 7, on: true });
  assert.equal(on.ok, true);
  assert.match(calls().at(-1), /^pr merge 7 --auto --squash$/);
  rules = RULES;
});

test("auto-merge uses the method the person picked, and refuses one the repo does not allow (bughunt 2026-10-29 PR-6)", async () => {
  rules = { ...RULES, autoMerge: true };
  try {
    const on = await prs.autoMergePr(root, { number: 7, on: true, method: "merge" });
    assert.equal(on.ok, true, on.error);
    assert.match(calls().at(-1), /^pr merge 7 --auto --merge$/);
    const before = calls().length;
    const no = await prs.autoMergePr(root, { number: 7, on: true, method: "rebase" });
    assert.equal(no.ok, false);
    assert.match(no.error, /does not allow a rebase merge — it allows squash, merge/);
    assert.equal(calls().length, before, "refused before gh");
    assert.equal((await prs.autoMergePr(root, { number: 7, on: true, method: "fast" })).ok, false);
  } finally { rules = RULES; }
});

test("close runs gh pr close and leaves the branch", async () => {
  const r = await prs.closePr(root, { number: 7 });
  assert.equal(r.ok, true);
  assert.match(calls().at(-1), /^pr close 7$/);
  assert.equal((await prs.closePr(root, { number: "7; rm" })).ok, false);
});

test("failing log: the last 80 lines of the failed run, or the check's page when it is no Actions run", async () => {
  put("list.json", [raw({ statusCheckRollup: [run(1, "ci", "FAILURE", "https://github.com/o/r/actions/runs/55/job/1")] })]);
  put("runlog.txt", Array.from({ length: 200 }, (_, i) => `\u001b[31mline ${i + 1}\u001b[0m`).join("\n") + "\n");
  const r = await prs.failingLog(root, { number: 7 });
  assert.equal(r.ok, true);
  const lines = r.output.split("\n");
  assert.equal(lines.length, 80);
  assert.equal(lines[0], "line 121");
  assert.equal(lines.at(-1), "line 200");
  assert.match(calls().at(-1), /^run view 55 --log-failed$/);
  put("list.json", [raw({ statusCheckRollup: [{ __typename: "StatusContext", context: "jenkins", state: "FAILURE", targetUrl: "https://ci.example/b/5" }] })]);
  const s = await prs.failingLog(root, { number: 7 });
  assert.equal(s.url, "https://ci.example/b/5");
  assert.match(s.output, /not a GitHub Actions run/);
  put("list.json", [raw()]);
  assert.equal((await prs.failingLog(root, { number: 7 })).ok, false);
});
