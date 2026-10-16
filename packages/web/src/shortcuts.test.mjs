/**
 * The shortcut table (`shortcuts.ts`): filtering by held modifier and `when()`,
 * the platform's labels, and the registry's add/remove.
 */
import test from "node:test";
import assert from "node:assert/strict";

import { detectMac, keyLabel, modLabel, registerShortcut, registeredShortcuts, shortcutsFor } from "./shortcuts.ts";

const MAC = { mac: true, tab: true };
const WIN = { mac: false, tab: true };

const entry = (o) => ({ id: "x", mods: ["ctrl"], key: "N", what: () => "do x", when: () => true, ...o });

test("only entries for the held modifier whose when() holds now", () => {
  const list = [
    entry({ id: "a", mods: ["ctrl", "meta"], key: "Enter", what: () => "send" }),
    entry({ id: "b", mods: ["alt"], what: () => "alt thing" }),
    entry({ id: "c", when: () => false }),
    entry({ id: "d", when: () => { throw new Error("boom"); } }),
  ];
  assert.deepEqual(shortcutsFor(list, "ctrl", WIN).map((r) => r.id), ["a"]);
  assert.deepEqual(shortcutsFor(list, "meta", MAC).map((r) => [r.key, r.what]), [["Return", "send"]]);
  assert.deepEqual(shortcutsFor(list, "alt", WIN).map((r) => r.id), ["b"]);
});

test("what() is read at show time, and a note per modifier/platform", () => {
  let repo = "api";
  const list = [entry({ what: () => `new session in ${repo}`, note: (m, env) => (m === "ctrl" && !env.mac ? "use Alt+N" : null) })];
  assert.equal(shortcutsFor(list, "ctrl", WIN)[0].what, "new session in api");
  repo = "other";
  assert.equal(shortcutsFor(list, "ctrl", WIN)[0].what, "new session in other");
  assert.equal(shortcutsFor(list, "ctrl", WIN)[0].note, "use Alt+N");
  assert.equal(shortcutsFor(list, "ctrl", MAC)[0].note, null);
});

test("labels: ⌘/⌥ on a Mac, Ctrl/Alt elsewhere; Return vs Enter", () => {
  assert.equal(modLabel("meta", MAC), "⌘");
  assert.equal(modLabel("alt", MAC), "⌥");
  assert.equal(modLabel("ctrl", MAC), "⌃");
  assert.equal(modLabel("ctrl", WIN), "Ctrl");
  assert.equal(modLabel("alt", WIN), "Alt");
  assert.equal(keyLabel("Enter", MAC), "Return");
  assert.equal(keyLabel("Enter", WIN), "Enter");
  assert.equal(keyLabel("n", WIN), "N");
});

test("detectMac", () => {
  assert.equal(detectMac({ platform: "MacIntel" }), true);
  assert.equal(detectMac({ userAgentData: { platform: "macOS" } }), true);
  assert.equal(detectMac({ platform: "iPad" }), true);
  assert.equal(detectMac({ platform: "Win32" }), false);
  assert.equal(detectMac({ userAgentData: { platform: "Android" }, platform: "Linux armv8l" }), false);
  assert.equal(detectMac(undefined), false);
});

test("register replaces by id and the removal takes it out", () => {
  const before = registeredShortcuts().length;
  const off1 = registerShortcut(entry({ id: "t1" }));
  registerShortcut(entry({ id: "t1", key: "M" }));
  assert.equal(registeredShortcuts().length, before + 1);
  assert.equal(registeredShortcuts().find((s) => s.id === "t1").key, "M");
  off1(); // the replaced entry's removal leaves the replacement alone
  assert.equal(registeredShortcuts().length, before + 1);
});
