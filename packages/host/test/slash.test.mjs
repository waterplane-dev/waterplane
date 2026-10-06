/**
 * Which slash commands open a VIEW instead of running a turn.
 *
 * The distinction decides how `deliver.ts` confirms a send. A TUI-local command
 * fires no `UserPromptSubmit`, so waiting for one times out; the proof has to be
 * the screen MOVING, and the composer sweep must send no Esc — the view it
 * would close is the one the user just asked for. Getting the membership wrong
 * either way is a send that reports the wrong thing.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { isLocalCommand, startsNoTurn } from "../dist/slash.js";

test("view-opening commands are local", () => {
  for (const c of ["/cost", "/context", "/resume", "/config", "/model", "/help"]) {
    assert.equal(isLocalCommand(c), true, `${c} opens a view`);
  }
});

test("a command that actually runs a turn is not", () => {
  for (const c of ["/commit", "/review", "/init", "/compact"]) {
    assert.equal(isLocalCommand(c), false, `${c} runs a turn`);
  }
});

test("ordinary prose is not a command", () => {
  assert.equal(isLocalCommand("fix the failing test"), false);
  assert.equal(isLocalCommand(""), false);
});

test("arguments are ignored — the verb is what decides", () => {
  assert.equal(isLocalCommand("/model opus"), true);
  assert.equal(isLocalCommand("  /cost  "), true, "and so is surrounding space");
});

test("a command mentioned mid-sentence is not one", () => {
  // The check is the FIRST token, so a prompt that talks about a command is
  // still a prompt.
  assert.equal(isLocalCommand("run /cost for me"), false);
});

test("the host also gets the wider question, and it is a different one", () => {
  // `deliver.ts` asks `startsNoTurn`, not `isLocalCommand`. The two answers
  // differ for exactly one command, and that difference is the point: `/btw`
  // takes the screen-moved submit proof (it can never prove a turn started) but
  // keeps the Esc in the composer sweep — it opened no view to close — and is
  // still delivered mid-turn by the phone rather than held.
  assert.equal(startsNoTurn("/btw ship it after this turn"), true);
  assert.equal(isLocalCommand("/btw ship it after this turn"), false);
  assert.equal(startsNoTurn("/context"), true, "every view is also a no-turn command");
  assert.equal(startsNoTurn("/review"), false);
});
