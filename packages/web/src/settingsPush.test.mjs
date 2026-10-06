/**
 * The two ways a settings push can overwrite the shared copy with the wrong
 * thing, pinned.
 *
 * Both are invisible from every screen: the device says `synced`, the host
 * holds an older list, and the notes that went missing were on another phone.
 *
 *     node --test packages/web/src/settingsPush.test.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";
import { aheadValue, repushAfterAdopt } from "./settingsPush.ts";

// The pad's real guard, in miniature: a union of two comma-separated lists.
const union = (incoming, current) => {
  const all = new Set([...(current ? current.split(",") : []), ...(incoming ? incoming.split(",") : [])]);
  return [...all].sort().join(",");
};

test("a merge that did not LAND is not pushed", () => {
  // The quota case. `setItem` threw, so this device still holds the old value —
  // and the push reads the store back, so it would send that old value stamped
  // newer than the host's. The flag is the write's, taken inside the `try`.
  assert.equal(repushAfterAdopt(false, "a,b", "b"), false);
  assert.equal(repushAfterAdopt(true, "a,b", "b"), true, "it landed and the host has not got it");
});

test("an adoption that merged NOTHING in has nothing to push", () => {
  assert.equal(repushAfterAdopt(true, "b", "b"), false, "what we wrote IS what arrived");
  assert.equal(repushAfterAdopt(false, "b", "b"), false);
});

test("a device that is ahead MERGES before it pushes", () => {
  // Wrote offline at t1 while the other device pushed at t0 < t1. Ahead, yes —
  // but pushing our copy takes the other device's notes off the host until it
  // reconnects and unions them back.
  assert.equal(aheadValue("mine", "theirs", union), "mine,theirs");
});

test("nothing to merge in means: push what you hold", () => {
  // `null` is the caller's signal to leave the value and the stamp alone.
  assert.equal(aheadValue("a,b", "a", union), null, "ours already contains theirs");
  assert.equal(aheadValue("a", "a", union), null);
  assert.equal(aheadValue("a", undefined, union), null, "the host has never heard of this key");
  assert.equal(aheadValue("a", "b", undefined), null, "an ordinary preference: last-write-wins is right");
});

test("a guard that throws never stops the push", () => {
  const boom = () => { throw new Error("bad JSON on the wire"); };
  assert.equal(aheadValue("mine", "theirs", boom), null, "a merge is best effort; the sync is not");
  // Nor does one that answers with something that is not a string.
  assert.equal(aheadValue("mine", "theirs", () => undefined), null);
});
