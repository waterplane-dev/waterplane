/**
 * The name a person gave a repo to be SHOWN (`reponames.ts`). Display only: discovery carries it as
 * `displayName` on every worktree of the clone while `repoName`, `id` and `worktreePath` stay the
 * folder's; a push reads the same name for a session's title. Nothing seeds it, and a bad name is
 * refused in words and stored as nothing. No real git needed — the fixtures are bare `.git` dirs.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { RepoNamesStore, installRepoNames, noteScannedNames, repoNamesStore, setRepoNamesStore, shownTitleForCwd } from "../dist/reponames.js";
import { discoverTargets } from "../dist/repos.js";
import { hostStateDir } from "../dist/branddirs.js";

after(() => { setRepoNamesStore(null); noteScannedNames("", []); });

function fakeRepo(dir, head = "ref: refs/heads/main\n") {
  mkdirSync(join(dir, ".git"), { recursive: true });
  writeFileSync(join(dir, ".git", "HEAD"), head);
}

test("reponames: nothing is seeded — a fresh host shows every folder name", async () => {
  const root = mkdtempSync(join(tmpdir(), "reponames-"));
  fakeRepo(join(root, "myapp"));
  installRepoNames(root);
  assert.equal(existsSync(join(hostStateDir(root), "repo-names.json")), false, "installing writes no file");
  const [t] = await discoverTargets(root);
  assert.equal(t.repoName, "myapp");
  assert.equal(t.displayName, undefined);
});

test("reponames: a set name rides discovery as displayName and moves nothing else; clearing puts the folder back", async () => {
  const root = mkdtempSync(join(tmpdir(), "reponames-"));
  fakeRepo(join(root, "myapp"));
  fakeRepo(join(root, "other"));
  installRepoNames(root);
  const before = (await discoverTargets(root)).find((t) => t.repoName === "myapp");
  const r = repoNamesStore().set(before.worktreePath, "  waterplane ");
  assert.deepEqual(r, { ok: true, name: "waterplane" });
  const after1 = await discoverTargets(root);
  const myapp = after1.find((t) => t.repoName === "myapp");
  assert.equal(myapp.displayName, "waterplane");
  // Identity is the folder's: same id, same path, same name.
  assert.equal(myapp.id, before.id);
  assert.equal(myapp.worktreePath, before.worktreePath);
  assert.equal(myapp.repoName, "myapp");
  assert.equal(after1.find((t) => t.repoName === "other").displayName, undefined);
  assert.deepEqual(repoNamesStore().set(before.worktreePath, null), { ok: true, name: null });
  assert.equal((await discoverTargets(root)).find((t) => t.repoName === "myapp").displayName, undefined);
});

test("reponames: it survives a restart (the file is the host's, per clone), and a hand-edited bad name is dropped on read", async () => {
  const root = mkdtempSync(join(tmpdir(), "reponames-"));
  fakeRepo(join(root, "myapp"));
  installRepoNames(root);
  const path = (await discoverTargets(root))[0].worktreePath;
  repoNamesStore().set(path, "waterplane");
  const again = new RepoNamesStore(root);
  assert.equal(again.of(path), "waterplane");
  const file = join(hostStateDir(root), "repo-names.json");
  const doc = JSON.parse(readFileSync(file, "utf8"));
  doc.names["/x/two-lines"] = "a\nb";
  writeFileSync(file, JSON.stringify(doc));
  assert.equal(new RepoNamesStore(root).of("/x/two-lines"), undefined);
  assert.equal(new RepoNamesStore(root).of(path), "waterplane");
});

test("reponames: a refused name is said in words and stores nothing", () => {
  const root = mkdtempSync(join(tmpdir(), "reponames-"));
  const store = new RepoNamesStore(root);
  const bad = store.set("/dev/myapp", "x".repeat(41));
  assert.equal(bad.ok, false);
  assert.match(bad.error, /at most 40/);
  assert.equal(store.set("/dev/myapp", "a\nb").ok, false);
  assert.equal(store.of("/dev/myapp"), undefined);
});

test("reponames: a push reads the shown name for a session's cwd — worktrees included — and only a whole leading folder name", async () => {
  const root = mkdtempSync(join(tmpdir(), "reponames-"));
  fakeRepo(join(root, "myapp"));
  installRepoNames(root);
  const dir = realpathSync(join(root, "myapp"));
  repoNamesStore().set(dir, "waterplane");
  await discoverTargets(root);
  assert.equal(shownTitleForCwd(dir, "myapp · main"), "waterplane · main");
  assert.equal(shownTitleForCwd(join(dir, "packages", "web"), "myapp"), "waterplane");
  assert.equal(shownTitleForCwd(dir, "fix myapp lint"), "fix myapp lint");
  assert.equal(shownTitleForCwd(join(root, "elsewhere"), "myapp · main"), "myapp · main");
  assert.equal(shownTitleForCwd(dir + "-sibling", "myapp · main"), "myapp · main");
});

test("reponames: scanning some OTHER folder (the code-folder check, a candidate) does not forget the names of the host's root", async () => {
  const root = mkdtempSync(join(tmpdir(), "reponames-"));
  const elsewhere = mkdtempSync(join(tmpdir(), "reponames-other-"));
  fakeRepo(join(root, "myapp"));
  fakeRepo(join(elsewhere, "unrelated"));
  installRepoNames(root);
  const dir = realpathSync(join(root, "myapp"));
  repoNamesStore().set(dir, "waterplane");
  await discoverTargets(root);
  assert.equal(shownTitleForCwd(dir, "myapp · main"), "waterplane · main");
  await discoverTargets(elsewhere);
  assert.equal(shownTitleForCwd(dir, "myapp · main"), "waterplane · main", "a scan of another folder must not clobber the root's names");
  // A rescan of the root still replaces ITS list: a cleared name goes back to the folder's.
  repoNamesStore().set(dir, "");
  await discoverTargets(root);
  assert.equal(shownTitleForCwd(dir, "myapp · main"), "myapp · main");
});

test("reponames: a scan of an ANCESTOR folder (a code folder above the root) does not keep a cleared name alive", async () => {
  const parent = mkdtempSync(join(tmpdir(), "reponames-up-"));
  const root = join(parent, "clients");
  fakeRepo(join(root, "myapp"));
  installRepoNames(root);
  const dir = realpathSync(join(root, "myapp"));
  repoNamesStore().set(dir, "waterplane");
  await discoverTargets(root);
  await discoverTargets(parent); // Settings → code folder: a second list for the same worktree
  assert.equal(shownTitleForCwd(dir, "myapp · main"), "waterplane · main");
  repoNamesStore().set(dir, "");
  await discoverTargets(root); // /api/repos after the person tapped "use myapp"
  assert.equal(shownTitleForCwd(dir, "myapp · main"), "myapp · main", "the newest scan of a path replaces older ones");
});
