/**
 * A headless `claude -p` run that failed because the CLI is signed out.
 *
 * The shapes are the measured ones: the live log's row (`error:
 * "authentication_failed"`, "Login expired · Please run /login") and the
 * errored envelope (`is_error`, `result` the one-liner). Sentences that resemble
 * the usage-limit banner are NOT used here; the false-positive cases are ordinary
 * prose and a quota block built from halves.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { detectHeadlessSignedOut, SIGNED_OUT_NOTE } from "../dist/headlessauth.js";
import { detectHeadlessLimit } from "../dist/limit.js";

const envelope = (result, extra = {}) => JSON.stringify({ type: "result", subtype: "success", is_error: true, result, session_id: "b0f3c1de-0000-4000-8000-000000000001", ...extra });

test("an errored envelope whose result is the CLI's sign-in one-liner is signed out", () => {
  for (const r of ["Not logged in · Please run /login", "Login expired · Please run /login", "Invalid API key · Please run /login", "Failed to authenticate: OAuth session expired"]) {
    assert.equal(detectHeadlessSignedOut(envelope(r), ""), true, r);
  }
});

test("a 401 status on an errored result is signed out whatever the text", () => {
  assert.equal(detectHeadlessSignedOut(envelope("something unreadable", { api_error_status: 401 }), ""), true);
});

test("stream-json: the result line and the authentication_failed assistant row both count", () => {
  const nd = [
    JSON.stringify({ type: "system", subtype: "init" }),
    JSON.stringify({ type: "assistant", error: "authentication_failed", isApiErrorMessage: true, message: { role: "assistant", content: [{ type: "text", text: "Login expired · Please run /login" }] } }),
    envelope("Login expired · Please run /login"),
  ].join("\n");
  assert.equal(detectHeadlessSignedOut(nd, ""), true);
  assert.equal(detectHeadlessSignedOut(nd.split("\n").slice(2).join("\n"), ""), true, "the result line alone");
  assert.equal(detectHeadlessSignedOut(nd.split("\n").slice(1, 2).join("\n"), ""), true, "the error kind alone");
});

test("the one-liner alone on stderr counts; prose that merely mentions it does not", () => {
  assert.equal(detectHeadlessSignedOut("", "Not logged in · Please run /login\n"), true);
  assert.equal(detectHeadlessSignedOut("", "warning: the doc says 'Not logged in' sometimes, so run /login if you like and then a very long explanation follows here and goes on and on for a while to be sure it is prose and not the CLI's one-liner, which is short."), false);
  assert.equal(detectHeadlessSignedOut("Step one: check whether the user is Not logged in · Please run /login", ""), false, "not anchored at the line start");
});

test("a successful run that SAYS the words is not signed out (is_error gates the text)", () => {
  const ok = JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "Not logged in · Please run /login" });
  assert.equal(detectHeadlessSignedOut(ok, ""), false);
});

test("a quota block and an ordinary failure are NOT signed out; unknown shapes stay today's behaviour", () => {
  const quota = envelope("You've hit your " + "session limit · resets 5:10pm (Europe/Berlin)");
  assert.equal(detectHeadlessSignedOut(quota, ""), false);
  assert.equal(detectHeadlessLimit(quota, "").blocked, true, "the limit detector still owns it");
  assert.equal(detectHeadlessSignedOut(envelope("no such file"), ""), false);
  assert.equal(detectHeadlessSignedOut("not json at all", ""), false);
  assert.equal(detectHeadlessSignedOut("", ""), false);
  assert.equal(detectHeadlessSignedOut(envelope("Authentication of the widget failed"), ""), false);
});

test("the sentence says what did not happen, once, in the host's own words", () => {
  assert.equal(SIGNED_OUT_NOTE, "Skipped — the CLI is signed out; sign in from any session.");
  assert.doesNotMatch(SIGNED_OUT_NOTE, /fail|error|\/login/i);
});
