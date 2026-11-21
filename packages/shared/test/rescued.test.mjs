import test from "node:test";
import assert from "node:assert/strict";
import { entryFrame, cleanRescued, isRescuedOpen, rescuedOpen, rescuedChipText, rescuedFiledToast, MAX_RESCUED_WHY } from "../dist/index.js";

test("cleanRescued needs both fields, one line, clipped", () => {
  assert.deepEqual(cleanRescued({ why: "  a\n b ", at: 5 }), { why: "a b", at: 5 });
  assert.equal(cleanRescued({ why: "x" }), undefined);
  assert.equal(cleanRescued({ why: "", at: 1 }), undefined);
  assert.equal(cleanRescued({ why: "x", at: NaN }), undefined);
  assert.equal(cleanRescued(null), undefined);
  assert.equal(cleanRescued([]), undefined);
  assert.equal(cleanRescued({ why: "y".repeat(500), at: 1 }).why.length, MAX_RESCUED_WHY);
});

test("one bucketing function: open means marked, waiting, not archived", () => {
  const m = { why: "w", at: 1 };
  const rows = [
    { rescued: m, status: "queued" }, { rescued: m, status: "blocked" },
    { rescued: m, status: "running" }, { rescued: m, status: "done" }, { rescued: m, status: "failed" },
    { rescued: m, status: "queued", archived: true }, { status: "queued" },
  ];
  assert.equal(rescuedOpen(rows).length, 2);
  assert.equal(isRescuedOpen(rows[6]), false);
});

test("the words say where it went", () => {
  assert.equal(rescuedChipText(2), "2 rescued");
  assert.match(rescuedFiledToast("api", false), /kept in api's backlog as rescued/);
  assert.match(rescuedFiledToast("api", true), /link is back/);
});

test("a queued backlog entry puts the mark and the hold on the frame; an ordinary one carries neither", () => {
  const base = { ackId: "a1", mode: "backlog", text: "t", cwd: "/r", status: "queued" };
  const f = entryFrame({ ...base, hold: true, rescued: { why: "w", at: 3 } });
  assert.deepEqual(f.rescued, { why: "w", at: 3 });
  assert.equal(f.hold, true);
  assert.equal("rescued" in entryFrame(base), false);
});
