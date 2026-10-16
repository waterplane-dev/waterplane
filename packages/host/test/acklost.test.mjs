// A LOST ack ledger fails closed on a pre-loss re-send (`acks.ts`'s
// `preLossRefusal`, the rule in `shared/sendstamp.ts`).
//
// The ledger is real (a corrupt acks.json in a scratch state dir), the clock is
// the ledger's own `lost.at`, and the stamps are what the phone's queue sends.
// The route side — that durableOp / session.input / backlog.add actually ask it
// and refuse without running — is `scripts/e2e-acklost.mjs`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BRAND, LOST_LEDGER_REFUSAL } from "@waterplane/shared";

const scratch = mkdtempSync(join(tmpdir(), "wp-acklost-"));
process.env[`${BRAND.envPrefix}ROOT`] ??= scratch;
const { AckLedger, ACK_TTL_MS, ACK_WRITE_FAILED, ackWriteNotice } = await import("../dist/acks.js");

function ledger({ corrupt }) {
  const root = mkdtempSync(join(tmpdir(), "wp-acklost-root-"));
  const dir = join(root, BRAND.stateDirName);
  mkdirSync(dir, { recursive: true });
  if (corrupt) writeFileSync(join(dir, "acks.json"), '{"updatedAt":1,"acks":{"x":{"ts":');
  const orig = console.error;
  console.error = () => {};
  try { return new AckLedger(root); } finally { console.error = orig; }
}

test("a lost ledger refuses an unknown ackId first sent before the loss", () => {
  const l = ledger({ corrupt: true });
  const at = l.lost.at;
  // First sent ten minutes before the loss, re-sent a minute after it.
  const now = at + 60_000;
  const stamp = { firstSentAt: now - 11 * 60_000, sentAt: now };
  assert.equal(l.preLossRefusal(stamp, now), LOST_LEDGER_REFUSAL);
});

test("a fresh send after the loss runs; a message with no stamp runs (older client)", () => {
  const l = ledger({ corrupt: true });
  const now = l.lost.at + 60_000;
  assert.equal(l.preLossRefusal({ firstSentAt: now, sentAt: now }, now), null, "fresh");
  assert.equal(l.preLossRefusal({}, now), null, "no firstSentAt");
  assert.equal(l.preLossRefusal(undefined, now), null, "no stamp at all");
});

test("the refusal is skew-free: a phone clock an hour off either way changes nothing", () => {
  const l = ledger({ corrupt: true });
  const now = l.lost.at + 60_000;
  for (const skew of [-3_600_000, 0, 3_600_000]) {
    const phoneNow = now + skew;
    assert.equal(l.preLossRefusal({ firstSentAt: phoneNow - 10 * 60_000, sentAt: phoneNow }, now), LOST_LEDGER_REFUSAL, `pre-loss, skew ${skew}`);
    assert.equal(l.preLossRefusal({ firstSentAt: phoneNow, sentAt: phoneNow }, now), null, `fresh, skew ${skew}`);
  }
});

test("past one TTL nothing is judged; an intact ledger judges nothing", () => {
  const l = ledger({ corrupt: true });
  const late = l.lost.until + 1;
  assert.equal(l.lost.until - l.lost.at, ACK_TTL_MS);
  assert.equal(l.preLossRefusal({ firstSentAt: 0, sentAt: late }, late), null);
  const ok = ledger({ corrupt: false });
  assert.equal(ok.lost, null);
  assert.equal(ok.preLossRefusal({ firstSentAt: 0, sentAt: Date.now() }), null);
});

// ── A ledger that cannot be WRITTEN ─────────────────────────────────────────
//
// The op an ackId names has already run by the time `remember` is called, so a
// failed write cannot refuse it — the verdict still holds in memory and still
// answers a retry this boot. What it can no longer do is survive a restart, and
// that used to be swallowed in silence. Now it is kept, logged once and TOLD
// once (main.ts turns `onWriteError` into a feed row), and it clears itself
// when the disk comes back.
test("a state dir the ledger cannot write: the verdict still answers, the failure is told once, and it clears", { skip: process.getuid?.() === 0 && "root ignores directory modes" }, () => {
  const root = mkdtempSync(join(tmpdir(), "wp-ackwrite-root-"));
  const dir = join(root, BRAND.stateDirName);
  mkdirSync(dir, { recursive: true });
  const l = new AckLedger(root);
  const told = [];
  l.onWriteError = (m) => told.push(m);
  const logs = { e: console.error, l: console.log };
  const errs = [];
  console.error = (...a) => errs.push(a.join(" "));
  console.log = () => {};
  chmodSync(dir, 0o500);
  try {
    l.remember("op-1", { ok: true, op: true, sessionId: "s1" });
    assert.equal(l.get("op-1")?.sessionId, "s1", "a retry this boot is still re-acked, never re-run");
    assert.match(l.lastWriteError() ?? "", /EACCES/);
    l.remember("op-2", { ok: true, op: true });
    assert.equal(told.length, 1, "told once per failing streak, not once per op");
    assert.match(told[0], /EACCES/);
    assert.equal(errs.filter((e) => e.includes(ACK_WRITE_FAILED)).length, 1, "logged once, rate-limited");
    const n = ackWriteNotice(told[0]);
    assert.match(n.body, /a retry after a restart may run twice/i);
    assert.equal(n.tag, "acks-write");
  } finally {
    chmodSync(dir, 0o700);
    console.error = logs.e;
    console.log = logs.l;
  }
  // The disk is writable again: the next write lands and the error clears.
  console.log = () => {};
  try { l.remember("op-3", { ok: true, op: true }); } finally { console.log = logs.l; }
  assert.equal(l.lastWriteError(), null);
  const onDisk = JSON.parse(readFileSync(join(dir, "acks.json"), "utf8"));
  assert.deepEqual(Object.keys(onDisk.acks).sort(), ["op-1", "op-2", "op-3"], "what memory held all along reaches the disk");
});

test("a failed write never throws into the request path, even when the listener does", () => {
  const root = mkdtempSync(join(tmpdir(), "wp-ackwrite-throw-"));
  // A FILE where the state dir should be: every write fails (ENOTDIR/EEXIST), whoever runs it.
  writeFileSync(join(root, BRAND.stateDirName), "not a directory");
  const l = new AckLedger(root);
  l.onWriteError = () => { throw new Error("listener blew up"); };
  const o = console.error; console.error = () => {};
  try {
    assert.doesNotThrow(() => l.remember("op-x", { ok: true, op: true }));
    assert.equal(l.flush(), false);
  } finally { console.error = o; }
  assert.ok(l.lastWriteError());
  assert.equal(l.get("op-x")?.ok, true);
});
