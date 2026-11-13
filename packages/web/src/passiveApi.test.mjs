/**
 * `passiveApi.ts` — the phone half of the passive (kids') device scope. The host half is a default-deny
 * allowlist (`packages/host/src/passive.ts` `passiveAllows`), so every call the passive screen makes must be
 * one a LOCKED passive token is let through: an `/api/auth/*` route (answered before the token gate,
 * `server/http.ts`) or one `passiveAllows` names. A call added here and not there is a screen that 403s on
 * the kids' phone. The PIN is the other way round: set only from a trusted phone, and the host refuses it to
 * a passive token, so it must stay an `/api/auth/pin` POST and nothing a GET could reach.
 *
 * The two polls are BACKGROUND reads (no activity-bar blink, `null` when the host is gone, so the poll
 * survives); the taps are counted and throw, so the screen can say the tap failed.
 *
 *     node --test packages/web/src/passiveApi.test.mjs
 */
import "../../../scripts/lib-tsload.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { fileURLToPath } from "node:url";

// The host's sources import their siblings as `./x.js` (tsc's spelling); here only the `.ts` exists.
registerHooks({
  resolve(spec, ctx, next) {
    if (/^\.\.?\/.*\.js$/.test(spec) && ctx.parentURL?.includes("/packages/host/src/")) {
      const url = new URL(spec.replace(/\.js$/, ".ts"), ctx.parentURL);
      if (existsSync(fileURLToPath(url))) return next(url.href, ctx);
    }
    return next(spec, ctx);
  },
});

globalThis.window ??= globalThis;
const { passiveApi } = await import("./passiveApi.ts");
const { ops } = await import("./link/linkOps.ts");
const { passiveAllows } = await import("../../host/src/passive.ts");

/** Every request a call makes, with how many requests the activity bar was showing as it went out. */
let sent = [];
let answer = () => new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
globalThis.fetch = async (url, init = {}) => {
  sent.push({ url: String(url), method: (init.method ?? "GET").toUpperCase(), body: init.body ? JSON.parse(init.body) : undefined, bar: ops.length });
  return answer();
};
test.afterEach(() => { sent = []; answer = () => new Response("{}", { status: 200 }); });

/** Each member, called as its screen calls it. A member missing here fails the coverage test below. */
const CALLS = {
  status: () => passiveApi.status(),
  state: () => passiveApi.state(),
  unlock: () => passiveApi.unlock("1234"),
  lock: () => passiveApi.lock(),
  setPin: () => passiveApi.setPin("1234"),
};
/** What the PASSIVE screen calls while the device is locked (`main.tsx`, `PassiveScreen.tsx`). */
const PASSIVE_SCREEN = ["status", "state", "unlock", "lock"];

async function requestOf(name) {
  sent = [];
  await CALLS[name]();
  assert.equal(sent.length, 1, `${name}: one request`);
  return sent[0];
}

const HTTP = readFileSync(new URL("../../host/src/server/http.ts", import.meta.url), "utf8");
/** What a locked passive token gets through: `/api/auth/*` before the gate, else `passiveAllows`. */
function lockedPassiveMayAsk({ url, method }) {
  const u = new URL(url, "http://phone");
  if (u.pathname.startsWith("/api/auth/")) return true;
  return passiveAllows(method, u.pathname, u.searchParams, () => false);
}

test("every member is listed here, so a new passive call has to answer the rules below", () => {
  assert.deepEqual(Object.keys(passiveApi).sort(), Object.keys(CALLS).sort());
});

test("the host answers /api/auth/* before its token gate — the exemption the passive screen relies on", () => {
  const exempt = HTTP.indexOf('if (p.startsWith("/api/auth/")) { handleAuthHttp(');
  const gate = HTTP.indexOf("async function gated()");
  assert.ok(exempt > 0 && gate > exempt, "server/http.ts no longer routes /api/auth/ ahead of the token gate");
  // and the checker is not vacuous: an ordinary route is refused to a passive token
  assert.equal(lockedPassiveMayAsk({ url: "/api/repos", method: "GET" }), false);
  assert.equal(lockedPassiveMayAsk({ url: "/api/passive/state", method: "POST" }), false);
});

test("every call the passive screen makes is one a locked passive token is let through", async () => {
  for (const name of PASSIVE_SCREEN) {
    const r = await requestOf(name);
    assert.ok(lockedPassiveMayAsk(r), `${name}: ${r.method} ${r.url} is refused to a passive device (passive.ts)`);
  }
});

test("the routes and verbs: polls are GETs, taps are POSTs with exactly their body", async () => {
  assert.deepEqual(await requestOf("status"), { url: "/api/auth/status", method: "GET", body: undefined, bar: 0 });
  assert.deepEqual(await requestOf("state"), { url: "/api/passive/state", method: "GET", body: undefined, bar: 0 });
  const unlock = await requestOf("unlock");
  assert.deepEqual([unlock.url, unlock.method, unlock.body], ["/api/auth/unlock", "POST", { pin: "1234" }]);
  const lock = await requestOf("lock");
  assert.deepEqual([lock.url, lock.method, lock.body], ["/api/auth/lock", "POST", {}]);
});

test("the PIN is a trusted-phone POST to /api/auth/pin, and clearing it sends null", async () => {
  const set = await requestOf("setPin");
  assert.deepEqual([set.url, set.method, set.body], ["/api/auth/pin", "POST", { pin: "1234" }]);
  sent = [];
  await passiveApi.setPin(null);
  assert.deepEqual(sent[0].body, { pin: null });
  // a GET would be refused anyway, but the route must never become something a passive allowlist read passes
  assert.equal(passiveAllows("GET", "/api/auth/pin", new URLSearchParams(), () => false), false);
});

test("the polls do not blink the activity bar; the taps do", async () => {
  for (const name of ["status", "state"]) assert.equal((await requestOf(name)).bar, 0, `${name} is a background read`);
  for (const name of ["unlock", "lock", "setPin"]) assert.equal((await requestOf(name)).bar, 1, `${name} is a tap`);
  assert.equal(ops.length, 0, "every counted request ended");
});

test("host gone: a poll reads null and survives, a tap throws so the screen can say so", async () => {
  answer = () => { throw new TypeError("Failed to fetch"); };
  assert.equal(await passiveApi.status(), null);
  assert.equal(await passiveApi.state(), null);
  await assert.rejects(passiveApi.unlock("1234"));
  answer = () => new Response("{}", { status: 503 });
  assert.equal(await passiveApi.state(), null, "a refusing host is null to the poll, never a half-read state");
});
