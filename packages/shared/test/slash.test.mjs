/**
 * Which slash commands open a VIEW rather than starting a turn.
 *
 * The list moved out of the host because both ends need the same answer and
 * only one of them had it. Reported from a phone: `/usage` delivered into a
 * session 22 minutes into a turn, the CLI logging its own "Settings dialog
 * dismissed" a line later, and the delivery stuck at "Sending… 10s" holding the
 * composer while the agent streamed underneath. Prose typed at a working agent
 * is a deliberate interjection; a modal over one is not.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { isLocalCommand, slashForkTitle, startsNoTurn, worksUnannounced } from "../dist/slash.js";

test("the usage view and both of the CLI's aliases for it are local", () => {
  // The CLI's own table is `{ name: "usage", aliases: ["cost", "stats"] }`,
  // which is why its menu entry draws as "/usage (cost)". All three reach the
  // same view, so all three must take the same delivery contract.
  for (const c of ["/usage", "/cost", "/stats"]) {
    assert.equal(isLocalCommand(c), true, c);
  }
});

test("arguments do not change what a command IS", () => {
  assert.equal(isLocalCommand("/resume some-session-id"), true);
  assert.equal(isLocalCommand("  /context  "), true);
});

test("anything that really starts a turn keeps the normal contract", () => {
  // The positive-list rule: getting this wrong in THIS direction means waiting
  // for a turn-start proof that will never arrive.
  for (const c of ["/init", "/compact", "/review", "/my-custom-command", "do the thing"]) {
    assert.equal(isLocalCommand(c), false, c);
  }
});

test("a command NAMED like one is not one", () => {
  // Substring matching here would quietly widen the list — a `/usage-report`
  // custom command does start a turn.
  assert.equal(isLocalCommand("/usage-report"), false);
  assert.equal(isLocalCommand("/costing"), false);
  assert.equal(isLocalCommand(""), false);
});

/**
 * `/btw` — submits, files a note, opens nothing, starts no turn.
 *
 * The two questions came apart here. The host asked "what proves this landed?"
 * and had only the turn-start proof, which for `/btw` can never arrive: five
 * Returns, a silent conversation log, and a note that HAD been filed reported
 * as `unsubmitted` — "it is sitting in the composer, unsent — do not retype
 * it". The phone asked "is this a view or an interjection?", and answering
 * "view" would hold the one command whose entire purpose is to be said to a
 * working agent without interrupting it.
 */
test("/btw starts no turn, and is still not a view", () => {
  assert.equal(startsNoTurn("/btw remember the flaky test"), true);
  assert.equal(isLocalCommand("/btw remember the flaky test"), false,
    "holding this one until the turn ends defeats the only thing it is for");
});

test("every view is also a no-turn command", () => {
  // The wider question must never answer NO where the narrower answers yes, or
  // a view goes down the prompt path and waits for a turn that cannot start.
  for (const c of ["/usage", "/context", "/resume", "/clear", "/model opus"]) {
    assert.equal(startsNoTurn(c), true, c);
  }
});

test("a real prompt starts a turn whichever way it is asked", () => {
  for (const c of ["/init", "/compact", "/my-custom-command", "do the thing", "", "/btwise"]) {
    assert.equal(startsNoTurn(c), false, c);
  }
});

/**
 * `/compact` — submits, works for minutes, announces nothing.
 *
 * The third question, and the one the phone must never be given: reported from
 * a phone as "typed, but Return was swallowed — open the session and press
 * Return", beside a terminal reading "✳ Compacting conversation… 15%". No
 * `UserPromptSubmit`, no `Stop`, and a conversation log that is silent about
 * slash commands either way, so every rung of the submit ladder was missing and
 * the one left is the CLI's own working line.
 */
test("/compact is unannounced work — not a view, and not a no-turn command", () => {
  assert.equal(worksUnannounced("/compact"), true);
  assert.equal(worksUnannounced("/compact focus on the test failures"), true,
    "arguments do not change what a command IS");
  assert.equal(isLocalCommand("/compact"), false,
    "it is not a modal to hold until the turn ends");
  assert.equal(startsNoTurn("/compact"), false,
    "there IS a turn's worth of work here — only nothing announcing it");
});

test("nothing else is unannounced work", () => {
  // Widening this set hands a command the weakest proof in the file: a spinner
  // the host inferred, which any busy session paints.
  for (const c of ["/btw note", "/usage", "/init", "/compacting", "/compact-all", "do the thing", ""]) {
    assert.equal(worksUnannounced(c), false, c);
  }
});

/**
 * `/fork [title]` — the command the HOST answers instead of typing it. From CLI
 * 2.1.291 the CLI's own `/fork` hands the branch to its background daemon, out
 * of every tmux this host owns, so the phone that asked never sees it. The
 * parser decides what is intercepted, so it must take exactly the command.
 */
test("/fork is recognised bare and with a title; the title is one tidy line", () => {
  assert.equal(slashForkTitle("/fork"), "");
  assert.equal(slashForkTitle("  /fork  "), "");
  assert.equal(slashForkTitle("/fork try the other schema"), "try the other schema");
  assert.equal(slashForkTitle("/fork   two\n  lines  "), "two lines");
  assert.equal(slashForkTitle(`/fork ${"x".repeat(200)}`).length, 80, "capped");
});

test("a command NAMED like /fork, or prose about one, is not one", () => {
  for (const t of ["/forked", "/fork-it", "/forks", "fork", "please /fork", "", "/for"]) {
    assert.equal(slashForkTitle(t), null, JSON.stringify(t));
  }
});

test("/fork is not a view: the phone sends it at once rather than holding it", () => {
  // Forking leaves the source session alone, so a running turn has nothing to
  // be protected from — holding it until idle would only delay the new tab.
  assert.equal(isLocalCommand("/fork"), false);
});
