/**
 * A repo-scope artifact walk never descends into `.claude/worktrees/`.
 *
 * Each agent worktree there is a full checkout, so walking it re-finds every
 * committed image under a new path. The turn-end image scan read one new
 * worktree as ~60 "new images" in the session strip, and after the worktree
 * was merged and removed every thumb in it was a 404.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { discoverArtifacts } = await import("../dist/files.js");

test("repo scope skips nested agent worktrees but keeps the repo's own images", () => {
  const dir = mkdtempSync(join(tmpdir(), "waterplane-walk-"));
  try {
    mkdirSync(join(dir, "brand"), { recursive: true });
    mkdirSync(join(dir, ".claude/outbox"), { recursive: true });
    mkdirSync(join(dir, ".claude/worktrees/agent-x/brand"), { recursive: true });
    writeFileSync(join(dir, "brand/icon.svg"), "<svg/>");
    writeFileSync(join(dir, ".claude/outbox/shot.png"), "png");
    writeFileSync(join(dir, ".claude/worktrees/agent-x/brand/icon.svg"), "<svg/>");

    const paths = discoverArtifacts(dir, { scope: "repo", kind: "image" }).files.map((f) => f.relPath).sort();
    assert.deepEqual(paths, [".claude/outbox/shot.png", "brand/icon.svg"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
