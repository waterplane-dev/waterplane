/**
 * A pull whose fetch failed on the NETWORK is not "needs you" (2026-11-03: three SSH pulls from
 * one "pull all" hit the 120 s timeout together, printed nothing, and became three unexplained
 * attention items). `gitfetchfail.ts` names the reason and the cause; `gitnotify.ts` turns a
 * burst of network failures into ONE info notice, and files attention only when the same repo
 * keeps failing that way.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

const { fetchFailure } = await import("../dist/gitfetchfail.js");
const { reportGitOutcome, NETWORK_STRIKES } = await import("../dist/gitnotify.js");

test("a fetch killed by the timeout, with no stderr, is a network failure that says so", () => {
  const err = Object.assign(new Error("Command failed: git fetch --no-tags"), { killed: true, signal: "SIGTERM", stderr: "", stdout: "" });
  assert.deepEqual(fetchFailure(err, 120_000), { reason: "no answer from the remote within 2 min", network: true });
});

test("transport errors are network; auth and a missing repo are not", () => {
  const f = (stderr) => fetchFailure(Object.assign(new Error("x"), { stderr }), 120_000);
  assert.deepEqual(f("ssh: Could not resolve hostname github.com: nodename nor servname provided, or not known\nfatal: Could not read from remote repository."),
    { reason: "Could not resolve hostname github.com: nodename nor servname provided, or not known", network: true });
  assert.equal(f("ssh: connect to host github.com port 22: Operation timed out").network, true);
  assert.equal(f("fatal: unable to access 'https://github.com/a/b.git/': Failed to connect to github.com port 443").network, true);
  const auth = f("git@github.com: Permission denied (publickey).\nfatal: Could not read from remote repository.\n\nPlease make sure you have the correct access rights\nand the repository exists.");
  assert.deepEqual(auth, { reason: "git@github.com: Permission denied (publickey)", network: false });
  assert.deepEqual(f("ERROR: Repository not found.\nfatal: Could not read from remote repository."), { reason: "Repository not found", network: false });
  assert.deepEqual(f(""), { reason: "git gave no reason", network: false });
});

test("a silent failure names which kind it was — these leave the same message, so only the fields tell", () => {
  const f = (fields) => fetchFailure(Object.assign(new Error("Command failed: git fetch --no-tags\n"), { stderr: "", ...fields }), 120_000);
  assert.deepEqual(f({ killed: false, signal: "SIGTERM", code: null }), { reason: "git was stopped by SIGTERM", network: false });
  assert.deepEqual(f({ killed: false, signal: null, code: 1 }), { reason: "git exited with 1 and gave no reason", network: false });
  assert.equal(f({ killed: true, signal: "SIGTERM", code: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER" }).network, false, "an output overflow is no network fault");
  assert.equal(f({ killed: true, signal: "SIGTERM", code: null, stderr: "remote: Counting objects" }).network, true, "a timed-out fetch that printed something is still a timeout");
});

function deps() {
  const sent = [];
  return { sent, ctx: { notify: (kind, p) => sent.push(p), resolveAttention: () => 0, networkBurstMs: 20 } };
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const netFail = (id, name) => ({
  repo: { id, name }, verb: "pull", ok: false, cause: "network", startedAt: 0, finishedAt: 1,
  error: "The fetch from origin/main failed: no answer from the remote within 2 min — nothing was changed.\n\nError: Command failed: git fetch --no-tags",
});

test("a burst of network-failed pulls is ONE info notice naming every repo, no attention", async () => {
  const { sent, ctx } = deps();
  for (const [id, name] of [["r1", "realestatecalc"], ["r2", "picture-app"], ["r3", "security-knowledge"]]) await reportGitOutcome(netFail(id, name), ctx);
  assert.equal(sent.length, 0, "nothing yet — the burst is still being gathered");
  await wait(60);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].level, "info");
  assert.equal(sent[0].key, undefined, "no attention key");
  assert.equal(sent[0].title, "Pulls did not reach the remote · 3 repos");
  assert.match(sent[0].body, /^realestatecalc, picture-app, security-knowledge: no answer from the remote within 2 min\. Nothing was changed/);
  for (const id of ["r1", "r2", "r3"]) await reportGitOutcome({ repo: { id, name: id }, verb: "pull", ok: true, startedAt: 0, finishedAt: 1 }, ctx);
});

test("the same repo failing on the network N times in a row is filed as attention; a good pull resets it", async () => {
  const { sent, ctx } = deps();
  for (let i = 1; i < NETWORK_STRIKES; i++) { await reportGitOutcome(netFail("s1", "solo"), ctx); await wait(40); }
  assert.ok(sent.every((p) => p.level === "info"));
  assert.equal(sent.at(-1).title, "Pull did not reach the remote · solo");
  assert.deepEqual(sent.at(-1).open, { to: "git", repoId: "s1", verb: "pull" });
  await reportGitOutcome(netFail("s1", "solo"), ctx);
  const filed = sent.at(-1);
  assert.equal(filed.outcome, "failed");
  assert.equal(filed.level, undefined, "the kind's default: attention");
  assert.equal(filed.title, "Pull failed · solo");
  assert.match(filed.body, /no answer from the remote within 2 min/);
  // A good pull resets the count: the next network failure is info again.
  await reportGitOutcome({ repo: { id: "s1", name: "solo" }, verb: "pull", ok: true, startedAt: 0, finishedAt: 1 }, ctx);
  const before = sent.length;
  await reportGitOutcome(netFail("s1", "solo"), ctx);
  await wait(40);
  assert.equal(sent.length, before + 1);
  assert.equal(sent.at(-1).level, "info");
});

test("a pull failure that is not the network is filed at once, as before", async () => {
  const { sent, ctx } = deps();
  await reportGitOutcome({ repo: { id: "a1", name: "keyless" }, verb: "pull", ok: false, startedAt: 0, finishedAt: 1, error: "The fetch from origin/main failed: git@github.com: Permission denied (publickey) — nothing was changed." }, ctx);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].title, "Pull failed · keyless");
  assert.equal(sent[0].key, "git:a1:pull");
});
