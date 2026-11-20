import { test } from "node:test";
import assert from "node:assert/strict";
import { PENDING_SILENT_MS, pendingCardHint, pendingCardLine, pendingOpenState, pendingSpins } from "./pendingWords.ts";

const now = 1_000_000;
const st = (entry, linkOpen = true, held = false) => pendingOpenState({ entry, linkOpen, held, now });

test("a pending open says where the create IS, never 'warming up' before the desktop took it (owner 2026-11-18)", () => {
  assert.equal(st(null), "starting");
  assert.equal(st({ status: "failed" }), "failed");
  assert.equal(st({ status: "pending", sentAt: now - 1000 }), "asking");
  assert.equal(st({ status: "pending", sentAt: now - PENDING_SILENT_MS }), "silent");
  // A socket that dropped mid-wait does not turn an unanswered create back into "asking".
  assert.equal(st({ status: "pending", sentAt: now - 7000 }, false), "silent");
  assert.equal(st({ status: "queued" }, false), "nolink");
  assert.equal(st({ status: "queued" }, true, true), "held");
  assert.equal(st({ status: "queued" }, true), "queued");
  for (const s of ["asking", "silent", "nolink", "queued", "held"]) assert.doesNotMatch(pendingCardLine(s, "r"), /warming|CLI/, s);
  assert.equal(pendingCardLine("starting", "waterplane"), "New session in waterplane — starting…");
  assert.equal(pendingCardLine("nolink", "waterplane"), "New session in waterplane — starts when the desktop is back.");
  assert.equal(pendingCardLine("silent", "r"), "New session in r — the desktop is not answering; it starts when it does.");
  assert.equal(pendingCardHint("nolink", false), "Write your first prompt now; it goes in then.");
  assert.equal(pendingCardHint("starting", false), "Write your first prompt now; it goes in as it opens.");
  assert.match(pendingCardHint("nolink", true), /^Your first prompt goes in then/);
});

test("the pending line spins only while something is on the wire (owner 2026-11-18: a spinner offline)", () => {
  assert.deepEqual(["starting", "asking", "silent", "nolink", "queued", "held", "failed"].filter(pendingSpins), ["starting", "asking"]);
});
