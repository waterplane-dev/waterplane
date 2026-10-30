/**
 * ↑N ↓M is counted against the branch's ACTUAL configured upstream (design round 4), and is
 * absent — never a 0 — when git cannot say. Pinned on real temp repos:
 * - a LOCAL upstream (`branch.X.remote = .`) and a non-origin remote (`upstream/main`) are
 *   counted against exactly that ref (git's own header does it; this pins that nobody "fixes"
 *   it into an origin/<branch> guess);
 * - a GONE upstream (`[gone]`: the remote branch was deleted and pruned) has nothing to count
 *   against — before, the listing said ahead 0 / behind 0 and the git view drew "→ origin/x ↑0"
 *   over commits that are on no remote at all.
 */
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { countChangedFiles, gitStatus, gitBranches } = await import("../dist/git.js");
const { gitLog } = await import("../dist/gitlog.js");

const g = (cwd, ...a) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", ...a], { cwd, stdio: "pipe" }).toString().trim();

function repo() {
  const root = mkdtempSync(join(tmpdir(), "wp-upcount-"));
  after(() => rmSync(root, { recursive: true, force: true }));
  const bare = join(root, "up.git"), a = join(root, "a");
  g(root, "init", "-q", "--bare", "-b", "main", bare);
  g(root, "init", "-q", "-b", "main", a);
  g(a, "commit", "-q", "--allow-empty", "-m", "one");
  g(a, "remote", "add", "upstream", bare);
  g(a, "push", "-q", "-u", "upstream", "main");
  return a;
}

test("a local upstream (remote = .) is counted against that local branch", async () => {
  const a = repo();
  g(a, "checkout", "-q", "-b", "feat");
  g(a, "branch", "-q", "--set-upstream-to=main");
  g(a, "commit", "-q", "--allow-empty", "-m", "f1");
  g(a, "commit", "-q", "--allow-empty", "-m", "f2");
  assert.equal(g(a, "config", "branch.feat.remote"), ".");
  const c = await countChangedFiles(a);
  assert.equal(c.ahead, 2); assert.equal(c.behind, 0);
  const s = await gitStatus(a);
  assert.equal(s.upstream, "main"); assert.equal(s.ahead, 2);
  assert.equal((await gitLog(a)).outgoingTotal, 2);
});

test("a non-origin upstream (upstream/main) is counted against it", async () => {
  const a = repo();
  g(a, "checkout", "-q", "-b", "f2");
  g(a, "branch", "-q", "--set-upstream-to=upstream/main");
  g(a, "commit", "-q", "--allow-empty", "-m", "x");
  const c = await countChangedFiles(a);
  assert.equal(c.ahead, 1); assert.equal(c.behind, 0);
  const s = await gitStatus(a);
  assert.equal(s.upstream, "upstream/main"); assert.equal(s.ahead, 1);
});

test("a gone upstream has no count: absent in the listing, no upstream in the git view", async () => {
  const a = repo();
  g(a, "checkout", "-q", "-b", "gone");
  g(a, "push", "-q", "-u", "upstream", "gone");
  g(a, "commit", "-q", "--allow-empty", "-m", "never pushed");
  g(a, "push", "-q", "upstream", "--delete", "gone");
  g(a, "fetch", "-q", "--prune", "upstream");
  const c = await countChangedFiles(a);
  assert.equal(c.ahead, undefined, "ahead 0 would say nothing is left to push");
  assert.equal(c.behind, undefined);
  const s = await gitStatus(a);
  assert.equal(s.upstream, undefined, "the view drew '→ upstream/gone ↑0' over an unpushed commit");
  assert.equal((await gitLog(a)).upstream, undefined, "the sheet's log already agreed: git says no @{u}");
});

test("a NON-current branch whose upstream is gone lists no upstream; a live one keeps its own", async () => {
  const a = repo();
  g(a, "checkout", "-q", "-b", "gone");
  g(a, "push", "-q", "-u", "upstream", "gone");
  g(a, "checkout", "-q", "-b", "live");
  g(a, "push", "-q", "-u", "upstream", "live");
  g(a, "checkout", "-q", "main");
  g(a, "push", "-q", "upstream", "--delete", "gone");
  g(a, "fetch", "-q", "--prune", "upstream");
  const byName = Object.fromEntries((await gitBranches(a)).map((b) => [b.name, b]));
  assert.equal(byName.gone.current, false);
  assert.equal(byName.gone.upstream, undefined, "the branch list drew '→ upstream/gone' for a deleted remote branch");
  assert.equal(byName.live.upstream, "upstream/live");
  assert.equal(byName.main.upstream, "upstream/main");
  assert.equal(byName.main.current, true);
});
