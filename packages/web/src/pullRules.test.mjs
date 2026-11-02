// `enableBuildsRule` (pullRules.ts): the one "turn on download-by-itself for builds" body, shared by
// the Downloads feature's card and the SDK's `enableBuilds`.
import test from "node:test";
import assert from "node:assert/strict";
import { cfgs, enableBuildsRule } from "./pullRules.ts";

function fakeConn() {
  const sent = [];
  return { sent, conn: { liveAsk: (f, blocked) => { sent.push(["ask", f, blocked]); return true; }, liveSend: (f, done, blocked) => { sent.push(["send", f, done, blocked]); return true; } } };
}

test("a rule nobody has read is ASKED for, never written over with defaults", () => {
  cfgs.set(new Map());
  const { sent, conn } = fakeConn();
  const toasts = [];
  assert.equal(enableBuildsRule("/r", "on", conn, (m) => toasts.push(m)), "asked");
  assert.deepEqual(sent.map((s) => [s[0], s[1].t]), [["ask", "pull.get"]]);
  assert.equal(cfgs.get().size, 0, "nothing written");
  assert.match(toasts[0], /tap again/);
});

test("a read rule keeps what the person set and flips only enabled + builds", () => {
  const rule = { enabled: false, builds: false, patterns: ["*.apk", "my typed words"], maxMb: 50 };
  cfgs.set(new Map([["/r", rule]]));
  const { sent, conn } = fakeConn();
  assert.equal(enableBuildsRule("/r", "download-by-itself is on", conn, () => {}), "saved");
  const want = { ...rule, enabled: true, builds: true };
  assert.deepEqual(cfgs.get().get("/r"), want);
  assert.deepEqual(sent, [["send", { t: "pull.save", repoDir: "/r", config: want }, "download-by-itself is on", "no connection — the rule lives on the desktop and was not saved"]]);
});
