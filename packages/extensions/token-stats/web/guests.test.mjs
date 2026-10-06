import test from "node:test";
import assert from "node:assert/strict";
import { claudeOnlyText, shownGuests } from "./guests.ts";

const def = (id) => ({ id, label: id, hasData: (d) => !!d && d.n > 0 });

test("a guest has a tab only when the host answered with something in it", () => {
  const g = [{ def: def("a"), doc: { n: 1 } }, { def: def("b"), doc: { n: 0 } }, { def: def("c"), doc: null }];
  assert.deepEqual(shownGuests(g).map((x) => x.def.id), ["a"]);
});

test("Claude's scope sentence names every other tab, and is absent with none", () => {
  assert.equal(claudeOnlyText([]), null);
  assert.equal(claudeOnlyText([{ def: def("a") }]), "Claude Code sessions only — a sessions are counted on their own view.");
  assert.equal(claudeOnlyText([{ def: def("a") }, { def: def("b") }, { def: def("c") }]), "Claude Code sessions only — a, b and c sessions are counted on their own views.");
});
