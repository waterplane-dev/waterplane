/**
 * The live desktop's other pure halves: sticky modifiers and typed text (`keys.ts`), the Quality
 * choice and the params it means (`quality.ts`), what a view has cost and the data cap
 * (`stats.ts`), and every "cannot" sentence (`words.ts`).
 *
 *     node --test packages/extensions/desktop/web/logic.test.mjs
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { CONTROL_SETTING_PATH, CONTROL_SWITCH, PRESETS, TEXT_MAX, cleanDesktopInput } from "../shared/wire.mts";
import { SETTING_GROUPS, SETTING_ROWS } from "../../../web/src/settingsIndex.ts";
import { ROW_KEYS, cleanDraft, keyboardEvent, pressKey,rowKeyEvent, textEvents, toggleMod } from "./keys.ts";
import { DEFAULT_CHOICE, FORCED_JPEG_FPS, cleanChoice, connectionType, fmtKbps, paramsFor, presetLine, startPreset } from "./quality.ts";
import { addFrame, addInputs, addLatency, chipText, detailLines, latencyMs, newMeter, overCap, totalBytes } from "./stats.ts";
import { ASK_ACCESS, GRANT_SCREEN, NOT_SERVING, REPLACED_LINE, TAKE_BACK, TURN_ON, availability, entryAvailability, controlBlock, controlSteps, stepsHead, noVideoSentence, partialSendLine, reopensBySelf, sentReceipt, shotReceipt, SHOT, SHOT_NO_REPO, SHOT_TITLE, streamLine, captureStopped, goneDisplay } from "./words.ts";

// ── keys ────────────────────────────────────────────────────────────────────

test("sticky modifiers apply to the next key, in a fixed order, then clear", () => {
  let held = toggleMod([], "shift");
  held = toggleMod(held, "cmd");
  assert.deepEqual(held, ["cmd", "shift"]);
  assert.deepEqual(toggleMod(held, "cmd"), ["shift"]);
  const r = pressKey(held, "s");
  assert.deepEqual(r.ev, { k: "key", key: "s", mods: ["cmd", "shift"] });
  assert.deepEqual(r.held, []);
});

test("the key row's ^C is Control-C, and a held modifier adds to it", () => {
  const ctrlc = ROW_KEYS.find((k) => k.id === "ctrlc");
  assert.deepEqual(rowKeyEvent([], ctrlc), { k: "key", key: "c", mods: ["ctrl"] });
  assert.deepEqual(rowKeyEvent(["shift"], ctrlc), { k: "key", key: "c", mods: ["ctrl", "shift"] });
  // every row key is one the host accepts
  for (const k of ROW_KEYS) assert.ok(cleanDesktopInput(rowKeyEvent([], k)), k.id);
});

test("typed text goes in chunks of at most TEXT_MAX code points, a line break as its own Return", () => {
  assert.deepEqual(textEvents("hi\nthere"), [
    { k: "text", s: "hi" }, { k: "key", key: "Return", mods: [] }, { k: "text", s: "there" },
  ]);
  assert.deepEqual(textEvents("a\r\n\nb"), [
    { k: "text", s: "a" }, { k: "key", key: "Return", mods: [] }, { k: "key", key: "Return", mods: [] }, { k: "text", s: "b" },
  ]);
  const long = "😀".repeat(TEXT_MAX + 3);
  const evs = textEvents(long);
  assert.equal(evs.length, 2);
  assert.equal([...evs[0].s].length, TEXT_MAX);
  assert.equal(evs[1].s, "😀😀😀"); // never a split surrogate pair
  for (const e of evs) assert.deepEqual(cleanDesktopInput(e), e);
  assert.deepEqual(textEvents(""), []);
});

test("one character typed with a modifier held is that key with it (⌘ + s), not text", () => {
  assert.deepEqual(textEvents("s", ["cmd"]), [{ k: "key", key: "s", mods: ["cmd"] }]);
  assert.deepEqual(textEvents("so", ["cmd"]), [{ k: "text", s: "so" }]);
});

// ── quality ─────────────────────────────────────────────────────────────────

test("a stored choice is cleaned whole: junk, an older shape and nothing all read as a usable choice", () => {
  assert.deepEqual(cleanChoice(null), DEFAULT_CHOICE);
  assert.deepEqual(cleanChoice("garbage"), DEFAULT_CHOICE);
  const c = cleanChoice({ preset: "nope", custom: { fps: 999, res: "huge", codec: "jpeg" }, source: { kind: "window", id: 42 }, capMb: -5, mode: "trackpad" });
  assert.equal(c.preset, "auto");
  assert.equal(c.custom.fps, 60);
  assert.equal(c.custom.res, "fit");
  assert.equal(c.custom.codec, "jpeg");
  assert.deepEqual(c.source, { kind: "window", id: 42 });
  assert.equal(c.capMb, 0);
  assert.equal(c.mode, "trackpad");
  assert.equal(cleanChoice({ preset: "custom" }).preset, "custom");
});

test("a preset sets what the wire's table says, at the phone's width; the source is kept", () => {
  const choice = { ...DEFAULT_CHOICE, preset: "saver", source: { kind: "display", id: 2 } };
  const p = paramsFor(choice, { phonePx: 1000, crop: null, forceJpeg: false });
  assert.equal(p.fps, 8);
  assert.equal(p.bitrateKbps, 150);
  assert.equal(p.maxWidth, 600);
  assert.deepEqual(p.source, { kind: "display", id: 2 });
  assert.equal(p.crop, undefined);
  assert.equal(paramsFor({ ...DEFAULT_CHOICE, preset: "sharp" }, { phonePx: 1000, crop: null, forceJpeg: false }).maxWidth, 0);
});

test("custom knobs: resolution as a fraction of the phone, grayscale only in JPEG", () => {
  const custom = { ...DEFAULT_CHOICE.custom, res: "half", fps: 5, bitrateKbps: 300, grayscale: true };
  const h = paramsFor({ ...DEFAULT_CHOICE, preset: "custom", custom }, { phonePx: 1200, crop: null, forceJpeg: false });
  assert.equal(h.maxWidth, 600);
  assert.equal(h.grayscale, false); // h264
  assert.equal(h.auto, false);
  const j = paramsFor({ ...DEFAULT_CHOICE, preset: "custom", custom: { ...custom, codec: "jpeg", res: "native" } }, { phonePx: 1200, crop: null, forceJpeg: false });
  assert.equal(j.grayscale, true);
  assert.equal(j.maxWidth, 0);
});

test("Crop to view streams the visible rect at the phone's own width; off, it never crops", () => {
  const crop = { x: 0.25, y: 0.1, w: 0.25, h: 0.3 };
  const on = paramsFor({ ...DEFAULT_CHOICE, preset: "sharp" }, { phonePx: 1170, crop, forceJpeg: false });
  assert.deepEqual(on.crop, crop);
  assert.equal(on.maxWidth, 1170);
  const off = paramsFor({ ...DEFAULT_CHOICE, cropToView: false }, { phonePx: 1170, crop, forceJpeg: false });
  assert.equal(off.crop, undefined);
});

test("no video decoder: JPEG whatever was chosen, and not 30 whole pictures a second", () => {
  const p = paramsFor(DEFAULT_CHOICE, { phonePx: 1000, crop: null, forceJpeg: true });
  assert.equal(p.codec, "jpeg");
  assert.equal(p.fps, FORCED_JPEG_FPS);
  const stills = paramsFor({ ...DEFAULT_CHOICE, preset: "stills" }, { phonePx: 1000, crop: null, forceJpeg: true });
  assert.equal(stills.fps, 2);
});

test("cellular start: Data saver for this view, said, unless the choice is already that frugal or the setting is off", () => {
  const s = startPreset(DEFAULT_CHOICE, true);
  assert.equal(s.override, "saver");
  assert.match(s.note, /cellular.*Data saver.*instead of Auto/);
  assert.deepEqual(startPreset(DEFAULT_CHOICE, false), { note: null });
  assert.deepEqual(startPreset({ ...DEFAULT_CHOICE, cellularSaver: false }, true), { note: null });
  assert.deepEqual(startPreset({ ...DEFAULT_CHOICE, preset: "stills" }, true), { note: null });
  const p = paramsFor(DEFAULT_CHOICE, { phonePx: 1000, crop: null, forceJpeg: false, presetOverride: s.override });
  assert.equal(p.bitrateKbps, PRESETS.find((x) => x.id === "saver").set.bitrateKbps);
  assert.equal(connectionType({ connection: { type: "cellular" } }), "cellular");
  assert.equal(connectionType({}), null);
});

test("the current preset's line says what it measures live, and never invents a number", () => {
  assert.equal(presetLine("15 fps", false, 900), "15 fps");
  assert.equal(presetLine("15 fps", true, null), "15 fps · now: measuring…");
  assert.equal(presetLine("15 fps", true, 812.4), "15 fps · now: 812 kbit/s");
  assert.equal(fmtKbps(2400), "2.4 Mbit/s");
});

// ── stats ───────────────────────────────────────────────────────────────────

test("the meter splits video from keyframes and counts input apart", () => {
  let m = newMeter();
  m = addFrame(m, 50_000, true);
  m = addFrame(m, 2_000, false);
  m = addFrame(m, 3_000, false);
  m = addInputs(m, 4);
  assert.equal(totalBytes(m), 55_000);
  assert.equal(m.keyBytes, 50_000);
  assert.equal(m.videoBytes, 5_000);
  assert.equal(m.frames, 3);
  assert.equal(m.keyframes, 1);
  const lines = detailLines(m, { width: 1170, height: 731, codec: "h264", bitrateKbps: 2100, auto: true });
  assert.match(lines[0], /video 0\.0 MB, keyframes 0\.1 MB \(1 of 3 frames\)/);
  assert.equal(lines[1], "sent up: 4 input events");
  assert.equal(lines[2], "picture: 1170×731 H.264");
  assert.equal(lines[3], "Auto is at: 2100 kbit/s");
});

test("latency is the median of what was measured, and '—' until something was", () => {
  let m = newMeter();
  assert.equal(latencyMs(m), null);
  assert.equal(chipText(812.3, 14.6, m), "812 kbps · 15 fps · — ms · 0.0 MB");
  for (const v of [10, 30, 20, -5, Number.NaN]) m = addLatency(m, v);
  assert.equal(latencyMs(m), 20);
  for (let i = 0; i < 100; i++) m = addLatency(m, 5);
  assert.equal(m.lat.length, 30);
  assert.equal(latencyMs(m), 5);
});

test("the data cap: off by default, reached at N MB, and a Resume grants another N", () => {
  let m = newMeter();
  m = addFrame(m, 4_000_000, true);
  assert.equal(overCap(m, 0), false);
  assert.equal(overCap(m, 5), false);
  m = addFrame(m, 1_000_000, false);
  assert.equal(overCap(m, 5), true);
  assert.equal(overCap(m, 5, totalBytes(m)), false);
});

// ── words ───────────────────────────────────────────────────────────────────

const probe = (r) => ({ k: "ok", at: 1, r: { available: true, screenRecording: true, accessibility: true, controlEnabled: false, displays: [], ...r } });

test("entryAvailability: a missing Screen Recording grant opens the view (its button asks); the rest stays a sentence", () => {
  assert.equal(entryAvailability(probe({ screenRecording: false })), true);
  assert.equal(entryAvailability({ k: "failed", error: "unknown plugin", at: 1 }), NOT_SERVING);
  assert.match(entryAvailability(probe({ available: false })), /Mac/);
});

test("availability: unknown is available; a failed probe, a missing helper or permission is a sentence", () => {
  assert.equal(availability({ k: "unknown" }), true);
  assert.equal(availability({ k: "failed", error: "unknown plugin", at: 1 }), NOT_SERVING);
  assert.equal(availability(probe({})), true);
  assert.equal(availability(probe({ available: false, reason: "Live desktop needs macOS for now" })), "Live desktop needs macOS for now");
  assert.match(availability(probe({ available: false })), /Mac/);
  assert.equal(availability(probe({ screenRecording: false })), GRANT_SCREEN);
  assert.match(GRANT_SCREEN, /System Settings → Privacy & Security/);
  // Screen Recording unknown (null) is not a refusal: the view will say what the host answers.
  assert.equal(availability(probe({ screenRecording: null })), true);
});

test("no video says why, and how to get it", () => {
  assert.match(noVideoSentence(false), /not a secure context.*stills.*https/);
  assert.match(noVideoSentence(true), /H\.264/);
});

test("control steps: each closed gate its own sentence and button; none when on, in View only, or unnamed", () => {
  const both = { state: "running", control: { on: false, reason: "x", needs: ["setting", "accessibility"] } };
  const steps = controlSteps("touch", both);
  assert.deepEqual(steps.map((s) => [s.need, s.button]), [["setting", TURN_ON], ["accessibility", ASK_ACCESS]]);
  assert.ok(steps[0].text.includes(CONTROL_SWITCH) && steps[0].text.includes(TURN_ON), steps[0].text);
  // The Accessibility step says the dialog alone grants nothing, and that the phone cannot flip it.
  assert.match(steps[1].text, /Privacy & Security → Accessibility/);
  assert.match(steps[1].text, /grants nothing/);
  assert.match(steps[1].text, /cannot flip it/);
  assert.match(stepsHead(2), /^2 things stop/);
  assert.match(stepsHead(1), /^One thing stops/);
  assert.deepEqual(controlSteps("touch", { state: "running", control: { on: false, needs: ["accessibility"] } }).map((s) => s.need), ["accessibility"]);
  assert.deepEqual(controlSteps("view", both), []);
  assert.deepEqual(controlSteps("touch", { state: "running", control: { on: true } }), []);
  // An older host names no gate: no button, the sentence (controlBlock) still says it.
  assert.deepEqual(controlSteps("touch", { state: "running", control: { on: false, reason: "x" } }), []);
  assert.deepEqual(controlSteps("touch", null), []);
});

test("control blocked: View only and a host with control off each say why; on, nothing is said", () => {
  assert.match(controlBlock("view", null), /^View only/);
  // The host's sentence is shown as it is: it already says "Control is off:" itself, so the phone adds nothing in front.
  const off = { state: "running", control: { on: false, reason: "Control is off: the phone can watch but not click. Turn on it in the setting." } };
  assert.equal(controlBlock("touch", off), "Control is off: the phone can watch but not click. Turn on it in the setting. Zoom and pan still work; nothing is sent.");
  const ax = { state: "running", control: { on: false, reason: "Control needs Accessibility for wp-desktop." } };
  assert.equal(controlBlock("touch", ax), "Control needs Accessibility for wp-desktop. Zoom and pan still work; nothing is sent.");
  // No sentence from the host at all: the phone's own fallback says it once.
  const none = controlBlock("trackpad", { state: "running", control: { on: false } });
  assert.ok(none.includes(`turn on "${CONTROL_SWITCH}" in ${CONTROL_SETTING_PATH}.`));
  assert.equal(none.match(/control is off/gi).length, 1, none);
  assert.equal(controlBlock("touch", { state: "running", control: { on: true } }), null);
  assert.equal(controlBlock("touch", null), null);
});

test("a typing receipt claims what the phone knows — sent, never typed or reached", () => {
  assert.equal(sentReceipt(false), "Sent to the desktop.");
  assert.equal(sentReceipt(true), "Sent to the desktop, then Return.");
  assert.equal(partialSendLine(2, 5), "Only part of it was sent to the desktop (2 of 5) — the link dropped.");
  assert.equal(partialSendLine(0, 5), "Not sent — the link dropped.");
  for (const s of [sentReceipt(false), sentReceipt(true), partialSendLine(2, 5)]) assert.doesNotMatch(s, /typed|reached/i, s);
});

test("a stored typing draft comes back word for word; anything else is an empty box", () => {
  assert.deepEqual(cleanDraft("  half a sentence\n"), ["  half a sentence\n"], "never trimmed: these are somebody's words");
  for (const v of [null, undefined, 3, ["x"], { t: "x" }]) assert.deepEqual(cleanDraft(v), [""]);
  const src = readFileSync(new URL("./state.ts", import.meta.url), "utf8");
  assert.match(src, /createStore<string\[\]>\(cleanDraft\(store\.read\("draft", null\)\)\)/, "the draft is seeded from extStorage");
  const panel = readFileSync(new URL("./TypePanel.tsx", import.meta.url), "utf8");
  assert.doesNotMatch(panel, /draft\.set\(/, "the panel writes through setDraft only, so the stored copy moves with it");
});

test("the control switch's path names every step as the phone draws it", () => {
  const [settings, group, row, section] = CONTROL_SETTING_PATH.split(" › ");
  assert.equal(settings, "Settings");
  const g = SETTING_GROUPS.find((x) => x.title === group);
  assert.ok(g, `a settings group titled "${group}"`);
  const r = SETTING_ROWS.find((x) => x.id === "plugins");
  assert.equal(r?.group, g.id, "the plugins row sits in that group");
  assert.equal(r.label, row);
  const manifest = JSON.parse(readFileSync(new URL("../waterplane-plugin.json", import.meta.url), "utf8"));
  assert.equal(manifest.name, section, "the plugin's section is headed by its manifest name");
  assert.equal(manifest.optional, true, "an optional builtin is listed under plugins (a non-optional one is not)");
  assert.equal(manifest.settings.find((s) => s.key === "control")?.label, CONTROL_SWITCH);
});

test("the stream's own state, in words", () => {
  assert.match(streamLine("opening", undefined, true), /Asking the desktop/);
  assert.match(streamLine("opening", undefined, false), /No connection/);
  assert.equal(streamLine("ended", "the helper exited", true), "The live view ended: the helper exited.");
  assert.match(streamLine("refused", undefined, true), /did not open.*no reason given/);
  assert.equal(streamLine("open", undefined, true), null);
  assert.equal(streamLine("ended", "The live view was opened on another screen.", true, "replaced"), REPLACED_LINE);
  assert.match(REPLACED_LINE, new RegExp(`tap ${TAKE_BACK} `), "names the button as drawn");
  assert.equal(streamLine("ended", "x", true, "plugin"), "The live view ended: x.");
  assert.equal(reopensBySelf("replaced"), false, "two phones must not take the view from each other for ever");
  for (const c of [undefined, "plugin", "error", "refused", "closed", "socket"]) assert.equal(reopensBySelf(c), true, String(c));
});

test("a hardware key: a character is text, a chord is a key off its code, a modifier alone is nothing", () => {
  const k = (key, code, m = {}) => ({ key, code, metaKey: false, altKey: false, ctrlKey: false, shiftKey: false, ...m });
  assert.deepEqual(keyboardEvent(k("a", "KeyA")), { k: "text", s: "a" });
  assert.deepEqual(keyboardEvent(k("A", "KeyA", { shiftKey: true })), { k: "text", s: "A" });
  assert.deepEqual(keyboardEvent(k("ß", "KeyS", { altKey: true })), { k: "key", key: "s", mods: ["alt"] });
  assert.deepEqual(keyboardEvent(k("s", "KeyS", { metaKey: true })), { k: "key", key: "s", mods: ["cmd"] });
  assert.deepEqual(keyboardEvent(k("1", "Digit1", { ctrlKey: true })), { k: "key", key: "1", mods: ["ctrl"] });
  assert.deepEqual(keyboardEvent(k("Enter", "Enter")), { k: "key", key: "Return", mods: [] });
  assert.deepEqual(keyboardEvent(k("Tab", "Tab", { shiftKey: true })), { k: "key", key: "Tab", mods: ["shift"] });
  assert.deepEqual(keyboardEvent(k("ArrowLeft", "ArrowLeft"), ["cmd"]), { k: "key", key: "ArrowLeft", mods: ["cmd"] });
  assert.equal(keyboardEvent(k("Shift", "ShiftLeft", { shiftKey: true })), null);
  assert.equal(keyboardEvent(k("Dead", "BracketLeft")), null);
  assert.equal(keyboardEvent({ ...k("a", "KeyA"), isComposing: true }), null);
});

test("the screenshot's receipt names the file by its full path, or says why there is none", () => {
  const ok = shotReceipt({ file: { relPath: ".claude/outbox/screenshot-2026-10-15-19-57-45.png" } }, "myapp");
  assert.equal(ok, "Screenshot saved to myapp/.claude/outbox/screenshot-2026-10-15-19-57-45.png — full resolution, in the gallery.");
  assert.equal(shotReceipt({ error: "screenshot unsupported on linux" }, "myapp"), "No screenshot: screenshot unsupported on linux.");
  assert.equal(shotReceipt({ error: "unknown repo." }, "myapp"), "No screenshot: unknown repo.", "one full stop");
  assert.equal(shotReceipt({ error: "  " }, "myapp"), "No screenshot: no reason given.");
  assert.match(SHOT_NO_REPO, /\.claude\/outbox\//, "says where it would have gone");
  assert.ok(SHOT_TITLE.startsWith(SHOT), "the title opens with the word drawn on the button");
});

test("capture-stopped line: one full stop, whatever the helper ended with", () => {
  assert.equal(captureStopped("Display 4 is not active on the Mac."), "The desktop's capture stopped: Display 4 is not active on the Mac.");
  assert.equal(captureStopped("stream ended"), "The desktop's capture stopped: stream ended.");
  assert.equal(captureStopped(undefined), "The desktop's capture stopped: no reason given.");
});

test("a saved display the desktop no longer lists is named gone; unknown is not gone", () => {
  const ok = (ids) => ({ k: "ok", at: 0, r: { available: true, screenRecording: true, accessibility: true, controlEnabled: true, displays: ids.map((id, i) => ({ id, width: 1, height: 1, main: i === 0 })) } });
  assert.match(goneDisplay({ kind: "display", id: 4 }, ok([3])), /not on the desktop any more.*one display now/);
  assert.equal(goneDisplay({ kind: "display", id: 3 }, ok([3])), null);
  assert.equal(goneDisplay({ kind: "display" }, ok([3])), null, "the main display is never stale");
  assert.equal(goneDisplay({ kind: "display", id: 4 }, ok([])), null, "no list ⇒ unknown, not gone");
  assert.equal(goneDisplay({ kind: "display", id: 4 }, { k: "unknown" }), null);
  assert.equal(goneDisplay({ kind: "front" }, ok([3])), null);
});
