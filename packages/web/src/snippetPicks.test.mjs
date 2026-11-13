import test from "node:test";
import assert from "node:assert/strict";
import { STARTERS, byRecent, noteRecent, insertLabel, joinSnippets, missingStarters, snippetView, tickedSnippets, toggleTick } from "./snippetPicks.ts";

test("starters show only when no list exists at all", () => {
  assert.equal(snippetView(null).starter, true);
  assert.equal(snippetView(null).list.length, STARTERS.length);
  assert.deepEqual(snippetView("[]"), { list: [], starter: false }); // an emptied list is a choice
  const mine = [{ id: "a", title: "A", text: "a" }];
  assert.deepEqual(snippetView(JSON.stringify(mine)), { list: mine, starter: false }); // an adopted list is that list
  assert.deepEqual(snippetView("{not json"), { list: [], starter: false }); // unreadable: never replaced by words nobody wrote
});

test("tick order is tap order and a second tap unticks", () => {
  let o = [];
  o = toggleTick(o, "b"); o = toggleTick(o, "a"); o = toggleTick(o, "c");
  assert.deepEqual(o, ["b", "a", "c"]);
  assert.deepEqual(toggleTick(o, "a"), ["b", "c"]);
  const list = [{ id: "a", text: "A" }, { id: "b", text: "B" }, { id: "c", text: "C" }];
  assert.deepEqual(tickedSnippets(list, ["c", "gone", "a"]).map((s) => s.id), ["c", "a"]);
});

test("ticked snippets join one per line", () => {
  assert.equal(joinSnippets([{ text: "one " }, { text: "" }, { text: "two" }]), "one\ntwo");
  assert.equal(joinSnippets([]), "");
});

test("insert label", () => {
  assert.equal(insertLabel(1), "Insert");
  assert.equal(insertLabel(3), "Insert 3");
});

test("add starters appends the missing ones by text, never replaces", () => {
  const mine = [{ id: "x", title: "Mine", text: STARTERS[0].text }, { id: "y", title: "Y", text: "y" }];
  const add = missingStarters(mine);
  assert.equal(add.length, STARTERS.length - 1);
  assert.ok(!add.some((s) => s.text === STARTERS[0].text));
  assert.equal(missingStarters([...mine, ...add]).length, 0);
});

test("byRecent puts the last inserted first and keeps the saved order for the rest; noteRecent caps and dedupes", () => {
  const list = [{ id: "a", title: "", text: "" }, { id: "b", title: "", text: "" }, { id: "c", title: "", text: "" }, { id: "d", title: "", text: "" }];
  assert.deepEqual(byRecent(list, ["c", "gone", "a"]).map((s) => s.id), ["c", "a", "b", "d"]);
  assert.deepEqual(byRecent(list, []).map((s) => s.id), ["a", "b", "c", "d"]);
  assert.deepEqual(noteRecent(["c", "a"], ["a", "d"]), ["a", "d", "c"]);
  assert.equal(noteRecent([], Array.from({ length: 60 }, (_, i) => String(i))).length, 50);
});
