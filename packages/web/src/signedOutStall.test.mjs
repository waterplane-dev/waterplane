/**
 * The note a running backlog/Activity row wears while its session is behind a
 * sign-in (`signedOutStall.ts`), and only then.
 */
import test from "node:test";
import assert from "node:assert/strict";

import { SIGNED_IN_AGAIN_DETAIL, SIGNED_OUT_STALL_TEXT } from "@waterplane/shared";
import { signedOutStallText } from "./signedOutStall.ts";

const sess = (id, o = {}) => ({ id, cwd: "/dev/app", title: id, running: true, ...o });

test("a running row on a signed-out session says why it is held", () => {
  const sessions = [sess("s1", { signedOut: true }), sess("s2", { signInWait: { since: 1 } })];
  assert.equal(signedOutStallText({ state: "running", sessionId: "s1" }, sessions), SIGNED_OUT_STALL_TEXT);
  assert.equal(signedOutStallText({ state: "running", sessionId: "s2" }, sessions), SIGNED_OUT_STALL_TEXT);
});

test("once signed in again the note stops saying sign in, and says where it stands", () => {
  const sessions = [sess("s1", { signInWait: { since: 1, signedInAt: 2 } })];
  assert.equal(signedOutStallText({ state: "running", sessionId: "s1" }, sessions), SIGNED_IN_AGAIN_DETAIL);
});

test("nothing for a row that is not running, has no session, or whose session is not signed out", () => {
  const sessions = [sess("s1", { signedOut: true }), sess("ok")];
  assert.equal(signedOutStallText({ state: "queued", sessionId: "s1" }, sessions), null);
  assert.equal(signedOutStallText({ state: "running" }, sessions), null);
  assert.equal(signedOutStallText({ state: "running", sessionId: "gone" }, sessions), null);
  assert.equal(signedOutStallText({ state: "running", sessionId: "ok" }, sessions), null);
});
