// The demo PTY drawn as the real CLI draws it (cli.ts): word wrap, glyphs, the input box.
import test from "node:test";
import assert from "node:assert/strict";
import { footer, render, wrap } from "./cli.ts";

const plain = (s) => s.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "");

test("wraps at words with a hanging indent, never mid-word", () => {
  const lines = wrap("⏺ Done. A quick-add bar now sits above the list of tasks", 24, 2).map(plain);
  assert.deepEqual(lines, ["⏺ Done. A quick-add bar", "  now sits above the", "  list of tasks"]);
  for (const l of lines) assert.ok(l.length <= 24);
});

test("a word longer than the line is cut where the line ends", () => {
  const lines = wrap("  ⎿  saved .claude/outbox/todo-garden-quick-add.png", 20, 5).map(plain);
  for (const l of lines) assert.ok(l.length <= 20, l);
  assert.equal(lines.join("").replace(/\s+/g, ""), "⎿saved.claude/outbox/todo-garden-quick-add.png");
});

test("source form becomes the CLI's glyphs, each block set off by a blank line", () => {
  const src = "\x1b[1m>\x1b[0m add a quick-add bar\r\n● On it.\r\n\x1b[1m● Read\x1b[0m(src/a.ts)\r\n\x1b[2m  ⎿  Read 84 lines\x1b[0m\r\n";
  const { lines, endsBlank } = render(src, 80, true);
  assert.deepEqual(lines.map(plain), ["❯ add a quick-add bar", "", "⏺ On it.", "", "⏺ Read(src/a.ts)", "  ⎿  Read 84 lines"]);
  assert.equal(endsBlank, false);
});

test("the input box is always there; the spinner only while a turn runs", () => {
  const idle = footer({ turnActive: false }, 30, 0).map(plain);
  assert.deepEqual(idle, ["─".repeat(30), "❯ ", "─".repeat(30), "  ? for shortcuts"]);
  const busy = footer({ turnActive: true, turnStartedAt: 1_000 }, 30, 13_000, false).map(plain);
  assert.deepEqual(busy.slice(0, 3), ["", "✻ Cooking… (12s · esc to interrupt)", ""]);
  assert.equal(busy.at(-2), "─".repeat(30));
});
