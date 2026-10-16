/**
 * The header's [Claude | Shell] tabs: which one is lit and where the other goes.
 */
import test from "node:test";
import assert from "node:assert/strict";

import { pairTabs, sessionSegs } from "./pairTabs.ts";

const can = { pending: false };
const cli = { id: "a", createdAt: 1 };

test("a companion shell lights Shell and Claude goes back to its parent", () => {
  const sh = { id: "s", companionOf: "a", createdAt: 2 };
  assert.deepEqual(pairTabs(sh, [cli, sh], can), { on: "shell", cli });
});

test("a session with companions lights Claude and Shell goes to the NEWEST", () => {
  const old = { id: "s1", companionOf: "a", createdAt: 2 };
  const neu = { id: "s2", companionOf: "a", createdAt: 3 };
  assert.deepEqual(pairTabs(cli, [cli, old, neu], can), { on: "cli", shell: neu });
});

test("a session with no companion has no tabs: the burger's companion shell makes one", () => {
  assert.equal(pairTabs(cli, [cli], can), null);
  const other = { id: "s", companionOf: "b", createdAt: 2 };
  assert.equal(pairTabs(cli, [cli, other], can), null);
});

test("no tabs on a pending open, a plain shell, or a companion whose parent is gone", () => {
  assert.equal(pairTabs(cli, [cli], { ...can, pending: true }), null);
  assert.equal(pairTabs({ id: "p" }, [{ id: "p" }], can), null);
  const orphan = { id: "s", companionOf: "gone" };
  assert.equal(pairTabs(orphan, [orphan], can), null);
});

// ── the generalised segment: pairTabs plus contributed views (SessionViewDef) ──

const segCan = { pending: false, shell: false };
const desk = { key: "desktop:screen", label: "Desktop" };

/** `sessionSegs`' output as the pair it must equal when no view is contributed. */
const asPair = (segs) => {
  if (!segs) return null;
  const [a, b] = segs;
  return a.on ? { on: "cli", shell: b.target } : { on: "shell", cli: a.target };
};

test("with no view contributed the segment IS pairTabs, shape for shape (the header is unchanged)", () => {
  const sh = { id: "s", companionOf: "a", createdAt: 2 };
  const other = { id: "o", companionOf: "b", createdAt: 2 };
  const cases = [
    [cli, [cli]], [cli, [cli, other]], [cli, [cli, sh]], [sh, [cli, sh]],
    [{ id: "p" }, [{ id: "p" }]], [{ id: "s", companionOf: "gone" }, [{ id: "s", companionOf: "gone" }]],
  ];
  for (const [active, list] of cases) {
    for (const shell of [false, true]) {
      for (const pending of [false, true]) {
        const segs = sessionSegs(active, list, { pending, shell }, []);
        assert.deepEqual(asPair(segs), pairTabs(active, list, { pending }), JSON.stringify({ active, shell, pending }));
        if (segs) assert.equal(segs.length, 2, "exactly the two tabs, nothing appended");
      }
    }
  }
});

test("claude with no companion and no view: no segment, as today", () => {
  assert.equal(sessionSegs(cli, [cli], segCan, []), null);
});

test("claude with no companion but a view: [Claude | Desktop], Claude lit", () => {
  assert.deepEqual(sessionSegs(cli, [cli], segCan, [desk]), [{ kind: "cli", on: true }, { kind: "view", view: desk }]);
});

test("a shell with a view: [Shell | Desktop], Shell lit — a plain shell and an orphaned companion alike", () => {
  const plain = { id: "p" };
  assert.deepEqual(sessionSegs(plain, [plain], { ...segCan, shell: true }, [desk]), [{ kind: "shell", on: true }, { kind: "view", view: desk }]);
  const orphan = { id: "s", companionOf: "gone" };
  assert.deepEqual(sessionSegs(orphan, [orphan], segCan, [desk]), [{ kind: "shell", on: true }, { kind: "view", view: desk }]);
});

test("with a companion pair the views come after both tabs", () => {
  const sh = { id: "s", companionOf: "a", createdAt: 2 };
  const v2 = { key: "x:y", label: "Other" };
  assert.deepEqual(sessionSegs(cli, [cli, sh], segCan, [desk, v2]), [
    { kind: "cli", on: true }, { kind: "shell", on: false, target: sh }, { kind: "view", view: desk }, { kind: "view", view: v2 },
  ]);
  assert.deepEqual(sessionSegs(sh, [cli, sh], segCan, [desk]), [
    { kind: "cli", on: false, target: cli }, { kind: "shell", on: true }, { kind: "view", view: desk },
  ]);
});

test("an unavailable view is still a segment: the model never filters it out", () => {
  const off = { ...desk, unavailable: "Live desktop needs macOS for now" };
  const segs = sessionSegs(cli, [cli], segCan, [off]);
  assert.deepEqual(segs.at(-1), { kind: "view", view: off });
});

test("a pending open has no segment even with a view", () => {
  assert.equal(sessionSegs(cli, [cli], { ...segCan, pending: true }, [desk]), null);
});
