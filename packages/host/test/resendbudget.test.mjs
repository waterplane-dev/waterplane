/**
 * How many times the host types a provably-absent prompt again
 * (`opendeliveries.ts`'s `RESEND_TRIES`).
 *
 * The rule used to be one attempt, then a full stop, and what it produced was a
 * row that went red fifteen seconds after a send saying nothing ran and nobody
 * would try again — which reads as fatal for what is usually a session that
 * stayed busy one moment longer. The safety argument did not change and is what
 * permits the count: every attempt is preceded by its OWN fresh `absent`
 * verdict (a readable conversation log that does not contain the prompt, and a
 * screen that does not either), so there is never a copy for the next one to
 * stack on.
 *
 * So what is pinned here is the arithmetic either side of that argument: the
 * budget is spent exactly once per attempt and stops ON the number, and the one
 * verdict that is a STATE rather than a race (`retry` — the session never
 * became ready) still ends the row immediately, with the budget untouched.
 *
 * The env knobs are read at module load, so the import is dynamic and comes
 * after they are set.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.WATERPLANE_SETTLE_BASE_MS = "20";
process.env.WATERPLANE_SETTLE_MAX_GAP_MS = "20";
process.env.WATERPLANE_RESEND_TRIES = "3";

const { OpenDeliveries } = await import("../dist/opendeliveries.js");
const { forgetSpentTurns } = await import("../dist/settle.js");

/**
 * A session whose conversation log is READABLE and does not hold the text, and
 * whose screen does not either — which is what `absent` means, and the only
 * verdict that authorises another send.
 *
 * The screen has to be non-EMPTY to be evidence at all: a blank read is a
 * session that could not be rendered, which settles `unknown` and acts on
 * nothing.
 */
function absentSessions() {
  const screen = ["  running the suite", "  283 passed", "", "❯ ", "  ⏵⏵ auto mode on"].join("\n");
  return {
    get: () => ({ running: true, cwd: "/tmp/repo", title: "repo · main", remoteControl: true }),
    // A claude session, which is what `absent` requires: settling asks this
    // BEFORE it reads a transcript, because a backend whose record is not
    // claude's jsonl can never produce the evidence these verdicts are about,
    // and reading one to discover that costs a full store read per settle.
    keepsClaudeLog: () => true,
    screenText: async () => screen,
    getTranscript: () => ({ source: "jsonl", turns: [{ id: "u0", prompt: "something else entirely", sentAt: Date.now() }] }),
  };
}

function store(redeliver) {
  const root = mkdtempSync(join(tmpdir(), "waterplane-resend-"));
  mkdirSync(join(root, ".myapp"), { recursive: true });
  const q = new OpenDeliveries(root, absentSessions(), redeliver, () => {});
  return q;
}

const PROMPT = "rewrite the retry test so a busy session does not read as a lost prompt";

const add = (q) => q.add({
  sessionId: "s1", text: PROMPT, result: "unconfirmed", startedAt: Date.now(),
  ackId: `ack-${Math.random().toString(36).slice(2)}`, source: "compose", kind: "prompt",
});

/** Drive the sweep until the row is no longer open (or the patience runs out —
 *  a hang here is a failure, not a slow test). */
async function settleRow(q, row) {
  q.start();
  try {
    for (let i = 0; i < 400 && row.verdict === "open"; i++) await new Promise((r) => setTimeout(r, 25));
  } finally { q.stop(); }
  return row;
}

test("an unconfirmable re-send is tried again — up to the budget, then answered", async (t) => {
  forgetSpentTurns();
  t.after(forgetSpentTurns);
  let sent = 0;
  const q = store(async () => { sent++; return "unconfirmed"; });
  const row = await settleRow(q, add(q));
  assert.equal(sent, 3, "three tries — the budget, spent once per attempt and not exceeded");
  assert.equal(row.resends, 3, "the count is on the row, so a phone can say which attempt this is");
  assert.equal(row.verdict, "absent");
  assert.match(row.reason, /3 times/, "the row says how hard the host tried, not just that it failed");
  assert.match(row.reason, /words are kept/, "…and what is left to do about it");
});

test("a re-send that provably typed nothing ends the row — that is a state, not a race", async (t) => {
  forgetSpentTurns();
  t.after(forgetSpentTurns);
  let sent = 0;
  const q = store(async () => { sent++; return "retry"; });
  const row = await settleRow(q, add(q));
  assert.equal(sent, 1, "another attempt in twenty milliseconds is a poller with a nice name");
  assert.equal(row.verdict, "absent");
  assert.match(row.reason, /never became ready/);
});

test("a re-send that lands stops the ladder at once", async (t) => {
  forgetSpentTurns();
  t.after(forgetSpentTurns);
  let sent = 0;
  const q = store(async () => { sent++; return "ok"; });
  const row = await settleRow(q, add(q));
  assert.equal(sent, 1);
  assert.equal(row.verdict, "landed");
  assert.equal(row.resends, 1);
});
