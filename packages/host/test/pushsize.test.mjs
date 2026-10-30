/**
 * Web push and the push service's size limit: a payload past it is cut to fit before it is sent,
 * a 413 is retried once smaller, and a push that still fails is said in the log — never dropped
 * silently (design round 3).
 *
 *     node --test packages/host/test/pushsize.test.mjs
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import webpush from "web-push";
import { PushManager, pushPayloadText, pushPayloadFit, PUSH_BUDGET, PUSH_FLOOR } from "../dist/push.js";

const dirs = [];
const realSend = webpush.sendNotification;
const realWarn = console.warn;
after(() => { webpush.sendNotification = realSend; console.warn = realWarn; for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

function manager() {
  const d = mkdtempSync(join(tmpdir(), "pushsize-")); dirs.push(d);
  const m = new PushManager(d);
  m.subscribe({ endpoint: "https://push.example.test/abc", keys: { p256dh: "x", auth: "y" } });
  return m;
}
const item = (body) => ({ id: "i1", kind: "git", ts: 1, title: "Push failed", body, key: "git:x", level: "attention" });
const bytes = (s) => Buffer.byteLength(s, "utf8");

test("a payload under the budget goes out whole", () => {
  const p = item("short");
  assert.equal(pushPayloadText(p, PUSH_BUDGET), JSON.stringify(p));
});

test("a long body is cut to fit the budget, and the item keeps its id, kind and key", () => {
  const t = pushPayloadText(item("é".repeat(20000)), PUSH_BUDGET);
  assert.ok(bytes(t) <= PUSH_BUDGET, `${bytes(t)} > ${PUSH_BUDGET}`);
  const o = JSON.parse(t);
  assert.equal(o.id, "i1"); assert.equal(o.kind, "git"); assert.equal(o.key, "git:x");
  assert.match(o.body, /…$/);
});

test("a title too long for the budget on its own is cut too, after the body", () => {
  const p = { ...item("body words"), title: "t".repeat(6000) };
  const o = JSON.parse(pushPayloadText(p, PUSH_BUDGET));
  assert.ok(bytes(JSON.stringify(o)) <= PUSH_BUDGET);
  assert.match(o.title, /…$/);
  assert.equal(o.id, "i1"); assert.equal(o.key, "git:x");
});

test("a 413 is retried once with a smaller payload, and said in the log", async () => {
  const m = manager();
  const sent = [];
  const warned = [];
  console.warn = (...a) => warned.push(a.join(" "));
  webpush.sendNotification = async (_sub, body) => {
    sent.push(body);
    if (sent.length === 1) throw Object.assign(new Error("too large"), { statusCode: 413 });
  };
  await m.notify(item("x".repeat(3000)));
  assert.equal(sent.length, 2);
  assert.ok(bytes(sent[1]) <= PUSH_FLOOR, `the retry is at the floor: ${bytes(sent[1])} > ${PUSH_FLOOR}`);
  assert.equal(JSON.parse(sent[1]).id, "i1");
  assert.ok(warned.some((w) => /413/.test(w)), warned.join("\n"));
});

test("a push the service refuses for any other reason is said in the log, and the subscription kept", async () => {
  const m = manager();
  const warned = [];
  console.warn = (...a) => warned.push(a.join(" "));
  let calls = 0;
  webpush.sendNotification = async () => { calls++; throw Object.assign(new Error("boom"), { statusCode: 500 }); };
  await m.notify(item("hi"));
  assert.equal(calls, 1);
  assert.ok(warned.some((w) => /500/.test(w) && /push\.example\.test/.test(w)), warned.join("\n"));
  calls = 0;
  await m.notify(item("hi"));
  assert.equal(calls, 1, "the subscription is still there");
  // The endpoint path is a capability URL: the log names the service's host, never the path.
  assert.ok(!warned.some((w) => w.includes("/abc")), warned.join("\n"));
});

test("a 413 refused again at the floor is said in the log, and not retried a third time", async () => {
  const m = manager();
  const warned = [];
  console.warn = (...a) => warned.push(a.join(" "));
  let calls = 0;
  webpush.sendNotification = async () => { calls++; throw Object.assign(new Error("too large"), { statusCode: 413 }); };
  await m.notify(item("x".repeat(3000)));
  assert.equal(calls, 2);
  assert.ok(warned.length >= 2, warned.join("\n"));
  assert.ok(!warned.some((w) => w.includes("/abc")), warned.join("\n"));
});

// The kept fields alone can exceed the budget: a multi-KB `file.relPath` (or `key`) used to go out
// over budget, to be answered 413 and lost. The tap target that is too long is DROPPED instead —
// the service worker then opens the item's own row in the feed (`notifItem` needs only id + kind),
// where the full item is — and a payload still over budget is never sent (design round 5).
const fileItem = (relPath) => ({
  ...item("built"), file: { repoId: "r1", relPath, name: "app.apk", size: 10 }, pull: "p1",
});

test("a multi-KB file path is dropped (with its pull) so the payload fits; id, kind and key stay", () => {
  const p = fileItem("d/".repeat(3000) + "app.apk");
  const { text, dropped } = pushPayloadFit(p, PUSH_BUDGET);
  assert.ok(text, "sent");
  assert.ok(bytes(text) <= PUSH_BUDGET, `${bytes(text)} > ${PUSH_BUDGET}`);
  const o = JSON.parse(text);
  assert.equal(o.file, undefined); assert.equal(o.pull, undefined, "a pull without its file cannot start");
  assert.equal(o.id, "i1"); assert.equal(o.kind, "git"); assert.equal(o.key, "git:x");
  assert.equal(o.body, "built", "the words were not cut for a field that was dropped anyway");
  assert.deepEqual(dropped, ["file", "pull"]);
  assert.ok(bytes(pushPayloadText(p, PUSH_BUDGET)) <= PUSH_BUDGET);
});

test("a huge key is dropped rather than a short file: the field that is too long goes", () => {
  const p = { ...fileItem("out/app.apk"), key: "git:" + "k".repeat(5000) };
  const { text, dropped } = pushPayloadFit(p, PUSH_BUDGET);
  const o = JSON.parse(text);
  assert.ok(bytes(text) <= PUSH_BUDGET);
  assert.equal(o.key, undefined);
  assert.equal(o.file.relPath, "out/app.apk"); assert.equal(o.pull, "p1");
  assert.deepEqual(dropped, ["key"]);
});

test("a payload that fits after cutting its words drops nothing", () => {
  const { dropped } = pushPayloadFit(fileItem("out/app.apk"), PUSH_BUDGET);
  assert.deepEqual(dropped, []);
  assert.deepEqual(pushPayloadFit({ ...fileItem("out/app.apk"), body: "x".repeat(9000) }, PUSH_BUDGET).dropped, []);
});

test("a payload whose never-dropped fields alone are over budget is not sent", () => {
  const { text } = pushPayloadFit({ ...item("b"), id: "i".repeat(5000) }, PUSH_BUDGET);
  assert.equal(text, null);
});

test("notify sends the fitted payload and says what it dropped; never sends one over budget", async () => {
  const m = manager();
  const sent = [];
  const warned = [];
  console.warn = (...a) => warned.push(a.join(" "));
  webpush.sendNotification = async (_sub, body) => { sent.push(body); };
  await m.notify(fileItem("d/".repeat(3000) + "app.apk"));
  assert.equal(sent.length, 1);
  assert.ok(bytes(sent[0]) <= PUSH_BUDGET);
  assert.ok(warned.some((w) => /file/.test(w) && /feed/.test(w)), warned.join("\n"));
  sent.length = 0; warned.length = 0;
  await m.notify({ ...item("b"), id: "i".repeat(5000) });
  assert.equal(sent.length, 0, "nothing over budget goes out");
  assert.ok(warned.some((w) => /not sent/.test(w)), warned.join("\n"));
});
