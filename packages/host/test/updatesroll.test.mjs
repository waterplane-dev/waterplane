/**
 * The phone-tapped rollback and the update route: a rollback with a state snapshot never reports ok
 * without the state coming back (it is refused, or restored in the shutdown path after the last flush),
 * and `updates.apply` through the real dispatcher + ack ledger: a repeated ackId runs once, a
 * malformed target is answered in words.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync, readlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BRAND } from "@waterplane/shared";

const scratch = mkdtempSync(join(tmpdir(), "wp-roll-root-"));
process.env[`${BRAND.envPrefix}ROOT`] ??= scratch;
// Assigned, never `??=`: STATE_DIR does not follow ROOT, and without this the
// restore below ran against the desktop's real state dir on every test run —
// moving every live store into `.before-rollback-*` and leaving the fixture's
// `{"schema":2}` as the person's intents.
process.env[`${BRAND.envPrefix}STATE_DIR`] = join(scratch, "state");
const { rollback, runPendingRestore, hasPendingRestore } = await import("../dist/cli/selfupdate.js");
const { STATE_DIR } = await import("../dist/env.js");
assert.ok(STATE_DIR.startsWith(scratch), `refusing to run against a real state dir: ${STATE_DIR}`);
const { snapshotState } = await import("../dist/cli/statesnap.js");
const { dispatch } = await import("../dist/routes/index.js");
const { createWsOps } = await import("../dist/server/wsops.js");
const { AckLedger } = await import("../dist/acks.js");
const { UpdateApplier } = await import("../dist/updates/apply.js");

function install() {
  const dataDir = mkdtempSync(join(tmpdir(), "wp-roll-data-"));
  for (const v of ["0.9.0", "1.0.0"]) {
    mkdirSync(join(dataDir, "versions", v), { recursive: true });
    writeFileSync(join(dataDir, "versions", v, "release.json"), JSON.stringify({ name: "w", version: v }));
  }
  symlinkSync(join("versions", "1.0.0"), join(dataDir, "current"));
  mkdirSync(STATE_DIR, { recursive: true });
  writeFileSync(join(STATE_DIR, "intents.json"), JSON.stringify({ schema: 3 }));
  // the snapshot taken when 0.9.0 was left: schema 2
  const old = mkdtempSync(join(tmpdir(), "wp-roll-old-"));
  writeFileSync(join(old, "intents.json"), JSON.stringify({ schema: 2 }));
  snapshotState(old, join(dataDir, "state-snapshots", "0.9.0"), { from: "0.9.0", to: "1.0.0" });
  return { mode: { kind: "tarball", dataDir, version: "1.0.0", root: dataDir }, dataDir };
}
const cur = (d) => readlinkSync(join(d, "current")).split("/").pop();

test("rollback with a snapshot from the phone: refused whole when nothing can restore it later", () => {
  const { mode, dataDir } = install();
  const code = rollback(mode, true, "refuse");
  assert.equal(code, 1);
  assert.equal(cur(dataDir), "1.0.0", "nothing was switched");
  assert.equal(hasPendingRestore(), false);
});

test("rollback with a snapshot under a supervisor: swapped, restore owed, done by the shutdown path AFTER the last write", () => {
  const { mode, dataDir } = install();
  assert.equal(rollback(mode, true, "defer"), 0);
  assert.equal(cur(dataDir), "0.9.0");
  assert.equal(hasPendingRestore(), true);
  assert.equal(JSON.parse(readFileSync(join(STATE_DIR, "intents.json"), "utf8")).schema, 3, "not restored while the host still runs");
  // the host's shutdown flush rewrites its stores...
  writeFileSync(join(STATE_DIR, "intents.json"), JSON.stringify({ schema: 3, flushed: true }));
  // ...and only then the owed restore runs
  const said = runPendingRestore();
  assert.match(said, /restored 1 store/);
  assert.equal(JSON.parse(readFileSync(join(STATE_DIR, "intents.json"), "utf8")).schema, 2);
  assert.equal(hasPendingRestore(), false);
  assert.equal(runPendingRestore(), null, "owed once");
});

test("the rollback's receipt survives the owed restore of updates.json", () => {
  const { mode } = install();
  // the snapshot's own (pre-update) cache holds a catalogue but no receipt
  const snapDir = join(mode.dataDir, "state-snapshots", "0.9.0");
  writeFileSync(join(snapDir, "updates.json"), JSON.stringify({ raw: [], checkedAt: 7 }));
  const meta = JSON.parse(readFileSync(join(snapDir, "snapshot.json"), "utf8"));
  meta.files.push("updates.json");
  writeFileSync(join(snapDir, "snapshot.json"), JSON.stringify(meta));
  assert.equal(rollback(mode, true, "defer"), 0);
  const receipt = { lastResult: { ok: true, message: "Rolled back 1.0.0 → 0.9.0.", at: 5 }, lastApply: { target: { kind: "self-rollback" }, ok: true, message: "Rolled back", restart: "restarting", at: 6 } };
  writeFileSync(join(STATE_DIR, "updates.json"), JSON.stringify({ raw: [], checkedAt: 99, ...receipt }));
  assert.match(runPendingRestore(), /restored/);
  const after = JSON.parse(readFileSync(join(STATE_DIR, "updates.json"), "utf8"));
  assert.equal(after.checkedAt, 7, "the older cache is what came back");
  assert.deepEqual(after.lastResult, receipt.lastResult);
  assert.deepEqual(after.lastApply, receipt.lastApply);
});

// ── the route ─────────────────────────────────────────────────────────

function routeWorld() {
  const sent = [];
  const runs = [];
  const root = mkdtempSync(join(tmpdir(), "wp-route-ack-"));
  mkdirSync(join(root, BRAND.stateDirName), { recursive: true });
  const ctx = {
    wsRole: new Map(), attached: new Map(), send: (_ws, m) => sent.push(m), broadcast() {},
    netstats: { noteAckReplay() {} }, acks: new AckLedger(root),
    updateApplier: { busy: false, apply: async (t) => { runs.push(t); return { ok: true, message: "done", restart: "none" }; } },
  };
  ctx.durableOp = createWsOps(ctx).durableOp;
  const ws = {};
  ctx.attached.set(ws, new Set());
  return { ctx, ws, sent, runs };
}
const settle = () => new Promise((r) => setTimeout(r, 30));

test("updates.apply: a repeated ackId runs once and is re-acked", async () => {
  const { ctx, ws, sent, runs } = routeWorld();
  const msg = { t: "updates.apply", reqId: "r1", ackId: "ack-1", target: { kind: "restart" } };
  dispatch(ctx, ws, msg); await settle();
  dispatch(ctx, ws, msg); await settle();
  assert.equal(runs.length, 1, "at most once");
  assert.equal(sent.filter((m) => m.t === "op.ack" && m.ackId === "ack-1").length, 2, "both sends are answered");
  assert.equal(sent.filter((m) => m.t === "updates.result").length, 1);
});

test("updates.apply: a null or wrong-typed target is answered in words by the real applier, never thrown", async () => {
  const { ctx, ws, sent } = routeWorld();
  const base = mkdtempSync(join(tmpdir(), "wp-route-cfg-"));
  const checker = { status: () => ({ self: { canApply: false }, catalog: [] }), setLastResult() {}, setLastApply() {}, refresh() {} };
  ctx.updateApplier = new UpdateApplier({ pluginsDir: join(base, "plugins"), plugins: { entries: [], byId: () => null, loadOne: async () => null }, checker, supervised: () => false });
  let i = 0;
  for (const target of [null, 5, { kind: "plugin-update", id: 5 }, { kind: "plugin-install", repo: 5 }, { kind: "self-rollback", extra: 1 }]) {
    dispatch(ctx, ws, { t: "updates.apply", reqId: `q${i}`, ackId: `a${i++}`, target }); await settle();
  }
  const results = sent.filter((m) => m.t === "updates.result");
  assert.equal(results.length, 5);
  for (const r of results) { assert.equal(typeof r.message, "string"); assert.ok(["none", "manual", "offer", "restarting"].includes(r.restart)); }
  assert.equal(results[0].ok, false);
});
