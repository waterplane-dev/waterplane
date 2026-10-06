/**
 * `repoOfWorktree`: an agent worktree the CLI makes under
 * `<repo>/.claude/worktrees/<name>` is counted as its repo, never as a repo
 * named `agent-<id>` beside it.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { repoOfWorktree } from "../dist/tokenstats.js";

test("an agent worktree folds into its repo", () => {
  assert.equal(repoOfWorktree("/Users/x/dev/g/mono/.claude/worktrees/agent-aae5b06d"), "/Users/x/dev/g/mono");
  assert.equal(repoOfWorktree("/Users/x/dev/g/mono/.claude/worktrees/jolly-cannon/sub/dir"), "/Users/x/dev/g/mono");
});

test("any other path is itself", () => {
  assert.equal(repoOfWorktree("/Users/x/dev/myapp"), "/Users/x/dev/myapp");
  assert.equal(repoOfWorktree("/Users/x/dev/myapp/packages/web"), "/Users/x/dev/myapp/packages/web");
});
