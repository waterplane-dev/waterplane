/**
 * A lost store becomes a RECORD a person can see (design proposal 1).
 *
 * Rounds 2 and 4 made a lost store safe — moved aside, never overwritten — but
 * not visible: a corrupt `budget.json` silently turned a weekly cap off, a lost
 * `ui-usage.json` read as "never used", a lost `sent.json` as an empty list.
 * `jsonstore.ts` now keeps one record per loss (file, when, kind, error, where
 * the bytes went), persisted so a loss at boot is still there when the person
 * looks, bounded, and dismissable without touching any bytes.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BRAND, storeLossText } from "@waterplane/shared";

// env.ts (imported below) binds the state dir: keep it inside a scratch root,
// never a person's real one.
const scratch = mkdtempSync(join(tmpdir(), "wp-storeloss-"));
const boundDir = join(scratch, "state");
mkdirSync(boundDir, { recursive: true });
process.env[`${BRAND.envPrefix}ROOT`] = scratch;
process.env[`${BRAND.envPrefix}STATE_DIR`] = boundDir;
await import("../dist/env.js");

const js = await import("../dist/jsonstore.js");
const { readJsonGuardedDetail, recordWriteLoss, listStoreLosses, storeLossFor, dismissStoreLoss, setStoreLossFile, STORE_LOSS_KEEP, STORE_LOSS_FILE } = js;
const { boundHostStateDir } = await import("../dist/branddirs.js");

const isRoot = typeof process.getuid === "function" && process.getuid() === 0;

function fresh() {
  const dir = mkdtempSync(join(tmpdir(), "wp-storeloss-case-"));
  const logFile = join(dir, "losses", STORE_LOSS_FILE);
  setStoreLossFile(logFile);
  return { dir, logFile };
}

test("a corrupt store is one record: corrupt, where the bytes went, and whether they are still there", () => {
  const { dir, logFile } = fresh();
  const p = join(dir, "budget.json");
  writeFileSync(p, "{ not json");
  const r = readJsonGuardedDetail(p, null);
  const losses = listStoreLosses();
  assert.equal(losses.length, 1);
  const l = losses[0];
  assert.equal(l.kind, "corrupt");
  assert.equal(l.store, "budget.json");
  assert.equal(l.path, p);
  assert.equal(l.movedTo, r.corrupt.movedTo);
  assert.equal(l.movedToExists, true);
  assert.ok(l.error.length > 0);
  assert.equal(l.memoryOnly, undefined, "an explicit record file persists");
  assert.ok(existsSync(logFile), "persisted with the atomic write");
  assert.deepEqual(storeLossFor(p)?.id, l.id);
  assert.match(storeLossText(l), /budget\.json was damaged .*kept its bytes as .*\.corrupt-/);

  rmSync(l.movedTo);
  assert.equal(listStoreLosses()[0].movedToExists, false, "checked on every read");
  assert.match(storeLossText(listStoreLosses()[0]), /since been removed/);
});

test("an unreadable store is recorded unreadable; keepUnreadable records movedTo null", { skip: isRoot && "root reads anything" }, (t) => {
  const { dir } = fresh();
  const a = join(dir, "a.json");
  const b = join(dir, "b.json");
  writeFileSync(a, "{}");
  writeFileSync(b, "{}");
  chmodSync(a, 0o000);
  chmodSync(b, 0o000);
  t.after(() => { try { chmodSync(b, 0o600); } catch { /* moved */ } });
  readJsonGuardedDetail(a, null);
  readJsonGuardedDetail(b, null, undefined, { keepUnreadable: true });
  const la = storeLossFor(a);
  const lb = storeLossFor(b);
  assert.equal(la.kind, "unreadable");
  assert.ok(la.movedTo && la.movedToExists);
  assert.equal(lb.kind, "unreadable");
  assert.equal(lb.movedTo, null);
  assert.equal("movedToExists" in lb, false, "nothing to look for, so nothing claimed");
  assert.match(storeLossText(lb), /left where it is/);
});

test("absent and valid files record nothing", () => {
  const { dir } = fresh();
  readJsonGuardedDetail(join(dir, "none.json"), null);
  writeFileSync(join(dir, "ok.json"), "{}");
  readJsonGuardedDetail(join(dir, "ok.json"), null);
  assert.deepEqual(listStoreLosses(), []);
});

test("recordWriteLoss: a save that keeps failing is ONE record with a count", () => {
  const { dir } = fresh();
  const p = join(dir, "sent.json");
  recordWriteLoss(p, new Error("ENOSPC: no space left on device"), 1000);
  recordWriteLoss(p, new Error("ENOSPC: no space left on device"), 2000);
  recordWriteLoss(p, new Error("EACCES: permission denied"), 3000);
  const all = listStoreLosses();
  assert.equal(all.length, 1);
  assert.equal(all[0].kind, "write-failed");
  assert.equal(all[0].at, 1000);
  assert.equal(all[0].lastAt, 3000);
  assert.equal(all[0].count, 3);
  assert.match(all[0].error, /EACCES/);
  assert.equal(all[0].movedTo, null);
  assert.match(storeLossText(all[0]), /sent\.json could not be saved .*3 times/);
});

test("a write failure whose own record could not be saved still coalesces (memory-only record)", () => {
  const { dir } = fresh();
  const p = join(dir, "sent.json");
  // The record file cannot be written: a directory sits where it should be.
  setStoreLossFile(join(dir, "blocked", STORE_LOSS_FILE));
  mkdirSync(join(dir, "blocked", STORE_LOSS_FILE, "x"), { recursive: true });
  for (let i = 1; i <= STORE_LOSS_KEEP + 20; i++) recordWriteLoss(p, new Error("ENOSPC"), i * 1000);
  const all = listStoreLosses().filter((r) => r.path === p);
  assert.equal(all.length, 1, "one record, never fifty");
  assert.equal(all[0].count, STORE_LOSS_KEEP + 20);
});

test("a real store's swallowed write failure is recorded and rides its reading", async () => {
  const { dir } = fresh();
  const { UiStats } = await import("../dist/uistats.js");
  const root = join(dir, "root");
  const stats = new UiStats(root);
  const { hostStateDir } = await import("../dist/branddirs.js");
  // A directory where the file should be: the rename fails, the store stays up.
  mkdirSync(join(hostStateDir(root), "ui-usage.json", "blocker"), { recursive: true });
  stats.merge({ "toolbar:diff": 1 });
  stats.flush();
  const loss = stats.loss();
  assert.equal(loss?.kind, "write-failed");
  assert.equal(loss?.store, "ui-usage.json");
  assert.equal(stats.get().features["toolbar:diff"].count, 1, "still serving from memory");
});

test("the record survives a re-import (a loss at boot is looked at after a restart)", async () => {
  const { dir, logFile } = fresh();
  const p = join(dir, "ui-usage.json");
  writeFileSync(p, "[1,");
  readJsonGuardedDetail(p, null);
  const id = listStoreLosses()[0].id;
  const again = await import(`../dist/jsonstore.js?reimport=${Date.now()}`);
  again.setStoreLossFile(logFile);
  const back = again.listStoreLosses();
  assert.equal(back.length, 1);
  assert.equal(back[0].id, id);
  assert.equal(back[0].kind, "corrupt");
  assert.equal(JSON.parse(readFileSync(logFile, "utf8")).length, 1);
});

test(`bounded: the newest ${STORE_LOSS_KEEP} are kept`, () => {
  const { dir, logFile } = fresh();
  for (let i = 0; i < STORE_LOSS_KEEP + 10; i++) recordWriteLoss(join(dir, `s${i}.json`), new Error("x"), 1000 + i);
  const all = listStoreLosses();
  assert.equal(all.length, STORE_LOSS_KEEP);
  assert.equal(all[0].store, `s${STORE_LOSS_KEEP + 9}.json`, "newest first");
  assert.equal(all.at(-1).store, "s10.json", "the oldest ten dropped");
  assert.equal(JSON.parse(readFileSync(logFile, "utf8")).length, STORE_LOSS_KEEP);
});

test("dismiss hides a record, keeps the bytes, persists, and says when there is nothing to dismiss", async () => {
  const { dir, logFile } = fresh();
  const p = join(dir, "budget.json");
  writeFileSync(p, "nope");
  readJsonGuardedDetail(p, null);
  const l = listStoreLosses()[0];
  assert.deepEqual(dismissStoreLoss(l.id), { ok: true });
  assert.deepEqual(listStoreLosses(), []);
  assert.equal(storeLossFor(p), undefined);
  assert.ok(existsSync(l.movedTo), "dismissing never deletes the .corrupt bytes");
  assert.deepEqual(dismissStoreLoss(l.id), { ok: true, already: true });
  const miss = dismissStoreLoss("no-such-id");
  assert.equal(miss.ok, false);
  assert.ok(miss.why.length > 0);
  const again = await import(`../dist/jsonstore.js?dismiss=${Date.now()}`);
  again.setStoreLossFile(logFile);
  assert.deepEqual(again.listStoreLosses(), [], "the dismissal survives a restart");
  // A later loss of the same store is a NEW record, shown again.
  writeFileSync(p, "still nope");
  readJsonGuardedDetail(p, null);
  assert.equal(listStoreLosses().length, 1);
  assert.notEqual(listStoreLosses()[0].id, l.id);
});

test("a damaged record file is set aside by hand, never recorded inside itself", () => {
  const { logFile } = fresh();
  mkdirSync(join(logFile, ".."), { recursive: true });
  writeFileSync(logFile, "{{");
  assert.deepEqual(listStoreLosses(), [], "a damaged record file reads as empty (its bytes set aside)");
  recordWriteLoss(join(logFile, "..", "x.json"), new Error("boom"));
  assert.equal(listStoreLosses().length, 1);
  assert.equal(listStoreLosses()[0].store, "x.json");
});

test("default: only a store inside the bound state dir persists; any other is memory-only", () => {
  setStoreLossFile(undefined);
  assert.equal(boundHostStateDir(), boundDir);
  const inside = join(boundDir, "sent.json");
  const outside = join(mkdtempSync(join(tmpdir(), "wp-storeloss-out-")), "sent.json");
  recordWriteLoss(inside, new Error("ENOSPC"));
  recordWriteLoss(outside, new Error("ENOSPC"));
  const onDisk = JSON.parse(readFileSync(join(boundDir, STORE_LOSS_FILE), "utf8"));
  assert.deepEqual(onDisk.map((r) => r.path), [inside]);
  assert.equal(storeLossFor(inside).memoryOnly, undefined);
  assert.equal(storeLossFor(outside).memoryOnly, true);
});

test("the storage reading carries the undismissed losses", async () => {
  const { dir } = fresh();
  const { hostStoreReport } = await import("../dist/hoststore.js");
  recordWriteLoss(join(dir, "budget.json"), new Error("EIO"));
  const rep = hostStoreReport(join(dir, "root"));
  assert.equal(rep.losses.length, 1);
  assert.equal(rep.losses[0].store, "budget.json");
  dismissStoreLoss(rep.losses[0].id);
  assert.deepEqual(hostStoreReport(join(dir, "root")).losses, []);
});

test("budget: a cap the person saves after the loss is known again — the sheet line goes, the record stays", async () => {
  fresh();
  const { BudgetStore } = await import("../dist/budget.js");
  const { hostStateDir } = await import("../dist/branddirs.js");
  const p = join(hostStateDir(scratch), "budget.json");
  mkdirSync(hostStateDir(scratch), { recursive: true });
  writeFileSync(p, "{ not json");
  const b = new BudgetStore(scratch, () => null);
  assert.equal(b.loss()?.kind, "corrupt", "before any save the cap shown is the default, not a choice");
  await new Promise((r) => setTimeout(r, 15));
  b.set({ ...b.get(), enabled: true });
  assert.equal(b.loss(), undefined, "after the person's own save the switch shows what they chose");
  assert.ok(storeLossFor(p), "the record itself stays until dismissed");
  assert.ok(new BudgetStore(scratch, () => null).loss() === undefined, "same answer after a restart");
});
