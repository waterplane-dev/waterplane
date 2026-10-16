// Passive device mode, the phone's half: which screen, and what a row says.
// The host enforces the scope (`packages/host/test/passive.test.mjs`).
import { test } from "node:test";
import assert from "node:assert/strict";
import { bootMode, passiveRows, passiveRowText, relockDelayMs } from "./passiveMode.ts";

test("bootMode: the host's word wins; with no answer, the remembered mark", () => {
  const now = 1_000_000;
  assert.equal(bootMode(false, null, now), "full");
  assert.equal(bootMode(true, null, now), "passive", "desktop out of reach: stay passive");
  assert.equal(bootMode(true, {}, now), "full", "the host says full: a stale mark does not lock the phone");
  assert.equal(bootMode(false, { scope: "passive" }, now), "passive");
  assert.equal(bootMode(true, { scope: "passive", unlockedUntil: now + 60_000 }, now), "full");
  assert.equal(bootMode(true, { scope: "passive", unlockedUntil: now - 1 }, now), "passive", "expired");
});

test("passiveRows: APKs only, newest first", () => {
  const r = (name, ts) => ({ item: { name, relPath: `.claude/outbox/${name}`, ts } });
  const rows = passiveRows([r("a.apk", 1), r("shot.png", 3), r("b.apk", 2)]);
  assert.deepEqual(rows.map((x) => x.item.name), ["b.apk", "a.apk"]);
});

test("passiveRowText: every state in words, progress capped below done", () => {
  assert.match(passiveRowText({ state: "queued", received: 0, item: { size: 10 } }), /waiting/);
  assert.equal(passiveRowText({ state: "downloading", received: 10, item: { size: 10 } }), "downloading 99%");
  assert.equal(passiveRowText({ state: "downloading", received: 5, item: { size: 0 } }), "downloading");
  assert.match(passiveRowText({ state: "failed", received: 0, item: { size: 1 }, error: "404" }), /404/);
  assert.match(passiveRowText({ state: "done", received: 1, item: { size: 1 } }), /installs itself/);
});

test("relockDelayMs: just after the unlock ends, never negative", () => {
  assert.equal(relockDelayMs(1000, 2000), 750);
  assert.equal(relockDelayMs(5000, 1000), 4750);
});
