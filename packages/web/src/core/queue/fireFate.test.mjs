/**
 * A fired durable op's fate — the one owner (`core/queue/fireFate.ts`).
 *
 *     node --test packages/web/src/core/queue/fireFate.test.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { droppedWords, fireAckIn, fireFate, fireFateOf, firedRun, trackFire } from "./fireFate.ts";

test("a fire's fate: a receipt wins; a failed or dismissed row never gets one (design round 4)", () => {
  assert.equal(fireFate(undefined, undefined, false).kind, "pending");       // row not listed yet
  assert.equal(fireFate(undefined, { status: "queued" }, true).kind, "pending");
  assert.equal(fireFate(undefined, { status: "pending" }, true).kind, "pending");
  assert.equal(fireFate({ ok: true }, undefined, true).kind, "acked");      // acked row retired
  assert.equal(fireFate({ ok: false }, undefined, true).kind, "refused");
  assert.deepEqual(fireFate(undefined, { status: "failed", reason: "queue full" }, true), { kind: "dropped", reason: "queue full" });
  assert.equal(fireFate(undefined, undefined, true).kind, "dropped");        // dismissed while offline
  assert.equal(fireFate({ ok: true }, { status: "failed" }, true).kind, "acked");
  // the receipt's run and refusal travel with the fate
  assert.deepEqual(fireFate({ ok: true, runId: "r1" }, undefined, true), { kind: "acked", runId: "r1" });
  assert.deepEqual(fireFate({ ok: false, reason: "no known repos selected" }, undefined, true), { kind: "refused", reason: "no known repos selected" });
});

test("a fire's receipt is kept only for a tracked ackId, with the run it names", () => {
  let m = trackFire(new Map(), "a1");
  assert.equal(m.get("a1"), null);                     // waiting on the receipt
  assert.equal(fireAckIn(m, "zz", true, "r9"), m);       // someone else's op.ack: untouched
  m = fireAckIn(m, "a1", true, "r1");
  assert.deepEqual(m.get("a1"), { ok: true, runId: "r1" });
  // an older host's receipt names no run: kept without one, never invented
  assert.deepEqual(fireAckIn(trackFire(new Map(), "a2"), "a2", true, undefined).get("a2"), { ok: true });
  assert.deepEqual(fireAckIn(trackFire(new Map(), "a3"), "a3", false, undefined).get("a3"), { ok: false });
  assert.deepEqual(fireAckIn(trackFire(new Map(), "a4"), "a4", false, undefined, "nope").get("a4"), { ok: false, reason: "nope" });
});

test("only the newest fires are tracked", () => {
  let m = new Map();
  for (let i = 0; i < 30; i++) m = fireAckIn(trackFire(m, "k" + i, 20), "k" + i, true, "r"); // settled
  assert.equal(m.size, 20);
  assert.equal(m.has("k0"), false);
  assert.equal(m.has("k29"), true);
});

test("the cap never evicts a fire still waiting on its receipt (design review 2026-10-30 W2 review L2)", () => {
  let m = new Map();
  for (let i = 0; i < 25; i++) m = trackFire(m, "p" + i, 20);   // all unsettled
  assert.equal(m.size, 25);
  assert.equal(m.has("p0"), true);
  m = fireAckIn(m, "p0", true, "r");                              // settled: now evictable
  m = fireAckIn(m, "p1", true, "r");
  m = trackFire(m, "p25", 20);
  assert.equal(m.has("p0"), false);
  assert.equal(m.has("p1"), false);
  assert.equal(m.has("p2"), true);
  assert.equal(m.has("p25"), true);
});

test("fireFateOf: tracked IS row-seen — a tracked fire whose row went without a receipt was dropped", () => {
  const tracked = trackFire(new Map(), "f1");
  assert.equal(fireFateOf(tracked, [], null), null);                   // nothing fired
  assert.equal(fireFateOf(new Map(), [], "f1"), null);                 // not tracked here: no claim
  assert.deepEqual(fireFateOf(tracked, [{ ackId: "f1", status: "queued" }], "f1"), { kind: "pending" });
  assert.deepEqual(fireFateOf(tracked, [{ ackId: "f1", status: "failed", reason: "x" }], "f1"), { kind: "dropped", reason: "x" });
  assert.deepEqual(fireFateOf(tracked, [], "f1"), { kind: "dropped" });
  assert.deepEqual(fireFateOf(fireAckIn(tracked, "f1", true, "run9"), [], "f1"), { kind: "acked", runId: "run9" });
});

test("firedRun: the run the receipt names, by identity — never the first unknown one", () => {
  const runs = [{ id: "other" }, { id: "mine" }];
  const idOf = (r) => r.id;
  assert.equal(firedRun(runs, { kind: "pending" }, idOf), null);
  assert.equal(firedRun(runs, { kind: "acked" }, idOf), null);          // a receipt naming no run: no guess
  assert.equal(firedRun(runs, { kind: "acked", runId: "mine" }, idOf), runs[1]);
  assert.equal(firedRun(runs, { kind: "acked", runId: "unlisted" }, idOf), null);
  assert.equal(firedRun(runs, null, idOf), null);
});

test("droppedWords says not sent, never that it ran", () => {
  assert.equal(droppedWords("sweep", "queue full"), "The sweep was not sent — queue full. Run it again when you want it.");
  assert.match(droppedWords("build"), /not sent — its queue row is gone/);
  assert.doesNotMatch(droppedWords("build"), /\b(started|running|ran)\b/i);
});

test("onOpAck records a tracked receipt BEFORE the row is retired; queueOp tracks only after the row is in", () => {
  const wire = readFileSync(new URL("./wire.ts", import.meta.url), "utf8");
  const body = wire.slice(wire.indexOf("function onOpAck("));
  const note = body.indexOf("noteFireAck(msg.ackId, msg.ok, msg.runId, msg.reason)");
  assert.ok(note > 0 && note < body.indexOf("writeOutbox("), "noteFireAck precedes the first writeOutbox in onOpAck");
  const send = readFileSync(new URL("./send.ts", import.meta.url), "utf8");
  const q = send.slice(send.indexOf("function queueOp("));
  const track = q.indexOf("if (opts?.track) noteFired(ackId)");
  assert.ok(track > q.indexOf("addOutbox(") && track < q.indexOf("flushOutbox()"), "track after addOutbox, before the flush");
});

/**
 * Ratchet (design review 2026-10-30 W2): a sheet never guesses which run its
 * tap started from "the run ids that existed before it". The run is the one
 * the fire's receipt names (`firedRun`, `useFireFate`). No file is exempt: the
 * build sheet's older-host fallback (`runsAtTap`) was removed 2026-10-30.
 */
import { readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

// Any callback parameter name, any of id/runId, with or without parens/braces.
const GUESS = /known:\s*new Set\(\s*runs\.map|new Set\(\s*runs\.map\(\s*(?:\(\s*(\w+)\s*\)|(\w+))\s*=>\s*\{?\s*(?:return\s+)?\1?\2?\.(?:id|runId)\b|\.known\.has\(/;

test("the ratchet's detector catches the guess whatever the callback parameter is called", () => {
  for (const src of ["new Set(runs.map((r) => r.id))", "new Set(runs.map((run) => run.id))", "new Set(runs.map(x => x.runId))",
    "new Set(runs.map((run) => { return run.id; }))", "known: new Set(runs.map(f))", "if (s.known.has(id))"]) {
    assert.match(src, GUESS, src);
  }
  assert.doesNotMatch("const ids = runs.filter((r) => r.open)", GUESS);
});

test("no sheet adopts the first run not known at the tap (ratchet = 0)", () => {
  const SRC = fileURLToPath(new URL("../../", import.meta.url));
  const walk = (d) => readdirSync(d).flatMap((n) => {
    const p = join(d, n);
    if (statSync(p).isDirectory()) return n === "node_modules" ? [] : walk(p);
    return /\.(ts|tsx)$/.test(n) ? [p] : [];
  });
  const guess = GUESS;
  const hits = walk(SRC).map((p) => relative(SRC, p)).filter((rel) => guess.test(readFileSync(join(SRC, rel), "utf8")));
  assert.deepEqual(hits, [], "a run guessed from absence — select the run the fire's receipt names (useFireFate + firedRun)");
});
