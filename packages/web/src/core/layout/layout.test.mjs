/**
 * Phone or wide (`layout.ts`): the predicate at its edge, and the one writer —
 * store and `<html data-layout>` move together, on every change, and stop when
 * unsubscribed. Docs: docs/analysis/desktop-workspace-plan.md §1.
 */
import test from "node:test";
import assert from "node:assert/strict";

import { LAYOUT_ATTR, WIDE_MIN_PX, WIDE_QUERY, layoutOf, layoutStore, startLayout } from "./layout.ts";

test("layoutOf: 1024 is wide, 1023 and a zoomed 1023.5 are phone", () => {
  assert.equal(WIDE_MIN_PX, 1024);
  assert.equal(layoutOf(1024), "wide");
  assert.equal(layoutOf(2560), "wide");
  assert.equal(layoutOf(1023), "phone");
  assert.equal(layoutOf(1023.5), "phone");
  assert.equal(layoutOf(448), "phone");
});

test("layoutOf: a width that is not a number is phone", () => {
  assert.equal(layoutOf(NaN), "phone");
  assert.equal(layoutOf(Infinity), "phone");
  assert.equal(layoutOf(undefined), "phone");
});

test("the query says the same number as the predicate", () => {
  assert.equal(WIDE_QUERY, "(min-width: 1024px)");
});

function fakeQuery(matches) {
  const subs = new Set();
  return {
    matches,
    addEventListener: (_t, fn) => subs.add(fn),
    removeEventListener: (_t, fn) => subs.delete(fn),
    flip(m) { this.matches = m; for (const fn of [...subs]) fn(); },
    subs,
  };
}

function fakeRoot() {
  const attrs = {};
  return { attrs, setAttribute: (k, v) => { attrs[k] = v; } };
}

test("the writer: store and attribute together, on start and on every change", () => {
  const mq = fakeQuery(false);
  const root = fakeRoot();
  const stop = startLayout(mq, root);
  assert.equal(layoutStore.get(), "phone");
  assert.equal(root.attrs[LAYOUT_ATTR], "phone");

  let emits = 0;
  const unsub = layoutStore.subscribe(() => { emits++; });
  mq.flip(true);
  assert.equal(layoutStore.get(), "wide");
  assert.equal(root.attrs["data-layout"], "wide");
  mq.flip(true); // nothing changed: no emit
  assert.equal(emits, 1);
  mq.flip(false);
  assert.equal(layoutStore.get(), "phone");
  assert.equal(root.attrs["data-layout"], "phone");

  stop();
  assert.equal(mq.subs.size, 0);
  mq.flip(true);
  assert.equal(layoutStore.get(), "phone", "an unsubscribed writer writes nothing");
  unsub();
});

test("the writer: no matchMedia means phone, and a legacy addListener query still works", () => {
  const root = fakeRoot();
  startLayout(null, root)();
  assert.equal(root.attrs["data-layout"], "phone");

  const subs = new Set();
  const legacy = { matches: true, addListener: (fn) => subs.add(fn), removeListener: (fn) => subs.delete(fn) };
  const stop = startLayout(legacy, root);
  assert.equal(root.attrs["data-layout"], "wide");
  legacy.matches = false;
  for (const fn of subs) fn();
  assert.equal(root.attrs["data-layout"], "phone");
  stop();
  assert.equal(subs.size, 0);
});
