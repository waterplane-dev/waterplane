/** The README's "Where do I find" table equals what the door registry generates (spec D10). */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { generated, current, README, table } from "./wherefind.mjs";

test("README where-find table matches the door registry (node tools/wherefind.mjs --write)", async () => {
  const cur = current(readFileSync(README, "utf8"));
  assert.ok(cur, "README.md needs the where-find markers");
  assert.equal(cur, await generated());
});

test("a task with two doors is one row, fewest taps first", () => {
  const t = table([
    { label: "B", from: "home menu", to: "x", title: "T", task: "Do it", taps: 2 },
    { label: "A", from: "home", to: "x", title: "T", task: "Do it", taps: 1 },
  ]);
  const rows = t.split("\n").slice(2);
  assert.equal(rows.length, 1);
  assert.match(rows[0], /Home › \*\*A\*\*; or Home ☰ menu › \*\*B\*\* \| T \| 1 \|$/);
});
