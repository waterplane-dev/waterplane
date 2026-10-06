/**
 * The local runner's readout (`localrt.ts`).
 *
 * Two things these pin, both of which are the difference between a useful bar
 * and a lying one:
 *
 *  - **"Nothing is loaded" and "nobody answered" are opposite facts.** A runner
 *    that is not installed must not render as a runner holding zero bytes.
 *  - **A memory conflict is a SENTENCE, never a refusal.** The numbers are good
 *    enough to warn on and nowhere near good enough to block work on.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

const { parsePs, memoryPressureNote } = await import("../dist/localrt.js");

const GB = 2 ** 30;

test("a loaded model is read with its size, vram and eviction time", () => {
  const rows = parsePs({ models: [{
    name: "gemma4:e4b", model: "gemma4:e4b",
    size: 9.2 * GB, size_vram: 9.2 * GB,
    expires_at: "2026-09-14T13:07:27.264172+02:00",
  }] });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].name, "gemma4:e4b");
  assert.equal(rows[0].size, 9.2 * GB);
  assert.equal(rows[0].vram, 9.2 * GB);
  assert.equal(rows[0].expiresAt, Date.parse("2026-09-14T13:07:27.264172+02:00"));
});

test("every field degrades on its own, and never to NaN", () => {
  // A NaN size poisons every total drawn from it, so an unreadable one is 0.
  // An unreadable eviction time is ABSENT — "now" and "never" are both claims.
  const rows = parsePs({ models: [{ name: "x", size: "huge", size_vram: null, expires_at: "not a date" }] });
  assert.deepEqual(rows, [{ name: "x", size: 0, vram: 0 }]);
  assert.ok(!("expiresAt" in rows[0]));
});

test("a row with no name is dropped — it can be neither shown nor matched", () => {
  assert.deepEqual(parsePs({ models: [{ size: 1 }, { name: "", size: 1 }] }), []);
  // …and `model` stands in for `name` when only that is given.
  assert.deepEqual(parsePs({ models: [{ model: "q:30b", size: 1 }] }), [{ name: "q:30b", size: 1, vram: 0 }]);
});

test("a body that is not a listing is empty, never a throw", () => {
  for (const b of [null, undefined, {}, { models: null }, { models: "nope" }, [], "text"]) {
    assert.deepEqual(parsePs(b), [], JSON.stringify(b));
  }
});

test("nothing resident ⇒ no pressure note at all", () => {
  assert.equal(memoryPressureNote([], "qwen3-coder:30b", 8 * GB), null);
});

test("the model already loaded is not a conflict with itself", () => {
  // Opening a second session on the SAME local model costs no second copy.
  // Warning there would train people to ignore the warning that matters.
  const loaded = [{ name: "qwen3-coder:30b", size: 18 * GB, vram: 18 * GB }];
  assert.equal(memoryPressureNote(loaded, "qwen3-coder:30b", 4 * GB), null);
});

test("a DIFFERENT local model names what is held, what is free, and the cost of switching", () => {
  // The real case: qwen resident, somebody starts gemma. It does not refuse —
  // the estimate is not good enough to refuse work on, and `keep_alive` makes
  // the conflict transient. It says the two things a person decides with.
  const loaded = [{ name: "qwen3-coder:30b", size: 18 * GB, vram: 18 * GB }];
  const note = memoryPressureNote(loaded, "gemma4:e4b", 6.5 * GB);
  assert.match(note, /qwen3-coder:30b is already loaded/);
  assert.match(note, /18\.0 GB held/);
  assert.match(note, /6\.5 GB free/);
  assert.match(note, /every switch between them reloads from disk/);
});

test("several resident models are all named", () => {
  const loaded = [
    { name: "qwen3-coder:30b", size: 18 * GB, vram: 18 * GB },
    { name: "gemma4:e4b", size: 9 * GB, vram: 9 * GB },
  ];
  const note = memoryPressureNote(loaded, "laguna-xs-2.1:q4_K_M", 2 * GB);
  assert.match(note, /qwen3-coder:30b, gemma4:e4b are already loaded/);
  assert.match(note, /27\.0 GB held/);
});

// ── The watch lease ────────────────────────────────────────────────────────
//
// The manager is a module-level singleton with a timer in it (`clihealth.ts`'s
// arrangement), so the part worth pinning is the part with no clock and no
// socket in it: who gets the next sample, who is dropped, and when the timer
// must go away. All three fail SILENTLY — a renewal that does not extend drops
// a live readout every minute, an entry that is never dropped keeps a desktop
// polling for a phone that left, and a timer that outlives its last watcher is
// a daemon polling for nobody.

const { dueWatchers, localRtWatch, localRtWatchCount, localRtPollMs, LEASE_MS } =
  await import("../dist/localrt.js");

const OPEN = { until: 0, open: true };
const lease = (until, open = true) => ({ ...OPEN, until, open });

test("a lease with time left on an open socket gets the sample", () => {
  const { live, lapsed } = dueWatchers([["a", lease(1_000)]], 900);
  assert.deepEqual(live, ["a"]);
  assert.deepEqual(lapsed, []);
});

test("renewing extends it — the same key, a later deadline, still live", () => {
  // What a 25 s pump buys: at 61 s the OLD lease is dead and the renewed one
  // is not. A renewal that silently failed to extend would look, from the
  // phone, like a desktop that answers for a minute and then stops.
  assert.deepEqual(dueWatchers([["a", lease(60_000)]], 61_000).live, []);
  assert.deepEqual(dueWatchers([["a", lease(60_000 + LEASE_MS)]], 61_000).live, ["a"]);
});

test("an expired lease lapses, and is DROPPED rather than kept quietly", () => {
  const { live, lapsed } = dueWatchers([["a", lease(1_000)], ["b", lease(9_000)]], 5_000);
  assert.deepEqual(live, ["b"]);
  assert.deepEqual(lapsed, ["a"]);
});

test("a CLOSED socket lapses even with time left on its lease", () => {
  // The clock is the backstop for a close nobody saw — never a reason to keep
  // writing frames into a socket that is already gone.
  const { live, lapsed } = dueWatchers([["a", lease(60_000, false)]], 1_000);
  assert.deepEqual(live, []);
  assert.deepEqual(lapsed, ["a"]);
});

test("no live watchers is the STOP condition, and an empty map is one too", () => {
  assert.deepEqual(dueWatchers([], 1).live, []);
  assert.deepEqual(dueWatchers([["a", lease(1, false)], ["b", lease(0)]], 5).live, []);
});

test("the poll interval is floored, so a hand-edited env can't make a load generator", () => {
  const keep = process.env.WATERPLANE_LOCALRT_POLL_MS;
  try {
    delete process.env.WATERPLANE_LOCALRT_POLL_MS;
    assert.equal(localRtPollMs(), 5000);
    process.env.WATERPLANE_LOCALRT_POLL_MS = "1";
    assert.equal(localRtPollMs(), 1000);
    process.env.WATERPLANE_LOCALRT_POLL_MS = "20000";
    assert.equal(localRtPollMs(), 20000);
    for (const bad of ["", "nope", "-5", "0"]) {
      process.env.WATERPLANE_LOCALRT_POLL_MS = bad;
      assert.equal(localRtPollMs(), 5000, bad);
    }
  } finally {
    if (keep === undefined) delete process.env.WATERPLANE_LOCALRT_POLL_MS; else process.env.WATERPLANE_LOCALRT_POLL_MS = keep;
  }
});

test("polling switched off answers ONCE, says so, and takes no lease", () => {
  // The frame is the whole point: a host that predates this feature ignores an
  // unknown `t` in silence, so without an immediate answer the phone cannot
  // tell "this desktop is old" from "this desktop is quiet". And `disabled` is
  // what keeps "nobody polls here" apart from "the runner did not answer",
  // which would otherwise both arrive as `reachable: false`.
  const keep = process.env.WATERPLANE_LOCAL_RUNTIME;
  const sent = [];
  try {
    process.env.WATERPLANE_LOCAL_RUNTIME = "0";
    localRtWatch({ readyState: 1 }, (m) => sent.push(m));
  } finally {
    if (keep === undefined) delete process.env.WATERPLANE_LOCAL_RUNTIME; else process.env.WATERPLANE_LOCAL_RUNTIME = keep;
  }
  assert.equal(sent.length, 1);
  assert.equal(sent[0].t, "localrt.sample");
  assert.equal(sent[0].disabled, true);
  assert.equal(sent[0].sample.reachable, false);
  assert.deepEqual(sent[0].sample.models, []);
  // No lease ⇒ no timer ⇒ nothing to stop. "Polling is off here" is a standing
  // fact about the machine, not a reading that needs refreshing.
  assert.equal(localRtWatchCount(), 0);
});
