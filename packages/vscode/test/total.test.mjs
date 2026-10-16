// The status bar and the panel's headline print ONE total: the conversation plus its subagents,
// withheld rather than partial when the agents' cost cannot be said. And the context reading is the
// latest RAW one, not the downsampled chart's last point (a bucket's max can sit there).
import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { LOG, data, prompt, req, tmp } from "./helpers.mjs";

test("fixture: the total is own + agents, and the agents' share is named", async () => {
  const { doc } = await data.readSession(LOG, null, "/f");
  const t = data.sessionTotal(doc);
  assert.ok(doc.cost.total > 0 && doc.agents.cost.total > 0);
  assert.ok(Math.abs(t.cost.total - (doc.cost.total + doc.agents.cost.total)) < 1e-12);
  assert.equal(t.agentUsd, doc.agents.cost.total);
  assert.equal(t.withheld, false);
});

const base = (over) => ({
  cost: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, total: 2 }, unpricedTok: 0,
  agents: null, ...over,
});
const split = (n) => ({ input: n, output: 0, cacheRead: 0, cacheWrite: 0, cacheWrite1h: 0, turns: 1 });

test("agents that spent tokens with no cost and no unpriced tokens: the whole total is withheld", () => {
  const t = data.sessionTotal(base({ agents: { logs: 1, split: split(50), cost: null, unpricedTok: 0 } }));
  assert.equal(t.cost, null);
  assert.equal(t.withheld, true);
});

test("agents on an unpriced model: own cost stands, their tokens reported unpriced", () => {
  const t = data.sessionTotal(base({ unpricedTok: 5, agents: { logs: 1, split: split(50), cost: null, unpricedTok: 50 } }));
  assert.equal(t.cost.total, 2);
  assert.equal(t.agentUsd, null);
  assert.equal(t.unpricedTok, 55);
});

test("no agents dir, or agents that spent nothing: own cost; nothing priced is null, never $0", () => {
  assert.equal(data.sessionTotal(base({})).cost.total, 2);
  assert.equal(data.sessionTotal(base({ agents: { logs: 1, split: split(0), cost: null, unpricedTok: 0 } })).cost.total, 2);
  assert.equal(data.sessionTotal(base({ cost: null })).cost, null);
});

test("lastTok is the latest RAW reading, not the downsampled series' last point", async () => {
  const p = join(tmp("many"), "m.jsonl");
  const lines = [prompt(0, "go")];
  // 3000 requests: a high/low saw, ending on a mid value that is neither its bucket's min nor max.
  const N = 3000;
  for (let i = 0; i < N; i++) {
    const tok = i === N - 1 ? 50_000 : (i % 2 ? 90_000 : 10_000);
    lines.push(req(1 + i, `m${i}`, { cr: tok - 10, input: 10, output: 1 }));
  }
  writeFileSync(p, lines.join("\n") + "\n");
  const { doc } = await data.readSession(p, null, "/f");
  assert.ok(doc.samples.length < N, `samples are downsampled (${doc.samples.length})`);
  assert.equal(doc.lastTok, 50_000);
  assert.notEqual(doc.samples.at(-1).tok, 50_000, "the chart's last point is a bucket extreme");
  assert.equal(typeof doc.lastAt, "number");
});

test("an empty log: lastTok and lastAt are null", async () => {
  const p = join(tmp("nolast"), "e.jsonl");
  writeFileSync(p, "");
  const { doc } = await data.readSession(p, null, "/f");
  assert.equal(doc.lastTok, null);
  assert.equal(doc.lastAt, null);
});

// The host's rule (ctxproject.ts): a subagents dir that exists but cannot be read publishes NO total,
// never the parent's half of it. ENOENT is a measured zero; EACCES is not.
test("an unreadable subagents dir: no total, said in words, the conversation's own tokens still read", {
  skip: process.platform === "win32" || process.getuid?.() === 0 ? "chmod 000 does not lock out this user" : false,
}, async () => {
  const { cpSync, chmodSync } = await import("node:fs");
  const { CONV_ID, PROJECT } = await import("./helpers.mjs");
  const dir = tmp("unread");
  cpSync(PROJECT, dir, { recursive: true });
  const log = join(dir, `${CONV_ID}.jsonl`);
  const sub = join(dir, CONV_ID, "subagents");
  const first = await data.readSession(log, null, "/f");
  assert.equal(first.doc.agentsUnread, null);
  assert.ok(first.doc.agents && data.sessionTotal(first.doc).cost);
  chmodSync(sub, 0o000);
  try {
    for (const prev of [null, first.cursor]) {
      const { doc } = await data.readSession(log, prev, "/f");
      assert.match(doc.agentsUnread, /could not be read, so there is no total/);
      assert.equal(doc.agents, null);
      assert.ok(doc.usageTok > 0 && doc.cost.total > 0, "the conversation's own reading stands");
      const t = data.sessionTotal(doc);
      assert.equal(t.cost, null);
      assert.equal(t.withheld, true);
      assert.equal(t.withheldWhy, doc.agentsUnread);
    }
  } finally {
    chmodSync(sub, 0o755);
  }
  const back = await data.readSession(log, first.cursor, "/f");
  assert.equal(back.doc.agentsUnread, null);
  assert.ok(Math.abs(data.sessionTotal(back.doc).cost.total - data.sessionTotal(first.doc).cost.total) < 1e-12);
});
