/**
 * The Review sheet's Explain as a job (`explainjob.ts`).
 *
 * Pinned because each fails quietly:
 *  1. **A second start JOINS the running brief** — a second tap or tab must
 *     never buy a second model call.
 *  2. **The last finished brief survives a restart** (`explains.json`): the
 *     person reopening the sheet sees the last answer, not a blank form.
 *  3. **A finished brief is told once**, to the sink `main.ts` installs.
 *
 * The worktree is a plain folder with no upstream, so `explainChanges`
 * answers with its reason before any fetch or model call — nothing is spent.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = mkdtempSync(join(tmpdir(), "wp-explain-root-"));
const state = mkdtempSync(join(tmpdir(), "wp-explain-state-"));
const wt = mkdtempSync(join(tmpdir(), "wp-explain-wt-"));
process.env.WATERPLANE_ROOT = root;
process.env.WATERPLANE_STATE_DIR = state;
after(() => { for (const d of [root, state, wt]) rmSync(d, { recursive: true, force: true }); });

const { startExplain, explainState, setExplainSink, resetExplainJobs } = await import("../dist/explainjob.js");
const { reportExplainOutcome } = await import("../dist/gitnotify.js");

test("a second start joins the running brief, and the end is told once", async () => {
  const told = [];
  setExplainSink((o) => told.push(o));
  const a = startExplain(wt, { foci: ["security"], note: "payments?" }, { id: "r1", name: "repo" });
  const b = startExplain(wt, { foci: [] }, { id: "r1", name: "repo" });
  assert.equal(a, b);
  assert.equal(explainState(wt).running, true);
  const brief = await a.done;
  assert.match(brief.reason, /no upstream/);
  const s = explainState(wt);
  assert.equal(s.running, false);
  assert.deepEqual(s.foci, ["security"]);
  assert.equal(s.note, "payments?");
  assert.equal(told.length, 1);
  setExplainSink(null);
});

test("the last finished brief is read back after a restart", () => {
  assert.ok(existsSync(join(state, "explains.json")));
  resetExplainJobs();
  const s = explainState(wt);
  assert.equal(s.running, false);
  assert.match(s.result.reason, /no upstream/);
  assert.equal(explainState(join(wt, "elsewhere")), null);
});

test("the notification opens the Explain view and says what came back", () => {
  const sent = [];
  const repo = { id: "r1", name: "repo" };
  reportExplainOutcome({ repo, brief: { text: "## To push", push: 3 }, startedAt: 0, finishedAt: 42_000 }, { notify: (k, p) => sent.push(p) });
  reportExplainOutcome({ repo, brief: { reason: "Nothing to push or pull." }, startedAt: 0, finishedAt: 1000 }, { notify: (k, p) => sent.push(p) });
  assert.deepEqual(sent[0].open, { to: "git", repoId: "r1", verb: "explain" });
  assert.equal(sent[0].title, "Explained · repo");
  assert.match(sent[0].body, /3 to push · took 42 s/);
  assert.equal(sent[1].title, "No explanation · repo");
  assert.equal(sent[1].body, "Nothing to push or pull.");
});
