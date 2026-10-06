/**
 * The persisted stores never crash boot and never lose their bytes silently.
 *
 *  - a truncated `vapid.json` used to throw out of `PushManager`'s constructor,
 *    i.e. the daemon did not start;
 *  - a corrupt store was "start fresh" — and the next save erased the only
 *    evidence anything had been lost;
 *  - the VAPID private key was written in place with the umask's mode;
 *  - a corrupt `acks.json` (the at-most-once memory) started empty in silence.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BRAND } from "@waterplane/shared";

// push.ts imports env.ts; keep anything it resolves inside a scratch root.
const scratch = mkdtempSync(join(tmpdir(), "wp-jsonstore-"));
process.env[`${BRAND.envPrefix}ROOT`] ??= scratch;

const { readJsonGuarded, readJsonGuardedDetail, writeJsonAtomic } = await import("../dist/jsonstore.js");
const { PushManager } = await import("../dist/push.js");
const { AckLedger } = await import("../dist/acks.js");

function stateDir() {
  const root = mkdtempSync(join(tmpdir(), "wp-jsonstore-root-"));
  const dir = join(root, BRAND.stateDirName);
  mkdirSync(dir, { recursive: true });
  return { root, dir };
}

/** Silence the one intended console.error per corrupt file, but count it. */
function quietly(fn) {
  const orig = console.error;
  const lines = [];
  console.error = (...a) => { lines.push(a.join(" ")); };
  try { return { value: fn(), lines }; } finally { console.error = orig; }
}

test("writeJsonAtomic applies the mode and leaves no tmp file", () => {
  const { dir } = stateDir();
  const p = join(dir, "secret.json");
  writeJsonAtomic(p, { k: 1 }, { mode: 0o600 });
  assert.deepEqual(JSON.parse(readFileSync(p, "utf8")), { k: 1 });
  assert.equal(statSync(p).mode & 0o777, 0o600);
  // A replace keeps the restrictive mode too (fresh tmp file, renamed over).
  writeJsonAtomic(p, { k: 2 }, { mode: 0o600 });
  assert.equal(statSync(p).mode & 0o777, 0o600);
  assert.deepEqual(readdirSync(dir), ["secret.json"]);
});

test("readJsonGuarded: absent is the fallback, silently", () => {
  const { dir } = stateDir();
  const { value, lines } = quietly(() => readJsonGuarded(join(dir, "nope.json"), { d: 1 }));
  assert.deepEqual(value, { d: 1 });
  assert.equal(lines.length, 0);
});

test("readJsonGuarded: a corrupt file is moved aside, logged once, fallback returned", () => {
  const { dir } = stateDir();
  const p = join(dir, "store.json");
  writeFileSync(p, '{"half": ');
  const { value, lines } = quietly(() => readJsonGuardedDetail(p, [], Array.isArray));
  assert.deepEqual(value.value, []);
  assert.equal(lines.length, 1);
  const kept = readdirSync(dir).filter((n) => n.startsWith("store.json.corrupt-"));
  assert.equal(kept.length, 1, "the bytes are kept under a .corrupt- name");
  assert.equal(readFileSync(join(dir, kept[0]), "utf8"), '{"half": ');
  assert.equal(value.corrupt.movedTo, join(dir, kept[0]));
  assert.ok(!readdirSync(dir).includes("store.json"), "the real name is free for the next write");
});

test("readJsonGuarded: valid JSON of the wrong shape counts as corrupt", () => {
  const { dir } = stateDir();
  const p = join(dir, "subs.json");
  writeFileSync(p, '{"not":"an array"}');
  const { value } = quietly(() => readJsonGuarded(p, [], Array.isArray));
  assert.deepEqual(value, []);
  assert.equal(readdirSync(dir).filter((n) => n.includes(".corrupt-")).length, 1);
});

test("a truncated vapid.json boots: keys regenerated, written 0600, old bytes kept", () => {
  const { root, dir } = stateDir();
  writeFileSync(join(dir, "vapid.json"), '{"publicKey":"BAbc');
  const { value: push, lines } = quietly(() => new PushManager(root));
  assert.equal(typeof push.publicKey, "string");
  assert.ok(push.publicKey.length > 20);
  const keys = join(dir, "vapid.json");
  assert.equal(statSync(keys).mode & 0o777, 0o600);
  assert.equal(JSON.parse(readFileSync(keys, "utf8")).publicKey, push.publicKey);
  assert.equal(readdirSync(dir).filter((n) => n.startsWith("vapid.json.corrupt-")).length, 1);
  assert.ok(lines.length >= 1);
  // And the regenerated keys are what the NEXT boot reads.
  assert.equal(new PushManager(root).publicKey, push.publicKey);
});

test("a fresh vapid.json is written 0600; an old wider one is tightened", () => {
  const { root, dir } = stateDir();
  const first = new PushManager(root);
  const keys = join(dir, "vapid.json");
  assert.equal(statSync(keys).mode & 0o777, 0o600);
  chmodSync(keys, 0o644); // the way an older build left it
  assert.equal(new PushManager(root).publicKey, first.publicKey);
  assert.equal(statSync(keys).mode & 0o777, 0o600);
});

test("a corrupt acks.json is kept, logged, and the loss is held for one TTL", async () => {
  const { ACK_TTL_MS } = await import("../dist/acks.js");
  const { root, dir } = stateDir();
  writeFileSync(join(dir, "acks.json"), '{"updatedAt":1,"acks":{"a1":{"ts":');
  const before = Date.now();
  const { value: ledger, lines } = quietly(() => new AckLedger(root));
  assert.ok(ledger.lost, "the ledger SAYS it lost its memory");
  assert.ok(ledger.lost.at >= before);
  assert.equal(ledger.lost.until, ledger.lost.at + ACK_TTL_MS);
  assert.ok(ledger.lost.movedTo && ledger.lost.movedTo.includes("acks.json.corrupt-"));
  assert.equal(readFileSync(ledger.lost.movedTo, "utf8"), '{"updatedAt":1,"acks":{"a1":{"ts":');
  assert.ok(lines.some((l) => l.includes("at-most-once")), "logged loudly");
  // It still works as a ledger from here on, and a save does not touch the kept copy.
  ledger.remember("b2", { ok: true, op: true });
  assert.equal(ledger.get("b2")?.ok, true);
  const reread = new AckLedger(root);
  assert.equal(reread.lost, null, "a good file is not a loss");
  assert.equal(reread.get("b2")?.ok, true);
  assert.equal(readdirSync(dir).filter((n) => n.startsWith("acks.json.corrupt-")).length, 1);
});

test("an absent acks.json is not a loss", () => {
  const { root } = stateDir();
  assert.equal(new AckLedger(root).lost, null);
});

test("auth.json: written atomically 0600; a corrupt one boots as no-password and is kept", async () => {
  const { AuthManager } = await import("../dist/auth.js");
  const { root, dir } = stateDir();
  const a = new AuthManager(root);
  a.setPassword("correct horse battery");
  const file = join(dir, "auth.json");
  assert.equal(statSync(file).mode & 0o777, 0o600);
  assert.ok(new AuthManager(root).verify("correct horse battery"));
  writeFileSync(file, '{"salt":"ab');
  const { value: b } = quietly(() => new AuthManager(root));
  assert.equal(b.isEnabled(), false, "deny-until-set, never a half-read hash");
  assert.equal(readdirSync(dir).filter((n) => n.startsWith("auth.json.corrupt-")).length, 1);
});

// A corrupt auth.json must never OPEN the gate: deny-until-set for LAN, and —
// when the damaged bytes may have held `gateTailscale` — Tailscale stays gated
// too until a person sets or clears the password from loopback. Loopback is
// never gated, so the desktop itself can always repair it.
test("auth.json corrupt: LAN denied, every token refused, a feed row says so", async () => {
  const { AuthManager, authLostNotice } = await import("../dist/auth.js");
  const { root, dir } = stateDir();
  const a = new AuthManager(root);
  a.setPassword("correct horse battery");
  const { token } = a.issueToken("phone", "lan");
  assert.ok(a.checkToken(token));
  writeFileSync(join(dir, "auth.json"), "\u0000\u0000garbage");
  const { value: b } = quietly(() => new AuthManager(root));
  assert.ok(b.lost, "the loss is recorded for the boot notice");
  assert.equal(b.needsToken("lan"), true);
  assert.equal(b.checkToken(token), false, "a token minted before the loss does not pass");
  assert.equal(b.needsToken("loopback"), false, "the desktop can always repair it");
  assert.equal(b.needsToken("tailscale"), false, "bytes that never mention the toggle leave Tailscale as it is by default");
  const n = authLostNotice(b.lost);
  assert.match(n.body, /auth\.json\.corrupt-/);
  assert.match(n.body, /LAN/);
});

test("auth.json corrupt with gateTailscale in its bytes: Tailscale stays gated until the password is set again", async () => {
  const { AuthManager, authLostNotice } = await import("../dist/auth.js");
  const { root, dir } = stateDir();
  const a = new AuthManager(root);
  a.setPassword("correct horse battery");
  a.setGateTailscale(true);
  assert.equal(a.needsToken("tailscale"), true);
  const file = join(dir, "auth.json");
  writeFileSync(file, readFileSync(file, "utf8").slice(0, -3)); // truncated mid-write
  const { value: b } = quietly(() => new AuthManager(root));
  assert.equal(b.isEnabled(), false);
  assert.equal(b.needsToken("tailscale"), true, "a lost file never opens the Tailscale gate");
  assert.equal(b.gateTailscale(), true, "and the settings screen says it is gated");
  assert.equal(b.needsToken("lan"), true);
  assert.match(authLostNotice(b.lost).body, /Tailscale/);
  // A person sets the password again (from loopback): the gate is KEPT on.
  b.setPassword("a new password here");
  assert.equal(b.needsToken("tailscale"), true);
  assert.equal(JSON.parse(readFileSync(file, "utf8")).gateTailscale, true);
  b.setGateTailscale(false);
  assert.equal(b.needsToken("tailscale"), false, "turning it off is the person's explicit tap");
});

test("auth.json absent is a fresh host: no loss, nothing gated but LAN", async () => {
  const { AuthManager } = await import("../dist/auth.js");
  const { root } = stateDir();
  const a = new AuthManager(root);
  assert.equal(a.lost, null);
  assert.equal(a.needsToken("tailscale"), false);
  assert.equal(a.needsToken("lan"), true);
});
