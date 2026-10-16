/**
 * Which keys follow the phone and which the active host (`KEY_SCOPE`). A key
 * nobody classified would silently follow the wrong owner on a host switch —
 * one desktop's queue shown against another, or a setting chosen twice — so
 * every key in the registry must be classified, and the built ones too.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { BRAND, HOST_PARK_PREFIX, LEGACY, SYNCED_SETTING_KEYS, isHostScopedKey, parkedKeyFor } from "@waterplane/shared";

import { DEVICE_KEYS, HOST_KEY_PREFIXES, KEY_SCOPE, LS, TR_SEEN_PREFIX, isDeviceKey, trSeenKey } from "./storage.ts";
import { UI_RESET_KEYS } from "./resetKeys.ts";

test("every registry key is classified, and nothing else is", () => {
  assert.deepEqual(Object.keys(KEY_SCOPE).sort(), Object.keys(LS).sort());
  for (const [k, v] of Object.entries(KEY_SCOPE)) assert.ok(v === "device" || v === "host", `${k}: ${v}`);
});

test("every key value carries the brand's prefix and none sits in the parking namespace", () => {
  for (const v of Object.values(LS)) {
    assert.ok(v.startsWith(BRAND.storagePrefix), v);
    assert.ok(!v.startsWith(HOST_PARK_PREFIX), `${v} would read as a parked key`);
    for (const l of LEGACY) assert.ok(!v.startsWith(l.storagePrefix), `${v} is under a legacy prefix`);
  }
});

test("the brand migration's marks follow the phone — a parked mark would re-run the copy", () => {
  assert.ok(isDeviceKey(LS.brandMigrated));
  assert.ok(isDeviceKey(LS.brandStores));
});

test("every synced key follows the host — sync is per host, and so is its bookkeeping", () => {
  for (const k of SYNCED_SETTING_KEYS) assert.equal(isDeviceKey(k), false, k);
  assert.equal(isDeviceKey(LS.syncTs), false);
});

test("the plan's device keys are device keys", () => {
  const device = [
    "hosts", "hostActive", "hostBase", "deviceId", "deviceName", "theme", "textScale", "iconScale", "termZoom",
    "readerZoom", "scrollZoom", "gitZoom", "dataSaver", "netPulse", "localRtBar", "sessionTabs", "sessionTabsCount",
    "sessionTabsOrder", "dictateLang", "dictateLangs", "cliMode", "typingRoom", "readMode", "toolbarOpen",
    "closeBy", "closeKeepStar", "closeCustomH", "schedPctLeft", "collageGap", "collageLabels",
    "dismissInsecure", "dismissPhoneSetup", "dismissedUpdate", "lastForcedReload", "toastLog", "hostedAck",
    "giveups", "giveupsMigrated", "padRescue", "padRescueMigrated",
  ];
  for (const k of device) assert.ok(DEVICE_KEYS.has(LS[k]), k);
});

test("the plan's host keys — and every store of words in flight — are host keys", () => {
  const host = [
    "outbox", "compose", "composeDrafts", "composeOutbox", "composeSheets", "deadUploads", "dictations",
    "pendingStars", "pullState", "slashCache", "fileMtimes", "artMarks", "newImages", "syncTs", "cmdHistory",
    "sessionOrder", "collapsedRepos", "backlogDraft", "fanoutText", "sendMemory", "launchLast", "notifSeen",
    "costNoticed", "agentNoticed", "installLog", "localRt", "tabOpens", "routeLast", "routeResume", "usage",
    "netlog", "netTraffic", "netSync", "upKbps", "webUpdateStaged", "pad",
  ];
  for (const k of host) assert.equal(DEVICE_KEYS.has(LS[k]), false, k);
});

test("built keys follow the host and are parked like any other", () => {
  assert.ok(HOST_KEY_PREFIXES.includes(TR_SEEN_PREFIX));
  const k = trSeenKey("sess-1");
  assert.equal(isDeviceKey(k), false);
  assert.equal(isHostScopedKey(k, isDeviceKey), true);
  assert.equal(parkedKeyFor(k, "abcd1234"), `${HOST_PARK_PREFIX}abcd1234.trSeen.sess-1`);
});

test("an unregistered prefixed key is a host key (parked, never lost); a foreign key is nobody's", () => {
  assert.equal(isHostScopedKey(`${BRAND.storagePrefix}somethingOld`, isDeviceKey), true);
  assert.equal(isHostScopedKey("other.key", isDeviceKey), false);
  assert.equal(isHostScopedKey(`${HOST_PARK_PREFIX}abcd1234.outbox`, isDeviceKey), false);
  // An older brand's key is nobody's to a host switch: it is the migration's
  // source, left exactly where it is.
  for (const l of LEGACY) assert.equal(isHostScopedKey(`${l.storagePrefix}pad`, isDeviceKey), false);
});

test("the UI reset forgets only this device's look — never words, never a synced choice", () => {
  const synced = new Set(SYNCED_SETTING_KEYS);
  for (const k of UI_RESET_KEYS) {
    assert.equal(KEY_SCOPE[k], "device", k);
    assert.ok(!synced.has(LS[k]), k);
  }
  assert.equal(new Set(UI_RESET_KEYS).size, UI_RESET_KEYS.length);
});
