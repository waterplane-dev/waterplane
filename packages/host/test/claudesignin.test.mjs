/**
 * Is claude signed in: `doctor.ts`'s reading of `claude auth status`, and the onboarding plan's
 * sentence when it is not. No claude is run here.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
const { classifyClaudeAuth, CLAUDE_SIGN_IN_FIX } = await import("../dist/doctor.js");
const { handleOnboardRoutes } = await import("../dist/onboardroutes.js");

test("auth status: signed in, signed out, and unreadable are three answers, never a guess", () => {
  assert.equal(classifyClaudeAuth('{"loggedIn": true, "authMethod": "claude.ai"}'), "in");
  assert.equal(classifyClaudeAuth('{"loggedIn": false}'), "out");
  assert.equal(classifyClaudeAuth("Not logged in. Please run /login"), "out", "'not logged in' contains 'logged in'");
  assert.equal(classifyClaudeAuth("Logged in as someone"), "in");
  assert.equal(classifyClaudeAuth("error: unknown command 'auth'"), null);
  assert.equal(classifyClaudeAuth(""), null);
});

test("the sign-in fix is the phone's route first, not a terminal", () => {
  assert.match(CLAUDE_SIGN_IN_FIX, /^Sign in from the phone: open any session on this desktop, tap its sign-in button/);
});

async function plan(signedIn) {
  let sent = null;
  const d = {
    onboard: { plan: () => ({ ok: true, path: "web", name: "x", folder: "/r/x", steps: [], consent: [], suggestedPrompt: "" }) },
    json: (_r, data) => { sent = data; },
    readJson: async () => null,
    ...(signedIn === undefined ? {} : { signedIn: async () => signedIn }),
  };
  await handleOnboardRoutes({ method: "GET" }, {}, "/api/onboard/plan", new URL("http://x/api/onboard/plan?name=x&path=web"), d);
  return sent;
}

test("the onboarding plan says how to sign in only when claude said it is signed out", async () => {
  assert.match((await plan("out")).signIn, /^claude is not signed in on this desktop\. Sign in from the phone/);
  for (const s of ["in", null, undefined]) assert.equal("signIn" in (await plan(s)), false, String(s));
});
