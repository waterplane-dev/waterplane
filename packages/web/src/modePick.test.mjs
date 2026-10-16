/**
 * The mode picker's rules, pinned without a browser (`modePick.ts`).
 *
 *     node --test packages/web/src/modePick.test.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  CYCLE_MODES, MODE_SWITCH_MS, RISKY_MODES, badgeMode, modeNow, modeNowText, modeRows, modeTap, modeTimeoutText,
  modedText, ultraCommand, ultraState, ultraText,
} from "./modePick.ts";
import { RISKY_PERM_MODES } from "./core/settings/permModes.ts";
import { CLAUDE_PERM_MODES } from "./backendCaps.ts";

const ALL = CLAUDE_PERM_MODES;

test("risky set is the Settings row's set — one list, not two", () => {
  assert.deepEqual([...RISKY_MODES].sort(), [...RISKY_PERM_MODES].sort());
});

test("rows: the shift+tab four, in the CLI's order", () => {
  assert.deepEqual(modeRows(ALL, {}).map((r) => r.mode), ["default", "acceptEdits", "plan", "auto"]);
  assert.deepEqual(modeRows(ALL, {}).map((r) => r.title), ["Manual", "Edit automatically", "Plan", "Auto"]);
  assert.deepEqual([...CYCLE_MODES], ["default", "acceptEdits", "plan", "auto"]);
});

test("rows: a no-approval mode only when the session is in it or launched in it", () => {
  assert.ok(!modeRows(ALL, { liveMode: "plan" }).some((r) => r.mode === "bypassPermissions"));
  assert.equal(modeRows(ALL, { liveMode: "bypassPermissions" }).at(-1).mode, "bypassPermissions");
  assert.equal(modeRows(ALL, { liveMode: "default", permissionMode: "bypassPermissions" }).at(-1).mode, "bypassPermissions");
  assert.equal(modeRows(ALL, { permissionMode: "dontAsk" }).at(-1).mode, "dontAsk");
  assert.ok(!modeRows(ALL, { permissionMode: "dontAsk" }).some((r) => r.mode === "bypassPermissions"));
});

test("rows: only what the backend lists; none for a backend with no modes", () => {
  assert.deepEqual(modeRows(["default", "plan"], {}).map((r) => r.mode), ["default", "plan"]);
  assert.deepEqual(modeRows([], { liveMode: "plan" }), []);
  // In it, but the backend does not list it: still not offered.
  assert.deepEqual(modeRows(["default"], { liveMode: "bypassPermissions" }).map((r) => r.mode), ["default"]);
});

test("every row has a title, a one-line description and an icon", () => {
  for (const r of modeRows(ALL, { liveMode: "bypassPermissions", permissionMode: "dontAsk" })) {
    assert.ok(r.title && r.desc && r.icon, r.mode);
    assert.ok(!r.desc.includes("\n"), r.mode);
  }
});

test("now: footer first, launch value second and SAID to be one, else unknown", () => {
  assert.deepEqual(modeNow({ liveMode: "plan", permissionMode: "default" }), { mode: "plan", source: "live" });
  assert.deepEqual(modeNow({ permissionMode: "acceptEdits" }), { mode: "acceptEdits", source: "launch" });
  assert.deepEqual(modeNow({}), { mode: null, source: "unknown" });
  assert.match(modeNowText(modeNow({ liveMode: "auto" })), /^Now: Auto/);
  const launch = modeNowText(modeNow({ permissionMode: "plan" }));
  assert.match(launch, /Launched in Plan/);
  assert.match(launch, /may have changed/);
  assert.match(modeNowText(modeNow({})), /not known/);
});

test("tap: the live mode is a no-op, a launch value is re-sent, risky asks first", () => {
  assert.equal(modeTap("plan", modeNow({ liveMode: "plan" })).kind, "none");
  assert.equal(modeTap("plan", modeNow({ permissionMode: "plan" })).kind, "send");
  assert.equal(modeTap("auto", modeNow({ liveMode: "plan" })).kind, "send");
  assert.equal(modeTap("bypassPermissions", modeNow({ liveMode: "default", permissionMode: "bypassPermissions" })).kind, "confirm");
  assert.equal(modeTap("dontAsk", modeNow({})).kind, "confirm");
  // Already in it: nothing to arm, so no confirm either.
  assert.equal(modeTap("bypassPermissions", modeNow({ liveMode: "bypassPermissions" })).kind, "none");
});

test("reply: the host's reason wins; success names the mode; no mode is said", () => {
  assert.equal(modedText({ mode: "default", reason: "plan is not in this session's cycle" }), "plan is not in this session's cycle");
  assert.equal(modedText({ mode: "plan" }), "now in Plan");
  assert.match(modedText({}), /could not read/);
  assert.match(modeTimeoutText("auto"), /did not answer the switch to Auto/);
  assert.ok(MODE_SWITCH_MS >= 5000 && MODE_SWITCH_MS <= 15000);
});

test("badge: the footer's mode only, and never for Manual", () => {
  assert.equal(badgeMode({ liveMode: "auto" }), "auto");
  assert.equal(badgeMode({ liveMode: "default" }), null);
  assert.equal(badgeMode({}), null);
  // A launch value is not drawn on a badge that cannot say it is one.
  assert.equal(badgeMode({ permissionMode: "plan" }), null);
});

test("ultracode: absent is unknown, never off", () => {
  assert.equal(ultraState(undefined), "unknown");
  assert.equal(ultraState(false), "off");
  assert.equal(ultraState(true), "on");
  assert.match(ultraText(undefined), /not known/);
  assert.doesNotMatch(ultraText(undefined), /^off/);
  assert.equal(ultraCommand(true), "/effort ultracode on");
  assert.equal(ultraCommand(false), "/effort ultracode off");
});
