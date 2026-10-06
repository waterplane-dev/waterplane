/**
 * **Words typed into a choice box are not a prompt the CLI is still holding.**
 *
 * The report: "read mode is not getting the latest output", over a reader that
 * showed the reply and then, BELOW it, two rows saying *the CLI has not started
 * it yet*. Both were "Other" answers to one two-question `AskUserQuestion`
 * box, typed in through the ordinary send path and so in waterplane's history as
 * prompts. The CLI never logs those as prompts: they come back once, inside the
 * box's `tool_result`. `queuedTurns` matched only `user` prompts, so the rows
 * never retired.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { boxAnswersOf, parseTranscript, queuedTurns } = await import("../dist/transcript.js");

const DIR = mkdtempSync(join(tmpdir(), "waterplane-boxanswer-"));
const T0 = Date.parse("2026-10-04T09:50:00Z");
const iso = (ms) => new Date(ms).toISOString();
function log(records) {
  const p = join(DIR, `t${T0}-${records.length}.jsonl`);
  writeFileSync(p, records.map((r) => JSON.stringify(r)).join("\n") + "\n");
  return p;
}
const user = (ms, text) => ({ type: "user", uuid: `u${ms}`, timestamp: iso(ms), message: { role: "user", content: [{ type: "text", text }] } });
const ask = (ms, id) => ({ type: "assistant", uuid: `a${ms}`, timestamp: iso(ms), message: { role: "assistant", content: [{ type: "tool_use", id, name: "AskUserQuestion", input: { questions: [] } }] } });
const answer = (ms, id, text) => ({ type: "user", uuid: `r${ms}`, timestamp: iso(ms), message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content: text }] } });
const entry = (id, text, at) => ({ id, kind: "prompt", text, sentAt: at });

const RESULT = 'The user answered: "Which low-use features should be cut?"="None of these. They are low usage frequency but important ", '
  + '"Launch shape?"="Open code can be kept private - factoring it out to a plugin might be good for hat purpose?". You can now continue.';

test("an answer typed into a box retires its waiting row, in a lite parse too", () => {
  const p = log([user(T0, "plan the release"), ask(T0 + 60_000, "toolu_1"), answer(T0 + 22 * 60_000, "toolu_1", RESULT)]);
  const doc = parseTranscript(p, "/repo", "lite");
  const sent = [
    entry("h3", "None of these. They are low usage frequency but important", T0 + 16 * 60_000),
    entry("h4", "Open code can be kept private - factoring it out to a plugin might be good for hat purpose?", T0 + 22 * 60_000 - 30_000),
  ];
  assert.deepEqual(queuedTurns(sent, doc.turns, boxAnswersOf(doc)), [], "the box's own record has both answers");
  assert.equal(queuedTurns(sent, doc.turns).length, 2, "…which is the only thing retiring them");
});

test("an older answer with the same words does not retire a newer send", () => {
  const p = log([user(T0, "plan"), ask(T0 + 1000, "toolu_2"), answer(T0 + 2000, "toolu_2", RESULT)]);
  const doc = parseTranscript(p, "/repo", "lite");
  const later = entry("h5", "None of these. They are low usage frequency but important", T0 + 60_000);
  assert.equal(queuedTurns([later], doc.turns, boxAnswersOf(doc)).length, 1);
});

test("a log with no box carries no answers", () => {
  const doc = parseTranscript(log([user(T0, "hi")]), "/repo", "lite");
  assert.deepEqual(boxAnswersOf(doc), []);
});
