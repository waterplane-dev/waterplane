// A LOST ack ledger fails closed on a pre-loss re-send (`acks.ts`'s
// `preLossRefusal`, the rule in `shared/sendstamp.ts`).
//
// The ledger is real (a corrupt acks.json in a scratch state dir), the clock is
// the ledger's own `lost.at`, and the stamps are what the phone's queue sends.
// The route side — that durableOp / session.input / backlog.add actually ask it
// and refuse without running — is `scripts/e2e-acklost.mjs`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BRAND, LOST_LEDGER_REFUSAL } from "@waterplane/shared";

const scratch = mkdtempSync(join(tmpdir(), "wp-acklost-"));
process.env[`${BRAND.envPrefix}ROOT`] ??= scratch;
const { AckLedger, ACK_TTL_MS } = await import("../dist/acks.js");

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
