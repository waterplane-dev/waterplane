import test from "node:test";
import assert from "node:assert/strict";
import { notePendingClose, sessionClosedShellsToast, shellKilledToast, shellsSubject, takePendingClose, toShellToast } from "./logic.ts";

test("shellsSubject: sid names a row", () => {
  const sessions = [{ id: "a" }, { id: "b" }];
  assert.equal(shellsSubject("b", sessions, null), sessions[1]);
});

test("shellsSubject: null sid falls back to the attached session", () => {
  const sessions = [{ id: "a" }];
  const active = { id: "z" };
  assert.equal(shellsSubject(null, sessions, active), active);
});

test("shellsSubject: a stale sid (row gone) falls back to the attached session, not null", () => {
  const sessions = [{ id: "a" }];
  const active = { id: "z" };
  assert.equal(shellsSubject("gone", sessions, active), active);
});

test("shellsSubject: neither a match nor an attached session is null", () => {
  assert.equal(shellsSubject("gone", [{ id: "a" }], null), null);
});

test("shellKilledToast: ok is 'stopped'", () => {
  assert.equal(shellKilledToast(true), "stopped");
});

test("shellKilledToast: a refusal names the reason", () => {
  assert.equal(shellKilledToast(false, "that shell has already ended"), "not stopped — that shell has already ended");
});

test("shellKilledToast: a refusal with no reason still says something", () => {
  assert.equal(shellKilledToast(false), "not stopped");
});

test("sessionClosedShellsToast: nothing stopped and nothing left is no toast at all", () => {
  assert.equal(sessionClosedShellsToast(0), null);
  assert.equal(sessionClosedShellsToast(0, 0), null);
});

test("sessionClosedShellsToast: singular vs plural", () => {
  assert.equal(sessionClosedShellsToast(1), "stopped 1 background shell when the session closed");
  assert.equal(sessionClosedShellsToast(2), "stopped 2 background shells when the session closed");
});

test("sessionClosedShellsToast: a survivor is named, not silently dropped", () => {
  assert.equal(sessionClosedShellsToast(2, 1), "stopped 2 background shells when the session closed · 1 did not stop");
  assert.equal(sessionClosedShellsToast(0, 1), "stopped 0 background shells when the session closed · 1 did not stop");
});

test("notePendingClose/takePendingClose: a marked id is claimed once", () => {
  notePendingClose("s1");
  assert.equal(takePendingClose("s1"), true);
  // Consumed — a second `session.closed` for the same id (there should never
  // be one, but the gate must not assume that) reads as NOT this phone's.
  assert.equal(takePendingClose("s1"), false);
});

test("takePendingClose: an id this phone never asked to close is not its toast", () => {
  assert.equal(takePendingClose("never-asked"), false);
});

test("notePendingClose: marks are independent per id", () => {
  notePendingClose("a");
  notePendingClose("b");
  assert.equal(takePendingClose("b"), true);
  assert.equal(takePendingClose("a"), true);
});

test("toShellToast: says the line has not run, and warns when it joined other words", () => {
  assert.match(toShellToast({ leftCli: false, already: false, joined: false }), /tap Send to run it/);
  assert.match(toShellToast({ leftCli: false, already: false, joined: true }), /send only what you mean to run/);
  assert.match(toShellToast({ leftCli: true, already: true, joined: true }), /^already .*CLI mode is off/);
});
