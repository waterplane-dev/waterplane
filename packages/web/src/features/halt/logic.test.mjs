// The halt banner's line (`logic.ts`): "Stopping…" until the kill's receipt
// for THIS halt arrives — never the previous halt's tally under a new time.
import { test } from "node:test";
import assert from "node:assert/strict";
import { haltBannerWords } from "./logic.ts";

const receipt = (at) => ({ at, sessions: 2, processes: 4, forced: 0, sidecars: 0, held: 1 });

test("off-the-press halt says it is still stopping", () => {
  const now = new Date(2026, 9, 15, 14, 40).getTime();
  const since = new Date(2026, 9, 15, 14, 32).getTime();
  assert.equal(haltBannerWords({ on: true, since, receipt: null }, now), "All AI halted since 14:32. Stopping…");
});

test("an older halt's receipt is not this halt's", () => {
  const since = Date.now();
  assert.match(haltBannerWords({ on: true, since, receipt: receipt(since - 60_000) }), /Stopping…$/);
});

test("this halt's receipt is said in full", () => {
  const since = Date.now() - 5000;
  const w = haltBannerWords({ on: true, since, receipt: receipt(since + 1200) });
  assert.match(w, /Stopped 2 sessions \(4 processes\)\. 1 waiting item held\./);
});
