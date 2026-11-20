/**
 * Door registry guard (whole-app journey spec D1, D10): every control that opens a screen says that
 * screen's title, and every screen has a way in.
 *
 * Reads the registry itself (`packages/web/src/doors/`, run straight from TypeScript): each door's
 * label equals its title or is its start at a word boundary, a leading count ignored ("3 blocked"
 * opens "Blocked"); its title is a value of `sheetNames.ts` `TITLE` (one table of titles); its target
 * is an overlay id `routing.ts` knows. Strict, with no baseline: the registry is new.
 *
 * RATCHET for coverage: every overlay id has a door (a door to an alias counts for the merged screen
 * it lands on, and the other way round) or a stated reason in an area's `noDoor`. The ids without one
 * today are tools/appdoors.baseline.json; an id may leave that list, never join it. A shrink is
 * printed, never a failure (packages built in parallel never write one file); `node
 * tools/appdoors.test.mjs --write` drops the ids that now pass, `--init` rewrites it as found.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname;
const BASELINE = join(ROOT, "tools/appdoors.baseline.json");
const WEB = join(ROOT, "packages/web/src");

const { OVERLAY_IDS, OVERLAY_ALIAS, isFeatureSheetId } = await import(join(WEB, "routing.ts"));
const { TITLE } = await import(join(WEB, "sheetNames.ts"));
const { DOORS, NO_DOOR, labelSaysTitle } = await import(join(WEB, "doors/index.ts"));

/** Ids with neither a door nor a stated reason. */
export function uncovered() {
  const reached = new Set();
  for (const d of DOORS) {
    reached.add(d.to);
    const alias = OVERLAY_ALIAS[d.to];
    if (alias) reached.add(alias.overlay);
  }
  // A door onto the merged screen reaches the ids it absorbed (they land on it).
  for (const [old, t] of Object.entries(OVERLAY_ALIAS)) if (reached.has(t.overlay)) reached.add(old);
  return OVERLAY_IDS.filter((id) => !reached.has(id) && !NO_DOOR[id]).sort();
}

const readBase = () => (existsSync(BASELINE) ? JSON.parse(readFileSync(BASELINE, "utf8")) : []);

if (process.argv.includes("--write") || process.argv.includes("--init")) {
  const now = uncovered();
  const next = process.argv.includes("--init") ? now : readBase().filter((id) => now.includes(id));
  writeFileSync(BASELINE, JSON.stringify(next, null, 2) + "\n");
  console.log(`${next.length} overlay id(s) without a door in the baseline`);
} else {
  test("every door says its screen's title, names a title from sheetNames.ts and opens a known overlay", () => {
    const titles = new Set(Object.values(TITLE));
    const ids = new Set(OVERLAY_IDS);
    const bad = [];
    for (const d of DOORS) {
      const at = `doors/${d.area}.ts "${d.label}" (${d.from})`;
      if (!titles.has(d.title)) bad.push(`${at}: title "${d.title}" is not a value of sheetNames.ts TITLE`);
      else if (!labelSaysTitle(d.label, d.title)) bad.push(`${at}: the label does not say the title "${d.title}" (equal, or its start)`);
      if (!ids.has(d.to) && !isFeatureSheetId(d.to)) bad.push(`${at}: opens "${d.to}", which routing.ts does not know`);
    }
    for (const id of Object.keys(NO_DOOR)) if (!ids.has(id) && !isFeatureSheetId(id)) bad.push(`noDoor names "${id}", which routing.ts does not know`);
    assert.deepEqual(bad, []);
  });

  test("every alias lands on a merged screen routing.ts knows", () => {
    const ids = new Set(OVERLAY_IDS);
    for (const [old, t] of Object.entries(OVERLAY_ALIAS)) {
      assert.ok(ids.has(old), `alias "${old}" is not an overlay id`);
      assert.ok(ids.has(t.overlay), `alias "${old}" lands on "${t.overlay}", not an overlay id`);
    }
  });

  test("coverage ratchet: an overlay id with no door and no reason may only leave the baseline", () => {
    const base = new Set(readBase());
    const now = uncovered();
    const fresh = now.filter((id) => !base.has(id));
    const gone = [...base].filter((id) => !now.includes(id));
    if (gone.length) console.log(`the baseline can go down (node tools/appdoors.test.mjs --write): ${gone.join(", ")}`);
    assert.deepEqual(fresh, [], "these overlay ids have no door in packages/web/src/doors/ and no noDoor reason");
  });

  test("labelSaysTitle: equal, or the start at a word boundary; a leading count ignored", () => {
    assert.ok(labelSaysTitle("Waiting work", "Waiting work"));
    assert.ok(labelSaysTitle("Browse files", "Browse files - repo"));
    assert.ok(labelSaysTitle("Images", "Images & documents"));
    assert.ok(labelSaysTitle("3 blocked", "Blocked"));
    assert.ok(labelSaysTitle("N blocked", "Blocked"));
    assert.ok(!labelSaysTitle("Change", "Changes - repo"));
    assert.ok(!labelSaysTitle("Manage", "Waiting work"));
    assert.ok(!labelSaysTitle("", "Pad"));
  });
}
