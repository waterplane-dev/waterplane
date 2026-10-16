/**
 * The code-folder dialog's pure half (`features/codeFolder/logic.ts`).
 *
 *     node --test packages/web/src/features/codeFolder/logic.test.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  afterSave, checkWords, dismissKey, footerWords, parseLater, pickedWords, reposWords, rootLine, samePath, sheetMode,
  shouldAskNow, targetPath, withLater,
} from "./logic.ts";

const info = (over = {}) => ({ picked: "found", root: "/Users/a/dev", rootExists: true, pending: null, ...over });
const plain = { overlay: null, demo: false };

test("how a root was picked, in words, for every kind", () => {
  assert.equal(pickedWords("named", "WATERPLANE_ROOT"), "set by WATERPLANE_ROOT");
  assert.equal(pickedWords("chosen", "X"), "chosen here");
  assert.equal(pickedWords("found", "X"), "guessed — first usual code folder");
  assert.equal(pickedWords("fallback", "X"), "guessed — folder missing");
});

test("repo counts and the current line", () => {
  assert.equal(reposWords(0), "no repos");
  assert.equal(reposWords(1), "1 repo");
  assert.equal(reposWords(14), "14 repos");
  assert.equal(rootLine({ root: "/r", rootExists: true, repos: 3 }), "/r · 3 repos");
  assert.equal(rootLine({ root: "/r", rootExists: false, repos: 0 }), "/r · doesn't exist");
});

test("a path compares without trailing slashes; the typed path beats the tapped row", () => {
  assert.ok(samePath("/a/dev/", "/a/dev"));
  assert.ok(!samePath("/a/dev", "/a/devx"));
  assert.ok(samePath("/", "/"));
  assert.equal(targetPath("/row", " /typed "), "/typed");
  assert.equal(targetPath("/row", "  "), "/row");
  assert.equal(targetPath(null, ""), "");
});

test("the sheet can choose only when it is not named and this connection may change it", () => {
  assert.equal(sheetMode({ picked: "named", canChange: true }), "named");
  assert.equal(sheetMode({ picked: "found", canChange: false }), "locked");
  assert.equal(sheetMode({ picked: "fallback", canChange: true }), "choose");
});

test("the footer names where it is kept and what wins over it", () => {
  const w = footerWords({ choicePath: "/c/root.json", envName: "WATERPLANE_ROOT" });
  assert.match(w, /Settings → Code folder/);
  assert.match(w, /\/c\/root\.json/);
  assert.match(w, /WATERPLANE_ROOT environment variable/);
});

test("dismissals are kept per guess, tolerantly, and bounded", () => {
  assert.equal(dismissKey({ picked: "found", root: "/a" }), "found:/a");
  assert.deepEqual(parseLater(null), []);
  assert.deepEqual(parseLater("x"), []);
  assert.deepEqual(parseLater(["a", 3, "", "b"]), ["a", "b"]);
  assert.deepEqual(withLater(["a"], "a"), ["a"]);
  assert.deepEqual(withLater(["a"], "b"), ["a", "b"]);
  const many = Array.from({ length: 40 }, (_, i) => `k${i}`);
  assert.equal(withLater(many, "new").length, 20);
  assert.equal(withLater(many, "new").at(-1), "new");
});

test("it asks unprompted only about a guess, once, on a plain screen, outside the demo", () => {
  assert.equal(shouldAskNow(info(), [], plain), true);
  assert.equal(shouldAskNow(info({ picked: "fallback", rootExists: false }), [], plain), true);
  assert.equal(shouldAskNow(info(), ["found:/Users/a/dev"], plain), false, "waved away");
  assert.equal(shouldAskNow(info({ root: "/Users/a/code" }), ["found:/Users/a/dev"], plain), true, "a different guess asks again");
  assert.equal(shouldAskNow(info({ picked: "named" }), [], plain), false, "a variable meant it");
  assert.equal(shouldAskNow(info({ picked: "chosen" }), [], plain), false);
  assert.equal(shouldAskNow(info({ picked: "chosen", rootExists: false }), [], plain), true, "a chosen folder that vanished");
  assert.equal(shouldAskNow(info({ pending: "/x" }), [], plain), false, "saved, awaiting a restart");
  assert.equal(shouldAskNow(info(), [], { overlay: "send", demo: false }), false, "not over somebody's sheet");
  assert.equal(shouldAskNow(info(), [], { overlay: null, demo: true }), false);
  // The same path dismissed as a guess does not silence it once it was chosen and vanished.
  assert.equal(shouldAskNow(info({ picked: "chosen", rootExists: false }), ["found:/Users/a/dev"], plain), true);
});

test("what a save leaves on the sheet", () => {
  assert.deepEqual(afterSave({ ok: true, root: "/r", repos: 2, saved: true, restart: "none" }), { kind: "closed" });
  assert.deepEqual(afterSave({ ok: true, root: "/r", repos: 2, saved: true, restart: "auto" }),
    { kind: "restarting", text: "Restarting the host to scan /r…" });
  assert.deepEqual(afterSave({ ok: true, root: "/r", repos: 2, saved: true, restart: "manual" }),
    { kind: "manual", text: "Saved. Restart the host on the desktop to scan /r." });
  assert.deepEqual(afterSave({ ok: false, error: "That folder does not exist." }),
    { kind: "refused", text: "That folder does not exist." });
  assert.equal(afterSave({ ok: true, root: "/r", repos: 2 }).kind, "refused", "a check is not a save");
});

test("a check answers with the count or the host's own sentence", () => {
  assert.equal(checkWords({ ok: true, root: "/r", repos: 1 }), "/r · found 1 repo");
  assert.equal(checkWords({ ok: false, error: "Not a folder." }), "Not a folder.");
});
