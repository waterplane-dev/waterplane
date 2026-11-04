/**
 * The trade-off, as a person reads it: what is said for which desktops, and what is never said
 * because the phone cannot know it or because it would not be true.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { parkedKeyFor } from "@waterplane/shared";
import { LS } from "./storage.ts";
import { forgetDoneWords, forgetLines, perDesktopTail, sealFacts, sealKeyKind, sealOnToast, sealRowCant, sealRowMore, sealRowNote, tradeoffLines } from "./tokenSealWords.ts";

const TOK = "tok_0123456789abcdef";
const kvOf = (seed = {}) => {
  const m = new Map(Object.entries(seed));
  return {
    getItem: (k) => m.get(k) ?? null, setItem: (k, v) => void m.set(k, v), removeItem: (k) => void m.delete(k),
    get length() { return m.size; }, key: (i) => [...m.keys()][i] ?? null,
  };
};
const host = (id, name, base = `http://100.64.0.${id.charCodeAt(0) % 200}:8770`) => ({ id, name, base });
const STUDIO = host("aaaa1111", "studio");
const WORK = host("bbbb2222", "work-mini");
const ZEN = host("cccc3333", "zenbook");
const parked = (h) => parkedKeyFor(LS.deviceToken, h.id);
const none = () => false;
const LAN = { enabled: true, gateTailscale: false };
const GATED = { enabled: true, gateTailscale: true };
const OFF = { enabled: false, gateTailscale: false };

const active = (h, extra = {}) => ({ [LS.hostActive]: h.id, [LS.deviceToken]: TOK, ...extra });
const facts = (seed, hosts, auth = null, held = none) => sealFacts(kvOf({ [LS.hosts]: JSON.stringify(hosts), ...seed }), hosts, auth, held);
const row = { path: "authenticate", lockOn: false, routePlain: false, read: null };
const tail = (f, name, on = false, memory = true) => perDesktopTail(f.desktops.find((d) => d.name === name), on, memory);

test("the three desktops of the mock", () => {
  const f = facts(active(STUDIO, { [parked(WORK)]: TOK }), [STUDIO, WORK, ZEN], LAN);
  assert.equal(tail(f, "studio"), "needed on your Wi-Fi only");
  assert.equal(tail(f, "work-mini"), "sign-in held");
  assert.equal(tail(f, "zenbook"), "no sign-in held — nothing to lock");
  assert.equal(f.lockable, 2);
});

test("no password is said only by the desktop itself", () => {
  const off = facts({ [LS.hostActive]: ZEN.id }, [ZEN, WORK], OFF);
  assert.equal(tail(off, "zenbook"), "no password — nothing to lock");
  assert.doesNotMatch(tail(off, "work-mini"), /no password/, "a parked desktop never told this phone");
  const offline = facts({ [LS.hostActive]: ZEN.id }, [ZEN], null);
  assert.doesNotMatch(tail(offline, "zenbook"), /no password/, "a closed socket has said nothing");
  const waiting = facts({ [LS.hostActive]: ZEN.id }, [ZEN], LAN);
  assert.match(tail(waiting, "zenbook"), /nothing to lock/);
  assert.doesNotMatch(tail(waiting, "zenbook"), /no password/);
});

test("a gated desktop's tail: the cost is a consequence before the choice, a fact after it", () => {
  const f = facts(active(WORK), [WORK], GATED);
  assert.equal(tail(f, "work-mini", true, false), "needed on the tailnet too — alerts need the app open");
  assert.equal(tail(f, "work-mini", true, true), "needed on the tailnet too — alerts pause after a restart until you open the app");
  assert.equal(tail(f, "work-mini", false, false), "needed on the tailnet too — once locked, alerts need the app open");
  assert.equal(tail(f, "work-mini", false, null), "needed on the tailnet too", "the shell has not answered: nothing is guessed");
});

test("sealed: the blob names the desktops, memory counts, and a passive token is drawn as what it is", () => {
  const blob = JSON.stringify({ v: 1, ct: "Y3Q=", nonce: "bm8=", hosts: [STUDIO.id] });
  const f = facts({ [LS.tokenSealOn]: "1", [LS.tokenSeal]: blob, [LS.hostActive]: STUDIO.id, [parked(ZEN)]: TOK, [parkedKeyFor(LS.passive, ZEN.id)]: "1" }, [STUDIO, WORK, ZEN], LAN, (id) => id === WORK.id);
  assert.equal(tail(f, "studio", true), "needed on your Wi-Fi only");
  assert.equal(tail(f, "work-mini", true), "sign-in held", "minted this run, memory only");
  assert.equal(tail(f, "zenbook", true), "sign-in stays unlocked");
});

test("a removed desktop's parked token is counted, and is not one of the rows", () => {
  const gone = host("dddd4444", "old");
  const f = facts({ [LS.hostActive]: ZEN.id, [parked(gone)]: TOK }, [ZEN], OFF);
  assert.equal(f.removed, 1);
  assert.equal(f.lockable, 1);
  assert.equal(f.desktops.length, 1);
});

test("a stray bare token is reported; a twin of a parked copy is not", () => {
  assert.equal(facts({ [LS.deviceToken]: TOK }, [ZEN]).stray, true);
  assert.equal(facts({ [LS.deviceToken]: TOK, [parked(ZEN)]: TOK }, [ZEN]).stray, false);
  assert.equal(facts(active(ZEN), [ZEN]).stray, false);
});

test("trade-off: old shell loses alerts whenever closed, new shell only after the process dies", () => {
  const f = facts(active(WORK), [WORK], GATED);
  const old = tradeoffLines(f, { anyKey: false, memory: false });
  assert.equal(old[0], "Opening the app will ask for your fingerprint before it connects. The phone's PIN does not open them on this app version.");
  assert.equal(old[1], "With the app closed, alerts from work-mini stop until you open the app.");
  assert.equal(old[2], "A fingerprint added or removed on this phone loses the sign-ins: work-mini must be paired again.");
  const fresh = tradeoffLines(f, { anyKey: true, memory: true });
  assert.equal(fresh[0], "Opening the app will ask for your fingerprint or the phone's PIN before it connects.");
  assert.equal(fresh[1], "With the app closed, alerts from work-mini keep coming until the phone restarts or Android stops the app; then they wait until you open it.");
});

test("an any key never blames a fingerprint: it survives one", () => {
  const f = facts(active(STUDIO), [STUDIO], LAN);
  const lines = tradeoffLines(f, { anyKey: true, memory: true }).join(" ");
  assert.doesNotMatch(lines, /fingerprint added/);
  assert.match(lines, /Removing the phone's screen lock loses the sign-ins: studio signs in again by itself\./);
  assert.doesNotMatch(sealRowMore("any"), /fingerprint added|does not open/);
  assert.match(sealRowMore("biometric"), /A fingerprint added or removed/);
  assert.match(sealRowMore("biometric"), /PIN does not open them/);
});

test("alerts are called unaffected only when the phone can know it", () => {
  const lan = facts(active(STUDIO), [STUDIO], LAN);
  assert.match(tradeoffLines(lan, { anyKey: true, memory: true })[1], /^Alerts are not affected/);
  const parkedToo = facts(active(STUDIO, { [parked(WORK)]: TOK }), [STUDIO, WORK], LAN);
  const lines = tradeoffLines(parkedToo, { anyKey: false, memory: false });
  assert.ok(!lines.some((l) => /not affected/.test(l)), "work-mini may gate the tailnet");
  assert.equal(lines[1], "If work-mini needs its sign-in on the tailnet, alerts stop with the app closed until you open it. This phone can only tell for the desktop it is connected to.");
  assert.match(lines[2], /studio signs in again by itself; work-mini: if signed out, pair again\.$/);
  const offline = facts(active(STUDIO), [STUDIO], null);
  assert.ok(!tradeoffLines(offline, { anyKey: true, memory: true }).some((l) => /not affected/.test(l)), "a closed socket has said nothing");
});

test("a desktop the phone cannot read leans on the gated one's sentence rather than repeating it", () => {
  const f = facts(active(WORK, { [parked(STUDIO)]: TOK }), [WORK, STUDIO], GATED);
  assert.equal(tradeoffLines(f, { anyKey: true, memory: true })[2], "If studio needs its sign-in on the tailnet, the same goes for its alerts. This phone can only tell for the desktop it is connected to.");
});

test("the row names what opens the key", () => {
  assert.match(sealRowNote("biometric"), /sealed under your fingerprint; opening/);
  assert.match(sealRowNote("any"), /sealed under your fingerprint or PIN; opening/);
});

test("several names read as a list; a desktop with nothing to lock is not named", () => {
  const f = facts(active(WORK, { [parked(STUDIO)]: TOK, [parked(ZEN)]: TOK }), [WORK, STUDIO, ZEN, host("eeee5555", "bare")], GATED);
  const lines = tradeoffLines(f, { anyKey: true, memory: false }).join(" ");
  assert.match(lines, /If studio and zenbook need their sign-ins on the tailnet/);
  assert.doesNotMatch(lines, /bare/);
});

test("a parked plain address is said before choosing", () => {
  const plain = host("ffff6666", "nas", "http://192.168.1.5:8770");
  const f = facts(active(STUDIO), [STUDIO, plain], LAN);
  assert.equal(sealRowCant(f, row), null);
  assert.ok(tradeoffLines(f, { anyKey: true, memory: true }).some((l) => /^nas is saved at an unprotected address/.test(l)));
});

test("no sentence claims the plaintext is gone", () => {
  const f = facts(active(WORK), [WORK], GATED);
  const all = [...tradeoffLines(f, { anyKey: true, memory: true }), sealRowMore("any"), sealRowMore("biometric"), sealOnToast("any"), sealOnToast(undefined)].join(" ");
  assert.doesNotMatch(all, /every (copy|sign-in|token)|no copy|nothing (is )?left|all (copies|sign-ins)/i);
});

test("the receipt says what the key that was made opens with", () => {
  assert.match(sealOnToast("any"), /fingerprint or the phone's PIN$/);
  assert.match(sealOnToast("biometric"), /your fingerprint$/);
  assert.match(sealOnToast(undefined), /your fingerprint$/);
});

test("the words follow the key, and a key nobody recorded is said as that", () => {
  assert.equal(sealKeyKind(kvOf({ [LS.tokenSealAuth]: "any" })), "any");
  assert.equal(sealKeyKind(kvOf()), null);
  assert.match(sealRowNote(null), /or PIN, if its sheet offers one/);
  assert.match(sealRowMore(null), /PIN if its sheet offers one, before it connects\. /);
  assert.doesNotMatch(sealRowMore(null), /does not open/, "unknown never claims the PIN fails");
  assert.match(sealRowMore(null), /on an older key a fingerprint added or removed, loses/);
});

test("forget: what goes and what to do, desktop by desktop", () => {
  const f = facts(active(STUDIO, { [parked(WORK)]: TOK }), [STUDIO, WORK], GATED);
  const lines = forgetLines(f);
  assert.match(lines[0], /stops using every sign-in/);
  assert.match(lines[0], /the lock goes off/);
  assert.doesNotMatch(lines.join(" "), /deleted|erased/, "the blob is set aside, not gone");
  assert.equal(lines[1], "studio must be paired again; work-mini: if signed out, pair again.");
  assert.match(lines[2], /^To pair: on the desktop: `\S+ pair`; here: Settings › Connection › hosts › pair with code\.$/);
  const lan = facts(active(STUDIO), [STUDIO], LAN);
  assert.equal(forgetLines(lan)[1], "studio signs in again by itself.");
  assert.match(forgetDoneWords(lan), /^The locked sign-ins are forgotten and the lock is off\. studio signs in again by itself\. To pair:.*turns the lock back on\.$/);
});

test("forget with no names to give still says what to do", () => {
  const f = facts({ [LS.hostActive]: ZEN.id, [LS.tokenSealOn]: "1", [LS.tokenSeal]: "not a blob" }, [ZEN]);
  assert.match(forgetLines(f)[1], /^A desktop with a LAN password signs this phone in again by itself; one that gates the tailnet must be paired again\.$/);
});

test("sealRowCant: no keystore comes first", () => {
  assert.match(sealRowCant(facts({}, [ZEN]), { ...row, path: null }), /needs a newer Android app/);
});

test("sealRowCant: nothing to lock, and the sentence is true for this phone", () => {
  assert.equal(sealRowCant(facts({ [LS.hostActive]: ZEN.id }, [ZEN], OFF), row), "nothing to lock: none of your desktops has a password, so this phone holds no sign-in");
  assert.match(sealRowCant(facts({ [LS.hostActive]: ZEN.id }, [ZEN], LAN), row), /^nothing to lock yet: zenbook has a password/);
  assert.match(sealRowCant(facts({ [LS.deviceToken]: TOK }, [ZEN]), row), /belongs to no saved desktop/);
});

test("sealRowCant: a plain saved address", () => {
  const plain = host("ffff6666", "nas", "http://192.168.1.5:8770");
  const on = facts(active(plain), [plain], LAN);
  assert.equal(sealRowCant(on, row), "needs the tailnet — nas is saved at an unprotected address, where the fingerprint key is refused");
});

test("sealRowCant: an old APK with the lock on refuses for ANY plain saved desktop: its card has no way past", () => {
  const plain = host("ffff6666", "nas", "http://192.168.1.5:8770");
  const f = facts(active(STUDIO), [STUDIO, plain], LAN);
  const old = { ...row, path: "sentinel" };
  assert.match(sealRowCant(f, { ...old, lockOn: true }), /^needs the tailnet — nas is saved.*nothing would open the app there/);
  assert.equal(sealRowCant(f, { ...old, lockOn: false }), null, "the lock off, the card offers open without the sign-ins");
  assert.equal(sealRowCant(f, { ...row, lockOn: true }), null, "a newer shell's lock takes no key");
});

test("sealRowCant: a plain ROUTE over a good address says leave this Wi-Fi", () => {
  assert.match(sealRowCant(facts(active(STUDIO), [STUDIO], LAN), { ...row, routePlain: true }), /Leave this Wi-Fi/);
});

test("sealRowCant: an any key reads the screen lock, a fingerprint key the enrolment", () => {
  const f = facts(active(STUDIO), [STUDIO], LAN);
  const pinOnly = { source: "lockStatus", hardware: true, enrolled: false, screenLock: true };
  assert.equal(sealRowCant(f, { ...row, read: pinOnly }), null, "a PIN-only phone can use an any key");
  assert.equal(sealRowCant(f, { ...row, read: { ...pinOnly, screenLock: false } }), "set a screen lock on the phone first");
  assert.equal(sealRowCant(f, { ...row, path: "sentinel", read: { source: "status", hardware: false, enrolled: false } }), "this phone has no fingerprint sensor the app can use");
});
