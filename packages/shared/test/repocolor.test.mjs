// What colour a repo is (`shared/src/repocolor.ts`).
//
// Three things here are promises rather than preferences, and all three are
// invisible until they break on somebody else's machine:
//
//  1. **Separation.** The reason this module exists is that the old
//     `hash * 137.508 % 360` put two repos 9° apart, which in a 30 px tab strip
//     is one colour. Every ring is measured for its own worst pair.
//  2. **Stability.** A repo's colour is something you learn. The hash and the
//     ring order are pinned by VALUE, so a refactor that changes what `usmc` is
//     coloured fails here rather than on the phone.
//  3. **A pinned colour is never moved.** `spreadRepoColors` overwrites what
//     people can see; the one thing it may not touch is an answer somebody gave.
import test from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_PALETTE, NO_REPO_COLORS, REPO_PALETTES, autoHue, cleanRepoColors, freeHue,
  hueGap, isPinned, paletteById, paletteSize, repoColorClashes, repoHueIn, repoNameHash,
  setPalette, setRepoColor, spreadRepoColors,
} from "../dist/index.js";

test("every ring keeps its own hues apart", () => {
  for (const p of REPO_PALETTES) {
    // A ring is exactly as good as its WORST pair: one close pair is one pair
    // of repos nobody can tell apart, however well spread the other ten are.
    let worst = 360, pair = "";
    for (let i = 0; i < p.hues.length; i++) {
      for (let j = i + 1; j < p.hues.length; j++) {
        const d = hueGap(p.hues[i], p.hues[j]);
        if (d < worst) { worst = d; pair = `${p.hues[i]}/${p.hues[j]}`; }
      }
    }
    // 24° is the floor the narrow rings (`cool`, `warm`) can hold with eight
    // hues in them; `spectrum` measures 28. Below ~20 the two read as one
    // colour at tab size, which is the failure this replaced.
    assert.ok(worst >= 24, `${p.id}: closest pair ${pair} is ${worst}° apart`);
    assert.ok(p.hues.every((h) => Number.isInteger(h) && h >= 0 && h < 360), `${p.id}: hue out of range`);
    assert.equal(new Set(p.hues).size, p.hues.length, `${p.id}: a hue is listed twice`);
  }
});

test("the ring is indexed by the hash, and both are pinned", () => {
  // By value on purpose: these two numbers ARE the colours on the launcher.
  assert.equal(repoNameHash("usmc"), 3599540);
  assert.equal(repoNameHash(""), 0);
  const spectrum = paletteById("spectrum");
  assert.equal(autoHue("usmc", spectrum), spectrum.hues[3599540 % spectrum.hues.length]);
  // Same name, same colour, every time — that is the whole contract.
  assert.equal(autoHue("usmc", spectrum), autoHue("usmc", spectrum));
});

test("an unknown palette id falls back rather than drawing nothing", () => {
  assert.equal(paletteById(undefined).id, DEFAULT_PALETTE);
  assert.equal(paletteById("from-a-newer-build").id, DEFAULT_PALETTE);
  assert.equal(repoHueIn("usmc", { palette: "nope", by: {} }), autoHue("usmc", paletteById(DEFAULT_PALETTE)));
});

test("a pinned hue wins, and clearing puts the ring back", () => {
  let cfg = NO_REPO_COLORS;
  assert.equal(isPinned("usmc", cfg), false);
  cfg = setRepoColor(cfg, "usmc", 300);
  assert.equal(repoHueIn("usmc", cfg), 300);
  assert.equal(isPinned("usmc", cfg), true);
  cfg = setRepoColor(cfg, "usmc", null);
  assert.equal(isPinned("usmc", cfg), false);
  assert.equal(repoHueIn("usmc", cfg), autoHue("usmc", paletteById(DEFAULT_PALETTE)));
});

test("a pinned answer survives a change of ring", () => {
  // The alternative reading — "slot 4 of whatever ring is current" — would move
  // a colour somebody chose, without them asking for it.
  const cfg = setPalette(setRepoColor(NO_REPO_COLORS, "usmc", 300), "cvd");
  assert.equal(cfg.palette, "cvd");
  assert.equal(repoHueIn("usmc", cfg), 300);
});

test("junk in the store is dropped, not drawn", () => {
  const cfg = cleanRepoColors({ palette: 7, by: { a: "red", b: null, c: 420, "": 10, d: 200 } });
  assert.equal(cfg.palette, DEFAULT_PALETTE);
  assert.deepEqual(cfg.by, { c: 60, d: 200 });   // 420 wraps to 60; the rest are not hues
  assert.deepEqual(cleanRepoColors(null), NO_REPO_COLORS);
  assert.deepEqual(cleanRepoColors("[]").by, {});
});

test("a clash is two repos on one hue — never a group of one", () => {
  const cfg = setRepoColor(setRepoColor(NO_REPO_COLORS, "a", 200), "b", 200);
  assert.deepEqual(repoColorClashes(["a", "b"], cfg), [["a", "b"]]);
  assert.deepEqual(repoColorClashes(["a"], cfg), []);
  assert.deepEqual(repoColorClashes([], cfg), []);
});

test("the free hue ignores the repo being re-coloured", () => {
  // Otherwise a repo alone on its colour is told its own colour is taken, and
  // "give me another" hands back the one it already has.
  const cfg = setRepoColor(NO_REPO_COLORS, "solo", 200);
  assert.notEqual(freeHue(["solo"], cfg, "solo"), undefined);
  const ring = paletteById(DEFAULT_PALETTE).hues;
  assert.ok(ring.includes(freeHue(["solo"], cfg, "solo")));
});

test("spreading separates what collides and leaves everything else alone", () => {
  const names = ["one", "two", "three", "four", "five", "six", "seven", "eight"];
  const before = repoColorClashes(names, NO_REPO_COLORS);
  const cfg = spreadRepoColors(names, NO_REPO_COLORS);
  assert.deepEqual(repoColorClashes(names, cfg), [], "a ring with room left still has a clash in it");
  // Every repo that was already alone on its hue kept it: the tap changes as
  // little as it can, so the colours you already recognise stay recognisable.
  for (const n of names) {
    const wasAlone = !before.some((g) => g.includes(n));
    if (wasAlone) assert.equal(repoHueIn(n, cfg), repoHueIn(n, NO_REPO_COLORS), `${n} moved for nothing`);
  }
  // Running it again does nothing at all.
  assert.deepEqual(spreadRepoColors(names, cfg), cfg);
});

test("spreading never moves a colour somebody chose", () => {
  const names = ["a", "b"];
  const pinned = setRepoColor(setRepoColor(NO_REPO_COLORS, "a", 200), "b", 200);
  const out = spreadRepoColors(names, pinned);
  assert.equal(repoHueIn("a", out), 200);
  assert.equal(repoHueIn("b", out), 200, "a pinned clash is the person's, and stays");
});

test("more repos than hues doubles up rather than inventing a colour", () => {
  const n = paletteSize(DEFAULT_PALETTE);
  const names = Array.from({ length: n + 3 }, (_, i) => `repo-${i}`);
  const cfg = spreadRepoColors(names, NO_REPO_COLORS);
  const ring = new Set(paletteById(DEFAULT_PALETTE).hues);
  for (const name of names) assert.ok(ring.has(repoHueIn(name, cfg)), `${name} left the ring`);
  // …and what doubles up is still REPORTED, so the sheet can say so rather
  // than a person discovering it two screens apart.
  const left = repoColorClashes(names, cfg);
  assert.ok(left.length > 0, "13 repos in a ring of 12 and nothing shares a colour?");
  assert.equal(left.flat().length - left.length, names.length - n, "more doubling up than the ring forces");
});
