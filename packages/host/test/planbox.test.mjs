/**
 * The plan behind a plan-approval box, read from the plan FILE.
 *
 * Measured on claude 2.1.x: the `ExitPlanMode` call is not in the conversation
 * log while its box is up, so the phone's card had the question and three
 * buttons and no plan. The file's location comes from the log (a `plan_mode`
 * attachment's `planFilePath`, else the `slug` on every record); every miss is
 * null — absent, never somebody else's plan.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const HOME = mkdtempSync(join(tmpdir(), "waterplane-planbox-"));
delete process.env.CLAUDE_CONFIG_DIR;
process.env.WATERPLANE_CLAUDE_HOME = HOME;
const { isPlanBox, planPathFor, readPlan, PLAN_CAP } = await import("../dist/planbox.js");
const { transcriptPath } = await import("../dist/transcript.js");

const CWD = "/tmp/some-repo";
const writeLog = (cid, records) => {
  const p = transcriptPath(CWD, cid);
  mkdirSync(join(p, ".."), { recursive: true });
  writeFileSync(p, records.map((r) => JSON.stringify(r)).join("\n") + "\n");
};

test.after(() => rmSync(HOME, { recursive: true, force: true }));

test("the plan-approval question is recognised, a tool approval is not", () => {
  assert.equal(isPlanBox("Claude has written up a plan and is ready to execute. Would you like to proceed?"), true);
  assert.equal(isPlanBox("Do you want to proceed?"), false);
  assert.equal(isPlanBox("Do you want to make this edit to planbox.ts?"), false);
  assert.equal(isPlanBox(undefined), false);
});

test("the slug every record carries names the plan file", () => {
  writeLog("c1", [
    { type: "user", slug: "brave-blue-otter", message: { role: "user", content: "hi" } },
    { type: "assistant", slug: "brave-blue-otter", message: { role: "assistant", content: [] } },
  ]);
  assert.equal(planPathFor(CWD, "c1"), join(HOME, ".claude", "plans", "brave-blue-otter.md"));
});

test("a plan_mode attachment's own path wins over the slug", () => {
  writeLog("c2", [
    { type: "attachment", slug: "x-y", attachment: { type: "plan_mode", planFilePath: "/elsewhere/plans/x-y.md" } },
    { type: "assistant", slug: "x-y", message: { role: "assistant", content: [] } },
  ]);
  assert.equal(planPathFor(CWD, "c2"), "/elsewhere/plans/x-y.md");
});

test("no log, no conversation id, no slug: null", () => {
  assert.equal(planPathFor(CWD, undefined), null);
  assert.equal(planPathFor(CWD, "missing"), null);
  writeLog("c3", [{ type: "user", message: { role: "user", content: "hi" } }]);
  assert.equal(planPathFor(CWD, "c3"), null);
});

test("the plan text comes back, capped and saying so", () => {
  const dir = join(HOME, ".claude", "plans");
  mkdirSync(dir, { recursive: true });
  const p = join(dir, "p.md");
  writeFileSync(p, "# Plan\n\n- step one\n");
  assert.deepEqual(readPlan(p), { text: "# Plan\n\n- step one\n", path: p });
  writeFileSync(p, "x".repeat(PLAN_CAP + 10));
  const big = readPlan(p);
  assert.equal(big.text.length, PLAN_CAP);
  assert.equal(big.cut, true);
  writeFileSync(p, "  \n");
  assert.equal(readPlan(p), null, "an empty plan is no plan");
  assert.equal(readPlan(join(dir, "nope.md")), null);
  assert.equal(readPlan(join(dir, "notes.txt")), null, "only a markdown plan file");
});
