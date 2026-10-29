/**
 * The backend parity matrix (docs/notes/backend-parity.md) is generated from the live descriptors.
 * Stale doc = a descriptor changed without `node tools/backendparity.mjs`. Reads host/dist, so the
 * host must be built (npm run build).
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DOC, cell, loadInRepo, render } from "./backendparity.mjs";

test("the committed parity doc equals the render of the live descriptors", async () => {
  const text = render(await loadInRepo());
  assert.equal(readFileSync(DOC, "utf8"), text, "stale: run `node tools/backendparity.mjs`");
});

test("every registered backend has a column and the groups are present", async () => {
  const ds = await loadInRepo();
  const doc = readFileSync(DOC, "utf8");
  for (const id of ["claude", "shell"]) assert.ok(ds.some((d) => d.id === id), `${id} registered`);
  const head = doc.split("\n").find((l) => l.startsWith("| fact |"));
  for (const d of ds) assert.ok(head.includes(`\`${d.id}\``), `column for ${d.id}`);
  for (const g of ["Caps", "Facts", "Delivery", "Sources", "effort", "permissionModes", "measured.versions", "transcript"]) assert.ok(doc.includes(g), g);
});

test("a table cell escapes the backslash before the pipe (CodeQL js/incomplete-sanitization)", () => {
  assert.equal(cell("a|b"), "a\\|b");
  assert.equal(cell('"\\r"'), '"\\\\r"', "renders as \"\\r\" in GFM");
  assert.equal(cell("x\\"), "x\\\\", "a trailing backslash cannot escape the next column's pipe");
  assert.equal(cell("x\\|y"), "x\\\\\\|y");
});
