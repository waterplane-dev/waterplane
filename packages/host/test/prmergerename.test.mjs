/**
 * A merge asked on the PR card survives its checkout folder being renamed (~/dev/before →
 * ~/dev/after-rename): the record carries the PR's origin, and on load a record whose folder is gone
 * moves to the ONE listed checkout with that origin, so its later landing is still settled as the
 * person's merge. Several or none ⇒ it stays, said once, and ages out; a record written before the
 * origin existed behaves as before (design round 4).
 *
 *     node --test packages/host/test/prmergerename.test.mjs
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, realpathSync, renameSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = realpathSync(mkdtempSync(join(tmpdir(), "prrename-")));
const bin = join(root, "bin"); mkdirSync(bin);
const F = (n) => join(root, n);
writeFileSync(join(bin, "gh"), `#!/bin/sh
case "$1 $2" in
  "pr list") cat "${F("list.json")}";;
  "pr view") if [ "$4" = "state" ] || [ "$5" = "state" ]; then cat "${F("state.json")}"; else cat "${F("view.json")}"; fi;;
  "pr merge") exit 0;;
  *) exit 1;;
esac
`);
chmodSync(join(bin, "gh"), 0o755);
process.env.PATH = `${bin}:${process.env.PATH}`;
const put = (n, v) => writeFileSync(F(n), JSON.stringify(v));

const prs = await import("../dist/prs.js");
const st = await import("../dist/prmergestore.js");
const STORE = F("pr-merges-asked.json");
prs.setPrMergeStore(STORE);
const RULES = { mode: "pr", requiredChecks: [], requiredApprovals: 1, allowedMerge: ["squash", "merge"], autoMerge: false, mergeQueue: true };
prs.setPrRules(async () => RULES);
const realWarn = console.warn, realLog = console.log;
after(() => { prs.stopAllPrs(); prs.setPrRepoLister(null); prs.setPrMergeStore(null); console.warn = realWarn; console.log = realLog; execFileSync("rm", ["-rf", root]); });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms = 5000) => { const end = Date.now() + ms; while (!fn()) { if (Date.now() > end) return false; await sleep(20); } return true; };
const sh = (cwd, ...a) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", ...a], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const raw = { number: 7, title: "Add x", headRefName: "wp/x", url: "https://github.com/o/r/pull/7", reviewDecision: "REVIEW_REQUIRED", mergeable: "MERGEABLE", autoMergeRequest: null, statusCheckRollup: [] };
let n = 0;
/** A clone `before` of a bare origin with a pushed head `wp/x`, a second clone `b` that lands merges,
 *  and a queued merge of PR #7 asked in `before`, then the host "restarts". */
async function askedThenRestart() {
  const d = join(root, `m${++n}`); mkdirSync(d);
  const bare = join(d, "o.git"), a = join(d, "before"), b = join(d, "b");
  sh(d, "init", "--bare", "-b", "main", bare);
  sh(d, "clone", bare, a);
  sh(a, "checkout", "-b", "main");
  writeFileSync(join(a, "f"), "1"); sh(a, "add", "f"); sh(a, "commit", "-m", "one");
  sh(a, "push", "-u", "origin", "main");
  sh(a, "branch", "wp/x"); sh(a, "push", "origin", "wp/x");
  sh(d, "clone", bare, b);
  put("view.json", { headRefName: "wp/x", baseRefName: "main", state: "OPEN" });
  put("state.json", { state: "OPEN" });
  put("list.json", [raw]);
  const r = await prs.mergePr(a, { number: 7 });
  assert.equal(r.ok, true, r.error);
  assert.match(r.output, /queued/i);
  assert.equal(JSON.parse(readFileSync(STORE, "utf8"))[a]["7"].origin, bare, "the record carries the PR's origin");
  prs.stopAllPrs();
  return { d, bare, a, b, a2: join(d, "after-rename") };
}

test("originKey: GitHub's ssh and https spell one repo the same; another remote is its URL; none is absent", () => {
  assert.equal(st.originKey("git@github.com:o/r.git"), "o/r");
  assert.equal(st.originKey("https://github.com/o/r\n"), "o/r");
  assert.equal(st.originKey("/srv/git/o.git"), "/srv/git/o.git");
  assert.equal(st.originKey(""), undefined);
  assert.equal(st.originKey(null), undefined);
});

test("originKey: credentials in an http(s) remote never survive, on any host; scp-style is kept as is", () => {
  assert.equal(st.originKey("https://user:ghp_SECRET@ghe.corp/o/r.git"), "https://ghe.corp/o/r.git");
  assert.equal(st.originKey("https://ghp_SECRET@GHE.Corp/o/r"), "https://ghe.corp/o/r");
  assert.equal(st.originKey("http://u:p@git.example.test:8080/o/r"), "http://git.example.test:8080/o/r");
  assert.equal(st.originKey("https://x-access-token:SECRET@github.com/o/r.git"), "o/r");
  assert.equal(st.originKey("git@ghe.corp:o/r.git"), "git@ghe.corp:o/r.git");
  assert.equal(st.originKey("ssh://git@ghe.corp/o/r.git"), "ssh://git@ghe.corp/o/r.git");
});

test("a record whose remote URL carries a token: neither the file nor the log ever holds the token", async () => {
  const warned = [];
  console.warn = (...a) => warned.push(a.join(" "));
  try {
    const d = join(root, `tok${++n}`); mkdirSync(d);
    const wt = join(d, "before");
    sh(d, "init", "-q", "-b", "main", wt);
    sh(wt, "remote", "add", "origin", "https://user:ghp_TOPSECRET@ghe.corp/o/r.git");
    put("view.json", { headRefName: "wp/x", baseRefName: "main", state: "OPEN" });
    put("state.json", { state: "OPEN" });
    put("list.json", [raw]);
    const r = await prs.mergePr(wt, { number: 7 });
    assert.equal(r.ok, true, r.error);
    prs.stopAllPrs();
    const disk = readFileSync(STORE, "utf8");
    assert.ok(!disk.includes("TOPSECRET") && !disk.includes("user:"), disk);
    assert.equal(JSON.parse(disk)[wt]["7"].origin, "https://ghe.corp/o/r.git");
    // An older file that already holds one is scrubbed on the way in.
    writeFileSync(STORE, JSON.stringify({ [wt]: { "7": { method: "squash", head: "h", base: "main", at: Date.now(), origin: "https://user:ghp_TOPSECRET@ghe.corp/o/r.git" } } }));
    renameSync(wt, join(d, "after-rename"));
    prs.setPrRepoLister(async () => []);
    prs.setPrMergeStore(STORE);
    prs.prMergesAsked(wt);
    await prs.prMergesRehomed();
    assert.equal(warned.filter((w) => /PR #7/.test(w)).length, 1, warned.join("\n"));
    assert.ok(!warned.join("\n").includes("TOPSECRET"), warned.join("\n"));
  } finally {
    console.warn = realWarn;
    prs.stopAllPrs();
    writeFileSync(STORE, "{}");
  }
});

test("rehomeTarget: exactly one other checkout with the origin, else none; no origin is no match", () => {
  const repos = [{ path: "/x/new", origin: "o/r" }, { path: "/x/other", origin: "o/q" }];
  assert.deepEqual(st.rehomeTarget({ origin: "o/r" }, "/x/old", repos), { to: "/x/new", matches: 1 });
  assert.deepEqual(st.rehomeTarget({ origin: "o/r" }, "/x/old", [...repos, { path: "/y/new", origin: "o/r" }]), { matches: 2 });
  assert.deepEqual(st.rehomeTarget({ origin: "o/z" }, "/x/old", repos), { matches: 0 });
  assert.deepEqual(st.rehomeTarget({}, "/x/old", repos), { matches: 0 });
});

test("a merge asked before the checkout's folder was renamed is settled after the restart under the new path", async () => {
  const sent = [];
  const logs = [];
  console.log = (...a) => logs.push(a.join(" "));
  try {
    prs.setPrNotify({ notify: (k, p) => sent.push([k, p]), resolveAttention: () => 1 });
    prs.setPrTiming({ leaseMs: 5_000, pollMs: 30 });
    const { a, a2, b, bare } = await askedThenRestart();
    renameSync(a, a2);
    prs.setPrRepoLister(async () => [{ path: a2, primary: true }]);
    prs.setPrMergeStore(STORE);
    prs.prMergesAsked(a2); // the first read after the restart loads the file
    await prs.prMergesRehomed();
    assert.deepEqual(prs.prMergesAsked(a2), [7], "the record followed the repo");
    assert.deepEqual(prs.prMergesAsked(a), []);
    const kept = JSON.parse(readFileSync(STORE, "utf8"));
    assert.equal(kept[a], undefined, "the old path is gone from disk");
    assert.equal(kept[a2]["7"].head, "wp/x");
    assert.ok(logs.some((l) => l.includes(a2)), logs.join("\n"));
    // The queue lands later; the card opens on the renamed checkout.
    sh(b, "commit", "--allow-empty", "-m", "merged", "-q"); sh(b, "push", "-q", "origin", "main");
    put("state.json", { state: "MERGED" });
    put("list.json", []);
    prs.leasePrs(a2, "p", { id: "rn1", name: "Repo" });
    assert.ok(await until(() => sh(bare, "branch", "--list", "wp/x") === ""), "settled as the person's merge: the head is deleted");
    await sleep(150);
    assert.deepEqual(sent.map(([, p]) => p.title), ["PR #7 merged · Repo"], "said as the tidy, never as somebody else's merge");
    assert.equal(sh(a2, "log", "-1", "--format=%s"), "merged", "and the base pulled in the renamed checkout");
    assert.deepEqual(JSON.parse(readFileSync(STORE, "utf8"))[a2] ?? {}, {}, "settled ⇒ gone from disk");
  } finally {
    console.log = realLog;
    prs.stopAllPrs(); prs.setPrNotify(null); prs.setPrTiming({ leaseMs: 60_000, pollMs: 20_000 });
  }
});

test("several checkouts with that origin: the record stays where it was, said once, never guessed", async () => {
  const warned = [];
  console.warn = (...a) => warned.push(a.join(" "));
  try {
    const { a, a2, b } = await askedThenRestart();
    renameSync(a, a2);
    prs.setPrRepoLister(async () => [{ path: a2, primary: true }, { path: b, primary: true }]);
    prs.setPrMergeStore(STORE);
    prs.prMergesAsked(a2);
    await prs.prMergesRehomed();
    assert.deepEqual(prs.prMergesAsked(a2), []);
    assert.deepEqual(prs.prMergesAsked(b), []);
    assert.deepEqual(prs.prMergesAsked(a), [7], "kept to age out");
    assert.equal(warned.filter((w) => /PR #7/.test(w)).length, 1, warned.join("\n"));
    assert.match(warned.find((w) => /PR #7/.test(w)), /2 listed checkouts/);
  } finally {
    console.warn = realWarn;
    prs.stopAllPrs();
    writeFileSync(STORE, "{}");
  }
});

test("a record written before the origin existed stays under its path, quietly, as before", async () => {
  const warned = [];
  console.warn = (...a) => warned.push(a.join(" "));
  try {
    const gone = join(root, "gone");
    writeFileSync(STORE, JSON.stringify({ [gone]: { "9": { method: "squash", head: "h", base: "main", at: Date.now() } } }));
    let asked = 0;
    prs.setPrRepoLister(async () => { asked++; return []; });
    prs.setPrMergeStore(STORE);
    prs.prMergesAsked(gone);
    await prs.prMergesRehomed();
    assert.deepEqual(prs.prMergesAsked(gone), [9]);
    assert.equal(asked, 1, "the re-home ran (its folder is gone) and still left the origin-less record where it was");
    assert.deepEqual(warned, []);
  } finally {
    console.warn = realWarn;
    prs.stopAllPrs();
    writeFileSync(STORE, "{}");
  }
});
