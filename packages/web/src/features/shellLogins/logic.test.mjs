import test from "node:test";
import assert from "node:assert/strict";
import { INSERTED_TOAST, LOGINS_HEADER, LOGIN_ROWS, cutRows, cutWords, localhostCount, rowWords } from "./logic.ts";

test("the eight rows, in the order a person reaches for them", () => {
  assert.deepEqual(LOGIN_ROWS.map((r) => r.id), ["gcloud", "gcloud-adc", "gh", "firebase", "codex", "npm", "tailscale", "docker"]);
});

test("a command is inserted bare: one line, no trailing newline (never auto-sent)", () => {
  for (const r of LOGIN_ROWS) {
    assert.ok(!/[\r\n]/.test(r.command), r.id);
    assert.equal(r.command, r.command.trim(), r.id);
  }
  assert.match(INSERTED_TOAST, /send/);
});

test("gcloud uses --no-launch-browser, and the note says --no-browser is something else", () => {
  const g = LOGIN_ROWS.find((r) => r.id === "gcloud");
  assert.equal(g.command, "gcloud auth login --no-launch-browser");
  assert.match(g.note, /--no-browser is different/);
});

test("firebase and codex carry the localhost warning, the rest do not", () => {
  assert.deepEqual(LOGIN_ROWS.filter((r) => r.redirectsToLocalhost).map((r) => r.id), ["firebase", "codex"]);
  assert.equal(localhostCount(), 2);
  assert.match(rowWords(LOGIN_ROWS.find((r) => r.id === "firebase")), /redirects to localhost on the desktop/);
  assert.equal(rowWords(LOGIN_ROWS.find((r) => r.id === "npm")), LOGIN_ROWS.find((r) => r.id === "npm").note);
});

test("the count is a filter: the cut and the number come from the same rows", () => {
  assert.equal(cutRows(true).length, localhostCount());
  assert.equal(cutRows(false).length, LOGIN_ROWS.length);
  assert.equal(cutWords(2, 8).startsWith("2 of 8"), true);
});

// The header stays generic: which store a token moves into is the person's
// choice (tools/publictree.test.mjs keeps private extension names out of here).
test("the header names no particular secret store", () => {
  assert.equal(LOGINS_HEADER, "log in once here, then move the token into a secret store");
});
