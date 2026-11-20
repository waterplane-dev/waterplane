/**
 * The merged screens of the whole-app journey spec (D4, D7): the old ids stay, and each lands on the
 * merged screen at its tab. `node --test packages/web/src/routingmerged.test.mjs`
 */
import test from "node:test";
import assert from "node:assert/strict";
import { OVERLAY_ALIAS, OVERLAY_IDS, PERSISTED_OVERLAYS, mergedTarget } from "./routing.ts";
import { TAB, HEALTH_SECTION, TITLE } from "./sheetNames.ts";

test("the old ids open the merged screens on their tab", () => {
  assert.deepEqual(mergedTarget("queue"), { overlay: "waiting", tab: "queued" });
  assert.deepEqual(mergedTarget("schedule"), { overlay: "waiting", tab: "scheduled" });
  assert.deepEqual(mergedTarget("repohealth"), { overlay: "health", tab: "repo", section: "score" });
  assert.deepEqual(mergedTarget("speedtest"), { overlay: "connection", tab: "speed" });
  assert.deepEqual(mergedTarget("waiting"), { overlay: "waiting", tab: "activity" });
  assert.equal(mergedTarget("git"), null);
  assert.equal(mergedTarget(null), null);
});

test("every alias and tab has its words, and the merged ids are overlay ids", () => {
  for (const id of ["waiting", "health", "connection"]) {
    assert.ok(OVERLAY_IDS.includes(id), id);
    assert.ok(TITLE[id], `no title for ${id}`);
  }
  for (const t of Object.values(OVERLAY_ALIAS)) {
    assert.ok(TAB[t.overlay][t.tab], `no words for ${t.overlay}/${t.tab}`);
    if ("section" in t) assert.ok(HEALTH_SECTION[t.section], `no words for section ${t.section}`);
  }
  // A persisted alias must land on a persisted screen, or a reload drops what the old id kept.
  for (const [old, t] of Object.entries(OVERLAY_ALIAS)) if (PERSISTED_OVERLAYS.has(old)) assert.ok(PERSISTED_OVERLAYS.has(t.overlay), `${old} is persisted, ${t.overlay} is not`);
});
