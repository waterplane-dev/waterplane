/**
 * What happens to a recording the desktop could not read yet.
 *
 *     node --test packages/web/src/dictateHold.test.mjs
 *
 * The rule under every case here: **a recording is never destroyed for being
 * inconvenient.** It was — a minute of speech on a slow tunnel was aborted by a
 * 20-second JSON fuse and dropped with a toast — and the whole hold exists so
 * that a spoken prompt survives a dead link the way a typed one always has.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { RETRY_BACKOFF_MS } from "@waterplane/shared";
import {
  HOLD_CAP,
  HOLD_MAX_BYTES,
  afterMiss,
  holdNews,
  holdRefusal,
  holdTitle,
  landedAwayWords,
  nextDue,
  nextWakeAt,
  saidNothing,
  releaseHold,
} from "./dictateHold.ts";

const clip = (o = {}) => ({ id: "d1", ts: 1000, seconds: 12, bytes: 400_000, tries: 0, ...o });

test("the oldest clip that is due goes first", () => {
  const held = [
    clip({ id: "b", ts: 2000 }),
    clip({ id: "a", ts: 1000 }),
    clip({ id: "c", ts: 500, retryAt: 9_000 }),
  ];
  // `c` is the oldest but is serving a backoff: words come back in the order
  // they were said, among the ones that may be tried at all.
  assert.equal(nextDue(held, 5_000).id, "a");
  assert.equal(nextDue(held, 10_000).id, "c");
});

test("nothing due answers null rather than a clip that may not be tried", () => {
  assert.equal(nextDue([clip({ retryAt: 9_000 })], 1_000), null);
  assert.equal(nextDue([], 1_000), null);
});

test("a missed attempt backs off and never gives up", () => {
  let c = clip();
  const now = 10_000;
  c = afterMiss(c, now);
  assert.equal(c.tries, 1);
  assert.equal(c.retryAt, now + RETRY_BACKOFF_MS);
  // Twenty misses later it is still a clip with a future, not a failure: audio
  // cannot be re-said, so there is nothing a give-up verdict would offer.
  for (let i = 0; i < 20; i++) c = afterMiss(c, now);
  assert.equal(c.tries, 21);
  assert.ok(c.retryAt > now);
});

test("a link that came back clears every backoff", () => {
  const held = releaseHold([clip({ id: "a", retryAt: 5_000 }), clip({ id: "b", retryAt: 90_000 })]);
  assert.deepEqual(held.map((c) => c.retryAt), [undefined, undefined]);
  assert.equal(nextDue(held, 0).id, "a");
});

test("the wake clock is the nearest backoff, and null when one is due now", () => {
  assert.equal(nextWakeAt([clip({ retryAt: 8_000 }), clip({ id: "d2", retryAt: 5_000 })], 1_000), 5_000);
  assert.equal(nextWakeAt([clip({ retryAt: 8_000 }), clip({ id: "d2" })], 1_000), null);
  assert.equal(nextWakeAt([], 1_000), null);
});

test("the cap REFUSES rather than shedding, and says so", () => {
  const full = Array.from({ length: HOLD_CAP }, (_, i) => clip({ id: `d${i}` }));
  const reason = holdRefusal(full, 100);
  assert.ok(reason, "a full hold must refuse");
  assert.match(reason, /waiting/);
  // The one thing it may never read as: that the recordings already held are
  // the ones at risk. They are not — the NEW one was not kept.
  assert.doesNotMatch(reason, /oldest|dropped|deleted/);
  assert.equal(holdRefusal(full.slice(0, HOLD_CAP - 1), 100), null);
});

test("bytes are bounded as well as clips", () => {
  const heavy = [clip({ bytes: HOLD_MAX_BYTES - 1000 })];
  assert.equal(holdRefusal(heavy, 500), null);
  assert.ok(holdRefusal(heavy, 5_000));
});

test("the button says which wait it is, and how much is behind it", () => {
  assert.equal(holdTitle(0, false), null);           // idle draws its own word
  assert.match(holdTitle(1, true), /reading what you said/);
  assert.match(holdTitle(3, true), /2 more recordings behind it/);
  assert.match(holdTitle(1, false), /waiting for the desktop/);
  assert.match(holdTitle(2, false), /order you said them/);
});

test("the held sentence is a promise, not an error", () => {
  const words = holdNews(clip({ seconds: 63 }));
  assert.match(words, /1m 3s/);
  assert.match(words, /held/);
  // The old wording on this path was "the host could not be reached", which on
  // a dropped recording was true and read as "your minute is gone".
  assert.match(words, /read as soon as it can be|comes back/);
  assert.match(holdNews(clip({ seconds: 8 })), /8s/);
  assert.match(holdNews(clip({ seconds: 120 })), /2m/);
});

test("words that outlive their box say where they went", () => {
  assert.match(landedAwayWords(30), /pad/);
  assert.match(landedAwayWords(30), /30s/);
});

test("a transcript with no words in it is silence, not a full stop in the box", () => {
  // Measured: two seconds of a tone POSTed to `/api/host/dictate` came back as
  // exactly ".". Appending that to somebody's prompt is a guess.
  assert.equal(saidNothing("."), true);
  assert.equal(saidNothing(" ... ,, !"), true);
  assert.equal(saidNothing(""), true);
  assert.equal(saidNothing("ok"), false);
  assert.equal(saidNothing("3"), false);
  assert.equal(saidNothing("höchstwahrscheinlich."), false);
});
