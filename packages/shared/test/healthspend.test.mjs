import { test } from "node:test";
import assert from "node:assert/strict";
import { repoSpendByWeek } from "../dist/index.js";


test("repoSpendByWeek: money and priced requests by ISO week, the repo's spellings only; one row without a context count drops the week's context, never its money", () => {
  const days = [
    { day: "2026-11-02", byRepo: [{ repo: "/r", turns: 2, pricedTurns: 2, usd: 1, ctxTok: 100 }, { repo: "/other", turns: 9, pricedTurns: 9, usd: 9, ctxTok: 9 }] },
    { day: "2026-11-04", byRepo: [{ repo: "/real/r", turns: 3, pricedTurns: 1, usd: 0.5, ctxTok: 50 }] },
    { day: "2026-11-09", byRepo: [{ repo: "/r", turns: 1, pricedTurns: 1, usd: 2 }, { repo: "/r", turns: 1, pricedTurns: 1, usd: 1, ctxTok: 5 }] },
  ];
  const w = repoSpendByWeek(days, ["/r", "/real/r"]);
  assert.deepEqual(w["2026-11-02"], { requests: 5, pricedRequests: 3, usd: 1.5, ctxTok: 150 });
  assert.deepEqual(w["2026-11-09"], { requests: 2, pricedRequests: 2, usd: 3 });
  assert.equal(Object.keys(w).length, 2);
});
