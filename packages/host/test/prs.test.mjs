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
  "pr list") cat "${F("list.json")}";;
  "pr view") if [ "$4" = "state" ] || [ "$5" = "state" ]; then cat "${F("state.json")}"; else cat "${F("view.json")}"; fi;;
  "pr merge") [ -f "${F("merge.sh")}" ] && sh "${F("merge.sh")}"; exit 0;;
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
  return { a, bare };
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

test("merge: a method the repo does not allow is refused before gh", async () => {
  const { a } = fixture();
  const before = calls().length;
  const r = await prs.mergePr(a, { number: 7, method: "rebase" });
  assert.equal(r.ok, false);
  assert.match(r.error, /does not allow a rebase merge — it allows squash, merge/);
  assert.equal(calls().length, before);
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
