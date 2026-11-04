/**
 * The signed web bundle, phone side: the shared vector, the policy table of the
 * LAN security plan (section 5), and the words every refusal says. Keys are
 * generated per run with node's WebCrypto, the same API the WebView has.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { webcrypto } from "node:crypto";
import {
  ASK_WORDS, NATIVE_UNVERIFIED_REASON, REFUSAL_WORDS, TRUST_BUTTON, UNVERIFIED_FALLBACK, askOf, baseOfDial, decide, goodUpdateKey,
  nativeRefusal, readSigned, signatureOk, unbase64,
} from "./updateTrust.ts";
import { createUpdateTrust } from "./updatePins.ts";
import { addHost, activeHostOf, setHostUpdateKey } from "./hosts.ts";
import { LS } from "./storage.ts";

const vector = JSON.parse(readFileSync(new URL("../../shared/test/fixtures/update-signature-vector.json", import.meta.url), "utf8"));
const JAVA = new URL("../../app/android/app/src/main/java/dev/waterplane/app/", import.meta.url);

const b64 = (bytes) => Buffer.from(bytes).toString("base64");

async function desktop() {
  const pair = await webcrypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
  const key = b64(new Uint8Array(await webcrypto.subtle.exportKey("spki", pair.publicKey)));
  const sign = async (body) => {
    const bytes = Buffer.from(typeof body === "string" ? body : JSON.stringify(body), "utf8");
    const sig = await webcrypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, pair.privateKey, bytes);
    return { signed: bytes.toString("base64"), sig: b64(new Uint8Array(sig)) };
  };
  return { key, sign };
}

const sha = "a".repeat(64);
const body = (over = {}) => ({
  v: 1, hostId: "abcd1234", buildId: "0123456789ab", gen: 5, total: 11,
  files: [{ path: "index.html", size: 11, sha256: sha }], ...over,
});
const facts = (over = {}) => ({ rowHostId: "abcd1234", pin: null, shell: null, offered: null, canLearn: true, ...over });

// ── the vector ───────────────────────────────────────────────────────────
test("the shared vector verifies, and its tampered case does not", async () => {
  assert.equal(await signatureOk(unbase64(vector.signed), vector.sig, vector.updateKey), true);
  assert.equal(await signatureOk(unbase64(vector.tampered.signed), vector.tampered.sig, vector.updateKey), false);
  assert.equal(goodUpdateKey(vector.updateKey), true);
  const b = readSigned(unbase64(vector.signed));
  assert.equal(b.gen, 1, "first signed gen is 1");
  assert.equal(b.hostId, "msu35b1c");
});

test("the same vector goes through the whole gate, tampered refused", async () => {
  const hostId = readSigned(unbase64(vector.signed)).hostId;
  const pin = { key: vector.updateKey, gen: 0 };
  const good = await decide(facts({ rowHostId: hostId, pin, signed: vector.signed, sig: vector.sig }));
  assert.equal(good.v, "good");
  const bad = await decide(facts({ rowHostId: hostId, pin, signed: vector.tampered.signed, sig: vector.tampered.sig }));
  assert.deepEqual(bad, { v: "refuse", why: "bad-signature" });
});

test("a signature of the wrong length or a junk key is a no, never a throw", async () => {
  const bytes = unbase64(vector.signed);
  assert.equal(await signatureOk(bytes, b64(new Uint8Array(70)), vector.updateKey), false);
  assert.equal(await signatureOk(bytes, undefined, vector.updateKey), false);
  assert.equal(await signatureOk(bytes, vector.sig, "AAAA"), false);
  assert.equal(await signatureOk(bytes, vector.sig, vector.updateKey, undefined), true);
});

test("goodUpdateKey takes only a P-256 SPKI", () => {
  assert.equal(goodUpdateKey("AAAA"), false);
  assert.equal(goodUpdateKey(undefined), false);
  assert.equal(goodUpdateKey(b64(new Uint8Array(91))), false);
});

test("base64 is the one strict spelling the native reader takes", () => {
  assert.equal(unbase64("QUJD\n"), null);
  assert.equal(unbase64("QUJ"), null);
  assert.equal(unbase64("QU-_"), null);
  assert.deepEqual([...unbase64("QUJD")], [65, 66, 67]);
});

// ── reading `signed` ─────────────────────────────────────────────────────
test("readSigned refuses what ShellBundleVerify.parse refuses", () => {
  const read = (o) => readSigned(Buffer.from(JSON.stringify(o)));
  assert.ok(read(body()));
  for (const [name, bad] of Object.entries({
    version: body({ v: 2 }),
    hostId: body({ hostId: "NOPE" }),
    buildId: body({ buildId: "xyz" }),
    gen: body({ gen: -1 }),
    "fractional gen": body({ gen: 1.5 }),
    "no files": body({ files: [], total: 0 }),
    "total off": body({ total: 12 }),
    "no index": body({ files: [{ path: "a.js", size: 11, sha256: sha }] }),
    "bad hash": body({ files: [{ path: "index.html", size: 11, sha256: "zz" }] }),
    climbing: body({ files: [{ path: "index.html", size: 5, sha256: sha }, { path: "../x", size: 6, sha256: sha }] }),
    repeated: body({ files: [{ path: "index.html", size: 5, sha256: sha }, { path: "index.html", size: 6, sha256: sha }] }),
  })) assert.equal(read(bad), null, name);
  assert.equal(readSigned(Buffer.from("not json")), null);
  assert.equal(readSigned(new Uint8Array([0xff, 0xfe])), null);
});

// ── the policy table ─────────────────────────────────────────────────────
test("no pin, unsigned: today's behaviour, on either APK", async () => {
  assert.deepEqual(await decide(facts()), { v: "open" });
  assert.deepEqual(await decide(facts({ shell: [] })), { v: "open" });
});

test("no pin, signed: the offered key is asked about, and it has to be the one that signed", async () => {
  const d = await desktop();
  const other = await desktop();
  const m = await d.sign(body());
  const offered = { hostId: "abcd1234", key: d.key };
  assert.deepEqual(await decide(facts({ ...m, offered })), { v: "pin", hostId: "abcd1234", key: d.key, change: false });
  assert.deepEqual(await decide(facts({ ...m, offered: { ...offered, key: other.key } })), { v: "refuse", why: "bad-signature" });
  assert.deepEqual(await decide(facts({ ...m, offered: { ...offered, hostId: "wxyz9876" } })), { v: "refuse", why: "bad-signature" });
});

test("no pin, signed, no key yet: waits, except where none can ever come", async () => {
  const d = await desktop();
  const m = await d.sign(body());
  assert.deepEqual(await decide(facts({ ...m })), { v: "refuse", why: "no-key" });
  assert.deepEqual(await decide(facts({ ...m, canLearn: false })), { v: "open" }, "a passive device is never locked out");
  assert.deepEqual(await decide(facts({ ...m, canLearn: false, shell: [{ hostId: "wxyz9876", key: d.key, gen: 1 }] })),
    { v: "refuse", why: "no-key" }, "but the shell would refuse an unsigned bundle anyway");
});

test("pin, unsigned: refused, also when only the shell holds the pin", async () => {
  const d = await desktop();
  assert.deepEqual(await decide(facts({ pin: { key: d.key, gen: 3 } })), { v: "refuse", why: "unsigned" });
  assert.deepEqual(await decide(facts({ shell: [{ hostId: "abcd1234", key: d.key, gen: 3 }] })), { v: "refuse", why: "unsigned" });
});

test("another desktop's native pin refuses unsigned before a whole bundle is fetched", async () => {
  const d = await desktop();
  assert.deepEqual(await decide(facts({ shell: [{ hostId: "wxyz9876", key: d.key, gen: 3 }] })), { v: "refuse", why: "unsigned-elsewhere" });
});

test("pin, bad signature, wrong host or unreadable: refused", async () => {
  const d = await desktop();
  const other = await desktop();
  const pin = { key: d.key, gen: 0 };
  assert.deepEqual(await decide(facts({ pin, ...(await other.sign(body())) })), { v: "refuse", why: "bad-signature" });
  assert.deepEqual(await decide(facts({ pin, ...(await d.sign(body({ hostId: "wxyz9876" }))) })), { v: "refuse", why: "wrong-host" });
  assert.deepEqual(await decide(facts({ pin, ...(await d.sign("not json")) })), { v: "refuse", why: "bad-manifest" });
  assert.deepEqual(await decide(facts({ pin, signed: "!!!", sig: "AAAA" })), { v: "refuse", why: "bad-manifest" });
  const m = await d.sign(body());
  assert.deepEqual(await decide(facts({ pin, signed: m.signed })), { v: "refuse", why: "bad-signature" }, "signed with no sig");
});

test("only what is inside `signed` is read", async () => {
  const d = await desktop();
  const g = await decide(facts({ pin: { key: d.key, gen: 0 }, ...(await d.sign(body())), buildId: "ffffffffffff", files: [] }));
  assert.equal(g.v, "good");
  assert.equal(g.body.buildId, "0123456789ab");
  assert.equal(g.body.files[0].sha256, sha);
});

test("gen below the mark is refused, equal is not, and the higher of LS and native is the mark", async () => {
  const d = await desktop();
  const m = await d.sign(body({ gen: 5 }));
  assert.equal((await decide(facts({ pin: { key: d.key, gen: 5 }, ...m }))).v, "good");
  assert.deepEqual(await decide(facts({ pin: { key: d.key, gen: 6 }, ...m })), { v: "refuse", why: "rollback", hostId: "abcd1234", key: d.key });
  const shell = [{ hostId: "abcd1234", key: d.key, gen: 9 }];
  assert.equal((await decide(facts({ pin: { key: d.key, gen: 2 }, shell, ...m }))).why, "rollback");
  assert.equal((await decide(facts({ pin: { key: d.key, gen: 2 }, shell: [{ ...shell[0], gen: 3 }], ...m }))).v, "good");
});

test("gen 0 on a row is a pin, and the first signed gen passes it", async () => {
  const d = await desktop();
  const g = await decide(facts({ pin: { key: d.key, gen: 0 }, ...(await d.sign(body({ gen: 1 }))) }));
  assert.equal(g.v, "good");
});

test("a key only the shell holds still gates, so a lost LS row cannot unpin", async () => {
  const d = await desktop();
  const other = await desktop();
  const shell = [{ hostId: "abcd1234", key: d.key, gen: 1 }];
  assert.equal((await decide(facts({ shell, ...(await d.sign(body())) }))).v, "good");
  assert.equal((await decide(facts({ shell, ...(await other.sign(body())) }))).why, "bad-signature");
});

test("a new APK with the key only on the row asks the shell before a bundle is fetched", async () => {
  const d = await desktop();
  const g = await decide(facts({ pin: { key: d.key, gen: 2 }, shell: [], ...(await d.sign(body())) }));
  assert.deepEqual(g, { v: "pin", hostId: "abcd1234", key: d.key, change: false });
});

test("a changed key needs the protected offer AND its signature, and is marked as a change", async () => {
  const old = await desktop();
  const d = await desktop();
  const m = await d.sign(body());
  const pin = { key: old.key, gen: 7 };
  assert.deepEqual(await decide(facts({ pin, ...m, offered: { hostId: "abcd1234", key: d.key } })), { v: "pin", hostId: "abcd1234", key: d.key, change: true });
  assert.equal((await decide(facts({ pin, ...m }))).why, "bad-signature", "no offer: nothing vouches for the new key");
  const stranger = await desktop();
  assert.equal((await decide(facts({ pin, ...m, offered: { hostId: "abcd1234", key: stranger.key } }))).why, "bad-signature");
});

test("a kept key under a new desktop id is a change only with a protected welcome saying so", async () => {
  const d = await desktop();
  const m = await d.sign(body({ hostId: "wxyz9876" }));
  const pin = { key: d.key, gen: 0 };
  assert.deepEqual(await decide(facts({ pin, ...m, offered: { hostId: "wxyz9876", key: d.key } })), { v: "pin", hostId: "wxyz9876", key: d.key, change: true });
  assert.equal((await decide(facts({ pin, ...m }))).why, "wrong-host");
});

// ── the dial address ─────────────────────────────────────────────────────
test("baseOfDial turns the socket's own url into what the route rule reads", () => {
  assert.equal(baseOfDial("ws://100.100.1.2:8770/ws"), "http://100.100.1.2:8770");
  assert.equal(baseOfDial("wss://mac.tail1.ts.net/ws"), "https://mac.tail1.ts.net");
  assert.equal(baseOfDial("wss://[fd7a:115c:a1e0::1]:8443/ws"), "https://[fd7a:115c:a1e0::1]:8443");
  assert.equal(baseOfDial("nonsense"), null);
});

// ── words ────────────────────────────────────────────────────────────────
test("every native reject code has words, and no code is shown", () => {
  const java = readFileSync(new URL("ShellBundleVerify.java", JAVA), "utf8");
  const codes = [...java.matchAll(/static final String ([A-Z_]+) = "\1";/g)].map((m) => m[1]);
  for (const code of [...codes, "BAD_KEY"]) {
    const why = nativeRefusal({ code });
    assert.ok(why, `${code} has no refusal`);
    assert.ok(!REFUSAL_WORDS[why].includes(code), `${code} is shown raw`);
  }
  assert.ok(codes.length >= 9);
  assert.equal(nativeRefusal({ code: "BAD_BUILD" }), null, "held, not refused");
  assert.equal(nativeRefusal({ code: "constructor" }), null);
  assert.equal(nativeRefusal(new Error("x")), null);
  assert.equal(nativeRefusal(null), null);
});

test("an unsigned refusal never claims the desktop is out of date", () => {
  for (const why of ["unsigned", "unsigned-elsewhere"]) {
    assert.doesNotMatch(REFUSAL_WORDS[why], /update the desktop/i);
    assert.match(REFUSAL_WORDS[why], /cannot read its key file/);
  }
});

test("a refused launch never says it did not start, and the reason is the Java's", () => {
  assert.doesNotMatch(UNVERIFIED_FALLBACK, /did not start/);
  assert.ok(readFileSync(new URL("ShellUpdatePlugin.java", JAVA), "utf8").includes(`"${NATIVE_UNVERIFIED_REASON}"`));
});

test("every way out names its button as drawn", () => {
  assert.ok(REFUSAL_WORDS.rollback.includes(`"${TRUST_BUTTON.restored}"`));
  assert.ok(REFUSAL_WORDS["no-pin"].includes(`"${TRUST_BUTTON.pin}"`));
  assert.equal(askOf("rollback"), "restored");
  assert.equal(askOf("no-pin"), "pin");
  assert.equal(askOf("unsigned"), undefined);
  assert.ok(ASK_WORDS.pin && ASK_WORDS["key-changed"]);
});

// ── the wiring node cannot run ───────────────────────────────────────────
test("the three seams the gate depends on are still connected", () => {
  const src = (p) => readFileSync(new URL(p, import.meta.url), "utf8");
  const web = src("./webUpdate.ts");
  assert.match(web, /finishBundle\(proof \? \{ id, signed: proof\.signed, sig: proof\.sig \} : \{ id \}\)/);
  assert.doesNotMatch(web.slice(web.indexOf("async download("), web.indexOf("private unstage(")), /\bm\.files\b/, "the signed list is the only list");
  assert.match(web, /!base \|\| !row \|\| plainInShell\(base\)/, "a welcome is judged by its own dial");
  assert.match(src("./core/conn/useHostFrames.ts"), /updates\.noteWelcome\(msg, connRef\.current\.dialUrl\)/);
});

// ── how a key comes to be believed ───────────────────────────────────────
function memKv() {
  const m = new Map();
  return { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => { m.set(k, String(v)); }, removeItem: (k) => { m.delete(k); } };
}

function rig({ shellKeys = null, answers = {} } = {}) {
  const kv = memKv();
  const added = addHost(kv, { name: "Mac", base: "http://100.100.1.2:8770" });
  assert.ok(added.ok);
  kv.setItem(LS.hostActive, added.host.id);
  const calls = [];
  const state = { shellKeys, visible: true, hasSocket: true, confirm: answers.confirm ?? false };
  const shell = {
    async pinUpdateKey(o) {
      calls.push(["pin", o.hostId, o.key]);
      const yes = answers.pin ?? true;
      if (yes === "throw") throw Object.assign(new Error("x"), { code: "BAD_KEY" });
      if (yes && state.shellKeys) state.shellKeys = [...state.shellKeys.filter((p) => p.hostId !== o.hostId), { hostId: o.hostId, key: o.key, gen: 0 }];
      return { pinned: !!yes };
    },
    async forgetUpdateKey(o) {
      calls.push(["forget", o.hostId]);
      const yes = answers.forget ?? true;
      if (yes && state.shellKeys) state.shellKeys = state.shellKeys.filter((p) => p.hostId !== o.hostId);
      return { forgotten: !!yes };
    },
  };
  const trust = createUpdateTrust({
    kv: () => kv,
    activeRow: () => activeHostOf(kv),
    shell: () => (state.shellKeys ? shell : null),
    shellKeys: async () => state.shellKeys,
    visible: () => state.visible,
    hasSocket: () => state.hasSocket,
    confirm: async (o) => { calls.push(["confirm", o.title]); return state.confirm; },
  });
  const row = () => activeHostOf(kv);
  return { kv, trust, calls, row, state };
}

test("migration: a row with no key learns it on a shipped APK with no question", async () => {
  const d = await desktop();
  const r = rig();
  r.trust.offer(r.row().id, { hostId: "abcd1234", key: d.key });
  assert.equal(await r.trust.learn(), "pinned");
  assert.deepEqual(r.row().updateKey, { key: d.key, gen: 0 });
  assert.equal(r.row().hostId, "abcd1234");
  assert.deepEqual(r.calls, []);
});

test("migration: a new APK goes through the native dialog, and a no stores nothing", async () => {
  const d = await desktop();
  const r = rig({ shellKeys: [], answers: { pin: false } });
  r.trust.offer(r.row().id, { hostId: "abcd1234", key: d.key });
  assert.equal(await r.trust.learn(), "declined");
  assert.equal(r.row().updateKey, undefined);
  assert.deepEqual(r.calls, [["pin", "abcd1234", d.key]]);
});

test("a no is not asked again by itself on this app start, and the button still can", async () => {
  const d = await desktop();
  const r = rig({ shellKeys: [], answers: { pin: false } });
  r.trust.offer(r.row().id, { hostId: "abcd1234", key: d.key });
  await r.trust.learn();
  assert.equal(await r.trust.learn(), "later");
  assert.equal(r.calls.length, 1);
  assert.equal(await r.trust.ask({ hostId: "abcd1234", key: d.key, change: false }, true), "declined");
  assert.equal(r.calls.length, 2);
});

test("no unasked dialog on a screen nobody is looking at", async () => {
  const d = await desktop();
  const r = rig({ shellKeys: [] });
  r.state.visible = false;
  r.trust.offer(r.row().id, { hostId: "abcd1234", key: d.key });
  assert.equal(await r.trust.learn(), "later");
  assert.deepEqual(r.calls, []);
  r.state.visible = true;
  assert.equal(await r.trust.learn(), "pinned", "and being hidden did not spend the one ask");
});

test("a key learned on a shipped APK goes on to the native store after a new APK", async () => {
  const d = await desktop();
  const r = rig({ shellKeys: [] });
  setHostUpdateKey(r.kv, r.row().id, { key: d.key, gen: 4 });
  r.trust.offer(r.row().id, { hostId: "abcd1234", key: d.key });
  assert.equal(await r.trust.learn(), "pinned");
  assert.deepEqual(r.row().updateKey, { key: d.key, gen: 4 }, "the mark survives the move");
});

test("a welcome alone never changes a held key, on either APK", async () => {
  const old = await desktop();
  const d = await desktop();
  for (const shellKeys of [null, [{ hostId: "abcd1234", key: old.key, gen: 2 }]]) {
    const r = rig({ shellKeys });
    setHostUpdateKey(r.kv, r.row().id, { key: old.key, gen: 2 });
    r.trust.offer(r.row().id, { hostId: "abcd1234", key: d.key });
    assert.equal(await r.trust.learn(), "held");
    assert.equal(r.row().updateKey.key, old.key);
    assert.deepEqual(r.calls, []);
  }
});

test("a changed key on a shipped APK asks only by hand, and its gen starts over", async () => {
  const old = await desktop();
  const d = await desktop();
  const r = rig();
  setHostUpdateKey(r.kv, r.row().id, { key: old.key, gen: 7 });
  const want = { hostId: "abcd1234", key: d.key, change: true };
  assert.equal(await r.trust.ask(want, false), "later");
  assert.deepEqual(r.calls, [], "an unasked Confirm would answer someone else's");
  assert.equal(await r.trust.ask(want, true), "declined");
  assert.equal(r.row().updateKey.key, old.key);
  r.state.confirm = true;
  assert.equal(await r.trust.ask(want, true), "pinned");
  assert.deepEqual(r.row().updateKey, { key: d.key, gen: 0 });
});

test("a changed key on a new APK resets the row with the dialog's yes", async () => {
  const old = await desktop();
  const d = await desktop();
  const r = rig({ shellKeys: [{ hostId: "abcd1234", key: old.key, gen: 7 }] });
  setHostUpdateKey(r.kv, r.row().id, { key: old.key, gen: 7 });
  assert.equal(await r.trust.ask({ hostId: "abcd1234", key: d.key, change: true }, false), "pinned");
  assert.deepEqual(r.row().updateKey, { key: d.key, gen: 0 });
});

test("restored desktop, new APK: forget then pin, and the whole gate then passes", async () => {
  const d = await desktop();
  const r = rig({ shellKeys: [{ hostId: "abcd1234", key: d.key, gen: 9 }] });
  setHostUpdateKey(r.kv, r.row().id, { key: d.key, gen: 9 });
  r.trust.offer(r.row().id, { hostId: "abcd1234", key: d.key });
  const m = await d.sign(body({ gen: 3 }));
  assert.equal((await r.trust.judge(m)).why, "rollback");
  assert.equal(await r.trust.restored("abcd1234", d.key), "pinned");
  assert.deepEqual(r.calls.map((c) => c[0]), ["forget", "pin"]);
  assert.deepEqual(r.row().updateKey, { key: d.key, gen: 0 });
  assert.equal((await r.trust.judge(m)).v, "good");
});

test("restored desktop: a no at either dialog changes no mark, and asking again reaches the second", async () => {
  const d = await desktop();
  const r = rig({ shellKeys: [{ hostId: "abcd1234", key: d.key, gen: 9 }], answers: { forget: false } });
  setHostUpdateKey(r.kv, r.row().id, { key: d.key, gen: 9 });
  assert.equal(await r.trust.restored("abcd1234", d.key), "declined");
  assert.equal(r.row().updateKey.gen, 9);

  const s = rig({ shellKeys: [{ hostId: "abcd1234", key: d.key, gen: 9 }], answers: { pin: false } });
  setHostUpdateKey(s.kv, s.row().id, { key: d.key, gen: 9 });
  assert.equal(await s.trust.restored("abcd1234", d.key), "declined");
  assert.equal(s.row().updateKey.gen, 9, "the row's mark holds, so the JS check still refuses");
  const m = await d.sign(body({ gen: 3 }));
  assert.equal((await s.trust.judge(m)).why, "rollback", "the way out is still on screen");
});

test("restored desktop, shipped APK: one Confirm", async () => {
  const d = await desktop();
  const r = rig();
  setHostUpdateKey(r.kv, r.row().id, { key: d.key, gen: 9 });
  assert.equal(await r.trust.restored("abcd1234", d.key), "declined");
  assert.equal(r.row().updateKey.gen, 9);
  r.state.confirm = true;
  assert.equal(await r.trust.restored("abcd1234", d.key), "pinned");
  assert.equal(r.row().updateKey.gen, 0);
});

test("a taken bundle raises the mark and never lowers it", async () => {
  const d = await desktop();
  const r = rig();
  setHostUpdateKey(r.kv, r.row().id, { key: d.key, gen: 4 });
  r.trust.taken(r.row().id, d.key, body({ gen: 6 }));
  assert.equal(r.row().updateKey.gen, 6);
  r.trust.taken(r.row().id, d.key, body({ gen: 2 }));
  assert.equal(r.row().updateKey.gen, 6);
  r.trust.taken("nosuchrow", d.key, body({ gen: 20 }));
  assert.equal(r.row().updateKey.gen, 6);
});

test("an offer holds for the row it came on, not the row switched to", async () => {
  const d = await desktop();
  const r = rig();
  r.trust.offer("otherrow", { hostId: "abcd1234", key: d.key });
  assert.equal(await r.trust.learn(), "held");
  assert.equal((await r.trust.judge(await d.sign(body()))).why, "no-key");
});

test("a passive device has no socket, so a signed manifest stays today's behaviour", async () => {
  const d = await desktop();
  const r = rig();
  r.state.hasSocket = false;
  assert.equal((await r.trust.judge(await d.sign(body()))).v, "open");
});

test("a native BAD_KEY is its own answer", async () => {
  const d = await desktop();
  const r = rig({ shellKeys: [], answers: { pin: "throw" } });
  assert.equal(await r.trust.ask({ hostId: "abcd1234", key: d.key, change: false }, true), "bad-key");
});
