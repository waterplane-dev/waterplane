import test from "node:test";
import assert from "node:assert/strict";

import { shellHostOpen, shellOpenTarget } from "./shellOpenTarget.ts";

test("plugin:<id> is a plugin, anything else is a session id", () => {
  assert.deepEqual(shellOpenTarget("plugin:vault"), { plugin: "vault" });
  assert.deepEqual(shellOpenTarget("3fa9c1d2"), { sessionId: "3fa9c1d2" });
  assert.deepEqual(shellOpenTarget("plugin:"), { sessionId: "plugin:" });
});

test("notif:<json> is a whole alert; a malformed one is not half-read", () => {
  const item = { id: "n1", kind: "health", ts: 5, title: "Tiptoi: Health score 73", body: "slipped", open: { to: "repohealth", repoId: "r1" } };
  assert.deepEqual(shellOpenTarget(`notif:${JSON.stringify(item)}`), { notif: item });
  const noBody = shellOpenTarget(`notif:${JSON.stringify({ id: "n2", kind: "disk", title: "Disk low" })}`);
  assert.equal(noBody.notif.body, "");
  assert.equal(typeof noBody.notif.ts, "number");
  assert.deepEqual(shellOpenTarget("notif:{not json"), { sessionId: "notif:{not json" });
  assert.deepEqual(shellOpenTarget(`notif:${JSON.stringify({ kind: "x", title: "t" })}`), { sessionId: `notif:${JSON.stringify({ kind: "x", title: "t" })}` }, "no id: not an item");
});

test("host:<id>|<rest> names the desktop an alert came from; the rest is an ordinary target", () => {
  assert.deepEqual(shellHostOpen("host:abcd1234|plugin:vault"), { hostId: "abcd1234", rest: "plugin:vault" });
  assert.deepEqual(shellOpenTarget(shellHostOpen("host:abcd1234|plugin:vault").rest), { plugin: "vault" });
  assert.deepEqual(shellHostOpen("host:abcd1234|3fa9c1d2"), { hostId: "abcd1234", rest: "3fa9c1d2" });
  const item = { id: "n1", kind: "health", ts: 5, title: "t", body: "b" };
  const r = shellHostOpen(`host:abcd1234|notif:${JSON.stringify(item)}`);
  assert.deepEqual(shellOpenTarget(r.rest), { notif: item }, "a '|' inside the json is the rest's, not a second split");
  assert.deepEqual(shellHostOpen("host:abcd1234|"), { hostId: "abcd1234", rest: "" }, "a summary: switch only");
});

test("host: that is not a host target is null, so the string is read as before", () => {
  assert.equal(shellHostOpen("3fa9c1d2"), null);
  assert.equal(shellHostOpen("plugin:vault"), null);
  assert.equal(shellHostOpen("host:abcd1234"), null, "no bar");
  assert.equal(shellHostOpen("host:AB|x"), null, "not a host id");
  assert.equal(shellHostOpen("host:|x"), null);
  assert.equal(shellHostOpen("host:abcd1234|host:efgh5678|x"), null, "never nested");
});
