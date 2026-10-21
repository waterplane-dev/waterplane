// The Copilot row without a sign-in: replaying Copilot Chat's session logs into this month's
// requests, the multiplier read off each answer's `details`, and the words the row shows.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { data, tmp } from "./helpers.mjs";

const NOW = Date.UTC(2026, 9, 21, 12);
const OCT = (d) => Date.UTC(2026, 9, d, 9);
const line = (o) => JSON.stringify(o);
const snapshot = (requests = []) => line({ kind: 0, v: { version: 3, requests, pendingRequests: [] } });
const request = (ts, modelId) => ({ requestId: `r${ts}`, timestamp: ts, modelId, response: [] });
const push = (reqs, i) => line({ kind: 2, k: ["requests"], v: reqs, ...(i !== undefined ? { i } : {}) });
const result = (n, details) => line({ kind: 1, k: ["requests", n, "result"], v: { details, metadata: {} } });

test("parseDetails reads a multiplier, credits, or nothing — never a guess", () => {
  assert.deepEqual(data.parseDetails("Claude Opus 4.7 • 7.5x"), { model: "Claude Opus 4.7", mult: 7.5, credits: null });
  assert.deepEqual(data.parseDetails("GPT-4.1 • 0x"), { model: "GPT-4.1", mult: 0, credits: null });
  assert.deepEqual(data.parseDetails("MAI-Code-1.1-Flash • 0.3 credits"), { model: "MAI-Code-1.1-Flash", mult: null, credits: 0.3 });
  assert.deepEqual(data.parseDetails("Some Model"), { model: "Some Model", mult: null, credits: null });
  assert.deepEqual(data.parseDetails(undefined), { model: null, mult: null, credits: null });
});

test("replayRequests follows set, push and a truncating push", () => {
  const text = [
    snapshot([request(OCT(1), "copilot/claude-sonnet-4.6")]),
    result(0, "Claude Sonnet 4.6 • 1x"),
    push([request(OCT(2), "copilot/claude-opus-4.7")]),
    result(1, "Claude Opus 4.7 • 15x"),
    push([request(OCT(3), "copilot/gpt-5.4")]),
    push([request(OCT(4), "copilot/gpt-5.4")], 2), // replaces the third (an edit-and-resend)
    "not json",
  ].join("\n");
  const reqs = data.replayRequests(text);
  assert.deepEqual(reqs.map((r) => [r.model, r.mult]), [["Claude Sonnet 4.6", 1], ["Claude Opus 4.7", 15], ["gpt-5.4", null]]);
  assert.equal(reqs[2].ts, OCT(4));
});

test("tallyMonth counts from the 1st (UTC), sums only shown multipliers, keeps credits apart", () => {
  const t = data.tallyMonth([
    { ts: Date.UTC(2026, 8, 30, 23), model: "A", mult: 1, credits: null }, // September: out
    { ts: OCT(1), model: "A", mult: 1, credits: null },
    { ts: OCT(2), model: "B", mult: 7.5, credits: null },
    { ts: OCT(3), model: "B", mult: null, credits: null },
    { ts: OCT(4), model: "C", mult: null, credits: 0.3 },
  ], NOW);
  assert.equal(t.month, "2026-10");
  assert.equal(t.requests, 4);
  assert.equal(t.premium, 8.5);
  assert.equal(t.unpriced, 1);
  assert.equal(t.credits, 0.3);
  assert.deepEqual(t.byModel.map((m) => [m.model, m.requests, m.premium]), [["B", 2, 7.5], ["A", 1, 1], ["C", 1, 0]]);
});

test("CopilotLocalReader reads both log homes, skips last month's files, re-reads only what moved", async () => {
  const user = tmp("cplocal");
  const ws = join(user, "workspaceStorage", "abc", "chatSessions");
  const empty = join(user, "globalStorage", "emptyWindowChatSessions");
  mkdirSync(ws, { recursive: true });
  mkdirSync(empty, { recursive: true });
  const a = join(ws, "a.jsonl");
  writeFileSync(a, [snapshot([request(OCT(5), "copilot/claude-opus-4.7")]), result(0, "Claude Opus 4.7 • 7.5x")].join("\n"));
  writeFileSync(join(empty, "b.jsonl"), [snapshot([request(OCT(6), "copilot/gpt-4.1")]), result(0, "GPT-4.1 • 0x")].join("\n"));
  const old = join(ws, "old.jsonl");
  writeFileSync(old, [snapshot([request(OCT(7), "copilot/x")]), result(0, "X • 100x")].join("\n"));
  const sept = Date.UTC(2026, 8, 20) / 1000;
  utimesSync(old, sept, sept); // untouched since September: nothing of this month can be in it

  const r = new data.CopilotLocalReader(user);
  const d = await r.read(NOW);
  assert.equal(d.logs, 3);
  assert.equal(d.requests, 2);
  assert.equal(d.premium, 7.5);
  assert.equal(d.sku, null, "no state.vscdb here: the plan is absent, never guessed");
  assert.match(data.localWords(d), /^plan unknown · 7\.5 premium requests this month here$/);

  writeFileSync(a, [snapshot([request(OCT(5), "copilot/claude-opus-4.7")]), result(0, "Claude Opus 4.7 • 15x")].join("\n"));
  assert.equal((await r.read(NOW)).premium, 15);
});

test("no session logs at all says so instead of a zero", async () => {
  const d = await new data.CopilotLocalReader(tmp("cpnone")).read(NOW);
  assert.equal(d.logs, 0);
  assert.match(d.why, /No Copilot Chat sessions/);
  assert.match(data.localLines(d).join("\n"), /No Copilot Chat sessions/);
});

test("planWords names the plans it knows and passes others through", () => {
  assert.equal(data.planWords("free_limited_copilot"), "Copilot Free");
  assert.equal(data.planWords("copilot_enterprise_seat"), "Copilot Enterprise");
  assert.equal(data.planWords("something_new"), "something_new");
  assert.equal(data.planWords(null), null);
});
