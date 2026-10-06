/**
 * The header chips a session may actually be offered — pinned without a browser.
 *
 *     node --test packages/web/src/headerCmds.test.mjs
 *
 * ── The bug on the screenshot ───────────────────────────────────────────────
 *
 * A live `opencode` session showed three absent-capability sentences — no
 * reader view, no context graph, **no slash commands** — and, two rows above
 * them, a `/compact` chip. The chip does not fail against that backend: its
 * descriptor says `slash: "none"` and its `isLocalCommand` is `() => false`, so
 * the text lands as an ordinary PROMPT and the binary is asked, in English, to
 * compact itself. The screen contradicted itself in one glance and the half
 * that won was the half you could press.
 *
 * So what is pinned here is not "the filter works". It is the three rules the
 * fix rests on, each of which can rot invisibly:
 *
 *  - **`canSlash: true` changes nothing.** That is claude, and it is every host
 *    that never described a backend. A claude header must be byte-identical.
 *  - **The number and the cut come from ONE call.** A count on a control is a
 *    filter (CLAUDE.md); a second derivation of "which chips are slash
 *    commands" makes the sentence in the strip a liar the first time the two
 *    disagree.
 *  - **The predicate is `runHeaderCmd`'s own.** The chip withheld must be
 *    exactly the chip that would have been submitted as `kind: "command"` —
 *    same `text.trimStart().startsWith("/")`, no second opinion about what a
 *    leading slash means.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_HEADER_CMDS, isSlashCmd, splitHeaderCmds } from "./headerCmds.ts";

const cmd = (id, text, title = id) => ({ id, title, text });

test("a backend that takes slash commands gets the list unchanged", () => {
  // The compatibility promise: claude, and every desktop that never sent a
  // `backends` frame (where `hasCap` answers true with no descriptor).
  const list = [...DEFAULT_HEADER_CMDS];
  const split = splitHeaderCmds(list, true);
  assert.deepEqual(split.shown, list);
  assert.equal(split.hiddenSlash, 0);
  // Not the same array — a caller must not be able to mutate the stored list
  // through the render's copy.
  assert.notEqual(split.shown, list);
});

test("the shipped defaults lose exactly their two slash chips", () => {
  // `/compact` and `/context` are Claude's vocabulary; `continue` is a word.
  const split = splitHeaderCmds(DEFAULT_HEADER_CMDS, false);
  assert.deepEqual(split.shown.map((c) => c.id), ["continue"]);
  assert.equal(split.hiddenSlash, 2);
});

test("the count and the cut are the same fact, never two", () => {
  // The rule the strip's sentence depends on: `hiddenSlash` is what was
  // actually removed, so "2 of your header chips" and the two missing chips
  // cannot drift.
  const list = [
    cmd("a", "/compact"), cmd("b", "keep going"), cmd("c", "/context"),
    cmd("d", "/usage"), cmd("e", "explain that"),
  ];
  const split = splitHeaderCmds(list, false);
  assert.equal(split.hiddenSlash, list.length - split.shown.length);
  assert.equal(split.hiddenSlash, 3);
  assert.deepEqual(split.shown.map((c) => c.id), ["b", "e"]);
});

test("a chip is slash by its TEXT, never by its title", () => {
  // The title is a label somebody typed; the text is what gets submitted. A
  // chip titled "compact" carrying "/compact" is the dangerous one, and a chip
  // titled "/compact" carrying prose is harmless.
  const split = splitHeaderCmds([
    cmd("x", "/compact", "compact"),
    cmd("y", "please compact", "/compact"),
  ], false);
  assert.deepEqual(split.shown.map((c) => c.id), ["y"]);
  assert.equal(split.hiddenSlash, 1);
});

test("leading whitespace does not smuggle a slash command through", () => {
  // `runHeaderCmd` trims the start before deciding `kind: "command"`, so this
  // must too — otherwise the chip is offered AND submitted as a command.
  assert.equal(isSlashCmd("   /compact"), true);
  assert.equal(isSlashCmd("\n\t/context"), true);
  assert.equal(isSlashCmd("/"), true);
  assert.equal(isSlashCmd("continue"), false);
  assert.equal(isSlashCmd("and/or"), false);
  assert.equal(isSlashCmd(""), false);
  // A path is not a command, and a chip is allowed to open with one.
  assert.equal(isSlashCmd("src/index.ts is wrong"), false);
  assert.equal(isSlashCmd("/Users/me/dev — look here"), true); // leading slash: withheld, deliberately
});

test("an empty list, and a list with nothing to hide, are both quiet", () => {
  // No count means no sentence appended in the strip — `sessionCants` only
  // appends past zero, and a "0 of your header chips" line would be noise on
  // the screen a person opens to find out what is missing.
  assert.deepEqual(splitHeaderCmds([], false), { shown: [], hiddenSlash: 0 });
  const prose = [cmd("a", "continue"), cmd("b", "keep going")];
  assert.deepEqual(splitHeaderCmds(prose, false), { shown: prose, hiddenSlash: 0 });
});

test("nothing is deleted — the input list is untouched", () => {
  // These are SYNCED user data. A session that cannot use a chip is not a
  // reason to edit somebody's configuration on every device they own.
  const list = [cmd("a", "/compact"), cmd("b", "continue")];
  const before = JSON.stringify(list);
  splitHeaderCmds(list, false);
  assert.equal(JSON.stringify(list), before);
});
