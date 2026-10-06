/**
 * **A prompt the CLI is HOLDING is still something the reader must show.**
 *
 * The report: "the last thing I sent was accepted by the CLI and is worked on
 * but it does not show in the list", with the outline saying `2 turns` over a
 * session that had just been sent a third. The outline was not wrong about the
 * conversation log — the log was not the whole of what is known. The TUI holds
 * a prompt typed into a mid-turn session in its composer until the turn ends,
 * and writes nothing until it starts it: measured on the live host, a prompt
 * sent at 09:57 reached the log at 10:04, behind a turn that ran 131 tools.
 *
 * `queuedTurns` is the other half of that record — what waterplane itself typed in —
 * and these cases are the three ways it could lie instead: claiming a prompt
 * the log has already taken, claiming one the log moved past, and claiming a
 * turn where there is only a prompt.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mergeLocalTurns, queuedTurns } from "../dist/transcript.js";

const T0 = Date.parse("2026-09-16T06:59:39Z");
/** One turn as the log records it. */
const logged = (n, prompt, at) => ({
  id: `t${n}`, n, prompt, promptLabel: prompt.slice(0, 40), sentAt: at,
  blocks: [], toolCount: 0, files: [], sidechains: 0,
});
/** One entry as `recordPrompt` writes it: a delivery whose text was SEEN. */
const entry = (id, text, at) => ({ id, kind: "prompt", text, sentAt: at });

test("a prompt sent after the newest logged turn is a waiting row", () => {
  const doc = [logged(1, "The x to close in this dialogue does not work", T0 - 4200_000), logged(2, "Ship ba3 prod release", T0)];
  const out = queuedTurns([entry("h1", "Ship ba3 prod release", T0), entry("h2", "and now do the release notes", T0 + 300_000)], doc);
  assert.equal(out.length, 1, "the one the log has not taken");
  assert.equal(out[0].queued, true, "…marked as what it is: sent, not started");
  assert.equal(out[0].prompt, "and now do the release notes");
  assert.deepEqual([out[0].blocks, out[0].toolCount, out[0].files], [[], 0, []],
    "…and it claims NO turn: no blocks, no tools, no files");
});

test("the log taking the prompt is what retires the row", () => {
  // The same send, a minute later, once the CLI started it. The log's copy
  // carries whatever the CLI appended (an image note, a file expansion), so the
  // match is on the squashed HEAD and not on equality — otherwise the row would
  // be drawn a second time, beside the real turn it has become.
  const doc = [logged(1, "and now do the release notes\n\n[Image: original 824x2046]", T0 + 300_000)];
  assert.deepEqual(queuedTurns([entry("h2", "and now do the release notes", T0 + 300_000)], doc), []);
});

test("an entry the log has moved past is never resurrected", () => {
  // A delivery that echoed and was then cleared (an Esc, a ctrl-U, a person
  // deleting it) leaves a history row behind. The next logged turn is what ends
  // its life: nothing has to retire it, which is why there is no clock here.
  const doc = [logged(1, "something else entirely", T0 + 600_000)];
  assert.deepEqual(queuedTurns([entry("h9", "a prompt that never ran", T0)], doc), []);
});

test("a local command is the other function's row, not this one's", () => {
  // `/btw` and friends never reach the log AT ALL — a different fact, with its
  // own row (`screenCommandTurns`, `local: "screen"`). Claiming them here would
  // print each of them twice.
  assert.deepEqual(queuedTurns([entry("h3", "/btw remember the tag is ba3", T0 + 60_000)], []), []);
});

test("the list is bounded, newest kept", () => {
  const many = Array.from({ length: 9 }, (_, i) => entry(`h${i}`, `prompt number ${i}`, T0 + i * 1000));
  const out = queuedTurns(many, []);
  assert.equal(out.length, 5, "a session typed into all day is not a document of waiting rows");
  assert.equal(out.at(-1).prompt, "prompt number 8", "…and the tail is the part somebody is waiting on");
});

test("merged, it numbers last and the outline can count it apart", () => {
  const doc = [logged(1, "first", T0), logged(2, "second", T0 + 10)];
  const merged = mergeLocalTurns(doc, queuedTurns([entry("h4", "third, still waiting", T0 + 20)], doc));
  assert.deepEqual(merged.map((t) => t.n), [1, 2, 3]);
  assert.equal(merged.at(-1).queued, true);
  assert.equal(merged.filter((t) => !t.queued).length, 2, "two turns and one waiting prompt — never three turns");
});
