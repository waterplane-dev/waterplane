/**
 * "Private" on the plugin manager is read from an extension's own `ship.json` (`"ship": false`,
 * `packages/host/src/plugins/builtin.ts`), while the public snapshot is cut by
 * `deploy/public-allowlist.txt` (`!packages/extensions/<id>/**`). Two sources for one fact: this
 * holds them together, for every folder under packages/extensions.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { privateExtensions } from "../scripts/release/public-lib.mjs";

const ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const EXT = join(ROOT, "packages", "extensions");
const ids = readdirSync(EXT, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name).sort();
const excluded = new Set(privateExtensions(readFileSync(join(ROOT, "deploy", "public-allowlist.txt"), "utf8")));

function shipFalse(id) {
  const f = join(EXT, id, "ship.json");
  if (!existsSync(f)) return false;
  return JSON.parse(readFileSync(f, "utf8")).ship === false;
}

for (const id of ids) {
  test(`${id}: ship.json "ship": false <=> the public allow-list leaves it out`, () => {
    assert.equal(shipFalse(id), excluded.has(id),
      shipFalse(id)
        ? `${id}/ship.json says ship:false but deploy/public-allowlist.txt has no "!packages/extensions/${id}/**" line`
        : `deploy/public-allowlist.txt leaves ${id} out but its ship.json does not say "ship": false`);
  });
}

// In the public snapshot every carved-out folder is absent by design; here at least one is present.
const snapshot = [...excluded].every((id) => !ids.includes(id));
test("every carve-out names a real extension folder", { skip: snapshot && "public snapshot: the carved-out extensions are left out on purpose" }, () => {
  for (const id of excluded) assert.ok(ids.includes(id), `allow-list names packages/extensions/${id}/ which does not exist`);
});
