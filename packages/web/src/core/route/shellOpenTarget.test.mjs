import test from "node:test";
import assert from "node:assert/strict";

import { shellOpenTarget } from "./shellOpenTarget.ts";

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
