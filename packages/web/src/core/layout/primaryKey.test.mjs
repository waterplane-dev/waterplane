/**
 * Ctrl/Cmd+Return on an open dialog (`primaryKey.ts`): only the bare chord,
 * never mid-IME, and the button pressed is the topmost dialog's `.send`.
 */
import test from "node:test";
import assert from "node:assert/strict";

import { isPrimaryPress, primaryButton } from "./primaryKey.ts";

const k = (o) => ({ key: "Enter", ctrlKey: false, metaKey: false, shiftKey: false, altKey: false, ...o });

test("isPrimaryPress: Ctrl or Cmd with Return, nothing else", () => {
  assert.equal(isPrimaryPress(k({ ctrlKey: true })), true);
  assert.equal(isPrimaryPress(k({ metaKey: true })), true);
  assert.equal(isPrimaryPress(k({})), false, "bare Return");
  assert.equal(isPrimaryPress(k({ ctrlKey: true, shiftKey: true })), false);
  assert.equal(isPrimaryPress(k({ ctrlKey: true, altKey: true })), false);
  assert.equal(isPrimaryPress(k({ ctrlKey: true, isComposing: true })), false, "an IME candidate pick");
  assert.equal(isPrimaryPress(k({ key: "a", ctrlKey: true })), false);
});

test("primaryButton: the LAST open dialog's blue button, or null", () => {
  const btn = (name) => ({ name });
  const dlg = (b) => ({ querySelector: () => b });
  const doc = (...d) => ({ querySelectorAll: () => d });
  assert.equal(primaryButton(doc()), null, "no dialog: the compose box keeps the keys");
  assert.equal(primaryButton(doc(dlg(null))), null, "a dialog without a primary");
  assert.equal(primaryButton(doc(dlg(btn("under")), dlg(btn("top")))).name, "top");
});

import { primaryWhat } from "./primaryKey.ts";

test("primaryWhat: the button's own words, else a generic phrase", () => {
  assert.equal(primaryWhat("Delete"), "press “Delete”");
  assert.equal(primaryWhat("  Start\n  now "), "press “Start now”");
  assert.equal(primaryWhat(""), "press the dialog's button");
  assert.equal(primaryWhat("a very long button label that goes on"), "press the dialog's button");
});
