/**
 * `intents.json` that is not what this host expects, at boot.
 *
 *  - corrupt (or not a store at all): moved aside to `intents.json.corrupt-<ts>`,
 *    the store starts empty, a notice says so, and the next write never lands
 *    on top of the damaged bytes;
 *  - written by a NEWER host (`schema` past `STORE_SCHEMA`): its rows are read,
 *    but nothing is written, posted or fired — the file is never downgraded.
 *
 * Fake deps and a temp root, as in `intentsched.test.mjs`.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { IntentManager } = await import("../dist/intents/manager.js");
const { STORE_SCHEMA } = await import("../dist/intents/contract.js");
const { readJsonGuardedDetail, writeTextAtomic } = await import("../dist/jsonstore.js");

const REPO = "/tmp/waterplane-storefile-repo";

function storeOver(body, extra = {}) {
  const root = mkdtempSync(join(tmpdir(), "waterplane-storefile-"));
  const dir = join(root, ".waterplane");
  mkdirSync(dir, { recursive: true });
  if (body !== undefined) writeFileSync(join(dir, "intents.json"), body);
  const ran = [];
  const exec = async (i) => { ran.push(i.id); return { ok: true, detail: "delivered" }; };
  // What `server/intentDeps.ts` injects: the guarded read and the atomic write.
  // Read through at CALL time by the store, so a test may swap `writeText`.
  const files = { readGuarded: readJsonGuardedDetail, writeText: (p, b) => writeTextAtomic(p, b) };
  const store = new IntentManager({
    root,
    files,
    ...extra,
    sessions: () => [],
    sessionAlive: () => false,
    repoSession: () => null,
    repoAnySession: () => false,
    autoSlotsFree: () => 3,
    autoSlotsDetail: () => undefined,
    revivedSessionFor: () => null,
    diedAtLimit: () => false,
    stopCount: () => 0,
    isHooked: () => false,
    sessionIdleMs: () => 99_000,
    sessionHasPrompt: () => false,
    idleWindowMs: () => 1000,
    groupConcurrency: () => 6,
    knownDirs: async () => new Set([REPO]),
    budgetBlocked: () => false,
    autoFire: () => true,
    logVerdict: () => "unknown",
    executors: { freshSession: exec, sweep: exec, deliver: exec, workItem: exec, build: exec, assess: exec },
    onChange: () => {},
  });
  return { store, dir, ran, files };
}

const draft = (id) => ({
  id, cwd: REPO,
  payload: { kind: "prompt", steps: ["do the thing"] },
  target: { kind: "repo", fresh: true },
  trigger: { kind: "now" },
  title: "a thing",
});
const settle = () => new Promise((r) => setTimeout(r, 30));

test("a corrupt intents.json is moved aside, the store starts empty, and a notice says where it went", () => {
  const { store, dir } = storeOver("{ this is not json");
  assert.equal(store.list().length, 0);
  const aside = readdirSync(dir).filter((n) => n.startsWith("intents.json.corrupt-"));
  assert.equal(aside.length, 1, "the damaged bytes are kept beside the store");
  assert.equal(readFileSync(join(dir, aside[0]), "utf8"), "{ this is not json");
  const n = store.storeNotice();
  assert.ok(n, "a boot notice exists");
  assert.match(n.body, new RegExp(aside[0].replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.equal(store.readOnly(), null, "a corrupt file does not make the store read-only");
  // The next write goes to a fresh file — never over the evidence.
  assert.equal(store.post(draft("after-corrupt")).ok, true);
  assert.equal(readFileSync(join(dir, aside[0]), "utf8"), "{ this is not json");
  assert.equal(JSON.parse(readFileSync(join(dir, "intents.json"), "utf8")).intents.length, 1);
});

test("a file that parses but is not a store is treated the same as a corrupt one", () => {
  const { store, dir } = storeOver(JSON.stringify({ hello: "world" }));
  assert.equal(store.list().length, 0);
  assert.equal(readdirSync(dir).filter((n) => n.startsWith("intents.json.corrupt-")).length, 1);
  assert.ok(store.storeNotice());
});

test("no file at all is a fresh host: no notice, nothing moved", () => {
  const { store, dir } = storeOver(undefined);
  assert.equal(store.storeNotice(), null);
  assert.deepEqual(readdirSync(dir), []);
});

test("a NEWER schema is read but never written, posted to or fired — and the notice says so", async () => {
  const row = { ...draft("from-the-future"), state: "queued", createdAt: Date.now() - 1000 };
  const body = JSON.stringify({ schema: STORE_SCHEMA + 1, intents: [row], futureField: true });
  const { store, dir, ran } = storeOver(body);
  assert.deepEqual(store.list().map((r) => r.id), ["from-the-future"], "the rows it can read are shown");
  assert.match(store.readOnly() ?? "", /newer/);
  assert.match(store.storeNotice()?.title ?? "", /read-only/);
  const posted = store.post(draft("new-one"));
  assert.equal(posted.ok, false, "a post is refused: ok means on disk");
  assert.match(posted.reason, /newer/);
  assert.equal(store.upsert(draft("upserted")), null);
  assert.equal((await store.runNow("from-the-future")).ok, false);
  await store.reconcile();
  store.start();
  await settle();
  store.stop();
  assert.deepEqual(ran, [], "nothing fires from a store whose `starting` cannot reach the disk");
  store.cancel("from-the-future");
  store.flush();
  assert.equal(readFileSync(join(dir, "intents.json"), "utf8"), body, "the newer file is byte-for-byte untouched");
  assert.equal(existsSync(join(dir, "intents-archive.jsonl")), false);
});

test("the schema this code knows still writes and fires as before (the read-only test is not vacuous)", async () => {
  const row = { ...draft("today"), state: "queued", createdAt: Date.now() - 1000 };
  const { store, dir, ran } = storeOver(JSON.stringify({ schema: STORE_SCHEMA, intents: [row] }));
  assert.equal(store.readOnly(), null);
  assert.equal(store.storeNotice(), null);
  assert.equal(store.post(draft("second")).ok, true);
  assert.equal(JSON.parse(readFileSync(join(dir, "intents.json"), "utf8")).intents.length, 2);
  await store.reconcile();
  store.start();
  await settle();
  store.stop();
  assert.ok(ran.includes("today"), "the same row fires from a writable store");
});

// ── A write that does not reach the disk ──────────────────────────────────
//
// `ok` on the wire means ON DISK. A full disk or a read-only state dir used to
// be swallowed by `persist()`, so the row was acked, lived in memory only, and
// a retry after a restart (inside the ack TTL) ran the prompt again. Now the
// write's failure is a REFUSAL with the row taken back out of memory — nothing
// has run, only been queued — and the failure is told once per streak.

const enospc = () => { const e = new Error("ENOSPC: no space left on device, write"); e.code = "ENOSPC"; throw e; };
const quiet = async (fn) => {
  const o = { e: console.error, l: console.log };
  console.error = () => {}; console.log = () => {};
  try { return await fn(); } finally { console.error = o.e; console.log = o.l; }
};

test("a post whose write fails is refused in words, and the row is not left in memory to fire", async () => {
  const told = [];
  const { store, dir, ran, files } = storeOver(undefined, { onWriteError: (m) => told.push(m) });
  const write = files.writeText;
  files.writeText = enospc;
  const r = await quiet(() => store.post(draft("never-saved")));
  assert.equal(r.ok, false);
  assert.match(r.reason, /^could not save to disk: ENOSPC: no space left on device/);
  assert.match(r.reason, /nothing was queued/);
  assert.equal(store.get("never-saved"), undefined, "reverted: memory says what the disk says");
  assert.match(store.lastWriteError() ?? "", /ENOSPC/);
  // A second failure in the same streak is NOT told again.
  assert.equal((await quiet(() => store.post(draft("never-saved-2")))).ok, false);
  assert.equal(told.length, 1, "told once per failing streak");
  assert.match(told[0], /ENOSPC/);
  await store.reconcile();
  store.start();
  await settle();
  store.stop();
  assert.deepEqual(ran, [], "nothing that was refused ever fires");
  assert.equal(existsSync(join(dir, "intents.json")), false);
  // The disk comes back: the same id posts, lands, and the error clears.
  files.writeText = write;
  assert.equal((await quiet(() => store.post({ ...draft("never-saved"), trigger: { kind: "files", needs: ["later.png"] } }))).ok, true);
  assert.equal(store.lastWriteError(), null);
  assert.equal(JSON.parse(readFileSync(join(dir, "intents.json"), "utf8")).intents[0].id, "never-saved");
  // A nearly-full disk flaps: a NEW streak inside the floor is not told again.
  files.writeText = enospc;
  assert.equal((await quiet(() => store.post(draft("flapped")))).ok, false);
  assert.equal(told.length, 1, "a flapping disk is one feed row and one push, not one per flap");
});

test("an upsert whose write fails is refused and the PREVIOUS row is put back, untouched", async () => {
  const { store, files } = storeOver(undefined);
  assert.equal(store.upsert({ ...draft("rule"), title: "the first words" })?.title, "the first words");
  files.writeText = enospc;
  assert.equal(await quiet(() => store.upsert({ ...draft("rule"), title: "an edit nobody saved" })), null);
  assert.match(store.lastWriteError() ?? "", /ENOSPC/, "the reason `schedule.save` words its refusal from");
  assert.equal(store.get("rule")?.title, "the first words", "the in-memory row is the one on disk");
  assert.equal(await quiet(() => store.upsert(draft("brand-new"))), null);
  assert.equal(store.get("brand-new"), undefined);
});

test("a row whose `starting` cannot be written is not started: the executor never runs and the row stays queued", async () => {
  const { store, ran, files } = storeOver(undefined);
  assert.equal(store.post({ ...draft("tap-me"), trigger: { kind: "files", needs: ["never.png"] } }).ok, true);
  files.writeText = enospc;
  const r = await quiet(() => store.runNow("tap-me"));
  assert.equal(r.ok, false, "the tap is refused, not acked as started");
  assert.match(r.reason, /not started: could not save to disk: ENOSPC/);
  await settle();
  assert.deepEqual(ran, [], "nothing ran whose start a restart would not remember");
  const row = store.get("tap-me");
  assert.equal(row.state, "queued");
  assert.equal(row.startedAt, undefined);
  assert.equal(row.missing, undefined, "the claim is taken back whole (no record of a run that went without its files)");
});

test("a state dir the host may not write (chmod 0500) refuses a post with the OS's own words", { skip: process.getuid?.() === 0 && "root ignores directory modes" }, async () => {
  const { store, dir } = storeOver(undefined);
  chmodSync(dir, 0o500);
  try {
    const r = await quiet(() => store.post(draft("ro-dir")));
    assert.equal(r.ok, false);
    assert.match(r.reason, /could not save to disk: EACCES/);
    assert.equal(store.get("ro-dir"), undefined);
  } finally { chmodSync(dir, 0o700); }
});
