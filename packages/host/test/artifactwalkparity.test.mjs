/**
 * The gallery's two artifact walks — `discoverArtifacts` (the outbox count and inline images) and
 * `discoverArtifactsAsync` (every repo-scope caller) — are ONE walk with two fs drivers, so the
 * security rule "a symlink leaving the worktree is neither walked nor listed" is written once.
 * Two hand copies of it (lstat + containedReal vs Dirent + containedReal) were a review burden
 * the moment one was edited without the other.
 *
 * Parity is asserted row for row (name, path, size, both times) over a fixture with a link out of
 * the worktree to a directory and to a file, dangling links, links that stay inside, the inbox, a nested agent
 * worktree and a skipped dir, in both scopes and under every filter.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { discoverArtifacts, discoverArtifactsAsync } = await import("../dist/files.js");

function fixture() {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "waterplane-walkparity-")));
  const wt = join(base, "wt");
  const out = join(base, "outside");
  const put = (p, body = "png", ageS = 0) => {
    mkdirSync(join(p, ".."), { recursive: true });
    writeFileSync(p, body);
    if (ageS) { const t = Date.now() / 1000 - ageS; utimesSync(p, t, t); }
  };
  put(join(out, "home.png"));
  put(join(out, "notes.md"), "# out");
  put(join(wt, "docs", "shot.png"), "pngpng");
  put(join(wt, "docs", "old.png"), "png", 3 * 86400);
  put(join(wt, "docs", "readme.md"), "# hi");
  put(join(wt, ".claude", "outbox", "flow.gif"), "gif");
  put(join(wt, ".claude", "outbox", "deep", "report.pdf"), "pdf");
  put(join(wt, ".claude", "inbox", "upload.png"));
  put(join(wt, ".claude", "worktrees", "agent-x", "docs", "shot.png"));
  put(join(wt, "node_modules", "pkg", "logo.png"));
  // Leaving the worktree: a committed `docs/home -> ~`, a file link, and the same inside the outbox.
  symlinkSync(out, join(wt, "docs", "home"));
  symlinkSync(join(out, "home.png"), join(wt, "docs", "linked-out.png"));
  symlinkSync(out, join(wt, ".claude", "outbox", "evildir"));
  symlinkSync(join(out, "notes.md"), join(wt, ".claude", "outbox", "evil.md"));
  // Dangling: its target is gone, so it is neither in nor out — never listed.
  symlinkSync(join(out, "gone.png"), join(wt, "docs", "dangling.png"));
  symlinkSync(join(wt, "docs", "gone.png"), join(wt, ".claude", "outbox", "dangling.png"));
  // Staying inside: followed and listed.
  symlinkSync(join(wt, "docs"), join(wt, "alias"));
  symlinkSync(join(wt, "docs", "shot.png"), join(wt, ".claude", "outbox", "same.png"));
  return { base, wt };
}

const OPTS = [
  {},
  { kind: "image" },
  { kind: "document" },
  { query: "SHOT" },
  { sinceSeconds: 86400 },
  { includeInbox: true },
  { limit: 2 },
  { scope: "outbox" },
  { scope: "outbox", kind: "image" },
  { scope: "outbox", kind: "document" },
];

test("the sync and async artifact walks answer the same rows over a tree with links out of it", async (t) => {
  const { base, wt } = fixture();
  t.after(() => rmSync(base, { recursive: true, force: true }));
  for (const o of OPTS) {
    const a = discoverArtifacts(wt, o);
    const b = await discoverArtifactsAsync(wt, o);
    assert.deepEqual(b, a, `same answer for ${JSON.stringify(o)}`);
    for (const f of a.files) {
      assert.ok(!/(^|\/)(home|evildir)\//.test(f.relPath) && !/linked-out|evil\.md|dangling/.test(f.relPath),
        `${f.relPath}: nothing behind a link that leaves the worktree (${JSON.stringify(o)})`);
    }
  }
  const repo = discoverArtifacts(wt).files.map((f) => f.relPath).sort();
  assert.deepEqual(repo, [
    ".claude/outbox/deep/report.pdf", ".claude/outbox/flow.gif", ".claude/outbox/same.png",
    "alias/old.png", "alias/readme.md", "alias/shot.png",
    "docs/old.png", "docs/readme.md", "docs/shot.png",
  ]);
  const outbox = discoverArtifacts(wt, { scope: "outbox" }).files.map((f) => f.relPath).sort();
  assert.deepEqual(outbox, [".claude/outbox/deep/report.pdf", ".claude/outbox/flow.gif", ".claude/outbox/same.png"]);
});

test("files.ts writes the walk's link-containment rule once, and both entry points run that walk", () => {
  const src = readFileSync(new URL("../src/files.ts", import.meta.url), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  const rule = src.match(/containedReal\(root, relative\(root, full\)\)/g) ?? [];
  assert.equal(rule.length, 1, "one copy of 'a link leaving the worktree is neither walked nor listed'");
  for (const name of ["discoverArtifacts", "discoverArtifactsAsync"]) {
    const at = src.search(new RegExp(`export (async )?function ${name}\\(`));
    assert.ok(at >= 0, `${name} is declared`);
    const body = src.slice(at, src.indexOf("\n}\n", at));
    assert.match(body, /artifactWalk\(/, `${name} runs the one walk`);
    assert.doesNotMatch(body, /readdir|statSync|statAsync|lstatSync/, `${name} touches the disk only through its driver`);
  }
});
