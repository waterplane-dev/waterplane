/**
 * The decision log's one-time migration from the retired oracle log
 * (`decisionlog.ts`): oracle rows become `source: "plugin", plugin: "oracle"`,
 * limit rows `source: "limit"`, the old file is renamed `.migrated` and never
 * deleted, and a second boot migrates nothing twice.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { DecisionLog } = await import("../dist/decisionlog.js");

const oracleRow = {
  id: "o1", ts: 2000, sessionId: "s1", sessionTitle: "demo", question: "Which?", options: [{ index: 1, label: "A" }],
  contextSent: "ctx", images: 1, model: "gemini-2.5-flash", choice: 1, answer: "A", confidence: 0.9,
  rationale: "because", outcome: "autofired", inTok: 10, outTok: 2, archived: true,
};
const limitRow = {
  id: "l1", ts: 1000, sessionId: "s1", sessionTitle: "demo", kind: "limit", phase: "blocked", question: "Stopped.",
  options: [], contextSent: "", images: 0, model: "", choice: null, answer: "", confidence: 0, rationale: "plan",
  outcome: "limit", inTok: 0, outTok: 0,
};

test("migrates oracle-log.json once and keeps the old file as .migrated", () => {
  const root = mkdtempSync(join(tmpdir(), "waterplane-declog-"));
  mkdirSync(join(root, ".waterplane"));
  writeFileSync(join(root, ".waterplane", "oracle-log.json"), JSON.stringify([oracleRow, limitRow]));
  const log = new DecisionLog(root);
  const rows = log.list(undefined, true);
  assert.deepEqual(rows.map((r) => r.id), ["o1", "l1"], "newest first");
  const [o, l] = rows;
  assert.equal(o.source, "plugin");
  assert.equal(o.plugin, "oracle");
  assert.equal(o.outcome, "autofired");
  assert.equal(o.model, "gemini-2.5-flash");
  assert.equal(o.inTok, 10);
  assert.equal(o.archived, true);
  assert.equal(l.source, "limit");
  assert.equal(l.plugin, undefined);
  assert.equal(l.phase, "blocked");
  assert.equal(l.model, undefined, "a limit row carries no model call");
  assert.equal(log.list().length, 1, "archived rows are hidden by default");
  assert.ok(!existsSync(join(root, ".waterplane", "oracle-log.json")));
  assert.ok(existsSync(join(root, ".waterplane", "oracle-log.json.migrated")), "renamed, never deleted");
  assert.equal(JSON.parse(readFileSync(join(root, ".waterplane", "decision-log.json"), "utf8")).length, 2);

  // A second boot finds nothing to migrate and changes nothing.
  assert.equal(new DecisionLog(root).list(undefined, true).length, 2);
});

test("an unreadable old log is left in place, not deleted", () => {
  const root = mkdtempSync(join(tmpdir(), "waterplane-declog-"));
  mkdirSync(join(root, ".waterplane"));
  writeFileSync(join(root, ".waterplane", "oracle-log.json"), "{nope");
  assert.equal(new DecisionLog(root).list().length, 0);
  assert.ok(existsSync(join(root, ".waterplane", "oracle-log.json")));
});

test("onChange fires on every mutation", () => {
  const root = mkdtempSync(join(tmpdir(), "waterplane-declog-"));
  let n = 0;
  const log = new DecisionLog(root, () => { n++; });
  log.add({ id: "a", ts: 1, sessionId: "s", sessionTitle: "t", source: "limit", question: "q", options: [], outcome: "limit", choice: null, rationale: "" });
  log.setArchived("a", true);
  log.archiveAll();
  log.remove("a");
  assert.equal(n, 3, "archiveAll with nothing visible changes nothing");
});
