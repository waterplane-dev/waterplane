import test from "node:test";
import assert from "node:assert/strict";

import { shellOpenTarget } from "./shellOpenTarget.ts";

test("plugin:<id> is a plugin, anything else is a session id", () => {
  assert.deepEqual(shellOpenTarget("plugin:vault"), { plugin: "vault" });
  assert.deepEqual(shellOpenTarget("3fa9c1d2"), { sessionId: "3fa9c1d2" });
  assert.deepEqual(shellOpenTarget("plugin:"), { sessionId: "plugin:" });
});
