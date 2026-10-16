/**
 * `launch.focusShell`'s pure half: which shell tab a sheet's "shell" tap lands on, how a pending
 * open is re-keyed when the host names it, and which screen draws the way back.
 */
import test from "node:test";
import assert from "node:assert/strict";

import { adoptAll, adoptedShell, pickShell, returnShownOn, returnWords } from "./shellTab.ts";

const shell = (id, over = {}) => ({ id, cwd: "/root", running: true, backend: "sh", ...over });
const base = {
  remembered: null, sessions: [], cwd: "/root",
  isShell: (b) => b === "sh", pendingAlive: () => false,
};

test("the remembered shell is reused while it runs — twenty trips are still one shell", () => {
  const sessions = [shell("a"), shell("b")];
  assert.deepEqual(pickShell({ ...base, sessions, remembered: "b" }), { do: "attach", id: "b" });
});

test("a remembered shell that ended falls back to a running shell in the folder, else a fresh one", () => {
  assert.deepEqual(pickShell({ ...base, sessions: [shell("b", { running: false }), shell("c")], remembered: "b" }), { do: "attach", id: "c" });
  assert.deepEqual(pickShell({ ...base, sessions: [shell("b", { running: false })], remembered: "b" }), { do: "open" });
  assert.deepEqual(pickShell({ ...base, remembered: "gone" }), { do: "open" });
});

test("an existing shell is reused only when it is a plain shell in the same folder", () => {
  const claude = { id: "k", cwd: "/root", running: true, backend: "claude" };
  const elsewhere = shell("e", { cwd: "/root/app" });
  const companion = shell("m", { companionOf: "k" });
  assert.deepEqual(pickShell({ ...base, sessions: [claude, elsewhere, companion] }), { do: "open" },
    "a claude tab, a shell in another folder and another session's companion are none of them ours");
  assert.deepEqual(pickShell({ ...base, sessions: [claude, elsewhere, companion, shell("s")] }), { do: "attach", id: "s" });
});

test("a pending open still in the queue is re-entered, never opened a second time", () => {
  const p = { ...base, remembered: "pending:ack1", pendingAlive: (a) => a === "ack1" };
  assert.deepEqual(pickShell(p), { do: "enter", ack: "ack1" });
  // Refused or gone: the next tap finds what is running, or opens.
  assert.deepEqual(pickShell({ ...p, pendingAlive: () => false }), { do: "open" });
  assert.deepEqual(pickShell({ ...p, pendingAlive: () => false, sessions: [shell("s")] }), { do: "attach", id: "s" });
});

test("the host naming a pending open moves exactly that remembered id", () => {
  assert.equal(adoptedShell("pending:ack1", "ack1", "s1"), "s1");
  assert.equal(adoptedShell("pending:ack2", "ack1", "s1"), "pending:ack2");
  assert.equal(adoptedShell(null, "ack1", "s1"), null);
  const m = { one: "pending:ack1", two: "x" };
  assert.deepEqual(adoptAll(m, "ack1", "s1"), { one: "s1", two: "x" });
  assert.equal(adoptAll(m, "nope", "s1"), m, "nothing moved: the same object, so the store emits nothing");
});

test("the way back is drawn on that shell's screen and nowhere else, in the sheet's own words", () => {
  const r = { sessionId: "s1" };
  assert.ok(returnShownOn(r, "s1"));
  assert.ok(!returnShownOn(r, "s2"));
  assert.ok(!returnShownOn(null, "s1"));
  assert.ok(!returnShownOn(r, null));
  assert.equal(returnWords("notes"), "back to notes");
});
