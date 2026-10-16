// The Android background link (`wire/notifylink.ts`): which socket is one, and
// what it is sent. The host's `send` asks `roleAllows` for every frame.
import test from "node:test";
import assert from "node:assert/strict";
import { NOTIFY_LINK_FRAMES, roleAccepts, roleAfterHello, roleAllows, roleFromUserAgent } from "../dist/index.js";

test("an OkHttp UA is the native link; the WebView's Chrome UA and no UA are not", () => {
  assert.equal(roleFromUserAgent("okhttp/4.12.0"), "notify");
  assert.equal(roleFromUserAgent("okhttp/5.0.0-alpha.14"), "notify");
  assert.equal(roleFromUserAgent(["okhttp/4.12.0"]), "notify");
  assert.equal(roleFromUserAgent("Mozilla/5.0 (Linux; Android 14; wv) AppleWebKit/537.36 Chrome/129.0 Mobile Safari/537.36"), undefined);
  assert.equal(roleFromUserAgent("Mozilla/5.0 okhttp/4.12.0"), undefined, "only a UA that STARTS okhttp/");
  assert.equal(roleFromUserAgent(undefined), undefined);
  assert.equal(roleFromUserAgent(""), undefined);
});

test("an explicit hello role wins; absent keeps what the upgrade said", () => {
  assert.equal(roleAfterHello("notify", undefined), "notify");
  assert.equal(roleAfterHello(undefined, "notify"), "notify", "an old APK declares nothing");
  assert.equal(roleAfterHello(undefined, undefined), undefined);
  assert.equal(roleAfterHello("viewer", undefined), undefined, "an unknown role is no role");
});

test("a notify link is sent exactly what ShellLinkService reads, plus pong", () => {
  assert.deepEqual([...NOTIFY_LINK_FRAMES].sort(), ["authRequired", "notification", "pong", "pull.new"]);
  for (const t of NOTIFY_LINK_FRAMES) assert.equal(roleAllows("notify", t), true, t);
  for (const t of ["welcome", "backends", "session.list", "usage.status", "notification.list", "auth.state", "pty", "intent.list"]) {
    assert.equal(roleAllows("notify", t), false, t);
  }
});

test("a full client is sent everything", () => {
  for (const t of ["welcome", "session.list", "pty", "notification"]) assert.equal(roleAllows(undefined, t), true, t);
});

test("a notify link may say hello and ping, and can never attach", () => {
  assert.equal(roleAccepts("notify", "hello"), true);
  assert.equal(roleAccepts("notify", "ping"), true);
  assert.equal(roleAccepts("notify", "session.attach"), false);
  assert.equal(roleAccepts("notify", "session.input"), false);
  assert.equal(roleAccepts(undefined, "session.attach"), true);
});
