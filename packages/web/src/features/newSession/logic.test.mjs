/**
 * The new-session chord (`logic.ts`): which presses are "new".
 */
import test from "node:test";
import assert from "node:assert/strict";

import { isNewSessionPress } from "./logic.ts";

const k = (o) => ({ key: "n", code: "KeyN", ctrlKey: false, metaKey: false, shiftKey: false, altKey: false, ...o });

test("isNewSessionPress: Ctrl+N, Cmd+N, Alt/Option+N — nothing else", () => {
  assert.equal(isNewSessionPress(k({ ctrlKey: true })), true);
  assert.equal(isNewSessionPress(k({ metaKey: true })), true);
  assert.equal(isNewSessionPress(k({ altKey: true, key: "˜" })), true, "Option+N types a dead key; code still says KeyN");
  assert.equal(isNewSessionPress(k({})), false, "a bare n is typing");
  assert.equal(isNewSessionPress(k({ ctrlKey: true, shiftKey: true })), false, "Ctrl+Shift+N is the browser's incognito");
  assert.equal(isNewSessionPress(k({ ctrlKey: true, metaKey: true })), false);
  assert.equal(isNewSessionPress(k({ ctrlKey: true, altKey: true })), false);
  assert.equal(isNewSessionPress(k({ ctrlKey: true, isComposing: true })), false);
  assert.equal(isNewSessionPress(k({ ctrlKey: true, key: "m", code: "KeyM" })), false);
});

import { newKeyNote, newKeyWhat } from "./logic.ts";

test("newKeyWhat: the repo on a session screen, else it asks", () => {
  assert.equal(newKeyWhat("api"), "new session in api");
  assert.equal(newKeyWhat(null), "new session — pick a repo");
});

test("newKeyNote: which modifier's N a browser tab never receives", () => {
  const winTab = { mac: false, tab: true };
  const macTab = { mac: true, tab: true };
  const app = { mac: false, tab: false };
  assert.match(newKeyNote("ctrl", winTab), /never receives Ctrl\+N — Alt\+N/);
  assert.equal(newKeyNote("ctrl", macTab), null);
  assert.equal(newKeyNote("ctrl", app), null);
  assert.match(newKeyNote("meta", macTab), /⌘N — ⌥N or ⌃N/);
  assert.equal(newKeyNote("meta", { mac: true, tab: false }), null);
  assert.match(newKeyNote("meta", app), /Win\+N/);
  assert.equal(newKeyNote("alt", winTab), null);
  assert.equal(newKeyNote("alt", macTab), null);
});
