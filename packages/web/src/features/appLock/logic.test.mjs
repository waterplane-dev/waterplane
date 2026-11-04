/**
 * The sealed sign-ins' flows, over a fake Keystore: how many sheets each one shows, what a refusal
 * leaves behind, and what the cold-start card may offer. The wrap is a stand-in: base64, no key.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parkedKeyFor } from "@waterplane/shared";

import { lockVerdict } from "../../appLock.ts";
import { heldToken, heldTokens, holdToken, holdTokens, releaseTokens } from "../../deviceToken.ts";
import { addHost } from "../../hosts.ts";
import { RESET_KEEP_PREFIXES } from "../../resetKeys.ts";
import { LS } from "../../storage.ts";
import { TOKEN_ALIAS, parseSealBlob, settleAtBoot } from "../../tokenVault.ts";
import { sealKeyKind } from "../../tokenSealWords.ts";
import {
  SEAL_GATE_OPEN, cardActions, lockMayStillAsk, openBlob, pairHeldWords, retireSeal, rewrapNow, sealBody, sealLostWords, sealNow, sealRefusalWords, sealVerdict, shownStuck,
  sealUnreadableWords, startGate, unsealNow,
} from "./logic.ts";

function shim(init = {}) {
  const m = new Map(Object.entries(init));
  return {
    m,
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => { m.set(k, String(v)); },
    removeItem: (k) => { m.delete(k); },
    key: (i) => [...m.keys()][i] ?? null,
    get length() { return m.size; },
  };
}

const TA = "token_for_active_0000000";
const TB = "token_for_parked_0000000";
const TC = "token_for_paired_0000000";

/** One desktop active with a plain token, one parked with its own. */
function plainPhone() {
  const kv = shim();
  const a = addHost(kv, { name: "studio", base: "http://100.64.0.1:8770" });
  const b = addHost(kv, { name: "mini", base: "http://100.64.0.2:8770" });
  assert.ok(a.ok && b.ok);
  kv.setItem(LS.hostActive, a.host.id);
  kv.setItem(LS.deviceToken, TA);
  kv.setItem(parkedKeyFor(LS.deviceToken, b.host.id), TB);
  return { kv, a: a.host.id, b: b.host.id };
}

/** A keystore that counts its sheets and answers with `refuse` (a code) when told to. */
function keystore(kv, { refuse = {}, auth = "any", reread = null, savedPlain = false } = {}) {
  const calls = { generate: [], wrap: [], unwrap: [] };
  return {
    calls,
    ports: {
      kv,
      generate: async (o) => { calls.generate.push(o); return auth ? { auth } : {}; },
      wrap: async (o) => {
        calls.wrap.push(o);
        if (refuse.wrap) throw { code: refuse.wrap, message: "said no" };
        return { ctB64: o.dataB64, nonceB64: "bm9uY2U=" };
      },
      unwrap: async (o) => {
        calls.unwrap.push(o);
        if (refuse.unwrap) throw { code: refuse.unwrap, message: "said no" };
        return { dataB64: o.ctB64 };
      },
      reread: async () => reread,
      savedPlain: () => savedPlain,
    },
  };
}

async function sealedPhone(t, opts) {
  const p = plainPhone();
  await sealNow(keystore(p.kv).ports);
  releaseTokens(); // a cold start: the blob is on disk, the map is empty
  t.after(releaseTokens);
  return { ...p, ks: keystore(p.kv, opts) };
}

test("sealing is one sheet, on an `any` key, and leaves the tokens in memory and off the disk", async (t) => {
  t.after(releaseTokens);
  const { kv, a, b } = plainPhone();
  const ks = keystore(kv);
  const r = await sealNow(ks.ports);
  assert.deepEqual(r, { ok: true, auth: "any" });
  assert.equal(ks.calls.wrap.length, 1);
  assert.equal(ks.calls.unwrap.length, 0);
  assert.equal(ks.calls.generate[0].auth, "any");
  assert.equal(ks.calls.generate[0].alias, TOKEN_ALIAS);
  assert.equal(kv.getItem(LS.tokenSealOn), "1");
  assert.equal(kv.getItem(LS.deviceToken), null);
  assert.equal(heldToken(a), TA);
  assert.equal(heldToken(b), TB);
});

test("a shell that ignored the ask made a biometric key, and says so by saying nothing", async (t) => {
  t.after(releaseTokens);
  const { kv } = plainPhone();
  assert.deepEqual(await sealNow(keystore(kv, { auth: null }).ports), { ok: true, auth: "biometric" });
});

test("a refused seal changes nothing: every plain token stays", async (t) => {
  t.after(releaseTokens);
  for (const code of ["cancelled", "lockout", "failed", "somethingNew"]) {
    const { kv } = plainPhone();
    const r = await sealNow(keystore(kv, { refuse: { wrap: code } }).ports);
    assert.equal(r.ok, false);
    assert.equal(r.why, "refused");
    assert.match(r.words, /^not turned on/);
    assert.equal(kv.getItem(LS.deviceToken), TA);
    assert.equal(kv.getItem(LS.tokenSealOn), null);
    assert.equal(kv.getItem(LS.tokenSeal), null);
  }
});

test("a phone with no sign-in has nothing to seal, and no sheet is shown for it", async () => {
  const kv = shim();
  const ks = keystore(kv);
  const r = await sealNow(ks.ports);
  assert.equal(r.why, "nothing");
  assert.equal(ks.calls.wrap.length + ks.calls.generate.length, 0);
});

test("unsealing is one sheet and puts every token back, with what arrived this run", async (t) => {
  const { kv, a, b, ks } = await sealedPhone(t);
  holdToken(b, TC); // newer than the blob
  const r = await unsealNow(ks.ports, []);
  assert.equal(r.ok, true);
  assert.equal(ks.calls.unwrap.length, 1);
  assert.equal(ks.calls.wrap.length, 0);
  assert.equal(kv.getItem(LS.tokenSealOn), null);
  assert.equal(kv.getItem(LS.tokenSeal), null);
  assert.equal(kv.getItem(LS.deviceToken), TA);
  assert.equal(kv.getItem(parkedKeyFor(LS.deviceToken, b)), TC);
  assert.equal(heldToken(a), null, "the map is emptied");
});

test("a refused unseal stays sealed, unknown codes included (D3)", async (t) => {
  for (const code of ["cancelled", "failed", "lockout", "busy", "plainRoute", "somethingNew"]) {
    const { kv, ks } = await sealedPhone(t, { refuse: { unwrap: code } });
    const blob = kv.getItem(LS.tokenSeal);
    const r = await unsealNow(ks.ports, []);
    assert.equal(r.why, "refused");
    assert.equal(kv.getItem(LS.tokenSeal), blob);
    assert.equal(kv.getItem(LS.tokenSealOn), "1");
  }
});

test("a key gone for good: what memory holds is saved, what it does not is said lost", async (t) => {
  const s1 = await sealedPhone(t, { refuse: { unwrap: "keyInvalidated" } });
  holdTokens({ [s1.a]: TA, [s1.b]: TB });
  assert.equal((await unsealNow(s1.ks.ports, [])).ok, true);
  assert.equal(s1.kv.getItem(LS.deviceToken), TA);
  assert.equal(s1.kv.getItem(LS.tokenSealOn), null);

  const s2 = await sealedPhone(t, { refuse: { unwrap: "keyInvalidated" } });
  const r = await unsealNow(s2.ks.ports, ["studio", "mini"]);
  assert.equal(r.why, "lost");
  assert.match(r.words, /studio, mini/);
  assert.equal(s2.kv.getItem(LS.tokenSeal), null);
  assert.equal(s2.kv.getItem(LS.tokenSealOn), null);
});

test("bytes this build cannot read are never deleted, and no sheet is spent on them", async (t) => {
  const { kv, ks } = await sealedPhone(t);
  kv.setItem(LS.tokenSeal, '{"v":2,"future":true}');
  assert.equal(settleAtBoot(kv), "blob-unreadable");
  assert.deepEqual(await openBlob(ks.ports, { title: "x" }), { ok: false, why: "unreadable", passed: false });
  const r = await unsealNow(ks.ports, []);
  assert.equal(r.why, "unreadable");
  assert.equal(await rewrapNow(ks.ports, "studio"), pairHeldWords("studio", "this version of the app cannot read the saved sign-ins"));
  assert.equal(ks.calls.unwrap.length + ks.calls.wrap.length, 0);
  assert.equal(kv.getItem(LS.tokenSeal), '{"v":2,"future":true}');
  assert.equal(kv.getItem(LS.tokenSealOn), "1");
});

test("a sheet passed over bytes that are no token map opens nothing, deletes nothing, and counts as the person", async (t) => {
  const { kv, ks } = await sealedPhone(t);
  const blob = parseSealBlob(kv.getItem(LS.tokenSeal));
  kv.setItem(LS.tokenSeal, JSON.stringify({ ...blob, ct: btoa("[1,2]") }));
  assert.deepEqual(await openBlob(ks.ports, { title: "x" }), { ok: false, why: "unreadable", passed: true });
  assert.equal(kv.getItem(LS.tokenSealOn), "1");
});

test("a rewrap with the blob unopened and refused leaves every other desktop in it", async (t) => {
  const { kv, b, ks } = await sealedPhone(t, { refuse: { unwrap: "cancelled" } });
  const blob = kv.getItem(LS.tokenSeal);
  holdToken(b, TC);
  assert.equal(heldTokens(), null, "open without the sign-ins: the map holds only what arrived");
  const words = await rewrapNow(ks.ports, "mini");
  assert.match(words, /^mini is paired, held in memory until the app restarts/);
  assert.match(words, /the prompt was dismissed/);
  assert.equal(ks.calls.wrap.length, 0, "a partial map is never wrapped");
  assert.equal(kv.getItem(LS.tokenSeal), blob);
});

test("a rewrap with the blob unopened opens it first, so the new blob holds everyone", async (t) => {
  const { kv, a, b, ks } = await sealedPhone(t);
  holdToken(b, TC);
  assert.equal(await rewrapNow(ks.ports, "mini"), null);
  assert.equal(ks.calls.unwrap.length, 1);
  assert.equal(ks.calls.wrap.length, 1);
  assert.equal(ks.calls.generate.length, 0, "the existing key, never a new one");
  assert.deepEqual(JSON.parse(atob(ks.calls.wrap[0].dataB64)), { [a]: TA, [b]: TC });
  assert.deepEqual(parseSealBlob(kv.getItem(LS.tokenSeal)).hosts, [a, b].sort());
});

test("a rewrap with the map complete is one sheet; refused, the old blob stands", async (t) => {
  const { kv, a, b, ks } = await sealedPhone(t, { refuse: { wrap: "cancelled" } });
  holdTokens({ [a]: TA, [b]: TB });
  const blob = kv.getItem(LS.tokenSeal);
  assert.match(await rewrapNow(ks.ports, "mini"), /the seal was not updated/);
  assert.equal(ks.calls.unwrap.length, 0);
  assert.equal(ks.calls.wrap.length, 1);
  assert.equal(kv.getItem(LS.tokenSeal), blob);
});

test("retiring a dead seal cannot be cut into a state that brings it back", async (t) => {
  const { kv } = await sealedPhone(t);
  const removed = [];
  const watch = { ...kv, getItem: kv.getItem, removeItem: (k) => { removed.push(k); kv.removeItem(k); } };
  retireSeal(watch);
  assert.deepEqual(removed, [LS.tokenSeal, LS.tokenSealOn], "the blob first");
  // Cut after the first delete: a flag with no blob clears itself.
  const cut = shim({ [LS.tokenSealOn]: "1" });
  assert.equal(settleAtBoot(cut), "repair-no-blob");
  assert.equal(cut.getItem(LS.tokenSealOn), null);
});

test("the gate waits only for a seal this shell can ask about", () => {
  const blob = JSON.stringify({ v: 1, ct: "Y3Q=", nonce: "bm9uY2U=", hosts: [] });
  assert.deepEqual(startGate(shim(), "authenticate"), SEAL_GATE_OPEN);
  assert.deepEqual(startGate(shim({ [LS.tokenSealOn]: "1", [LS.tokenSeal]: blob }), null), SEAL_GATE_OPEN, "no keystore: the app opens, the blob stays");
  assert.deepEqual(startGate(shim({ [LS.tokenSealOn]: "1", [LS.tokenSeal]: blob }), "sentinel"), { waiting: true, lockPassed: false, unreadable: false });
  assert.deepEqual(startGate(shim({ [LS.tokenSealOn]: "1", [LS.tokenSeal]: "{}" }), "sentinel"), { waiting: true, lockPassed: false, unreadable: true });
});

test("D2: with the app lock on, the way past the sign-ins is not offered until the lock's own check passed", () => {
  const g = { waiting: true, lockPassed: false, unreadable: false };
  assert.deepEqual(cardActions(g, true), { unlock: true, exit: false });
  assert.deepEqual(cardActions({ ...g, lockPassed: true }, true), { unlock: true, exit: true });
  assert.deepEqual(cardActions(g, false), { unlock: true, exit: true });
});

test("bytes that cannot be read never strand anyone, and never pass the lock", () => {
  const g = { waiting: true, lockPassed: false, unreadable: true };
  assert.deepEqual(cardActions(g, false), { unlock: false, exit: true });
  assert.deepEqual(cardActions(g, true), { unlock: true, exit: false }, "unlock here is the lock's own sheet");
  assert.deepEqual(cardActions({ ...g, lockPassed: true }, true), { unlock: false, exit: true });
  assert.match(sealUnreadableWords(true), /They are kept on this phone/);
  assert.match(sealUnreadableWords(true), /open without the sign-ins/);
  assert.doesNotMatch(sealUnreadableWords(false), /open without the sign-ins/);
});

test("only a refusal whose sheet never appeared hands over to the lock's own sheet", () => {
  for (const path of ["authenticate", "sentinel"]) {
    for (const c of ["plainRoute", "noHardware", "noneEnrolled"]) assert.equal(lockMayStillAsk(c, path), true, c);
    for (const c of ["cancelled", "busy", "somethingNew", ""]) assert.equal(lockMayStillAsk(c, path), false, c);
  }
});

test("a key that took no PIN hands a lockout to a lock whose own sheet does", () => {
  for (const c of ["lockout", "failed"]) {
    assert.equal(lockMayStillAsk(c, "authenticate"), true, c);
    assert.equal(lockMayStillAsk(c, "sentinel"), false, `${c}: that lock's sheet is a key too`);
  }
});

test("a noHardware or noneEnrolled turns the seal off only on a fresh read that confirms it", async (t) => {
  const none = { source: "lockStatus", hardware: true, enrolled: false, screenLock: false };
  const pin = { source: "lockStatus", hardware: true, enrolled: false, screenLock: true };
  const s1 = await sealedPhone(t, { refuse: { unwrap: "noneEnrolled" }, reread: none });
  assert.equal((await openBlob(s1.ks.ports, { title: "x" })).verdict, "open-and-off");
  for (const reread of [pin, null]) {
    const s = await sealedPhone(t, { refuse: { unwrap: "noneEnrolled" }, reread });
    assert.equal((await openBlob(s.ks.ports, { title: "x" })).verdict, "stay");
  }
  assert.equal(lockVerdict("failed"), "stay");
});

test("sealVerdict: noHardware never retires the seal, whatever the read says", async (t) => {
  const reads = [
    { source: "lockStatus", hardware: false, enrolled: false, screenLock: true },
    { source: "lockStatus", hardware: false, enrolled: false, screenLock: false },
    { source: "status", hardware: false, enrolled: false },
    { source: "status", hardware: true, enrolled: false },
    null, undefined,
  ];
  for (const r of reads) assert.equal(sealVerdict("noHardware", r), "stay", JSON.stringify(r));
  assert.equal(lockVerdict("noHardware", reads[0]), "open-and-off", "the lock's rule stays: it has nothing to lose");
  const s = await sealedPhone(t, { refuse: { unwrap: "noHardware" }, reread: reads[0] });
  const blob = s.kv.getItem(LS.tokenSeal);
  const r = await unsealNow(s.ks.ports, ["studio"]);
  assert.equal(r.why, "refused");
  assert.equal(s.kv.getItem(LS.tokenSeal), blob);
  assert.equal(s.kv.getItem(LS.tokenSealOn), "1");
});

test("a plain SAVED address is not sent to another Wi-Fi: no network changes it", async (t) => {
  const saved = sealRefusalWords("plainRoute", "", false, true);
  assert.doesNotMatch(saved, /Leave this Wi-Fi|tap unlock/);
  assert.match(saved, /Update the Android app, or clear this app's data\.$/);
  assert.match(sealRefusalWords("plainRoute", "", true, true), /or open without the sign-ins\.$/);
  assert.doesNotMatch(saved, /open without/);
  assert.match(sealRefusalWords("plainRoute", "", false), /Leave this Wi-Fi/, "a plain ROUTE over a good address still can");
  const s = await sealedPhone(t, { refuse: { unwrap: "plainRoute" }, savedPlain: true });
  const r = await unsealNow(s.ks.ports, []);
  assert.doesNotMatch(r.words, /leave this Wi-Fi/i);
  assert.match(r.words, /^not turned off — .*save its tailnet address, update the Android app, or clear this app's data$/);
});

test("sealVerdict: only the named cases turn it off", () => {
  for (const c of ["keyInvalidated", "noKey", "badInput"]) assert.equal(sealVerdict(c), "open-and-off", c);
  assert.equal(sealVerdict("noneEnrolled", { source: "lockStatus", hardware: false, enrolled: false, screenLock: false }), "open-and-off", "no screen lock left");
  assert.equal(sealVerdict("noneEnrolled", { source: "lockStatus", hardware: false, enrolled: false, screenLock: true }), "stay", "a PIN still opens an any key");
  assert.equal(sealVerdict("noneEnrolled", { source: "status", hardware: true, enrolled: false }), "open-and-off", "fingerprints gone: a biometric key's end");
  assert.equal(sealVerdict("noneEnrolled", { source: "status", hardware: false, enrolled: false }), "stay", "a down sensor reads the same");
  assert.equal(sealVerdict("noneEnrolled", null), "stay");
  for (const c of ["failed", "lockout", "cancelled", "busy", "plainRoute", "somethingNew", ""]) {
    assert.equal(sealVerdict(c, { source: "lockStatus", hardware: false, enrolled: false, screenLock: false }), "stay", c);
  }
});

test("a verdict that retires the seal moves the blob aside, and boot leaves it there", async (t) => {
  const { kv, ks } = await sealedPhone(t, { refuse: { unwrap: "keyInvalidated" } });
  const blob = kv.getItem(LS.tokenSeal);
  assert.equal((await unsealNow(ks.ports, ["studio"])).why, "lost");
  assert.equal(kv.getItem(LS.tokenSeal), null);
  assert.equal(kv.getItem(LS.tokenSealOn), null);
  assert.equal(kv.getItem(LS.tokenSealDead), blob, "a wrong verdict has destroyed nothing");
  assert.equal(settleAtBoot(kv), "plain", "and nothing re-arms from it");
  assert.equal(kv.getItem(LS.tokenSealDead), blob);
});

test("a move storage refused keeps the last copy where it was", async (t) => {
  const { kv } = await sealedPhone(t);
  const blob = kv.getItem(LS.tokenSeal);
  retireSeal({ ...kv, setItem: () => { throw new Error("quota"); } });
  assert.equal(kv.getItem(LS.tokenSeal), blob);
  assert.equal(kv.getItem(LS.tokenSealOn), null);
  assert.notEqual(settleAtBoot(kv), "plain", "the blob brings the mode back at the next boot");
  assert.equal(kv.getItem(LS.tokenSealOn), "1");
});

test("forget is offered only for a refusal about the seal, never for one about the moment", () => {
  for (const code of ["failed", "noHardware", "noneEnrolled", "somethingNew"]) assert.equal(shownStuck({ ok: false, why: "refused", code }), true, code);
  for (const code of ["cancelled", "busy", "lockout", "plainRoute"]) assert.equal(shownStuck({ ok: false, why: "refused", code }), false, code);
  assert.equal(shownStuck({ ok: false, why: "unreadable" }), true);
  for (const why of ["changed", "storage", "lost", "nothing", "noKeystore"]) assert.equal(shownStuck({ ok: false, why }), false, why);
  assert.equal(shownStuck({ ok: true }), false);
});

test("the key kind is stored when the key is made, and outlives the mode going off", async (t) => {
  t.after(releaseTokens);
  const any = plainPhone();
  await sealNow(keystore(any.kv).ports);
  assert.equal(sealKeyKind(any.kv), "any");
  const old = plainPhone();
  await sealNow(keystore(old.kv, { auth: null }).ports);
  assert.equal(sealKeyKind(old.kv), "biometric");
  assert.equal(sealKeyKind(shim({})), null, "sealed before the phone kept this");
  assert.equal(sealKeyKind(shim({ [LS.tokenSealAuth]: "somethingNew" })), null);
  const refused = plainPhone();
  await sealNow(keystore(refused.kv, { refuse: { wrap: "cancelled" } }).ports);
  assert.equal(sealKeyKind(refused.kv), null);
});

test("the words: the shell's sentence survives, and no key change is blamed on a fingerprint alone", () => {
  assert.match(sealRefusalWords("failed", "that unlock does not open this key: use the phone's PIN or try again", false), /use the phone's PIN or try again\. Tap unlock/);
  assert.match(sealRefusalWords("plainRoute", "", true), /or open without the sign-ins/);
  assert.doesNotMatch(sealRefusalWords("plainRoute", "", false), /open without/, "words never name a button that is not there");
  assert.doesNotMatch(sealRefusalWords("noneEnrolled", "", false), /PIN/, "the key may not take one");
  assert.match(sealLostWords("keyInvalidated", []), /fingerprints or the screen lock/);
  assert.match(sealLostWords("keyInvalidated", ["studio"]), /studio: if one shows as signed out/);
  assert.match(sealLostWords("keyInvalidated", []), /Settings › Connection › lock the desktop sign-ins/);
  assert.match(sealBody("any"), /fingerprint or the phone's PIN to open/);
  assert.doesNotMatch(sealBody("biometric"), /PIN/, "this is the key's sheet, whatever the lock's path offers");
  assert.match(sealBody(null), /PIN if its sheet offers one/, "unknown is said, never picked");
  assert.match(pairHeldWords("mini", "failed"), /forget the locked sign-ins/);
  assert.doesNotMatch(pairHeldWords("mini", "failed"), /off and on/, "that refuses in the very state this is said in");
});

const src = (f) => readFileSync(new URL(f, import.meta.url), "utf8");

test("nothing that dials is mounted before the gate lets go, and the card stays in #root", () => {
  const main = src("../../main.tsx");
  const gate = main.indexOf("if (sealWaiting)");
  assert.ok(gate > 0 && gate < main.indexOf("<App />"), "the early return comes before App");
  assert.ok(gate < main.indexOf("<PulseProbe />"));
  assert.match(main.slice(gate, main.indexOf("}", gate + 30)), /<SealGate \/>/);
  // An empty #root after four seconds is a failed boot to `armBootTrap`.
  assert.doesNotMatch(src("./AppLockGate.tsx").match(/export function SealGate[\s\S]*?\n}/)[0], /createPortal/);
});

test("forget checks for itself: a refusal behind it, the lock's sheet, then the retire; and the row confirms first", () => {
  const f = src("./tokenSealActions.ts").match(/export async function forgetSignIns[\s\S]*?\n}/)[0];
  assert.ok(f.indexOf("sealCannotOpen()") < f.indexOf("lockOwed()"));
  assert.ok(f.indexOf("lockOwed()") < f.indexOf("lockSheet(FORGET_PROMPT)"));
  assert.ok(f.indexOf("if (why) return why") < f.indexOf("retireSeal(kv)"), "a lock sheet refused forgets nothing");
  assert.doesNotMatch(f, /commitUnseal|setItem/, "it writes no token to storage");
  const row = src("./TokenSealSettings.tsx");
  const go = row.match(/const forget = async[\s\S]*?\n  };/)[0];
  assert.ok(go.indexOf("core.say.confirm") >= 0 && go.indexOf("core.say.confirm") < go.indexOf("forgetSignIns("));
  assert.ok(go.indexOf("if (!yes) return") < go.indexOf("forgetSignIns("));
  assert.match(row, /\{sealCannotOpen\(\) && \(\s*<SetLine>/, "drawn only once a refusal showed it");
  assert.ok(row.indexOf("once(forget)") < row.indexOf("<Desktops facts"), "a control above the rows");
});

test("the way past the seal checks the lock itself, not only the button", () => {
  const f = src("./tokenSealActions.ts").match(/export function openWithoutTokens[\s\S]*?\n}/)[0];
  assert.match(f, /cardActions\(g, lockOwed\(\)\)\.exit/);
  assert.doesNotMatch(f, /tokenSealOn|retireSeal|setPref/, "it leaves the seal as it is");
});

test("a key gone for good never lands past the lock", () => {
  const f = src("./tokenSealActions.ts");
  assert.match(f.match(/verdict === "open-and-off"[\s\S]*?return null;/)[0], /land\(lockOwed\(\)\)/);
});

test("a hard reset keeps the lock: a crash screen in front of the card is no way past it", () => {
  for (const k of ["appLock", "appLockBlob", "tokenSeal", "tokenSealOn"]) {
    assert.ok(RESET_KEEP_PREFIXES.some((p) => LS[k].startsWith(p)), k);
  }
});
