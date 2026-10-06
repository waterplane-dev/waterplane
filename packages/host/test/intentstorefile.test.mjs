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
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { IntentManager } = await import("../dist/intents/manager.js");
const { STORE_SCHEMA } = await import("../dist/intents/contract.js");
const { readJsonGuardedDetail, writeTextAtomic } = await import("../dist/jsonstore.js");

const REPO = "/tmp/waterplane-storefile-repo";

function storeOver(body) {
  const root = mkdtempSync(join(tmpdir(), "waterplane-storefile-"));
  const dir = join(root, ".waterplane");
  mkdirSync(dir, { recursive: true });
  if (body !== undefined) writeFileSync(join(dir, "intents.json"), body);
  const ran = [];
  const exec = async (i) => { ran.push(i.id); return { ok: true, detail: "delivered" }; };
  const store = new IntentManager({
    root,
    // What `server/intentDeps.ts` injects: the guarded read and the atomic write.
    files: { readGuarded: readJsonGuardedDetail, writeText: (p, b) => writeTextAtomic(p, b) },
    sessions: () => [],
    sessionAlive: () => false,
    repoSession: () => null,
    repoAnySession: () => false,
    autoSlotsFree: () => 3,
    autoSlotsDetail: () => undefined,
    reapAutoSession: () => null,
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
  return { store, dir, ran };
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
