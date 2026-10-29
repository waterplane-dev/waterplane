/** The one wording of the host's retry after a transient API give-up (`netretry.ts`). */
import { test } from "node:test";
import assert from "node:assert/strict";
import { netRetryLine, netRetryWait } from "../dist/index.js";

const base = { attempt: 1, max: 8, error: "Connection dropped (ECONNRESET)", at: 0 };

test("waiting says when and which try", () => {
  assert.equal(netRetryLine({ ...base, state: "waiting", nextAt: 40_000 }, 0), "Network error — retrying in 40s (2/8)");
  assert.equal(netRetryLine({ ...base, state: "waiting", nextAt: 90_000, why: "waiting for the open box to be answered" }, 0),
    "Network error — retrying in 1m 30s (2/8) · waiting for the open box to be answered");
});

test("sent and gave up", () => {
  assert.equal(netRetryLine({ ...base, state: "sent", attempt: 2, nextAt: null }, 0), "Network error — retried (2/8), waiting for the reply");
  assert.equal(netRetryLine({ ...base, state: "gaveup", attempt: 8, nextAt: null, why: "after 8 tries" }, 0), "Network error — stopped retrying: after 8 tries. Type to try again.");
});

test("absent is null, a past instant is 0s, never negative", () => {
  assert.equal(netRetryLine(null, 0), null);
  assert.equal(netRetryLine(undefined, 0), null);
  assert.equal(netRetryWait(-5000), "0s");
  assert.equal(netRetryWait(120_000), "2m");
});

test("netGaveUpDetail: the sentence a waiting item is failed with says the API was unreachable and the work did not run", async () => {
  const { netGaveUpDetail } = await import("../dist/index.js");
  const d = netGaveUpDetail("Can't reach the API server (ENOTFOUND)", "after 8 tries");
  assert.match(d, /could not be reached \(Can't reach the API server \(ENOTFOUND\)\)/);
  assert.match(d, /stopped retrying after 8 tries/);
  assert.match(d, /did not run/);
});
