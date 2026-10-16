/** A failed push/pull handed to a new session: the words and the seed. */
import test from "node:test";
import assert from "node:assert/strict";

import { gitFailPrompt, gitFailSeed } from "./gitFailPrompt.ts";

const repo = { id: "r1", repoName: "myapp", worktreePath: "/dev/myapp" };
const push = {
  verb: "push", branch: "main", upstream: "origin/main", ahead: 3, took: "0:39",
  error: "The pre-push check stopped it — npm run test:unit (exit 1)\n\nnot ok 4 - claudemd",
};

test("a push failure names the branch, the upstream, the count and the clock, and quotes the log", () => {
  const p = gitFailPrompt(push);
  assert.match(p, /^Pushing `main` \(3 commits ahead\) to `origin\/main` failed on this desktop after 0:39\./);
  assert.ok(p.includes("```\nThe pre-push check stopped it — npm run test:unit (exit 1)\n\nnot ok 4 - claudemd\n```"));
  assert.match(p, /only the last lines/);
  assert.match(p, /Leave the push to me/);
});

test("absent facts are left out, never guessed", () => {
  const p = gitFailPrompt({ verb: "push", branch: "feat", error: "rejected" });
  assert.match(p, /^Pushing `feat` to `its upstream` failed on this desktop\.\n/);
});

test("a log full of ``` fences cannot close the quote early", () => {
  const p = gitFailPrompt({ ...push, error: "'```ts\\n' +\n````" });
  const lines = p.split("\n");
  const open = lines.indexOf("`````");
  assert.ok(open > 0, "fence is one longer than the longest run");
  assert.equal(lines.lastIndexOf("`````") > open, true);
});

test("a pull failure asks for a branch the pull can go through, and no push", () => {
  const p = gitFailPrompt({ verb: "pull", branch: "main", upstream: "origin/main", error: "Both sides moved" });
  assert.match(p, /^Pulling `origin\/main` into `main` failed/);
  assert.match(p, /Don't push\.$/);
});

test("the seed opens a fresh session in the repo and sends nothing on its own", () => {
  const s = gitFailSeed(push, repo);
  assert.deepEqual(s.target, { kind: "repo", cwd: "/dev/myapp" });
  assert.equal(s.repoId, "r1");
  assert.equal(s.cwdHint, "/dev/myapp");
  assert.equal(s.prompts.length, 1);
  assert.equal(s.origin, "From myapp's git screen — the failed push");
  assert.equal(s.when, undefined);
});

test("the copy receipts say what landed, and the refusal says what to do instead", async () => {
  const { GIT_COPIED, GIT_COPY_FAILED, GIT_COPY_LABEL } = await import("./gitFailPrompt.ts");
  assert.equal(GIT_COPY_LABEL, "copy");
  assert.match(GIT_COPIED, /branch, upstream/);
  assert.match(GIT_COPY_FAILED, /Select the log/);
});
