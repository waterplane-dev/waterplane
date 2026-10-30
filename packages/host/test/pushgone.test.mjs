/**
 * Web push and a refusal that cannot heal: one rule (`pushRefusal`) says which refusals mean the
 * subscription is gone for good (404/410, and 401/403 — bound to a key this desktop no longer signs
 * with) and which are transient (429, 5xx, a network error). A gone subscription is removed once,
 * with one line telling the person to re-enable notifications; a transient one is kept, and the same
 * refusal repeating on every notify is logged once per window, not once per notify (design round 4).
 *
 *     node --test packages/host/test/pushgone.test.mjs
 */
import { test, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import webpush from "web-push";
import * as push from "../dist/push.js";

const { PushManager } = push;
const dirs = [];
const realSend = webpush.sendNotification;
const realWarn = console.warn;
after(() => { webpush.sendNotification = realSend; console.warn = realWarn; for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

let warned;
beforeEach(() => { warned = []; console.warn = (...a) => warned.push(a.join(" ")); });

function manager() {
  const d = mkdtempSync(join(tmpdir(), "pushgone-")); dirs.push(d);
  const m = new PushManager(d);
  m.subscribe({ endpoint: "https://push.example.test/abc", keys: { p256dh: "x", auth: "y" } });
  return { m };
}
const item = { id: "i1", kind: "git", ts: 1, title: "Push failed", body: "hi", level: "attention" };
const refuse = (statusCode) => async () => { throw Object.assign(new Error("refused"), statusCode === undefined ? {} : { statusCode }); };

test("the rule: 404 and 410 are gone; 401 and 403 a refusal of this desktop's key; 413 too large; 429, 5xx, 400 and no status transient", () => {
  assert.equal(typeof push.pushRefusal, "function", "pushRefusal is exported");
  for (const c of [404, 410]) assert.equal(push.pushRefusal(c), "gone", String(c));
  for (const c of [401, 403]) assert.equal(push.pushRefusal(c), "key-refused", String(c));
  assert.equal(push.pushRefusal(413), "too-large");
  for (const c of [429, 500, 502, 503, 400, undefined]) assert.equal(push.pushRefusal(c), "transient", String(c));
});

const HOUR = 60 * 60_000;
function clocked(dir) {
  const d = dir ?? mkdtempSync(join(tmpdir(), "pushgone-")); if (!dir) dirs.push(d);
  const clock = { t: 1_000_000 };
  const m = new PushManager(d, { now: () => clock.t });
  if (!dir) m.subscribe({ endpoint: "https://push.example.test/abc", keys: { p256dh: "x", auth: "y" } });
  return { m, clock, dir: d };
}

for (const code of [403, 401]) {
  test(`a ${code} is counted, not acted on: the subscription stays and the line says what heals it`, async () => {
    const { m } = clocked();
    let calls = 0;
    webpush.sendNotification = async (...a) => { calls++; return refuse(code)(...a); };
    await m.notify(item);
    await m.notify(item);
    assert.equal(calls, 2, "kept: the second notify still sends");
    assert.equal(warned.length, 1, warned.join("\n"));
    assert.match(warned[0], /counting/i);
    assert.match(warned[0], /VAPID_CONTACT|clock|vapid\.json/);
    assert.ok(!warned[0].includes("/abc"), "the capability path stays out of the log");
  });

  test(`a ${code} that persists (3 refusals over 24 h) removes the subscription, with one line saying re-enable`, async () => {
    const { m, clock } = clocked();
    let calls = 0;
    webpush.sendNotification = async (...a) => { calls++; return refuse(code)(...a); };
    await m.notify(item);                 // 1st, t0
    clock.t += 2 * HOUR; await m.notify(item);   // 2nd
    clock.t += 2 * HOUR; await m.notify(item);   // 3rd, but only 4 h in: kept
    assert.equal(calls, 3);
    clock.t += 21 * HOUR; await m.notify(item);  // 4th, 25 h after the first: removed
    assert.equal(calls, 4);
    assert.match(warned.at(-1), /re-enable notifications/);
    assert.ok(!warned.join("\n").includes("/abc"));
    await m.notify(item);
    assert.equal(calls, 4, "the subscription is gone: no further send");
  });
}

test("three key refusals in a burst are not enough: the span must reach 24 h", async () => {
  const { m } = clocked();
  let calls = 0;
  webpush.sendNotification = async (...a) => { calls++; return refuse(403)(...a); };
  for (let i = 0; i < 6; i++) await m.notify(item);
  assert.equal(calls, 6);
});

test("the refusal count survives a restart of the host", async () => {
  const a = clocked();
  webpush.sendNotification = refuse(403);
  await a.m.notify(item);
  a.clock.t += 12 * HOUR; await a.m.notify(item);
  const b = clocked(a.dir);
  b.clock.t = a.clock.t + 13 * HOUR;
  let calls = 0;
  webpush.sendNotification = async (...x) => { calls++; return refuse(403)(...x); };
  await b.m.notify(item);              // 3rd, 25 h after the first, in a new process: removed
  await b.m.notify(item);
  assert.equal(calls, 1, "removed on the third refusal, counted across the restart");
});

test("a successful send resets the count", async () => {
  const { m, clock } = clocked();
  let calls = 0, ok = false;
  webpush.sendNotification = async (...a) => { calls++; if (ok) return {}; return refuse(403)(...a); };
  await m.notify(item);
  clock.t += 12 * HOUR; await m.notify(item);
  ok = true; clock.t += 1 * HOUR; await m.notify(item);  // the host's config was fixed
  ok = false;
  clock.t += 12 * HOUR; await m.notify(item);
  clock.t += 12 * HOUR; await m.notify(item);  // 2 refusals since the reset: kept
  assert.equal(calls, 5);
  await m.notify(item);
  assert.equal(calls, 6, "still subscribed");
});

test("a 404/410 removes the subscription quietly, as before", async () => {
  const { m } = manager();
  let calls = 0;
  webpush.sendNotification = async (...a) => { calls++; return refuse(410)(...a); };
  await m.notify(item);
  await m.notify(item);
  assert.equal(calls, 1);
  assert.equal(warned.length, 0, warned.join("\n"));
});

test("a 410 on the 413 retry removes the subscription too", async () => {
  const { m } = manager();
  let calls = 0;
  webpush.sendNotification = async (...a) => { calls++; return refuse(calls === 1 ? 413 : 410)(...a); };
  await m.notify({ ...item, body: "x".repeat(3000) });
  assert.equal(calls, 2);
  await m.notify(item);
  assert.equal(calls, 2, "removed after the retry's 410");
});

test("a 403 on the 413 retry is counted like any other key refusal", async () => {
  const { m } = clocked();
  let calls = 0;
  webpush.sendNotification = async (...a) => { calls++; return refuse(calls === 1 ? 413 : 403)(...a); };
  await m.notify({ ...item, body: "x".repeat(3000) });
  assert.equal(calls, 2);
  await m.notify(item);
  assert.equal(calls, 3, "kept after one retry 403");
});

for (const code of [429, 503, undefined]) {
  test(`a transient refusal (${code ?? "network"}) keeps the subscription, and repeating it logs once per window`, async () => {
    const { m } = manager();
    let calls = 0;
    webpush.sendNotification = async (...a) => { calls++; return refuse(code)(...a); };
    await m.notify(item);
    await m.notify(item);
    await m.notify(item);
    assert.equal(calls, 3, "kept: every notify tries again");
    assert.equal(warned.length, 1, warned.join("\n"));
  });
}

test("a different transient refusal from the same subscription is its own line", async () => {
  const { m } = manager();
  let calls = 0;
  webpush.sendNotification = async (...a) => { calls++; return refuse(calls === 1 ? 503 : 429)(...a); };
  await m.notify(item);
  await m.notify(item);
  assert.equal(warned.length, 2, warned.join("\n"));
});

test("a network error is logged once per window by its code, not its message (which names an IP)", async () => {
  const { m } = clocked();
  let calls = 0;
  webpush.sendNotification = async () => {
    calls++;
    throw Object.assign(new Error(`connect ETIMEDOUT 142.250.0.${calls}:443`), { code: "ETIMEDOUT" });
  };
  await m.notify(item);
  await m.notify(item);
  await m.notify(item);
  assert.equal(calls, 3);
  assert.equal(warned.length, 1, warned.join("\n"));
  assert.ok(!warned[0].includes("142.250"), "the line names the code, not an address");
  assert.match(warned[0], /ETIMEDOUT/);
});

test("the once-an-hour log memory forgets entries past the window", async () => {
  const { m, clock } = clocked();
  let calls = 0;
  webpush.sendNotification = async () => { calls++; throw Object.assign(new Error("x"), { statusCode: 500 + (calls % 50) }); };
  for (let i = 0; i < 20; i++) { await m.notify(item); clock.t += 2 * HOUR; }
  assert.equal(warned.length, 20);
  assert.ok(m.lastLogged.size <= 1, `kept ${m.lastLogged.size} stale entries`);
});

// A 401/403 caused by THIS host's clock being wrong (the VAPID JWT's `exp` is built from it) is
// not the subscription's fault: the push service's own `Date` header (web-push's WebPushError
// carries the response `headers`) says so. Past `PUSH_CLOCK_SKEW_MS` the refusal is never counted
// toward removal, and is logged once an hour naming the skew in minutes (design round 5).
const refuseAt = (statusCode, date) => async () => {
  throw Object.assign(new Error("refused"), { statusCode, headers: date === undefined ? {} : { date } });
};

test("a key refusal while the host's clock is off by more than the bound is never counted, and says the skew", async () => {
  const { m, clock } = clocked();
  let calls = 0;
  // The service's clock is 3 hours ahead of the host's.
  webpush.sendNotification = async (...a) => { calls++; return refuseAt(403, new Date(clock.t + 3 * HOUR).toUTCString())(...a); };
  for (let i = 0; i < 4; i++) { await m.notify(item); clock.t += 10 * HOUR; }
  await m.notify(item);
  assert.equal(calls, 5, "kept past 3 refusals over 40 h: none of them counted");
  assert.equal(m.subs[0].keyRefused, undefined, "no count stored");
  const skewLines = warned.filter((w) => /clock/i.test(w) && /180 min/.test(w));
  assert.ok(skewLines.length >= 1, warned.join("\n"));
  assert.ok(!warned.some((w) => /removing/.test(w)), warned.join("\n"));
  assert.ok(!warned.join("\n").includes("/abc"));
});

test("the skew line is logged once an hour, not once per notify", async () => {
  const { m, clock } = clocked();
  webpush.sendNotification = async () => refuseAt(401, new Date(clock.t - 2 * HOUR).toUTCString())();
  await m.notify(item);
  clock.t += 10 * 60_000; await m.notify(item);
  clock.t += 10 * 60_000; await m.notify(item);
  assert.equal(warned.length, 1, warned.join("\n"));
  assert.match(warned[0], /120 min/);
  clock.t += HOUR; await m.notify(item);
  assert.equal(warned.length, 2, warned.join("\n"));
});

test("a Date header within the bound, or none, or an unparseable one, counts the refusal as before", async () => {
  for (const date of [(t) => new Date(t + 2 * 60_000).toUTCString(), () => undefined, () => "not a date"]) {
    const { m, clock } = clocked();
    let calls = 0;
    webpush.sendNotification = async (...a) => { calls++; return refuseAt(403, date(clock.t))(...a); };
    await m.notify(item);
    clock.t += 2 * HOUR; await m.notify(item);
    clock.t += 23 * HOUR; await m.notify(item);  // 3rd, 25 h after the first: removed
    await m.notify(item);
    assert.equal(calls, 3, String(date(clock.t)));
  }
});
