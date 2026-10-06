/**
 * How `tools/repohealth/narrate.mjs` WRITES `.claude/outbox/repohealth.md`:
 * one section per day, ascending, whatever order the days are reported in.
 *
 * The writer used to append. That is a sort only while every run reports days
 * later than the file's last one, and two ordinary runs broke it on the live
 * file: an evening commit re-reading a day already narrated (same day, new
 * event id) and a late reading of an OLDER day. Each landed as a second
 * `## <day>` at the bottom, and the phone draws the file in its own order.
 *
 *     node --test tools/repohealth-narrate.test.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { PREREG } from "./repohealth/constants.mjs";
import { HEADER, ledgerFile, OUTBOX_MD, events, mergeNarrative, narrate, render } from "./repohealth/narrate.mjs";
import { perDay } from "./repohealth/series.mjs";

const headings = (md) => [...md.matchAll(/^## (.*)$/gm)].map((m) => m[1]);
const ev = (day, id, text) => ({ day, id: `${id}:${day}`, text });

test("a new line for a day already in the file joins THAT day's section, below what it said", () => {
  const was = `${HEADER}\n${render([ev("2026-09-20", "a", "first."), ev("2026-09-21", "b", "morning.")])}`;
  const now = mergeNarrative(was, render([ev("2026-09-21", "c", "evening.")]));
  assert.deepEqual(headings(now), ["2026-09-20", "2026-09-21"]);
  assert.match(now, /## 2026-09-21\n\n- morning\.\n- evening\.\n$/);
});

test("an OLDER day is inserted where its date puts it, not appended", () => {
  const was = `${HEADER}\n${render([ev("2026-09-12", "a", "x."), ev("2026-09-21", "b", "y.")])}`;
  const now = mergeNarrative(was, render([ev("2026-06-19", "c", "back."), ev("2026-09-19", "d", "z."), ev("2026-09-25", "e", "new.")]));
  assert.deepEqual(headings(now), ["2026-06-19", "2026-09-12", "2026-09-19", "2026-09-21", "2026-09-25"]);
  for (const line of ["- x.", "- y.", "- back.", "- z.", "- new."]) assert.ok(now.includes(`${line}\n`), line);
});

test("a file the old appender left out of order and doubled is repaired by an empty merge, losing no line", () => {
  // The shape found on the live file: 09-21 twice, then older days after it.
  const broken = [
    HEADER,
    "## 2026-09-20\n\n- a.\n",
    "## 2026-09-21\n\n- b.\n- c.\n",
    "## 2026-09-21\n\n- d.\n",
    "## 2026-06-19\n\n- e.\n",
    "## 2026-09-21\n\n- f.\n",
    "## 2026-09-22\n\n- g.\n",
  ].join("\n");
  const fixed = mergeNarrative(broken, "");
  assert.deepEqual(headings(fixed), ["2026-06-19", "2026-09-20", "2026-09-21", "2026-09-22"]);
  assert.match(fixed, /## 2026-09-21\n\n- b\.\n- c\.\n- d\.\n- f\.\n\n## 2026-09-22/, "earlier copy first, nothing dropped");
  assert.ok(fixed.startsWith(HEADER), "the preamble is carried through untouched");
  assert.equal(mergeNarrative(fixed, ""), fixed, "and a sorted file is a fixed point");
});

test("hand edits survive: a preamble note and a non-date heading travel with their neighbour", () => {
  const was = `${HEADER}A note of mine.\n\n## 2026-09-21\n\n- y.\n\n## my notes\n\nkeep me\n`;
  const now = mergeNarrative(was, render([ev("2026-09-20", "a", "older.")]));
  assert.ok(now.startsWith(`${HEADER}A note of mine.\n`));
  assert.deepEqual(headings(now), ["2026-09-20", "2026-09-21", "my notes"]);
  assert.ok(now.includes("keep me\n"));
});

test("narrate() on disk: a late older day and a re-read day land in place, once, and silence stays silent", () => {
  const rows = perDay(JSON.parse(readFileSync(new URL("./repohealth/fixture.json", import.meta.url), "utf8")).rows);
  // A day that has something to say, with a neighbour after it that does too.
  const said = new Set(events([], rows, PREREG).map((e) => e.day));
  const j = rows.findIndex((r, k) => k > 1 && k < rows.length - 2 && said.has(r.day) && said.has(rows[k + 1].day));
  assert.ok(j > 0, "the fixture has two adjacent days with events");
  const root = mkdtempSync(join(tmpdir(), "waterplane-narrate-"));
  try {
    const md = join(root, OUTBOX_MD);
    // First run never saw day j — the row turned up later (a backfill).
    const r1 = narrate({ root, nextDays: rows.filter((_, k) => k !== j), prereg: PREREG });
    assert.equal(r1.written, true);
    assert.ok(!headings(readFileSync(md, "utf8")).includes(rows[j].day));

    const r2 = narrate({ root, nextDays: rows, prereg: PREREG });
    assert.equal(r2.written, true, "day j is news");
    const text = readFileSync(md, "utf8");
    const hs = headings(text);
    assert.deepEqual(hs, [...hs].sort(), "ascending — the older day was inserted, not appended");
    assert.equal(hs.length, new Set(hs).size, "one section per day — a re-read day merged into its own");
    assert.ok(hs.includes(rows[j].day));
    assert.ok(text.startsWith(HEADER));

    const ledger = JSON.parse(readFileSync(ledgerFile(root), "utf8")).ids;
    for (const e of r2.unseen) assert.ok(ledger.includes(e.id), `remembered: ${e.id}`);
    for (const e of r2.unseen) assert.ok(text.includes(`- ${e.text}\n`), `written: ${e.id}`);

    const before = statSync(md).mtimeMs;
    const r3 = narrate({ root, nextDays: rows, prereg: PREREG });
    assert.equal(r3.written, false, "nothing is said twice");
    assert.equal(statSync(md).mtimeMs, before, "and the file is not touched");
    assert.equal(readFileSync(md, "utf8"), text);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
