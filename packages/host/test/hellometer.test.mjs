/** The phone's `world.meter` is seeded on connect: `hello` answers one `meter.status` frame (and it draws nothing while empty). */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

test("onHello sends meter.status, so the host-spend line needs no first call to appear", () => {
  const src = readFileSync(new URL("../src/routes/system.ts", import.meta.url), "utf8");
  const hello = src.slice(src.indexOf("const onHello"), src.indexOf("const onHello") + 4000);
  assert.match(hello, /t: "meter\.status", summary: a\.c\.meter\.summary\(\)/);
});
