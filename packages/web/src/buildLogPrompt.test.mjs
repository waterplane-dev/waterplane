/** A build run's log handed to a new session in its repo: the words and the seed. */
import test from "node:test";
import assert from "node:assert/strict";

import { buildLogPrompt, buildLogSeed, logTail, BUILD_LOG_TAIL_LINES } from "./buildLogPrompt.ts";

const repo = { id: "r1", repoName: "usher", worktreePath: "/dev/usher" };
const failed = {
  name: "Public mirror", cmd: "npm run release:public", cwd: "/dev/usher",
  status: "failed", exitCode: 1, params: { mode: "check" },
};

test("a failed run names the build, its parameters, the exit and the clock, and quotes the log", () => {
  const p = buildLogPrompt(failed, "[6/7] npm run test:unit …\n    FAILED (exit 1)\n", "1m 49s");
  assert.match(p, /^The build "Public mirror" with mode=check failed \(exit 1\) on this desktop after 1m 49s\./);
  assert.match(p, /Command: `npm run release:public`/);
  assert.ok(p.includes("```\n[6/7] npm run test:unit …\n    FAILED (exit 1)\n```"));
  assert.match(p, /whole output/);
  assert.match(p, /fix it/);
});

test("a finished run asks for a look, not a change; absent facts are left out", () => {
  const p = buildLogPrompt({ ...failed, status: "done", exitCode: 0, params: undefined }, "ok");
  assert.match(p, /^The build "Public mirror" finished on this desktop\.\n/);
  assert.match(p, /Don't change anything yet/);
});

test("a long log rides as its tail and says how much was left out", () => {
  const log = Array.from({ length: BUILD_LOG_TAIL_LINES + 50 }, (_, i) => `line ${i}`).join("\n");
  const t = logTail(log);
  assert.equal(t.cut, 50);
  assert.ok(t.text.startsWith("line 50\n"));
  assert.match(buildLogPrompt(failed, log), /50 earlier lines left out/);
});

test("the seed aims at a new session in the run's repo and sends nothing", () => {
  const s = buildLogSeed(failed, "x", repo);
  assert.deepEqual(s.target, { kind: "repo", cwd: "/dev/usher" });
  assert.equal(s.repoId, "r1");
  assert.equal(s.prompts.length, 1);
});
