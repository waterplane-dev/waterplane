import test from "node:test";
import assert from "node:assert/strict";
import { afterKey, nextModState, typedKey, NAMED_KEY } from "./chordState.ts";
import { CLI_SHORTCUTS, shortcutWrites } from "../session/cliShortcuts.ts";

test("a modifier tap cycles off → once → lock → off", () => {
  assert.equal(nextModState("off"), "once");
  assert.equal(nextModState("once"), "lock");
  assert.equal(nextModState("lock"), "off");
});

test("a key drops one-shot modifiers and keeps locked ones", () => {
  assert.deepEqual(afterKey({ ctrl: "once", alt: "lock", shift: "off" }), { ctrl: "off", alt: "lock", shift: "off" });
});

test("pipe bytes name the key the modifiers land on", () => {
  assert.equal(typedKey("\x7f"), "backspace");
  assert.equal(typedKey("\r"), "enter");
  assert.equal(typedKey(" "), "space");
  assert.equal(typedKey("o"), "o");
  assert.equal(NAMED_KEY.ArrowUp, "up");
});

test("every listed CLI shortcut has bytes, and the risky ones are not listed", () => {
  for (const s of CLI_SHORTCUTS) assert.ok(shortcutWrites(s), s.name);
  const names = CLI_SHORTCUTS.map((s) => s.name);
  for (const risky of ["ctrl+c", "ctrl+d", "ctrl+g", "ctrl+e", "ctrl+v"]) assert.ok(!names.includes(risky), risky);
  assert.deepEqual(shortcutWrites(CLI_SHORTCUTS.find((s) => s.name === "ctrl+o")), ["\x0f"]);
  assert.deepEqual(shortcutWrites(CLI_SHORTCUTS.find((s) => s.name === "alt+p")), ["\x1bp"]);
  assert.deepEqual(shortcutWrites(CLI_SHORTCUTS.find((s) => s.name === "esc esc")), ["\x1b", "\x1b"]);
});
