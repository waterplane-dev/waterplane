/** The repo-readings feature's seed and aim, moved out of App. */
import test from "node:test";
import assert from "node:assert/strict";

import { aimAfterFile, remedySeed } from "./logic.ts";

const repo = { id: "r1", repoName: "myapp", worktreePath: "/dev/myapp" };

test("a remedy is a repo-targeted seed that names where it came from, and sends nothing", () => {
  assert.deepEqual(remedySeed("trim CLAUDE.md", repo, "context weight"), {
    prompts: ["trim CLAUDE.md"],
    target: { kind: "repo", cwd: "/dev/myapp" },
    cwdHint: "/dev/myapp",
    repoId: "r1",
    origin: "From myapp's repo readings — context weight",
  });
});

test("coming back from a file lands on the series region, keeping the rest of the aim", () => {
  assert.deepEqual(aimAfterFile({ focus: "findings" }), { focus: "findings", region: "series" });
  assert.deepEqual(aimAfterFile({ region: "setup" }), { region: "series" });
});
