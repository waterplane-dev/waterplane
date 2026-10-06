/**
 * The consent gate (`confirmgate.ts`): a confirm-gated fix or an onboard start needs a browser
 * Origin AND a one-shot token bound to what the phone's screen showed. Pure — no daemon.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

const { createConfirmGate, gateRefusal, fixGateRefusal, withFixConfirms, fixBind, FIX_SCOPE, CONFIRM_TTL_MS } = await import("../dist/confirmgate.js");
const { configureOrigins } = await import("../dist/origin.js");

configureOrigins({ port: 8771 });
const browser = { headers: { origin: "http://127.0.0.1:8771" } };
const script = { headers: {} };
const evil = { headers: { origin: "https://evil.example" } };

test("a token works once, for exactly what it was minted for", () => {
  const g = createConfirmGate();
  const t = g.mint("onboard.start", "web", ["repo", "session"]);
  assert.equal(g.check(t, "onboard.start", "web", ["repo"]), null);
  assert.match(g.check(t, "onboard.start", "android", ["repo"]), /something else/);
  assert.match(g.check(t, "onboard.resume", "web"), /something else/);
  assert.match(g.check(t, "onboard.start", "web", ["repo", "toolchain"]), /toolchain/);
  // A check does not spend it; only the accepted action does.
  assert.equal(g.check(t, "onboard.start", "web", ["repo", "session"]), null);
  g.consume(t);
  assert.match(g.check(t, "onboard.start", "web", ["repo"]), /already used/);
  assert.match(g.check(undefined, "onboard.start", "web"), /no confirm token/);
  assert.match(g.check("nope", "onboard.start", "web"), /already used/);
});

test("a token expires", () => {
  let now = 1_000;
  const g = createConfirmGate(() => now);
  const t = g.mint("fix", "x");
  now += CONFIRM_TTL_MS + 1;
  assert.match(g.check(t, "fix", "x"), /expired/);
  assert.equal(g.size(), 0);
});

test("live tokens are bounded", () => {
  const g = createConfirmGate();
  const first = g.mint("fix", "a");
  for (let i = 0; i < 100; i++) g.mint("fix", `b${i}`);
  assert.ok(g.size() <= 64);
  assert.notEqual(g.check(first, "fix", "a"), null);
});

test("Origin-less or foreign-Origin requests are refused even with a good token", () => {
  const g = createConfirmGate();
  const t = g.mint("fix", "x");
  assert.match(gateRefusal(script, t, "fix", "x", undefined, g), /no Origin/);
  assert.match(gateRefusal(evil, t, "fix", "x", undefined, g), /origin not allowed/);
  assert.equal(gateRefusal(browser, t, "fix", "x", undefined, g), null);
});

test("compliance fixes: ungated lists pass, a gated id runs alone with its own token", () => {
  const g = createConfirmGate();
  assert.equal(fixGateRefusal(script, "/wt", ["gitignore", "claude-md"], undefined, g), null);
  const report = withFixConfirms("/wt", {
    repoId: "r", repoName: "r", ok: false,
    checks: [{ id: "android-toolchain", fix: "android-toolchain" }, { id: "gi", fix: "gitignore" }, { id: "k", fix: null }],
  }, g);
  assert.deepEqual(Object.keys(report.confirm), ["android-toolchain"]);
  const t = report.confirm["android-toolchain"];
  assert.equal(fixGateRefusal(script, "/wt", ["android-toolchain"], t, g).status, 403);
  assert.equal(fixGateRefusal(browser, "/wt", ["gitignore", "android-toolchain"], t, g).status, 400);
  assert.equal(fixGateRefusal(browser, "/other", ["android-toolchain"], t, g).status, 403);
  assert.equal(fixGateRefusal(browser, "/wt", ["signing-key"], t, g).status, 403);
  assert.equal(fixGateRefusal(browser, "/wt", ["android-toolchain"], t, g), null);
  assert.equal(g.check(t, FIX_SCOPE, fixBind("/wt", "android-toolchain")), null);
});
