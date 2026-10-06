/**
 * The schedule feature's pure half: the queued saves read off the send queue,
 * and the two sentences that moved out of App with the sheet.
 */
import test from "node:test";
import assert from "node:assert/strict";

import { pendingSchedulesOf, spentLabel } from "./logic.ts";
import { scheduleRemovedToast } from "../../clockCuts.ts";

const save = (id, status = "queued") => ({
  ackId: `a-${id}`, mode: "op", status, sessionId: "fanout", cwd: "/r", text: id,
  op: { t: "schedule.save", entry: { id, name: id } },
});

test("only queued schedule.save ops are pending, and a given-up one says so", () => {
  const got = pendingSchedulesOf([
    save("s1"),
    save("s2", "failed"),
    { ackId: "x", mode: "op", status: "queued", op: { t: "schedule.run", id: "s1" } },
    { ackId: "y", mode: "input", status: "queued", text: "hi" },
  ]);
  assert.deepEqual(got.map((p) => [p.entry.id, p.failed]), [["s1", false], ["s2", true]]);
});

test("the spent foot's cut names how many, singular and plural", () => {
  assert.equal(spentLabel(1), "the 1 one-off that has been and gone");
  assert.equal(spentLabel(3), "the 3 one-offs that have been and gone");
});

test("a delete's receipt counts the queue rows that named the schedule", () => {
  assert.equal(scheduleRemovedToast(0), "schedule deleted");
  assert.equal(scheduleRemovedToast(1), "schedule deleted — and the queue row that named it");
  assert.equal(scheduleRemovedToast(2), "schedule deleted — and 2 queue rows that named it");
});
