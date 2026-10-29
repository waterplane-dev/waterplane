import { test } from "node:test";
import assert from "node:assert/strict";
import { squeezeDecision, squeezeMessage } from "./capsqueeze.mjs";

const CAP = 900;
const body = (n, note = false) => Array.from({ length: n }, (_, i) => (note ? `// note ${i}` : `const a${i} = ${i};`)).join("\n") + "\n";
const diffOf = (removed) => ["--- a/x.ts", "+++ b/x.ts", "@@ -1 +1 @@", ...removed.map((l) => `-${l}`)].join("\n");

test("notes-only trim into the cap is refused", () => {
  assert.equal(squeezeDecision(body(903), body(900), diffOf(["// why", "", " * more"]), CAP), true);
  assert.match(squeezeMessage("a.ts"), /splitting a\.ts by subject \(refactoring skill\), not by deleting its notes/);
});
test("code removal is allowed", () => {
  assert.equal(squeezeDecision(body(903), body(900), diffOf(["// why", "const x = 1;"]), CAP), false);
});
test("files under cap-20 before are allowed", () => {
  assert.equal(squeezeDecision(body(850), body(840), diffOf(["// why"]), CAP), false);
});
test("new and deleted files are allowed", () => {
  assert.equal(squeezeDecision(null, body(900), "", CAP), false);
  assert.equal(squeezeDecision(body(900), null, "", CAP), false);
});
test("still over the cap is allowed", () => {
  assert.equal(squeezeDecision(body(1300), body(1290), diffOf(["// why"]), CAP), false);
});
test("not shrinking is allowed", () => {
  assert.equal(squeezeDecision(body(890), body(890), diffOf(["// a"]), CAP), false);
});
