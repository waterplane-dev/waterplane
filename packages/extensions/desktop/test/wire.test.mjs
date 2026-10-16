/**
 * The live desktop's wire (`shared/wire.mts`): what a phone may steer and send. Both cleaners run on
 * the HOST, so whatever arrives, the helper only ever sees clamped, known fields, and a malformed
 * click is dropped, never guessed into a click somewhere else.
 *
 *     node --test packages/extensions/desktop/test/wire.test.mjs   (after the host build)
 */
import { test } from "node:test";
import assert from "node:assert/strict";

const W = await import("../../../host/dist/extensions/desktop/shared/wire.mjs");

test("garbage in, the defaults out", () => {
  for (const raw of [null, 7, "x", [], {}]) assert.deepEqual(W.cleanDesktopParams(raw), W.DEFAULT_PARAMS);
});

test("numbers are clamped and rounded, unknown fields dropped", () => {
  const p = W.cleanDesktopParams({ fps: 999, bitrateKbps: 1, maxWidth: -5, jpegQuality: 55.6, evil: "rm -rf", codec: "vp9" });
  assert.equal(p.fps, 60);
  assert.equal(p.bitrateKbps, 50);
  assert.equal(p.maxWidth, 0);
  assert.equal(p.jpegQuality, 56);
  assert.equal(p.codec, "h264");
  assert.equal("evil" in p, false);
});

test("a crop is kept inside the source, and a whole-source or tiny crop is no crop", () => {
  assert.deepEqual(W.cleanDesktopParams({ crop: { x: 0.5, y: 0.5, w: 0.9, h: 0.25 } }).crop, { x: 0.5, y: 0.5, w: 0.5, h: 0.25 });
  assert.equal(W.cleanDesktopParams({ crop: { x: 0, y: 0, w: 1, h: 1 } }).crop, undefined);
  assert.equal(W.cleanDesktopParams({ crop: { x: 0.1, y: 0.1, w: 0.001, h: 0.5 } }).crop, undefined);
  assert.equal(W.cleanDesktopParams({ crop: { x: "0", y: 0, w: 1, h: 1 } }).crop, undefined);
});

test("sources: a window needs a positive id, anything else is a display", () => {
  assert.deepEqual(W.cleanDesktopParams({ source: { kind: "window", id: 42 } }).source, { kind: "window", id: 42 });
  assert.deepEqual(W.cleanDesktopParams({ source: { kind: "window" } }).source, { kind: "display" });
  assert.deepEqual(W.cleanDesktopParams({ source: { kind: "front" } }).source, { kind: "front" });
  assert.deepEqual(W.cleanDesktopParams({ source: { id: 3 } }).source, { kind: "display", id: 3 });
});

test("presets scale to the phone and keep the source and crop", () => {
  const base = W.cleanDesktopParams({ source: { kind: "window", id: 9 }, crop: { x: 0.1, y: 0.1, w: 0.5, h: 0.5 } });
  const saver = W.applyPreset(base, "saver", 1008);
  assert.equal(saver.maxWidth, 605);
  assert.equal(saver.fps, 8);
  assert.equal(saver.auto, false);
  assert.deepEqual(saver.source, base.source);
  assert.deepEqual(saver.crop, base.crop);
  assert.equal(W.applyPreset(base, "sharp", 1008).maxWidth, 0);
  assert.equal(W.applyPreset(base, "stills", 1008).codec, "jpeg");
  assert.equal(W.applyPreset(base, "nope", 1008), base);
});

test("input: valid events pass, malformed ones are dropped, never guessed", () => {
  assert.deepEqual(W.cleanDesktopInput({ k: "click", b: "l", x: 0.5, y: 0.25 }), { k: "click", b: "l", x: 0.5, y: 0.25, n: 1 });
  assert.deepEqual(W.cleanDesktopInput({ k: "click", b: "r", x: 1, y: 0, n: 2 }), { k: "click", b: "r", x: 1, y: 0, n: 2 });
  for (const bad of [
    { k: "click", b: "l", x: 1.2, y: 0.5 },
    { k: "click", x: 0.5, y: 0.5 },
    { k: "down", b: "x", x: 0.5, y: 0.5 },
    { k: "move", x: "0.5", y: 0.5 },
    { k: "scroll", x: 0.5, y: 0.5, dx: 0, dy: 0 },
    { k: "key", key: "rm -rf", mods: [] },
    { k: "text", s: "" },
    { k: "exec", cmd: "ls" },
    null,
  ]) assert.equal(W.cleanDesktopInput(bad), null, JSON.stringify(bad));
});

test("input: keys keep known modifiers only, text and scroll are capped", () => {
  assert.deepEqual(W.cleanDesktopInput({ k: "key", key: "c", mods: ["cmd", "hyper", "shift"] }), { k: "key", key: "c", mods: ["cmd", "shift"] });
  assert.deepEqual(W.cleanDesktopInput({ k: "key", key: "ArrowUp" }), { k: "key", key: "ArrowUp", mods: [] });
  assert.equal(W.cleanDesktopInput({ k: "text", s: "é".repeat(900) }).s.length, W.TEXT_MAX);
  assert.deepEqual(W.cleanDesktopInput({ k: "scroll", x: 0, y: 0, dx: 0, dy: -99999 }), { k: "scroll", x: 0, y: 0, dx: 0, dy: -W.SCROLL_MAX });
});
