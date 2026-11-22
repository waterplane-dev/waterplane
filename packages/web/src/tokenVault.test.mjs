/**
 * The sealed sign-ins: what is collected, the order of every write, and every state a kill can
 * leave. The "truth" below is the rule the header of `tokenVault.ts` states; a token that is not
 * in the truth at some cut point is a lost sign-in. The wrap is a stand-in: base64, no key.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { parkedKeyFor } from "@waterplane/shared";

import {
  TOKEN_AAD, TOKEN_ALIAS, collectIdentities, collectTokens, commitRewrap, commitSeal, commitUnseal, parseSealBlob, readSealLan, readSealPlaintext,
  sealPlaintext, sealWritePlan, sealedHostIds, settleAtBoot, unsealWritePlan,
} from "./tokenVault.ts";
import { addHost } from "./hosts.ts";
import { LS } from "./storage.ts";

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

/** `kv` until `n` writes have landed, then a dead process: every write throws, reads still work. */
function dying(kv, n) {
  let left = n;
  const spend = () => { if (left-- <= 0) throw new Error("killed"); };
  return {
    getItem: kv.getItem, key: kv.key, get length() { return kv.length; },
    setItem: (k, v) => { spend(); kv.setItem(k, v); },
    removeItem: (k) => { spend(); kv.removeItem(k); },
  };
}

const TA = "token_for_active_0000000";
const TB = "token_for_parked_0000000";
const TG = "token_for_removed_000000";
const STALE = "stale_parked_copy_of_a_00";

/** A active (with the stale parked copy a restore leaves), B parked, C a removed desktop's park. */
function world() {
  const kv = shim();
  const a = addHost(kv, { name: "studio", base: "http://100.64.0.1:8770" }).host.id;
  const b = addHost(kv, { name: "mini", base: "http://100.64.0.2:8770" }).host.id;
  const c = "gone1234";
  kv.setItem(LS.hostActive, a);
  kv.setItem(LS.deviceToken, TA);
  kv.setItem(parkedKeyFor(LS.deviceToken, a), STALE);
  kv.setItem(parkedKeyFor(LS.deviceToken, b), TB);
  kv.setItem(parkedKeyFor(LS.deviceToken, c), TG);
  return { kv, a, b, c, tokens: { [a]: TA, [b]: TB, [c]: TG } };
}

const wrap = (tokens) => ({ ct: Buffer.from(sealPlaintext(tokens)).toString("base64"), nonce: "bm9uY2U=" });
const opened = (kv) => {
  const blob = parseSealBlob(kv.getItem(LS.tokenSeal));
  return blob ? readSealPlaintext(Buffer.from(blob.ct, "base64").toString()) : null;
};
/** Where every token is, by the rule: flag on with a blob, the blob; otherwise plaintext. */
const truth = (kv) => (kv.getItem(LS.tokenSealOn) === "1" && kv.getItem(LS.tokenSeal) ? opened(kv) : collectTokens(kv));
const plainLeft = (kv) => [...kv.m.values()].filter((v) => [TA, TB, TG, STALE].includes(v));

function sealed(w) {
  assert.deepEqual(commitSeal(w.kv, wrap(w.tokens), w.tokens), { ok: true });
  return w;
}

// ── What is collected ────────────────────────────────────────────────────

test("collect: bare is the active desktop's and beats its stale parked copy; parked by id, removed desktops included", () => {
  const w = world();
  assert.deepEqual(collectTokens(w.kv), w.tokens);
});

test("collect: a bare token with no active host belongs to nobody, and a hand-edited token is not one", () => {
  const kv = shim({ [LS.deviceToken]: TA, [parkedKeyFor(LS.deviceToken, "abcd1234")]: "short" });
  assert.deepEqual(collectTokens(kv), {});
});

test("collect: a passive token stays out, active or parked", () => {
  const w = world();
  w.kv.setItem(parkedKeyFor(LS.passive, w.b), "1");
  assert.equal(collectTokens(w.kv)[w.b], undefined);
  w.kv.setItem(LS.passive, "1");
  assert.equal(collectTokens(w.kv)[w.a], undefined);
});

// ── Order ────────────────────────────────────────────────────────────────

test("seal plan: blob, then flag, then the deletes, and the deletes reach every plain copy", () => {
  const w = world();
  const blob = { v: 1, ...wrap(w.tokens), hosts: Object.keys(w.tokens).sort() };
  const ops = sealWritePlan(w.kv, blob);
  assert.deepEqual(ops.slice(0, 2).map((o) => [o.op, o.key]), [["set", LS.tokenSeal], ["set", LS.tokenSealOn]]);
  assert.ok(ops.slice(2).every((o) => o.op === "remove"));
  assert.deepEqual(new Set(ops.slice(2).map((o) => o.key)), new Set([
    LS.deviceToken, parkedKeyFor(LS.deviceToken, w.a), parkedKeyFor(LS.deviceToken, w.b), parkedKeyFor(LS.deviceToken, w.c),
  ]));
});

test("unseal plan: bare for the active desktop, parked for the rest, then the flag, then the blob", () => {
  const w = sealed(world());
  assert.deepEqual(unsealWritePlan(w.kv, w.tokens), [
    { op: "set", key: LS.deviceToken, value: TA },
    { op: "set", key: parkedKeyFor(LS.deviceToken, w.b), value: TB },
    { op: "set", key: parkedKeyFor(LS.deviceToken, w.c), value: TG },
    { op: "remove", key: LS.tokenSealOn },
    { op: "remove", key: LS.tokenSeal },
  ]);
});

test("unseal with no active host: every token parked, none on the one bare key", () => {
  const w = sealed(world());
  w.kv.removeItem(LS.hostActive);
  const sets = unsealWritePlan(w.kv, w.tokens).filter((o) => o.op === "set");
  assert.equal(sets.length, 3);
  assert.ok(sets.every((o) => o.key !== LS.deviceToken));
});

// ── Commit ───────────────────────────────────────────────────────────────

test("seal then unseal: no plain token left between, and each back on its own key after", () => {
  const w = sealed(world());
  assert.deepEqual(plainLeft(w.kv), []);
  assert.deepEqual(sealedHostIds(w.kv), Object.keys(w.tokens).sort());
  assert.deepEqual(opened(w.kv), w.tokens);
  assert.deepEqual(commitUnseal(w.kv, w.tokens), { ok: true });
  assert.equal(w.kv.getItem(LS.deviceToken), TA);
  assert.equal(w.kv.getItem(parkedKeyFor(LS.deviceToken, w.b)), TB);
  assert.equal(w.kv.getItem(parkedKeyFor(LS.deviceToken, w.c)), TG);
  assert.equal(w.kv.getItem(LS.tokenSeal), null);
  assert.equal(w.kv.getItem(LS.tokenSealOn), null);
});

test("a token that landed while the sheet was up refuses the commit, and nothing moves", () => {
  const w = world();
  const before = wrap(w.tokens);
  w.kv.setItem(LS.deviceToken, "a_newer_token_from_a_mint");
  const snap = JSON.stringify([...w.kv.m]);
  assert.deepEqual(commitSeal(w.kv, before, w.tokens), { ok: false, why: "changed" });
  assert.equal(JSON.stringify([...w.kv.m]), snap);
});

test("a blob storage will not take deletes nothing: quota, and bytes that read back wrong", () => {
  const w = world();
  const full = { ...w.kv, getItem: w.kv.getItem, key: w.kv.key, get length() { return w.kv.length; }, setItem: () => { throw new Error("QuotaExceededError"); } };
  assert.deepEqual(commitSeal(full, wrap(w.tokens), w.tokens), { ok: false, why: "storage" });
  assert.deepEqual(collectTokens(w.kv), w.tokens);
  const liar = { ...full, setItem: (k, v) => { w.kv.setItem(k, k === LS.tokenSeal ? `${v}x` : v); } };
  assert.deepEqual(commitSeal(liar, wrap(w.tokens), w.tokens), { ok: false, why: "storage" });
  assert.deepEqual(collectTokens(w.kv), w.tokens);
  assert.equal(w.kv.getItem(LS.tokenSealOn), null);
});

test("a wrap with nothing in it is refused before any write", () => {
  const w = world();
  assert.deepEqual(commitSeal(w.kv, { ct: "", nonce: "x" }, w.tokens), { ok: false, why: "badBlob" });
  assert.equal(w.kv.getItem(LS.tokenSeal), null);
});

test("an unseal that cannot write stays sealed and takes back what it wrote", () => {
  const w = sealed(world());
  let n = 0;
  const flaky = { getItem: w.kv.getItem, key: w.kv.key, removeItem: w.kv.removeItem, get length() { return w.kv.length; },
    setItem: (k, v) => { if (n++ === 1) throw new Error("QuotaExceededError"); w.kv.setItem(k, v); } };
  assert.deepEqual(commitUnseal(flaky, w.tokens), { ok: false, why: "storage" });
  assert.deepEqual(plainLeft(w.kv), []);
  assert.deepEqual(opened(w.kv), w.tokens);
  assert.equal(w.kv.getItem(LS.tokenSealOn), "1");
});

test("a re-wrap replaces the blob and its list, and a refused one leaves the old blob whole", () => {
  const w = sealed(world());
  const more = { ...w.tokens, abcd9999: "token_for_new_pair_00000" };
  assert.deepEqual(commitRewrap(w.kv, wrap(more), more), { ok: true });
  assert.deepEqual(opened(w.kv), more);
  assert.ok(sealedHostIds(w.kv).includes("abcd9999"));
  const full = { getItem: w.kv.getItem, key: w.kv.key, removeItem: w.kv.removeItem, get length() { return w.kv.length; }, setItem: () => { throw new Error("QuotaExceededError"); } };
  assert.deepEqual(commitRewrap(full, wrap(w.tokens), w.tokens), { ok: false, why: "storage" });
  assert.deepEqual(opened(w.kv), more);
});

test("a re-wrap with the mode off writes nothing", () => {
  const w = world();
  assert.deepEqual(commitRewrap(w.kv, wrap(w.tokens), w.tokens), { ok: false, why: "changed" });
  assert.equal(w.kv.getItem(LS.tokenSeal), null);
});

// ── The interrupted states, by name ──────────────────────────────────────

const blobFor = (w) => JSON.stringify({ v: 1, ...wrap(w.tokens), hosts: Object.keys(w.tokens).sort() });

test("nothing to repair: plain stays plain, sealed stays sealed", () => {
  const w = world();
  assert.equal(settleAtBoot(w.kv), "plain");
  assert.deepEqual(collectTokens(w.kv), w.tokens);
  sealed(w);
  assert.equal(settleAtBoot(w.kv), "sealed");
  assert.deepEqual(opened(w.kv), w.tokens);
});

test("seal cut after the blob, before the flag: the plaintext is whole, so the blob goes", () => {
  const w = world();
  w.kv.setItem(LS.tokenSeal, blobFor(w));
  assert.equal(settleAtBoot(w.kv), "repair-finished-unseal");
  assert.equal(w.kv.getItem(LS.tokenSeal), null);
  assert.deepEqual(collectTokens(w.kv), w.tokens);
});

test("seal cut after the flag, some deletes done: the rest of the deletes finish, the blob stands", () => {
  const w = world();
  w.kv.setItem(LS.tokenSeal, blobFor(w));
  w.kv.setItem(LS.tokenSealOn, "1");
  w.kv.removeItem(LS.deviceToken);
  assert.equal(settleAtBoot(w.kv), "repair-finished-seal");
  assert.deepEqual(plainLeft(w.kv), []);
  assert.deepEqual(opened(w.kv), w.tokens);
});

test("unseal cut with some plaintext written, flag still on: the blob is the truth and the copies go", () => {
  const w = sealed(world());
  w.kv.setItem(LS.deviceToken, TA);
  assert.equal(settleAtBoot(w.kv), "repair-finished-seal");
  assert.deepEqual(plainLeft(w.kv), []);
  assert.equal(w.kv.getItem(LS.tokenSealOn), "1");
});

test("unseal cut after the flag cleared, blob still there: the plaintext is whole, so the blob goes", () => {
  const w = sealed(world());
  for (const [k, v] of [[LS.deviceToken, TA], [parkedKeyFor(LS.deviceToken, w.b), TB], [parkedKeyFor(LS.deviceToken, w.c), TG]]) w.kv.setItem(k, v);
  w.kv.removeItem(LS.tokenSealOn);
  assert.equal(settleAtBoot(w.kv), "repair-finished-unseal");
  assert.equal(w.kv.getItem(LS.tokenSeal), null);
  assert.deepEqual(collectTokens(w.kv), w.tokens);
});

test("flag off over a blob that holds a desktop plaintext lacks: never deleted, the mode comes back on", () => {
  const w = sealed(world());
  w.kv.removeItem(LS.tokenSealOn);
  w.kv.setItem(LS.deviceToken, TA);
  assert.equal(settleAtBoot(w.kv), "repair-finished-seal");
  assert.equal(w.kv.getItem(LS.tokenSealOn), "1");
  assert.deepEqual(opened(w.kv), w.tokens);
  assert.deepEqual(plainLeft(w.kv), []);
});

test("flag on with no blob: the flag goes, plaintext is left alone", () => {
  const w = world();
  w.kv.setItem(LS.tokenSealOn, "1");
  assert.equal(settleAtBoot(w.kv), "repair-no-blob");
  assert.equal(w.kv.getItem(LS.tokenSealOn), null);
  assert.deepEqual(collectTokens(w.kv), w.tokens);
});

test("bytes this build cannot read are never deleted, nor is any plaintext beside them", () => {
  const w = world();
  w.kv.setItem(LS.tokenSeal, JSON.stringify({ v: 2, sealed: "by a newer build" }));
  w.kv.setItem(LS.tokenSealOn, "1");
  assert.equal(settleAtBoot(w.kv), "blob-unreadable");
  assert.ok(w.kv.getItem(LS.tokenSeal));
  assert.deepEqual(collectTokens(w.kv), w.tokens);
  w.kv.removeItem(LS.tokenSealOn);
  assert.equal(settleAtBoot(w.kv), "plain");
  assert.ok(w.kv.getItem(LS.tokenSeal));
});

test("a plain token the blob does not list survives every repair: the deletes are bounded by its list", () => {
  const w = sealed(world());
  const later = parkedKeyFor(LS.deviceToken, "late1234");
  w.kv.setItem(later, "token_landed_after_seal0");
  w.kv.setItem(LS.deviceToken, TA);
  settleAtBoot(w.kv);
  assert.equal(w.kv.getItem(later), "token_landed_after_seal0");
  assert.equal(w.kv.getItem(LS.deviceToken), null);
});

test("a desktop re-paired as passive after sealing keeps its plain token, though the blob lists it", () => {
  const w = sealed(world());
  w.kv.setItem(parkedKeyFor(LS.deviceToken, w.b), "passive_token_0000000000");
  w.kv.setItem(parkedKeyFor(LS.passive, w.b), "1");
  assert.equal(settleAtBoot(w.kv), "sealed");
  assert.equal(w.kv.getItem(parkedKeyFor(LS.deviceToken, w.b)), "passive_token_0000000000");
  assert.equal(unsealWritePlan(w.kv, w.tokens).some((o) => o.key === parkedKeyFor(LS.deviceToken, w.b)), false);
});

test("a bare token with no active host: kept unless it is the twin of a parked copy", () => {
  const twin = shim({ [LS.deviceToken]: TB, [parkedKeyFor(LS.deviceToken, "abcd1234")]: TB });
  const toks = collectTokens(twin);
  assert.deepEqual(toks, { abcd1234: TB });
  assert.deepEqual(commitSeal(twin, wrap(toks), toks), { ok: true });
  assert.equal(twin.getItem(LS.deviceToken), null);

  const stray = shim({ [LS.deviceToken]: TA, [parkedKeyFor(LS.deviceToken, "abcd1234")]: TB });
  const toks2 = collectTokens(stray);
  assert.deepEqual(commitSeal(stray, wrap(toks2), toks2), { ok: true });
  assert.equal(stray.getItem(LS.deviceToken), TA, "no other copy of it exists");
});

// ── Every cut, not only the named ones ───────────────────────────────────

const ended = (kv, tokens) => {
  const on = kv.getItem(LS.tokenSealOn) === "1";
  assert.equal(!!kv.getItem(LS.tokenSeal), on, "flag and blob agree");
  assert.equal(plainLeft(kv).length > 0, !on, "plaintext only when the mode is off");
  assert.deepEqual(truth(kv), tokens);
};

/** Cut `act` after n writes, for every n; boot, cut THAT after m writes, for every m; boot again. */
function walk(start, act) {
  for (let n = 0; ; n++) {
    const first = start();
    let whole = true;
    const probe = dying(first.kv, n);
    const write = { setItem: probe.setItem, removeItem: probe.removeItem };
    const counted = { ...probe, getItem: first.kv.getItem, key: first.kv.key, get length() { return first.kv.length; },
      setItem: (k, v) => { try { write.setItem(k, v); } catch (e) { whole = false; throw e; } },
      removeItem: (k) => { try { write.removeItem(k); } catch (e) { whole = false; throw e; } } };
    act(counted, first);
    assert.deepEqual(truth(first.kv), first.tokens, `cut after ${n} writes: a token is gone`);
    if (first.lan) assert.deepEqual(truthLan(first.kv, first.tokens), first.lan, `cut after ${n} writes: an identity is gone`);
    for (let m = 0; m < 12; m++) {
      const w = { kv: shim(Object.fromEntries(first.kv.m)), tokens: first.tokens };
      try { settleAtBoot(dying(w.kv, m)); } catch { /* the second kill */ }
      assert.deepEqual(truth(w.kv), w.tokens, `cut after ${n}, boot cut after ${m}: a token is gone`);
      if (first.lan) assert.deepEqual(truthLan(w.kv, w.tokens), first.lan, `cut after ${n}, boot cut after ${m}: an identity is gone`);
      settleAtBoot(w.kv);
      ended(w.kv, w.tokens);
      if (first.lan) endedLan(w.kv, w.tokens, first.lan);
    }
    if (whole) { assert.ok(n > 3, "the walk reached the end of the writes"); return; }
  }
}

test("a seal killed at ANY write, and the boot after it killed at any write, loses no token", () => {
  walk(world, (kv, w) => { commitSeal(kv, wrap(w.tokens), w.tokens); });
});

test("an unseal killed at ANY write, and the boot after it killed at any write, loses no token", () => {
  walk(() => sealed(world()), (kv, w) => { commitUnseal(kv, w.tokens); });
});

test("a re-wrap killed at its one write leaves a blob that opens", () => {
  const w = sealed(world());
  const more = { ...w.tokens, abcd9999: "token_for_new_pair_00000" };
  assert.equal(commitRewrap(dying(w.kv, 0), wrap(more), more).ok, false);
  assert.deepEqual(opened(w.kv), w.tokens);
});

// ── The LAN identity, sealed with its token ──────────────────────────────

const IA = { hostId: "deska000", secret: "a".repeat(32) };
const IB = { hostId: "deskb000", secret: "b".repeat(32) };
const ISTALE = { hostId: "deska000", secret: "z".repeat(32) };
const SECRETS = [IA, IB, ISTALE].map((i) => i.secret);

/** `world()` plus identities: A's on the bare key (and a stale parked copy), B's parked, the removed desktop has none. */
function lanWorld() {
  const w = world();
  w.kv.setItem(LS.lanIdentity, JSON.stringify(IA));
  w.kv.setItem(parkedKeyFor(LS.lanIdentity, w.a), JSON.stringify(ISTALE));
  w.kv.setItem(parkedKeyFor(LS.lanIdentity, w.b), JSON.stringify(IB));
  return { ...w, lan: { [w.a]: IA, [w.b]: IB } };
}

const wrapLan = (tokens, lan) => ({ ct: Buffer.from(sealPlaintext(tokens, lan)).toString("base64"), nonce: "bm9uY2U=" });
const openedText = (kv) => Buffer.from(parseSealBlob(kv.getItem(LS.tokenSeal)).ct, "base64").toString();
/** Where every identity is, by the tokens' rule. */
function truthLan(kv, tokens) {
  return kv.getItem(LS.tokenSealOn) === "1" && kv.getItem(LS.tokenSeal) ? readSealLan(openedText(kv)) : collectIdentities(kv, Object.keys(tokens));
}
const secretsLeft = (kv) => [...kv.m.entries()].filter(([k, v]) => k !== LS.tokenSeal && SECRETS.some((s) => v.includes(s)));
function endedLan(kv, tokens, lan) {
  assert.equal(secretsLeft(kv).length > 0, kv.getItem(LS.tokenSealOn) !== "1", "a plain identity only when the mode is off");
  assert.deepEqual(truthLan(kv, tokens), lan);
}
/** Sealed by a build from before identities: the blob holds tokens only, the identities are plain. */
function oldSealed() {
  const w = sealed(world());
  w.kv.setItem(LS.lanIdentity, JSON.stringify(IA));
  w.kv.setItem(parkedKeyFor(LS.lanIdentity, w.b), JSON.stringify(IB));
  return { ...w, lan: { [w.a]: IA, [w.b]: IB } };
}
function sealedLan(w) {
  assert.deepEqual(commitSeal(w.kv, wrapLan(w.tokens, w.lan), w.tokens, w.lan), { ok: true });
  return w;
}

test("identities collected: bare is the active desktop's and beats the parked copy; only for the desktops asked; none for a passive one", () => {
  const w = lanWorld();
  assert.deepEqual(collectIdentities(w.kv, Object.keys(w.tokens)), w.lan);
  assert.deepEqual(collectIdentities(w.kv, [w.b]), { [w.b]: IB });
  w.kv.setItem(parkedKeyFor(LS.passive, w.b), "1");
  assert.deepEqual(collectIdentities(w.kv, Object.keys(w.tokens)), { [w.a]: IA });
  w.kv.setItem(LS.lanIdentity, "{not json");
  assert.deepEqual(collectIdentities(w.kv, [w.a]), { [w.a]: ISTALE }, "bytes that are no identity are not one");
});

test("seal plan with identities: blob, flag, the token deletes, THEN every plain identity the blob lists", () => {
  const w = lanWorld();
  const blob = { v: 1, ...wrapLan(w.tokens, w.lan), hosts: Object.keys(w.tokens).sort(), lan: Object.keys(w.lan).sort() };
  const ops = sealWritePlan(w.kv, blob);
  assert.deepEqual(ops.slice(0, 2).map((o) => [o.op, o.key]), [["set", LS.tokenSeal], ["set", LS.tokenSealOn]]);
  assert.ok(ops.slice(2).every((o) => o.op === "remove"));
  assert.ok(ops.slice(2, -3).every((o) => o.key.includes("deviceToken")));
  assert.equal(ops.at(-3).key, LS.lanIdentity, "the bare key first, as for the tokens");
  assert.deepEqual(new Set(ops.slice(-2).map((o) => o.key)), new Set([parkedKeyFor(LS.lanIdentity, w.a), parkedKeyFor(LS.lanIdentity, w.b)]));
  const noList = sealWritePlan(w.kv, { ...blob, lan: undefined });
  assert.ok(!noList.some((o) => o.key.includes("lanIdentity")), "a blob that lists no identity deletes none");
});

test("unseal plan with identities: after the tokens and before the flag, bare for the active desktop, parked for the rest", () => {
  const w = sealedLan(lanWorld());
  const ops = unsealWritePlan(w.kv, w.tokens, w.lan);
  assert.deepEqual(ops.slice(3), [
    { op: "set", key: LS.lanIdentity, value: JSON.stringify(IA) },
    { op: "set", key: parkedKeyFor(LS.lanIdentity, w.b), value: JSON.stringify(IB) },
    { op: "remove", key: LS.tokenSealOn },
    { op: "remove", key: LS.tokenSeal },
  ]);
});

test("seal then unseal with identities: no secret in plain storage between, each back on its own key after", () => {
  const w = sealedLan(lanWorld());
  assert.deepEqual(secretsLeft(w.kv), []);
  assert.deepEqual(parseSealBlob(w.kv.getItem(LS.tokenSeal)).lan, [w.a, w.b].sort());
  assert.deepEqual(readSealPlaintext(openedText(w.kv)), w.tokens);
  assert.deepEqual(readSealLan(openedText(w.kv)), w.lan);
  assert.deepEqual(commitUnseal(w.kv, w.tokens, w.lan), { ok: true });
  assert.deepEqual(JSON.parse(w.kv.getItem(LS.lanIdentity)), IA);
  assert.deepEqual(JSON.parse(w.kv.getItem(parkedKeyFor(LS.lanIdentity, w.b))), IB);
  assert.equal(w.kv.getItem(LS.tokenSeal), null);
});

test("an identity that landed or left while the sheet was up refuses the commit, and nothing moves", () => {
  const landed = lanWorld();
  const before = collectIdentities(landed.kv, [landed.b]);
  assert.deepEqual(commitSeal(landed.kv, wrapLan(landed.tokens, before), landed.tokens, before), { ok: false, why: "changed" });
  assert.equal(landed.kv.getItem(LS.tokenSeal), null);
  assert.equal(landed.kv.getItem(LS.deviceToken), TA);
  const left = lanWorld();
  left.kv.removeItem(parkedKeyFor(LS.lanIdentity, left.b));
  assert.deepEqual(commitSeal(left.kv, wrapLan(left.tokens, left.lan), left.tokens, left.lan), { ok: false, why: "changed" });
  assert.equal(left.kv.getItem(LS.tokenSealOn), null);
});

test("an identity is sealed with its token or not at all: one for a desktop outside the map goes nowhere", () => {
  const w = lanWorld();
  const extra = { ...w.lan, zzzz9999: IB };
  assert.deepEqual(readSealLan(sealPlaintext(w.tokens, extra)), w.lan);
  assert.equal(sealPlaintext(w.tokens, { zzzz9999: IB }), sealPlaintext(w.tokens), "and with none, the text is the token map it always was");
});

test("a build from before identities reads the new text and the new blob as tokens, and deletes nothing of theirs", () => {
  const w = sealedLan(lanWorld());
  // What that build's reader does: host-id keys with token values. `lan` is neither.
  assert.deepEqual(readSealPlaintext(openedText(w.kv)), w.tokens);
  const { lan: _unknownToIt, ...asItSeesIt } = JSON.parse(w.kv.getItem(LS.tokenSeal));
  assert.deepEqual(parseSealBlob(JSON.stringify(asItSeesIt)).hosts, Object.keys(w.tokens).sort());
});

test("a blob from before identities: the plain identities stay through every boot, and a re-wrap takes them in", () => {
  const w = oldSealed();
  assert.equal(parseSealBlob(w.kv.getItem(LS.tokenSeal)).lan, undefined);
  assert.deepEqual(readSealLan(openedText(w.kv)), {});
  assert.equal(settleAtBoot(w.kv), "sealed");
  assert.deepEqual(collectIdentities(w.kv, Object.keys(w.tokens)), w.lan, "the only copy, so it is not touched");
  assert.deepEqual(commitRewrap(w.kv, wrapLan(w.tokens, w.lan), w.tokens, w.lan), { ok: true });
  assert.deepEqual(readSealLan(openedText(w.kv)), w.lan);
  assert.deepEqual(secretsLeft(w.kv), []);
});

test("a list of identities that is not a list, or names a desktop the blob lacks, deletes no identity", () => {
  const w = lanWorld();
  for (const lan of ["x", { a: 1 }, ["no such id!"], ["zzzz9999"]]) {
    const kv = shim(Object.fromEntries(w.kv.m));
    kv.setItem(LS.tokenSeal, JSON.stringify({ v: 1, ...wrap(w.tokens), hosts: Object.keys(w.tokens).sort(), lan }));
    kv.setItem(LS.tokenSealOn, "1");
    settleAtBoot(kv);
    assert.deepEqual(collectIdentities(kv, Object.keys(w.tokens)), w.lan, JSON.stringify(lan));
  }
});

test("a desktop re-paired as passive after sealing gets no identity back on unseal", () => {
  const w = sealedLan(lanWorld());
  w.kv.setItem(parkedKeyFor(LS.passive, w.b), "1");
  assert.deepEqual(commitUnseal(w.kv, w.tokens, w.lan), { ok: true });
  assert.equal(w.kv.getItem(parkedKeyFor(LS.lanIdentity, w.b)), null);
  assert.deepEqual(JSON.parse(w.kv.getItem(LS.lanIdentity)), IA);
});

test("an identity never decides: a flag-off blob goes once the tokens are covered, though an identity it lists is not", () => {
  const w = sealedLan(lanWorld());
  assert.deepEqual(commitUnseal(dying(w.kv, 5), w.tokens, { [w.a]: IA }), { ok: true }, "the blob's own delete is the write that died");
  assert.ok(w.kv.getItem(LS.tokenSeal));
  assert.equal(settleAtBoot(w.kv), "repair-finished-unseal");
  assert.equal(w.kv.getItem(LS.tokenSealOn), null);
  assert.deepEqual(collectTokens(w.kv), w.tokens);
});

test("an unseal that cannot write takes back the identities it wrote too", () => {
  const w = sealedLan(lanWorld());
  assert.deepEqual(commitUnseal(dying(w.kv, 4), w.tokens, w.lan), { ok: false, why: "storage" });
  const kv = shim(Object.fromEntries(w.kv.m));
  settleAtBoot(kv);
  endedLan(kv, w.tokens, w.lan);
});

test("a seal with identities killed at ANY write, and the boot after it killed at any write, loses no token and no identity", () => {
  walk(lanWorld, (kv, w) => { commitSeal(kv, wrapLan(w.tokens, w.lan), w.tokens, w.lan); });
});

test("an unseal with identities killed at ANY write, and the boot after it killed at any write, loses no token and no identity", () => {
  walk(() => sealedLan(lanWorld()), (kv, w) => { commitUnseal(kv, w.tokens, w.lan); });
});

test("a re-wrap that takes plain identities in, killed at ANY write, and the boot after it: none is lost, none stays plain", () => {
  for (let n = 0; n < 6; n++) {
    const w = oldSealed();
    commitRewrap(dying(w.kv, n), wrapLan(w.tokens, w.lan), w.tokens, w.lan);
    assert.deepEqual(truth(w.kv), w.tokens, `cut after ${n}`);
    const inBlob = readSealLan(openedText(w.kv));
    const whole = { ...collectIdentities(w.kv, Object.keys(w.tokens)), ...inBlob };
    assert.deepEqual(whole, w.lan, `cut after ${n}: an identity is in neither place`);
    settleAtBoot(w.kv);
    if (n > 0) endedLan(w.kv, w.tokens, w.lan);
    else assert.deepEqual(collectIdentities(w.kv, Object.keys(w.tokens)), w.lan, "the old blob stands and the plain copies with it");
  }
});

// ── The shape of what is stored ──────────────────────────────────────────

test("an unsealed text that is not a token map is null, and junk rows inside one are dropped", () => {
  assert.equal(readSealPlaintext("not json"), null);
  assert.equal(readSealPlaintext("[1]"), null);
  assert.deepEqual(readSealPlaintext(JSON.stringify({ abcd1234: TA, "NOT AN ID": TB, efgh5678: "short" })), { abcd1234: TA });
});

test("the identities in an unsealed text: none from a text without them, and junk rows are dropped", () => {
  assert.deepEqual(readSealLan("not json"), {});
  assert.deepEqual(readSealLan(JSON.stringify({ abcd1234: TA })), {});
  assert.deepEqual(readSealLan(JSON.stringify({ abcd1234: TA, lan: [IA] })), {});
  assert.deepEqual(readSealLan(JSON.stringify({ abcd1234: TA, lan: { abcd1234: IA, "NOT AN ID": IB, efgh5678: { hostId: "h", secret: "tiny" } } })), { abcd1234: IA });
});

test("a blob of any other shape does not parse", () => {
  for (const raw of [null, "", "{", "{}", JSON.stringify({ v: 1, ct: "a", nonce: "b" }), JSON.stringify({ v: 1, ct: "", nonce: "b", hosts: [] }), JSON.stringify({ v: 1, ct: "a", nonce: "b", hosts: ["no such id!"] })]) {
    assert.equal(parseSealBlob(raw), null, String(raw));
  }
});

test("the key and aad are constants: the hard reset drops deviceId, so nothing here may hang on it", () => {
  assert.match(TOKEN_ALIAS, /\.tokens$/);
  assert.equal(TOKEN_AAD, "tokens");
});
