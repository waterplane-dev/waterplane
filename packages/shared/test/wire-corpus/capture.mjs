/**
 * Writes the wire corpus: what a desktop of each GENERATION answers on the routes the phone's token
 * screens read (`/api/tokenwindows`, `/api/costwindow`, `/api/tokenstats`), replayed through
 * today's phone readers by `packages/extensions/token-stats/web/wirecorpus.test.mjs`.
 *
 *     node packages/shared/test/wire-corpus/capture.mjs
 *
 * `base/<doc>.json` is the demo fake host's answer (the host's own folds over the demo ledger) at a
 * fixed instant, trimmed so the files stay small — the record's reach trimmed WITH the rows, so
 * nothing trimmed comes back as a measured nothing. `generations.json` is, per generation and
 * document, only the fields that generation's host added: 0.1.11 (the last release, none), then
 * the three shapes `undated` went through on 2026-10-30 — f99f4328 (`undated` alone; on
 * `/api/costwindow` the ALL-TIME count), 52f2fadb (+ `undatedUntil`; costwindow's count cut to the
 * window by it), e976a22d (+ `undatedLogs`; costwindow's cut by the pairs). A host running any of
 * them is a desktop the phone can meet: the web bundle goes out over the air, the host only on a
 * restart. Not captured: costwindow's `beside` (since 0.1.11; the fake host does not model it).
 *
 * A new shape of a document the phone reads ⇒ a new generation here, written by this script, never
 * edited by hand. The corpus is only as faithful as the fake host; that limit is said, not hidden.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { hourFloor, hourKeyMs, undatedSince } from "@waterplane/shared";
import { demoCostWindow, demoTokenStats, demoTokenWindows } from "../../../web/src/demo/host/ledger.ts";

const HOUR = 3_600_000;
const here = dirname(fileURLToPath(import.meta.url));
const now = Date.UTC(2026, 9, 29, 12);
/** Scraped resets sit off the hour (the CLI prints the minute), as they do on a real desktop. */
const specs = [
  { id: "session", anchor: now + 2 * HOUR + 59 * 60_000, lenMs: 5 * HOUR },
  { id: "week", anchor: now + 3 * 24 * HOUR + 59 * 60_000, lenMs: 7 * 24 * HOUR },
];
const KEEP_BACK = 40;
const tokenwindows = demoTokenWindows(now, specs);
/** The record's reach is trimmed with the rows: a window the trim dropped must not come back as a
 *  measured "ran nothing". Half an hour before the oldest kept window opened, on the hour, is at or
 *  before its nearest local hour in every zone (`windowStartHour`). */
const reach = Math.floor((specs[0].anchor - KEEP_BACK * specs[0].lenMs - HOUR / 2) / HOUR) * HOUR;
tokenwindows.series = tokenwindows.series.map((s) => ({
  ...s,
  windows: s.windows.filter((w) => w.back < KEEP_BACK && s.anchor - (w.back + 1) * s.lenMs >= reach),
  oldestHour: Math.max(s.oldestHour, reach),
}));

/** The last twelve hours, the span a week card asks for early in a week. */
const costFrom = now - 12 * HOUR;
const costwindow = demoCostWindow(now, costFrom, now);

/** The all-time ledger keeps its days whole; its hours are trimmed to the last day, and
 *  `hoursFrom` with them (a host may keep hours for less than its reach — the field says so). */
const tokenstats = demoTokenStats(now);
const hoursFrom = hourFloor(now - 24 * HOUR);
tokenstats.hours = tokenstats.hours.filter((h) => hourKeyMs(h.hour) >= hoursFrom);
tokenstats.hoursFrom = Math.max(tokenstats.hoursFrom ?? hoursFrom, hoursFrom);

/** One log holding undated records written inside window back 2 of the session grid (inside the
 *  cost window too), one long before the record starts: the per-log pairs then clear some spans
 *  and not others. */
const recent = specs[0].anchor - 2 * 5 * HOUR - HOUR;
const old = tokenwindows.series[0].oldestHour - 24 * HOUR;
const until = { undated: 6, undatedUntil: recent };
const logs = { ...until, undatedLogs: [[old, 5], [recent, 1]] };
/** What each host put on `/api/costwindow`: f99f4328 the all-time count, later ones the count
 *  cut to the window by the same rule the phone reads (`undatedSince`, from the window's hour). */
const costUndated = (doc) => ({ undated: undatedSince(doc, costwindow.fromHour) });
const generations = {
  "0.1.11": { tokenwindows: {}, costwindow: {}, tokenstats: {} },
  f99f4328: { tokenwindows: { undated: 6 }, costwindow: { undated: 6 }, tokenstats: { undated: 6 } },
  "52f2fadb": { tokenwindows: until, costwindow: costUndated(until), tokenstats: until },
  e976a22d: { tokenwindows: logs, costwindow: costUndated(logs), tokenstats: logs },
};

mkdirSync(join(here, "base"), { recursive: true });
for (const [name, doc] of Object.entries({ tokenwindows, costwindow, tokenstats })) {
  writeFileSync(join(here, "base", `${name}.json`), JSON.stringify(doc) + "\n");
}
writeFileSync(join(here, "generations.json"), JSON.stringify(generations, null, 2) + "\n");
