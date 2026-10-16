/**
 * Local commands in the reader — `/goal`, `/context`, `/btw`.
 *
 * The reader's document is the CLI's own conversation log, and the log treats a
 * TUI-local command as plumbing: `<command-name>` + `<command-args>` in one
 * record, `<local-command-stdout>` in the next. `isSyntheticPrompt` dropped both
 * so they could not open a bogus turn — correct, and it also meant read mode
 * showed a conversation in which the command and its answer had never happened,
 * while the terminal one swipe away showed both.
 *
 * Worse for `/btw`: the CLI writes NOTHING for it. Measured on this desktop —
 * the exchange exists only on the screen and in waterplane's own PTY capture, which is
 * why `screenCommandTurns` exists at all and why it is labelled `screen` rather
 * than passed off as a log record.
 *
 * Pinned here rather than in e2e because every failure mode is a plausible
 * document: a turn that reads as a model turn, an answer printed under the wrong
 * prompt, or the same command shown twice — none of them crash.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { parseTranscript, screenCommandTurns, mergeLocalTurns, trimTuiChrome, scrollHintTrimmed, sliceToCommand, foldRepaints } =
  await import("../dist/transcript.js");

const DIR = mkdtempSync(join(tmpdir(), "waterplane-localcmd-"));
let n = 0;
function log(records) {
  const p = join(DIR, `t${n++}.jsonl`);
  writeFileSync(p, records.map((r) => (typeof r === "string" ? r : JSON.stringify(r))).join("\n") + "\n");
  return p;
}
const T = Date.parse("2026-09-12T10:00:00.000Z");
const iso = (ms) => new Date(ms).toISOString();
const user = (text, over = {}) => ({
  type: "user", uuid: `u${n}-${Math.round(Math.random() * 1e6)}`, timestamp: iso(T),
  message: { role: "user", content: [{ type: "text", text }] }, ...over,
});
const assistant = (text, over = {}) => ({
  type: "assistant", uuid: `a${n}`, timestamp: iso(T + 1000),
  message: { role: "assistant", content: [{ type: "text", text }] }, ...over,
});

test("a logged local command is a TURN of its own, with its stdout under it", () => {
  const p = log([
    user("<command-name>/goal</command-name>\n<command-message>goal</command-message>\n<command-args>ship the queue fix</command-args>"),
    user("<local-command-stdout>Goal set: ship the queue fix</local-command-stdout>"),
  ]);
  const doc = parseTranscript(p, "/repo");
  assert.equal(doc.turns.length, 1);
  const t = doc.turns[0];
  // The command as a person typed it — name and args rejoined, not the envelope.
  assert.equal(t.prompt, "/goal ship the queue fix");
  assert.equal(t.local, "log");
  assert.deepEqual(t.blocks, [{ kind: "screen", text: "Goal set: ship the queue fix" }]);
});

test("stdout with no envelope above it is still dropped, and opens nothing", () => {
  // The old behaviour for every other piece of plumbing, unchanged: an orphan
  // stdout record printed as a turn would be an answer with no question.
  const p = log([user("<local-command-stdout>something the CLI said</local-command-stdout>")]);
  const doc = parseTranscript(p, "/repo");
  assert.deepEqual(doc.turns, []);
});

test("a real prompt after a local command opens its own turn", () => {
  const p = log([
    user("<command-name>/context</command-name>"),
    user("<local-command-stdout>  84% used</local-command-stdout>"),
    user("fix the flaky test"),
    assistant("on it"),
  ]);
  const doc = parseTranscript(p, "/repo");
  assert.deepEqual(doc.turns.map((t) => [t.prompt, t.local ?? null]), [
    ["/context", "log"],
    ["fix the flaky test", null],
  ]);
  // The model's words belong to the PROMPT, never to the command above it.
  assert.deepEqual(doc.turns[1].blocks, [{ kind: "text", text: "on it" }]);
});

test("screenCommandTurns carries the commands the log never wrote down", () => {
  const entries = [
    { id: "h1", kind: "command", text: "/usage today", sentAt: T, output: "  /usage today\n\n    artifact-design and artifact-diagramming.", outputAt: T + 5000 },
  ];
  const [turn] = screenCommandTurns(entries, []);
  assert.equal(turn.local, "screen");
  assert.equal(turn.prompt, "/usage today");
  assert.equal(turn.blocks[0].kind, "screen");
  assert.match(turn.blocks[0].text, /artifact-diagramming/);
});

test("/btw is a ROW with no body: the reader points at the CLI instead of copying the overlay", () => {
  // Typed into a running turn (its whole purpose) the capture is the turn's
  // screen with the overlay painted over it, and cutting one out of the other
  // kept breaking. The row stays, so the question is still in the reader.
  const clean = [{ id: "h1", kind: "command", text: "/btw which skills are these?", sentAt: T, output: "  /btw which skills are these?\n\n    artifact-design.", outputAt: T + 5000 }];
  const [idle] = screenCommandTurns(clean, []);
  assert.equal(idle.local, "screen");
  assert.equal(idle.prompt, "/btw which skills are these?");
  assert.deepEqual(idle.blocks, []);
  const logged = [{ id: "x", n: 1, prompt: "work", promptLabel: "work", sentAt: T - 60_000, endedAt: T + 600_000, blocks: [], toolCount: 0, files: [], sidechains: 0 }];
  const [mid] = screenCommandTurns([{ ...clean[0], output: undefined, outputAt: undefined }], logged);
  assert.deepEqual(mid.blocks, []);
});

test("a command the LOG already carries is never added a second time", () => {
  const logged = [{ id: "x", n: 1, prompt: "/goal ship it", promptLabel: "/goal ship it", sentAt: T + 20_000, blocks: [], toolCount: 0, files: [], sidechains: 0, local: "log" }];
  const entries = [{ id: "h1", kind: "command", text: "/goal ship it", sentAt: T, output: "Goal set", outputAt: T + 1000 }];
  assert.deepEqual(screenCommandTurns(entries, logged), []);
  // …but the same command typed again an hour later is a different act.
  const later = [{ id: "h2", kind: "command", text: "/goal ship it", sentAt: T + 60 * 60_000, output: "Goal set", outputAt: T + 60 * 60_000 }];
  assert.equal(screenCommandTurns(later, logged).length, 1);
});

test("prompts are never injected from the capture — only commands", () => {
  // A prompt reaches the conversation log by definition; taking it from the
  // screen too would print every turn twice, the second time approximately.
  const entries = [{ id: "h1", kind: "prompt", text: "fix the flaky test", sentAt: T, output: "…", outputAt: T }];
  assert.deepEqual(screenCommandTurns(entries, []), []);
});

test("merging renumbers, so the outline and the reader agree", () => {
  const turns = [
    { id: "a", n: 1, prompt: "first", promptLabel: "first", sentAt: T, blocks: [], toolCount: 0, files: [], sidechains: 0 },
    { id: "b", n: 2, prompt: "second", promptLabel: "second", sentAt: T + 60_000, blocks: [], toolCount: 0, files: [], sidechains: 0 },
  ];
  const extra = [{ id: "screen:h1", n: 0, prompt: "/btw", promptLabel: "/btw", sentAt: T + 30_000, blocks: [], toolCount: 0, files: [], sidechains: 0, local: "screen" }];
  const merged = mergeLocalTurns(turns, extra);
  assert.deepEqual(merged.map((t) => [t.n, t.prompt]), [[1, "first"], [2, "/btw"], [3, "second"]]);
  // Nothing to merge leaves the document — and its numbering — untouched.
  assert.equal(mergeLocalTurns(turns, []), turns);
});

test("the capture is cut to the command and stripped of the CLI's furniture", () => {
  const capture = [
    "Read 1 file, listed 2 directories (ctrl+o to expand)",
    "⏺ Skill(artifact-diagramming)",
    "  /btw which skills are these?",
    "",
    "    artifact-design then artifact-diagramming.",
    "",
    "  ↑/↓ to scroll · c to copy · f to fork · Esc to close",
    "",
    "──────────────────────────────────────────",
    "❯ ",
    "──────────────────────────────────────────",
    "  [CAVEMAN]",
    "  ⏵⏵ auto mode on (shift+tab to cycle)",
  ].join("\n");
  const body = trimTuiChrome(sliceToCommand(capture, "/btw which skills are these?"));
  assert.match(body, /^ {2}\/btw which skills/);
  assert.match(body, /artifact-diagramming\.$/);
  assert.doesNotMatch(body, /CAVEMAN|auto mode|to scroll/);
  // A rule in the MIDDLE is content the command drew, not furniture.
  assert.match(trimTuiChrome("a\n────────\nb"), /────────/);
  // No echo of the command in the capture ⇒ nothing is cut. A capture that lost
  // the echo is still the only record there is.
  assert.equal(sliceToCommand("just output\nmore output", "/btw x"), "just output\nmore output");
});

test("a command typed into a running turn does not take that turn's screen as its answer", () => {
  // Measured (session 0fa9eacb, 2026-10-06): `/effort high` typed 50 s into a
  // turn that went on to launch background agents. The capture held no echo of
  // the command, only the turn's own output, and as the newest row the reader
  // showed that frozen screen with "finished 20:42 · took 2m" while the turn
  // above it ran to 21:08.
  const logged = [{ id: "a", n: 1, prompt: "fix both", promptLabel: "fix both", sentAt: T, endedAt: T + 30 * 60_000, blocks: [], toolCount: 3, files: [], sidechains: 0 }];
  const capture = "⏺ 2 background agents launched\n\n✻ Waiting for 2 background agents to finish\n\n❯ ";
  const [turn] = screenCommandTurns(
    [{ id: "h1", kind: "command", text: "/effort high", sentAt: T + 50_000, output: capture, outputAt: T + 170_000 }],
    logged,
  );
  assert.deepEqual(turn.blocks, []);
  assert.equal(turn.endedAt, undefined);
  // The same capture with the command's own echo in it IS the command's answer.
  const [echoed] = screenCommandTurns(
    [{ id: "h2", kind: "command", text: "/effort high", sentAt: T + 50_000, output: `${capture}\n  /effort high\n  Set effort level to high`, outputAt: T + 170_000 }],
    logged,
  );
  assert.match(echoed.blocks[0].text, /Set effort level to high/);
  assert.doesNotMatch(echoed.blocks[0].text, /background agents/);
  // Typed into an IDLE session, an echo-less capture is still the only record.
  const [idle] = screenCommandTurns(
    [{ id: "h3", kind: "command", text: "/usage x", sentAt: T + 40 * 60_000, output: "just output", outputAt: T + 41 * 60_000 }],
    logged,
  );
  assert.equal(idle.blocks[0].text, "just output");
  assert.equal(idle.endedAt, T + 41 * 60_000);
});

test("a capture the CLI could scroll is MARKED as partial, not passed off as whole", () => {
  // The footer is the only evidence there is: the rows below the fold were never
  // painted, so they are in no capture, no scrollback and no log. A block that
  // does not say so reads as the complete answer.
  const panel = [
    "  /usage which skills are these?",
    "",
    "    artifact-design then artifact-diagramming.",
    "",
    "  ↑/↓ to scroll · c to copy · f to fork · Esc to close",
    "",
    "──────────────────────────────────────────",
    "❯ ",
  ].join("\n");
  const [turn] = screenCommandTurns(
    [{ id: "h1", kind: "command", text: "/usage which skills are these?", sentAt: T, output: panel, outputAt: T + 1000 }],
    [],
  );
  assert.equal(turn.blocks[0].scrollable, true);
  // The evidence is kept; the furniture is still gone.
  assert.doesNotMatch(turn.blocks[0].text, /to scroll/);
});

test("a capture that ended in content carries no claim about a panel", () => {
  const [turn] = screenCommandTurns(
    [{ id: "h1", kind: "command", text: "/goal ship it", sentAt: T, output: "  /goal ship it\n\n    Goal set.", outputAt: T + 1000 }],
    [],
  );
  // Absent, not false: a block nobody has evidence about must not assert one.
  assert.equal(turn.blocks[0].scrollable, undefined);
});

test("the scroll hint counts only where it was on screen when the capture sealed", () => {
  const tail = "answer\n\n  ↑/↓ to scroll · Esc to close\n\n❯ ";
  assert.equal(scrollHintTrimmed(tail), true);
  // Painted over by the time the capture closed: the panel is gone, and putting
  // the notice under an answer the CLI has since replaced would point at the
  // wrong thing.
  assert.equal(scrollHintTrimmed("  ↑/↓ to scroll · Esc to close\nthen it printed this"), false);
  // "c to copy" says nothing about how much was drawn.
  assert.equal(scrollHintTrimmed("answer\n  c to copy · Esc to close"), false);
  assert.equal(scrollHintTrimmed(""), false);
});

test("a panel the CLI painted twice is ONE answer, not the same exchange twice", () => {
  // Measured capture (session 5630c7fb, 2026-09-12): the TUI painted a short
  // draft of a `/btw` panel, then repainted a taller one, and the replay keeps
  // both because each paint SCROLLED rather than overwrote. The reader showed
  // the question and its opening paragraph, then the question again with the
  // whole answer under it.
  const capture = [
    "  /btw Unaddressed? I think we fixed this very very …",
    "",
    "    Can't open the image from here — no tools in this",
    "    side thread.",
    "",
    "  /btw Unaddressed? I think we fixed this very very e…",
    "",
    "    Can't open the image from here — no tools in this",
    "    side thread.",
    "",
    "    What I actually had. One grep of store/changelog.txt.",
  ].join("\n");
  const folded = foldRepaints(capture, "/btw Unaddressed? I think we fixed this");
  assert.equal(folded.match(/\/btw Unaddressed/g).length, 1);
  assert.match(folded, /What I actually had/);
  // The kept draft is the one that says the most — the echo line differs between
  // paints because the TUI truncates it to the width it has.
  assert.match(folded, /very very e…/);
});

test("a paint that says something no other paint holds is KEPT", () => {
  // An answer long enough to scroll leaves rows in an early paint that no later
  // one carries. Folding on "keep the longest" would delete them silently.
  const capture = [
    "  /btw q",
    "    the first half, which scrolled away",
    "  /btw q",
    "    the second half, which is all that is left on screen",
  ].join("\n");
  const folded = foldRepaints(capture, "/btw q");
  assert.match(folded, /first half/);
  assert.match(folded, /second half/);
});

test("folding leaves a single-paint capture exactly as it was", () => {
  const one = "  /btw q\n\n    an answer.";
  assert.equal(foldRepaints(one, "/btw q"), one);
  // Two identical paints leave the first standing — dropping each because the
  // other matches would lose the answer altogether.
  assert.equal(foldRepaints("  /btw q\n    same\n  /btw q\n    same", "/btw q"), "  /btw q\n    same");
});
