// The halt receipt's one sentence (`shared/src/halt.ts`): what was stopped,
// what is held, and — always — what a halt cannot reach, so nobody reads
// "stopped 0 sessions" as "nothing AI is running anywhere".
import { test } from "node:test";
import assert from "node:assert/strict";
import { haltReceiptWords, HALT_OFF } from "../dist/index.js";

const r = (o) => ({ at: 0, sessions: 0, processes: 0, forced: 0, sidecars: 0, held: 0, ...o });

test("counts, plural and forced", () => {
  assert.equal(haltReceiptWords(r({ sessions: 3, processes: 7, forced: 2, sidecars: 1, held: 4 })),
    "Stopped 3 sessions and 1 background model run (7 processes, 2 forced). 4 waiting items held. AI started outside waterplane and cloud sessions are not reached.");
});

test("nothing running still names what a halt cannot reach", () => {
  const w = haltReceiptWords(r({}));
  assert.match(w, /^Stopped 0 sessions\./);
  assert.match(w, /outside waterplane/);
});

test("off is off", () => {
  assert.deepEqual(HALT_OFF, { on: false, since: null, receipt: null });
});
