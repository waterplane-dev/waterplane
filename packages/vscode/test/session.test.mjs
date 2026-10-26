// One conversation as the extension shows it: the window, the spend and its
// split, the turns and the subagents — absent where nothing is known.
import { test } from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, cpSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CONV_ID, LOG, PROJECT, SONNET, data, pick, prompt, req, sumKinds, tmp } from "./helpers.mjs";

test("fixture: sonnet under 200k reads a 200k window; split, cost, turns and compaction from the cursor", async () => {
  const { doc, cursor } = await data.readSession(LOG, null, "/Users/x/repo");
  assert.ok(cursor);
  assert.equal(doc.id, CONV_ID);
  assert.equal(doc.folder, "/Users/x/repo");
  assert.equal(doc.model, SONNET);
  assert.equal(doc.windowTok, 200_000);
  assert.equal(doc.windowFrom, "measured");
  assert.equal(doc.turns, 3);
  assert.equal(doc.split.turns, 6);
  assert.ok(doc.cost && doc.cost.total > 0);
  assert.deepEqual(sumKinds(doc.turnCosts.map((r) => r.kinds)), pick(doc.split));
  assert.ok(Math.abs(doc.turnCosts.reduce((n, r) => n + r.costUsd, 0) - doc.cost.total) < 1e-9);
  assert.equal(doc.compaction.manual.count, 1);
  assert.equal(doc.unpricedTok, 0);
  assert.ok(doc.pricesAsOf);
  assert.ok(doc.samples.length > 0 && doc.events.some((e) => e.kind === "compact"));
});

test("fixture: the subagents are read beside it, priced on their own model", async () => {
  const { doc } = await data.readSession(LOG, null, "/Users/x/repo");
  assert.ok(doc.agents);
  assert.equal(doc.agents.logs, 1);
  assert.equal(doc.agents.split.turns, 2);
  assert.equal(doc.agents.split.input, 56);
  assert.ok(doc.agents.cost && doc.agents.cost.total > 0);
  assert.equal(doc.agents.unpricedTok, 0);
  // The v0.1 reader (summarizeLog per model×day) priced this log at exactly this; the host's
  // per-record pricing must not move it.
  assert.ok(Math.abs(doc.agents.cost.total - 0.004956) < 1e-12, `agents cost ${doc.agents.cost.total}`);
});

test("fixture: the roster — one dated run, its model an index into the doc's models, its label off the meta", async () => {
  const { doc } = await data.readSession(LOG, null, "/Users/x/repo");
  const a = doc.agents;
  assert.equal(a.runs.length, 1);
  const r = a.runs[0];
  assert.equal(typeof r.model, "number");
  assert.match(doc.models[r.model], /haiku/, "an agent-only model is appended to the table, not dropped");
  assert.equal(doc.models[0], SONNET, "the conversation's own models keep their places");
  assert.ok(r.at > 0 && r.at <= r.endAt);
  assert.equal(r.tok, a.tok);
  assert.equal(r.type, "Explore");
  assert.ok(r.costUsd > 0);
  assert.equal(a.split.input + a.split.output + a.split.cacheRead + a.split.cacheWrite, a.tok, "the split IS the total");
  assert.ok(a.cum && a.cum.length >= 1);
  assert.equal(a.cum.at(-1)[1], a.tok, "the running total ends at the total");
});

/** A copy of the fixture conversation in a temp dir, so a test can grow or break its agents. */
function copyFixture(tag) {
  const dir = tmp(tag);
  cpSync(PROJECT, dir, { recursive: true });
  return { log: join(dir, `${CONV_ID}.jsonl`), sub: join(dir, CONV_ID, "subagents") };
}

test("a corrupt or missing meta file costs only the label", async () => {
  const { log, sub } = copyFixture("meta");
  writeFileSync(join(sub, "agent-1.meta.json"), "{not json");
  const { doc } = await data.readSession(log, null, "/f");
  assert.equal(doc.agents.runs.length, 1);
  assert.equal(doc.agents.runs[0].type, undefined);
  assert.ok(doc.agents.tok > 0 && doc.agents.cost.total > 0);
});

test("an agent that writes while the parent sleeps: the next poll moves tok and matches a fresh read", async () => {
  const { log, sub } = copyFixture("agentgrow");
  const first = await data.readSession(log, null, "/f");
  const before = first.doc.agents.tok;
  appendFileSync(join(sub, "agent-1.jsonl"), JSON.stringify({
    sessionId: CONV_ID, cwd: "/Users/x/repo", timestamp: "2026-10-01T10:10:20.000Z", type: "assistant", isSidechain: true, agentId: "1",
    message: { id: "msg_s3", model: "claude-haiku-4-5-20251001", role: "assistant", content: [{ type: "text", text: "ok" }],
      usage: { input_tokens: 9, cache_creation_input_tokens: 0, cache_read_input_tokens: 2100, output_tokens: 30 } },
  }) + "\n");
  const next = await data.readSession(log, first.cursor, "/f");
  assert.equal(next.doc.agents.tok, before + 2139);
  const fresh = await data.readSession(log, null, "/f");
  assert.deepEqual(next.doc.agents, fresh.doc.agents);
  assert.deepEqual(next.doc.models, fresh.doc.models);
});

test("a second agent on the parent's own model reuses its index", async () => {
  const { log, sub } = copyFixture("agent2");
  writeFileSync(join(sub, "agent-2.jsonl"), JSON.stringify({
    sessionId: CONV_ID, cwd: "/Users/x/repo", timestamp: "2026-10-01T10:11:00.000Z", type: "assistant", isSidechain: true, agentId: "2",
    message: { id: "msg_t1", model: SONNET, role: "assistant", content: [{ type: "text", text: "ok" }],
      usage: { input_tokens: 10, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 5 } },
  }) + "\n");
  const { doc } = await data.readSession(log, null, "/f");
  assert.equal(doc.agents.logs, 2);
  assert.equal(doc.agents.runs.length, 2);
  assert.equal(doc.models.indexOf(SONNET), 0);
  assert.equal(doc.agents.runs.find((r) => r.id === "2").model, 0);
  assert.equal(doc.agents.cum.at(-1)[1], doc.agents.tok);
});

test("an empty subagents directory: null, not a zero total", async () => {
  const p = join(tmp("emptysub"), "c.jsonl");
  writeFileSync(p, [prompt(0, "go"), req(1, "x", { input: 10, output: 5 })].join("\n") + "\n");
  mkdirSync(p.replace(/\.jsonl$/, "") + "/subagents", { recursive: true });
  const { doc } = await data.readSession(p, null, "/f");
  assert.equal(doc.agents, null);
});

test("a 300k reading on a sonnet model measures the 1M window", async () => {
  const p = join(tmp("big"), "b.jsonl");
  writeFileSync(p, [prompt(0, "go"), req(1, "x", { cr: 299_000, input: 1_000, output: 10 })].join("\n") + "\n");
  const { doc } = await data.readSession(p, null, "/f");
  assert.equal(doc.windowTok, 1_000_000);
  assert.equal(doc.windowFrom, "measured");
  assert.equal(doc.agents, null, "no subagents dir ⇒ null, not zeros");
});

test("an unknown model: no window, no cost, the tokens counted as unpriced", async () => {
  const p = join(tmp("unknown"), "u.jsonl");
  writeFileSync(p, [prompt(0, "go"), req(1, "x", { input: 500, output: 20, model: "mystery-model" })].join("\n") + "\n");
  const { doc } = await data.readSession(p, null, "/f");
  assert.equal(doc.windowTok, null);
  assert.equal(doc.windowFrom, "none");
  assert.equal(doc.cost, null);
  assert.equal(doc.unpricedTok, 520);
  assert.equal(doc.turnCosts[0].costUsd, null);
});

test("an empty log: no cost, not $0", async () => {
  const p = join(tmp("empty"), "e.jsonl");
  writeFileSync(p, "");
  const { doc } = await data.readSession(p, null, "/f");
  assert.equal(doc.cost, null);
  assert.equal(doc.windowTok, null);
  assert.deepEqual(doc.turnCosts, []);
});

test("incremental append: the cursor advances and matches a fresh read", async () => {
  const p = join(tmp("append"), "a.jsonl");
  writeFileSync(p, [prompt(0, "one"), req(1, "a", { input: 100, cw: 5000, output: 30 })].join("\n") + "\n");
  const first = await data.readSession(p, null, "/f");
  assert.equal(first.doc.turns, 1);
  const consumed = first.cursor.ctx.consumed;
  appendFileSync(p, [prompt(2, "two"), req(3, "b", { input: 4, cr: 5000, cw: 200, output: 80 })].join("\n") + "\n");
  const next = await data.readSession(p, first.cursor, "/f");
  assert.ok(next.cursor.ctx.consumed > consumed);
  const fresh = await data.readSession(p, null, "/f");
  assert.equal(next.doc.turns, 2);
  assert.equal(next.doc.usageTok, fresh.doc.usageTok);
  assert.deepEqual(next.doc.split, fresh.doc.split);
  assert.deepEqual(next.doc.turnCosts, fresh.doc.turnCosts);
});

test("a log that is gone: null doc with a sentence", async () => {
  const r = await data.readSession(join(tmp("gone"), "x.jsonl"), null, "/f");
  assert.equal(r.doc, null);
  assert.equal(r.cursor, null);
  assert.match(r.why, /no longer there/);
});

test("fixture: what the first request carried is read off the attachments before it", async () => {
  const { doc } = await data.readSession(LOG, null, "/Users/x/repo");
  const byKind = Object.fromEntries(doc.carried.parts.map((p) => [p.kind, p]));
  assert.equal(byKind.instructions.chars, 400);
  assert.equal(byKind.instructions.files[0].path, "/Users/x/repo/CLAUDE.md");
  assert.equal(byKind.skill_listing.chars, 200);
  assert.equal(byKind.skill_listing.count, 2);
});
