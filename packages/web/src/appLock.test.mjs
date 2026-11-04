/**
 * The app lock's decisions. The one that matters: it fails CLOSED. A refusal
 * opens the app only where someone holding the phone could not have caused it.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  APP_LOCK_ALIAS, APP_LOCK_GRACE_MS, APP_LOCK_WAY_BACK, NO_KEYSTORE_WORDS, UNLOCK_PROMPT,
  lockBody, lockOnStart, lockRowCant, lockRowNote, lockRowRefusal, lockVerdict, lockWords, needsReread, pickLockPath, shouldLockOnWake,
} from "./appLock.ts";

const fn = () => {};
const OPENS = ["keyInvalidated", "noKey", "badInput"];
const STAYS = ["cancelled", "lockout", "busy", "failed", "unavailable", "exists", "plainRoute", "somethingNew", ""];

test("the path follows what the shell has, never its version", () => {
  assert.equal(pickLockPath({ authenticate: fn, wrap: fn }), "authenticate");
  assert.equal(pickLockPath({ wrap: fn }), "sentinel");
  assert.equal(pickLockPath({}), null);
  assert.equal(pickLockPath(undefined), null);
  assert.equal(pickLockPath(null), null);
  assert.equal(pickLockPath({ authenticate: true, wrap: "no" }), null);
});

test("it locks on start only with the switch on and a way to ask", () => {
  assert.equal(lockOnStart(true, "sentinel"), true);
  assert.equal(lockOnStart(true, "authenticate"), true);
  assert.equal(lockOnStart(true, null), false);
  assert.equal(lockOnStart(false, "authenticate"), false);
});

test("waking locks only past the grace", () => {
  const t = 1_000_000;
  assert.equal(shouldLockOnWake(null, t), false);
  assert.equal(shouldLockOnWake(t - APP_LOCK_GRACE_MS + 1, t), false);
  assert.equal(shouldLockOnWake(t - APP_LOCK_GRACE_MS, t), false);
  assert.equal(shouldLockOnWake(t - APP_LOCK_GRACE_MS - 1, t), true);
});

test("a key or blob only the owner could have changed opens, with or without a status read", () => {
  for (const c of OPENS) {
    assert.equal(lockVerdict(c), "open-and-off", c);
    assert.equal(lockVerdict(c, null), "open-and-off", c);
  }
});

test("failed never opens at any repeat count, whatever the status says", () => {
  for (let i = 0; i < 50; i++) assert.equal(lockVerdict("failed"), "stay");
  assert.equal(lockVerdict("failed", { source: "status", hardware: true, enrolled: false }), "stay");
  assert.equal(lockVerdict("failed", { source: "lockStatus", hardware: false, enrolled: false, screenLock: false }), "stay");
});

test("every other code stays, an unknown one included", () => {
  for (const c of STAYS) {
    assert.equal(lockVerdict(c), "stay", c);
    assert.equal(lockVerdict(c, { source: "lockStatus", hardware: false, enrolled: false, screenLock: false }), "stay", c);
  }
});

test("noHardware and noneEnrolled are the only codes that ask for a fresh read", () => {
  assert.equal(needsReread("noHardware"), true);
  assert.equal(needsReread("noneEnrolled"), true);
  for (const c of [...OPENS, ...STAYS]) assert.equal(needsReread(c), false, c);
});

const fresh = (hardware, enrolled, screenLock) => ({ source: "lockStatus", hardware, enrolled, screenLock });
const old = (hardware, enrolled) => ({ source: "status", hardware, enrolled });

for (const code of ["noHardware", "noneEnrolled"]) {
  test(`${code} stays when the read threw or is missing`, () => {
    assert.equal(lockVerdict(code), "stay");
    assert.equal(lockVerdict(code, null), "stay");
  });

  test(`${code} on a new shell opens only on a confirming lockStatus`, () => {
    assert.equal(lockVerdict(code, fresh(false, false, true)), "open-and-off");
    assert.equal(lockVerdict(code, fresh(false, true, true)), "open-and-off");
    assert.equal(lockVerdict(code, fresh(true, false, false)), "open-and-off");
  });

  test(`${code} on a new shell: enrolled false alone proves nothing`, () => {
    assert.equal(lockVerdict(code, fresh(true, false, true)), "stay");
    assert.equal(lockVerdict(code, fresh(true, true, false)), "stay");
    assert.equal(lockVerdict(code, fresh(true, true, true)), "stay");
  });

  test(`${code} stays on a field that is not a boolean`, () => {
    assert.equal(lockVerdict(code, { source: "lockStatus" }), "stay");
    assert.equal(lockVerdict(code, { source: "status" }), "stay");
    assert.equal(lockVerdict(code, {}), "stay");
  });
}

test("old APK: noHardware always stays, status() cannot tell a gone sensor from a transient one", () => {
  for (const h of [true, false]) for (const e of [true, false]) assert.equal(lockVerdict("noHardware", old(h, e)), "stay");
});

test("old APK: noneEnrolled opens only with hardware true and enrolled false", () => {
  assert.equal(lockVerdict("noneEnrolled", old(true, false)), "open-and-off");
  assert.equal(lockVerdict("noneEnrolled", old(false, false)), "stay");
  assert.equal(lockVerdict("noneEnrolled", old(true, true)), "stay");
  assert.equal(lockVerdict("noneEnrolled", old(false, true)), "stay");
});

const OPEN_WORDS = [...OPENS, "noHardware", "noneEnrolled"];
const allWords = () => {
  const out = [NO_KEYSTORE_WORDS, lockBody("sentinel"), lockBody("authenticate"), UNLOCK_PROMPT.title];
  for (const path of ["sentinel", "authenticate"]) {
    for (const c of OPEN_WORDS) out.push(lockWords(c, path, "open-and-off"));
    for (const c of [...STAYS, "noHardware", "noneEnrolled"]) out.push(lockWords(c, path, "stay", "the sheet broke"));
  }
  return out;
};

test("every open-and-off sentence names the way back; no stay sentence does", () => {
  for (const path of ["sentinel", "authenticate"]) {
    for (const c of OPEN_WORDS) assert.ok(lockWords(c, path, "open-and-off").includes(APP_LOCK_WAY_BACK), c);
    for (const c of [...STAYS, "noHardware", "noneEnrolled"]) {
      assert.ok(!lockWords(c, path, "stay", "x").includes("Settings ›"), c);
    }
  }
});

test("the sentence follows the verdict, so a refused noHardware never claims the lock went off", () => {
  assert.doesNotMatch(lockWords("noHardware", "sentinel", "stay"), /switched off/);
  assert.match(lockWords("noHardware", "sentinel", "open-and-off"), /switched off/);
});

test("failed keeps the shell's words and asks for another tap", () => {
  assert.equal(lockWords("failed", "sentinel", "stay", "the sheet broke."), "the sheet broke. Tap unlock to try again.");
  assert.equal(lockWords("failed", "sentinel", "stay", "the sheet broke"), "the sheet broke. Tap unlock to try again.");
  assert.equal(lockWords("somethingNew", "sentinel", "stay", "odd"), "odd. Tap unlock to try again.");
});

test("failed with no message of its own never prints the bare code", () => {
  for (const m of [undefined, "", "failed"]) {
    assert.equal(lockWords("failed", "sentinel", "stay", m), "The fingerprint sheet could not be shown. Tap unlock to try again.");
  }
});

test("a sealed fingerprint on a plain route stays, and says how to get out from behind the card", () => {
  assert.equal(lockVerdict("plainRoute"), "stay");
  assert.match(lockWords("plainRoute", "sentinel", "stay", "see Network health"), /Leave this Wi-Fi/);
  assert.doesNotMatch(lockWords("plainRoute", "sentinel", "stay", "see Network health"), /Network health/); // unreachable from here
});

test("the PIN is promised only on the path whose sheet offers it", () => {
  assert.match(lockBody("authenticate"), /PIN/);
  assert.doesNotMatch(lockBody("sentinel"), /PIN/);
  assert.match(lockWords("noHardware", "authenticate", "stay"), /PIN/);
  assert.doesNotMatch(lockWords("noHardware", "sentinel", "stay"), /PIN/);
});

test("the alias is the lock's own", () => {
  assert.match(APP_LOCK_ALIAS, /\.applock$/);
});

test("no sentence trips the host's banner detector", () => {
  const src = readFileSync(new URL("../../host/src/limit.ts", import.meta.url), "utf8");
  const patterns = [...src.matchAll(/^(?:const \w+ = |export const \w+ = |\s+)\/(.+)\/i[,;]/gm)].map((m) => new RegExp(m[1], "i"));
  assert.ok(patterns.length >= 8, `read ${patterns.length} patterns from limit.ts`);
  for (const s of allWords()) for (const re of patterns) assert.doesNotMatch(s, re);
});

test("the settings row says why it cannot be turned on, in a sentence", () => {
  assert.match(lockRowCant(null, false, null), /newer Android app/);
  assert.match(lockRowCant("sentinel", true, null), /not protected/);
  assert.match(lockRowCant("sentinel", true, null), /update the Android app/);
  assert.equal(lockRowCant("authenticate", true, null), null); // authenticate uses no key: a plain route does not matter
  assert.match(lockRowCant("sentinel", false, { source: "status", hardware: false, enrolled: false, strongBox: false }), /no fingerprint sensor/);
  assert.match(lockRowCant("sentinel", false, { source: "status", hardware: true, enrolled: false }), /add a fingerprint/);
  assert.equal(lockRowCant("sentinel", false, { source: "status", hardware: true, enrolled: true }), null);
  assert.match(lockRowCant("authenticate", false, { source: "lockStatus", hardware: false, enrolled: false, screenLock: false }), /screen lock/);
  assert.equal(lockRowCant("authenticate", false, { source: "lockStatus", hardware: false, enrolled: false, screenLock: true }), null); // the PIN works
  assert.equal(lockRowCant("sentinel", false, null), null); // unread: the sheet will say
});

test("the row's note mentions the PIN only on the shell that has it", () => {
  assert.match(lockRowNote("authenticate"), /PIN works too/);
  assert.doesNotMatch(lockRowNote("sentinel"), /PIN/);
});

test("a refused switch says which way it did not go", () => {
  assert.equal(lockRowRefusal("cancelled", true), "not turned on — the prompt was dismissed");
  assert.equal(lockRowRefusal("cancelled", false), "not turned off — the prompt was dismissed");
  assert.match(lockRowRefusal("failed", true, "Sensor busy."), /^not turned on — Sensor busy$/);
  assert.match(lockRowRefusal("plainRoute", false), /not protected/);
  assert.match(lockRowRefusal("plainRoute", false), /leave this Wi-Fi/);
  assert.doesNotMatch(lockRowRefusal("plainRoute", false, "", true), /leave this Wi-Fi/);
  assert.match(lockRowRefusal("plainRoute", true, "", true), /^not turned on — .*update the Android app, or clear this app's data$/);
  assert.doesNotMatch(lockWords("plainRoute", "sentinel", "stay", "", true), /Leave this Wi-Fi|tap unlock/);
  assert.match(lockWords("plainRoute", "sentinel", "stay", "", true), /Update the Android app, or clear this app's data\.$/);
  assert.doesNotMatch(lockRowCant("sentinel", true, null, true), /Leave this Wi-Fi/);
  assert.match(lockRowCant("sentinel", true, null, true), /Save its tailnet address, or update the Android app$/);
});
