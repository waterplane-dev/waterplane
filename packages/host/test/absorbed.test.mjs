/**
 * **A prompt the CLI took mid-turn is in the log ONCE, and not as a turn.**
 *
 * The report: "read mode misses the last output of the CLI", with two
 * screenshots a second apart — the terminal showing an answer, the reader
 * showing the same answer above a row that still read *sent from this app · the
 * CLI has not started it yet*. The CLI had started it. It had also answered it.
 *
 * What was missing was the boundary, not the output. A prompt typed into a busy
 * session is held in the composer, and when the turn ends the CLI usually starts
 * it properly and writes a `user` record. Sometimes it ABSORBS it into the turn
 * already running, and then it writes no `user` record at all: the words reach
 * the log once, as `{"type":"attachment","attachment":{"type":"queued_command",
 * "prompt":…}}`. Measured across seven days of logs on this desktop, 48 of 62
 * real queued prompts (77%) were recorded that way and no other — so every one
 * of them was invisible to a parser that reads `user` and `assistant` records,
 * its answer was folded into the previous prompt's turn, and `queuedTurns`,
 * which retires a waiting row by finding the log's own copy of the prompt, could
 * never find one.
 *
 * These cases are the four ways the recovery could lie instead: missing the
 * prompt that is only an attachment, drawing a SECOND turn for one the CLI did
 * start properly (measured: 134 records and four minutes between the attachment
 * and the `user` record, all of which belong to the turn above), opening a turn
 * on `<task-notification>` plumbing (261 of those 348 queued rows), and leaving
 * the waiting row up once the log has taken the words.
 *
 * Fixtures are hand-built logs in a temp dir, as in `lastturn.test.mjs`.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { absorbedOpeners, parseTranscript, queuedTurns, queuedPromptOf } = await import("../dist/transcript.js");

const DIR = mkdtempSync(join(tmpdir(), "waterplane-absorbed-"));
let n = 0;
function log(records) {
  const p = join(DIR, `t${n++}.jsonl`);
  writeFileSync(p, records.map((r) => JSON.stringify(r)).join("\n") + "\n");
  return p;
}

const T0 = Date.parse("2026-09-18T19:35:05Z");
const iso = (ms) => new Date(ms).toISOString();

const user = (ms, text, uuid = `u${ms}`) =>
  ({ type: "user", uuid, timestamp: iso(ms), message: { role: "user", content: [{ type: "text", text }] } });
const assistant = (ms, text) =>
  ({ type: "assistant", uuid: `a${ms}`, timestamp: iso(ms), message: { role: "assistant", content: [{ type: "text", text }] } });
/** The CLI's own record of a prompt it pulled off the composer queue. */
const queued = (ms, prompt, uuid = `q${ms}`) =>
  ({ type: "attachment", uuid, timestamp: iso(ms), attachment: { type: "queued_command", prompt, commandMode: "prompt", origin: { kind: "human" }, timestamp: iso(ms) } });
/** The bookkeeping rows that ride beside it and are deliberately not read. */
const queueOp = (ms, operation, content, reason) =>
  ({ type: "queue-operation", operation, timestamp: iso(ms), content, ...(reason ? { reason } : null) });

const parse = (p) => parseTranscript(p, "/repo", "full");
const textOf = (t) => t.blocks.filter((b) => b.kind === "text").map((b) => b.text).join("\n");

test("an absorbed prompt is a turn, and the answer under it is its own", () => {
  const p = log([
    user(T0, "what is left to do here?"),
    assistant(T0 + 16_000, "Garmin monorepo found, nested two levels under the root."),
    queueOp(T0 + 37_000, "enqueue", "Can I even expect quality output here?"),
    queueOp(T0 + 42_000, "remove", "Can I even expect quality output here?", "absorbed_mid_turn"),
    queued(T0 + 37_000, "Can I even expect quality output here?"),
    assistant(T0 + 53_000, "Short answer: no, not unsupervised."),
  ]);
  const doc = parse(p);
  assert.equal(doc.turns.length, 2, "the prompt the CLI absorbed opens a turn of its own");
  const [first, second] = doc.turns;
  assert.equal(first.prompt, "what is left to do here?");
  assert.equal(textOf(first), "Garmin monorepo found, nested two levels under the root.",
    "…and the earlier answer stays with the prompt it was given for");
  assert.equal(second.prompt, "Can I even expect quality output here?");
  assert.equal(second.absorbed, true, "…marked, because the CLI folded it into a running turn");
  assert.equal(textOf(second), "Short answer: no, not unsupervised.",
    "…and the last output of the CLI is under it, which is the whole report");
  assert.equal(second.sentAt, T0 + 37_000, "stamped when the person sent it, not when it was absorbed");
});

test("a prompt the CLI DID start properly is not drawn twice", () => {
  // The measured shape: the attachment is written when the queue is drained,
  // and the `user` record minutes and many records later, when the turn
  // actually starts. Everything between the two belongs to the turn above — so
  // a turn opened on the attachment would both duplicate the prompt and steal
  // that work from the turn that did it.
  const p = log([
    user(T0, "first prompt"),
    queued(T0 + 30_000, "the queued one"),
    assistant(T0 + 40_000, "still finishing the first"),
    assistant(T0 + 90_000, "done with the first"),
    user(T0 + 120_000, "the queued one"),
    assistant(T0 + 130_000, "answering the queued one"),
  ]);
  const doc = parse(p);
  assert.equal(doc.turns.length, 2, "two prompts, two turns — never three");
  assert.equal(doc.turns.filter((t) => t.absorbed).length, 0);
  assert.equal(textOf(doc.turns[0]), "still finishing the first\ndone with the first",
    "…and the work between the two records stays where it was done");
});

test("the log's own copy may carry more than the queue's, and still counts as the same prompt", () => {
  // The CLI appends to a prompt it takes (an image note, a pasted-file
  // expansion), which is why `queuedTurns` matches on a squashed head. The same
  // rule decides this, or an attachment whose `user` record grew a suffix would
  // open a duplicate turn.
  const p = log([
    queued(T0, "look at this .claude/inbox/shot.png"),
    user(T0 + 60_000, "look at this .claude/inbox/shot.png\n\n[Image: original 824x2046, displayed at 412x1023]"),
    assistant(T0 + 70_000, "seen"),
  ]);
  assert.equal(parse(p).turns.length, 1);
});

test("plumbing queued behind a turn opens nothing", () => {
  // 261 of the 348 queued rows in the seven-day sample were task notifications
  // and hook echoes. `isSyntheticPrompt` drops those from a `user` record and
  // must drop them here for the same reason — they are not something a person
  // sent.
  const p = log([
    user(T0, "go"),
    queued(T0 + 10_000, "<task-notification>\n<task-id>ac688cfde</task-id>\n</task-notification>"),
    assistant(T0 + 20_000, "carrying on"),
  ]);
  const doc = parse(p);
  assert.equal(doc.turns.length, 1);
  assert.equal(queuedPromptOf(queued(T0, "<system-reminder>be brief</system-reminder>")), null);
  assert.equal(queuedPromptOf(queued(T0, "a real prompt")), "a real prompt");
  assert.equal(queuedPromptOf(user(T0, "a real prompt")), null, "a `user` record is `promptOf`'s, not this one's");
});

test("a log with no queued prompts is not parsed twice", () => {
  // The recovery costs a second pass over the same lines, so it is gated on the
  // file holding such an attachment at all — measured: 78 of 1,375 logs here.
  assert.equal(absorbedOpeners(['{"type":"user","message":{"content":"hi"}}']).size, 0);
  assert.equal(absorbedOpeners([JSON.stringify(queued(T0, "a real prompt"))]).size, 1);
});

test("the waiting row retires once the log holds the absorbed prompt", () => {
  // The visible half of the bug. Nothing in the log ever matched those words,
  // so waterplane's own row kept saying "the CLI has not started it yet" — sorted
  // BELOW the answer it had already given, which is what made the newest output
  // read as missing.
  const p = log([
    user(T0, "what is left to do here?"),
    assistant(T0 + 16_000, "here is what is left"),
    queued(T0 + 37_000, "Can I even expect quality output here?"),
    assistant(T0 + 53_000, "Short answer: no."),
  ]);
  const doc = parse(p);
  const entry = { id: "h1", kind: "prompt", text: "Can I even expect quality output here?", sentAt: T0 + 36_000 };
  assert.deepEqual(queuedTurns([entry], doc.turns), [], "the log has taken it — there is nothing left waiting");
});

test("a subagent's hand-back is not a prompt, and opens no turn", () => {
  // A background agent's final report reaches the parent as a queued
  // `<agent-message>` the CLI absorbs into the running turn. Read as a prompt
  // it split the turn: the reply's tail, and its cost, landed under a turn the
  // person never started, and "this prompt" printed that tail alone.
  const handBack = '<agent-message from="abfac7a479d9eed10">\n[Subagent hand-back] The report follows:\n  ## findings';
  const p = log([
    user(T0, "hunt for bugs with three agents"),
    assistant(T0 + 1_000, "Started three agents."),
    queueOp(T0 + 60_000, "enqueue", handBack),
    queueOp(T0 + 61_000, "remove", handBack, "absorbed_mid_turn"),
    queued(T0 + 60_000, handBack),
    assistant(T0 + 70_000, "All three are back; here is the merged report."),
  ]);
  const doc = parse(p);
  assert.equal(doc.turns.length, 1);
  assert.equal(textOf(doc.turns[0]), "Started three agents.\nAll three are back; here is the merged report.");
});
