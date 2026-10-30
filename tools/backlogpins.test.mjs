/**
 * Pins for splitting the backlog sheet (docs/notes/backlog-architecture.md).
 *
 * `Backlog.tsx` was 2674 lines — one component holding ~25 pieces of state —
 * and `backlogFilter.ts` 1649 lines of the rules its rows and chips are drawn
 * from. Both are cut into folders (`backlog/`, `backlogFilter/`). A
 * copy-then-delete move can DUPLICATE a site (a verb wired twice is a tap that
 * sends twice; a `track` id twice is a counter that double-counts) or DROP one
 * (a barrel that forgot a file is a name every caller loses at once). So the
 * counts here are read off the sheet's files as TEXT, FILE-AGNOSTIC — the same
 * assertions hold before the move, after each cut, and after the last. Moving
 * a pinned site keeps its count; changing a count is a behaviour change, made
 * here in the same commit and named in it.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname;
const SRC = join(ROOT, "packages", "web", "src");

/** The sheet: `Backlog.tsx` plus everything under `backlog/` (tests excluded). */
function sheetFiles() {
  const out = [{ rel: "Backlog.tsx", text: readFileSync(join(SRC, "Backlog.tsx"), "utf8") }];
  const dir = join(SRC, "backlog");
  if (existsSync(dir)) {
    for (const f of readdirSync(dir, { recursive: true }).filter((f) => /\.(ts|tsx)$/.test(f)).sort()) {
      out.push({ rel: `backlog/${f}`, text: readFileSync(join(dir, f), "utf8") });
    }
  }
  return out;
}
const sheet = () => sheetFiles().map((f) => f.text).join("\n");

/** occurrences of each match of `re` (group 1), over the sheet's files. */
function tally(re) {
  const out = {};
  for (const m of sheet().matchAll(re)) out[m[1]] = (out[m[1]] ?? 0) + 1;
  return Object.fromEntries(Object.entries(out).sort(([a], [b]) => (a < b ? -1 : 1)));
}

// ── P1: the barrel exports exactly what the one file did ───────────────────
test("P1: backlogFilter.ts exports the same 106 runtime names and 10 types", async () => {
  const m = await import(join(SRC, "backlogFilter.ts"));
  assert.deepEqual(Object.keys(m).sort(), [
    "AGE_LABEL", "ASSESS_NONE_IN_CUT", "BACKLOG_AGES", "BACKLOG_STATUSES", "BL_OFFLINE", "CATEGORY_BUCKETS",
    "CATEGORY_CHIP_LABEL", "CLOCK_MOVE_NOTE", "CLOSED_TARGET_OPTION", "DROP_CLOCK_TOAST", "FOCUS_AUTO_ON_LABEL",
    "FOCUS_AUTO_ON_TITLE", "HEADLINE_BY_WORDS", "HELD_OFFLINE", "HOLD_FOR_HOST_TEXT", "HOLD_FOR_HOST_TITLE",
    "NAME_COST_NOTE", "NAME_RUNNING_NOTE", "NEW_SESSION_OPTION", "NO_BACKLOG_FILTER", "PAST_BUDGET_CHIP",
    "PAST_BUDGET_TITLE", "PAST_BUDGET_UNDONE_TOAST", "RETIME_NONE_PICKED",
    "RETIME_PICK_LABEL", "RUN_AGAIN_LABEL", "RUN_AGAIN_TOAST", "SORT_CLOCK_NOTE", "SORT_LABEL", "SORT_NEWEST_NOTE", "ageBucket", "archiveDoneLabel", "archiveDoneNote",
    "archiveDoneToast", "assessScopeLabel", "assessScopeNote", "assessableInCut", "backlogBadgeCut", "backlogCountWords",
    "backlogCounts", "backlogFilterSentence", "badgeCutLabel", "badgeCutWords", "categoryBucket", "categoryChipTitle", "clockGroupWords",
    "clockGroups", "clockPickLabel", "clockPicks", "clockSeat", "clockSeatWords", "clockWords", "drawnChips", "dropClockNote", "dropClockTitle",
    "dropClocksLabel", "dropClocksNote", "dropClocksToast", "editTargetOptions", "effectiveSort", "fmtSpan", "focusRunWords",
    "fromScheduleWords", "goneOnClockLabel", "hasBacklogFilter", "headlineEditHint", "hiddenByArchive",
    "holdChipWords", "holderOffer", "isFailedRow", "itemClockKey", "matchesBacklogFilter", "nameLabel", "nameNote", "nameableInCut",
    "namingToast", "onClockIds", "onClockLabel", "pastBudgetChipWords", "queuedChipHeld", "realLabel", "refireOffered",
    "requeuedWords", "retimeEligible", "retimeNote", "retimeOffClockNote", "retimeQueuedToast", "retimeToast", "rowStatusKey", "rowStatusWord",
    "runAgainAimedCount", "runAgainClosedNote", "runAgainEligible", "runAgainIds", "runAgainLabel",
    "runAgainNote", "runAgainRowNote", "runAgainState", "runAgainToast", "runSeats", "scheduleItemsLabel",
    "scheduleParentLabel", "scheduleRuleLabel", "sortRows", "statusBucket", "withinAge",
  ]);
  // Types are erased, so read them as text: each declared exported exactly once
  // across the barrel and its folder.
  const dir = join(SRC, "backlogFilter");
  const texts = [readFileSync(join(SRC, "backlogFilter.ts"), "utf8"),
    ...(existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith(".ts")).map((f) => readFileSync(join(dir, f), "utf8")) : [])].join("\n");
  for (const t of ["BacklogAge", "CategoryBucket", "BacklogFilter", "FocusRunBreakdown", "BacklogClock", "ClockGroup", "ClockPick", "EditTargetOption", "BadgeCut", "BacklogSort"]) {
    assert.equal([...texts.matchAll(new RegExp(`^export (?:type|interface) ${t}\\b`, "gm"))].length, 1, t);
  }
});

// ── P2: one bucketing function per axis ─────────────────────────────────────
test("P2: ageBucket and categoryBucket are each defined once, and the count and the cut both call them", () => {
  const dir = join(SRC, "backlogFilter");
  const files = [join(SRC, "backlogFilter.ts"), ...(existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith(".ts")).map((f) => join(dir, f)) : [])];
  const all = files.map((f) => readFileSync(f, "utf8")).join("\n");
  for (const fn of ["ageBucket", "categoryBucket", "withinAge"]) {
    assert.equal([...all.matchAll(new RegExp(`export function ${fn}\\(`, "g"))].length, 1, `${fn} has one definition`);
  }
  const body = (name) => {
    const at = all.indexOf(`export function ${name}(`);
    assert.ok(at >= 0, name);
    return all.slice(at, all.indexOf("\n}\n", at));
  };
  assert.match(body("matchesBacklogFilter"), /withinAge\(/);
  assert.match(body("matchesBacklogFilter"), /categoryBucket\(/);
  assert.match(body("backlogCounts"), /ageBucket\(|withinAge\(/);
  assert.match(body("backlogCounts"), /categoryBucket\(/);
});

// ── P3: every verb is wired from as many sites as before ────────────────────
test("P3: each callback the sheet is handed is called from the same number of sites", () => {
  assert.deepEqual(tally(/\.(on[A-Z][A-Za-z]*|renderRetime|imageSrc|scheduleFor|assessBlocked)(?:\?\.|!)?\(/g), {
    assessBlocked: 1, imageSrc: 1,
    onArchive: 2, onArchiveMany: 1, onAssess: 1, onCheck: 1, onCloseSession: 1, onContinue: 3, onDone: 1,
    onDropClock: 1, onDropClocks: 1, onEditImage: 1, onEditWhen: 1, onFire: 2, onHoldForBudget: 1, onName: 1,
    onNextStep: 1, onOpenCut: 1, onOpenSchedule: 1, onOpenSend: 2, onOpenWeekBurn: 2, onOpenSession: 4, onQueueHere: 2, onRemove: 1,
    onReorder: 1, onRunAgain: 1, onRunAgainMany: 1, onSetAuto: 2, onSetBudget: 1, onSetCloseWhenDone: 1, onSetFlagWhenDone: 1, onSlotCheck: 1,
    onSwap: 4, onUpdate: 1, onValidate: 1,
    renderRetime: 1, scheduleFor: 1,
  });
});

// ── P4: usage counters and hint anchors are neither lost nor doubled ────────
test("P4: every track(\"action:backlog.*\") id and data-hint keeps its count", () => {
  assert.deepEqual(tally(/track\("action:(backlog\.[^"]+)"\)/g), {
    "backlog.archive.done": 1, "backlog.assess": 1, "backlog.auto.focus": 1, "backlog.clock.down": 1,
    "backlog.clock.up": 1, "backlog.done": 1, "backlog.dropclock": 1, "backlog.dropclock.all": 1,
    "backlog.editwhen": 1, "backlog.filter.age": 1, "backlog.filter.category": 1, "backlog.filter.clear": 1,
    "backlog.filter.clock": 1, "backlog.filter.status": 1, "backlog.fire": 1, "backlog.fromschedule": 1, "backlog.fromweekburn": 1,
    "backlog.holdforbudget": 1, "backlog.name": 1, "backlog.openholder": 1,
    "backlog.queuehere": 1, "backlog.refire": 1, "backlog.remove": 1, "backlog.retime.clock": 1, "backlog.retime.pick": 1,
    "backlog.runagain": 1, "backlog.runagain.all": 1, "backlog.send": 1, "backlog.slotClose": 1, "backlog.slotask.on": 1, "backlog.slotcheck": 1,
    "backlog.sort.newest": 1, "backlog.sort.run": 1, "backlog.unqueuehere": 1,
    "backlog.weekburn": 1, "backlog.weekburnrows": 1,
  });
  assert.deepEqual(tally(/data-hint="(backlog\.[^"]+)"/g), {
    "backlog.done": 1, "backlog.fire": 1, "backlog.name": 1, "backlog.openholder": 1, "backlog.queuehere": 2,
    "backlog.refire": 1, "backlog.runagain": 1,
  });
});

// ── P5: the four keys the sheet keeps, and their spelling ──────────────────
test("P5: the sheet's localStorage keys are the registry's, spelled as they always were", () => {
  const storage = ["storage.ts", "storage/keysPrefs.ts", "storage/keysWork.ts", "storage/keysView.ts"].map((f) => readFileSync(join(SRC, f), "utf8")).join("\n");
  assert.match(storage, /backlogRepo: lsKey\("backlogRepo"\)/);
  assert.match(storage, /backlogDraft: lsKey\("backlogDraft"\)/);
  assert.match(storage, /backlogShowArchived: lsKey\("backlogShowArchived"\)/);
  assert.match(storage, /backlogSortRun: lsKey\("backlogSortRun"\)/);
  const s = sheet();
  for (const k of ["backlogRepo", "backlogDraft", "backlogShowArchived", "backlogSortRun"]) assert.ok(s.includes(`LS.${k}`), `LS.${k} is read through the registry`);
  // The effects the sheet registers: one drag binding (the clock is `useNow`)
  // and the one that pins a repo derived from the items into the cut. The cut
  // is otherwise no effect at all: it is one store outside the sheet, read every
  // render, so nothing re-applies a cut from outside or mirrors one back (NAV-1).
  // A second copy of any of them runs twice per change.
  assert.equal(s.split("useEffect(").length - 1, 2, "two effects");
  assert.equal(s.split("useNow(").length - 1, 1, "one clock");
});

// ── the cut has one owner, and Back keeps exactly it ────────────────────────
// NAV-1: Back restored the cut the sheet was OPENED on, because the cut on
// screen lived in the sheet's own state while `keep` saved the open-time
// stores. The behaviour is pinned in `features/backlog/livecut.test.mjs`; this
// pins the two lines no unit test can import (the manifest needs the SDK): the
// store `onLeave` clears is the one store `keep` puts back.
test("the backlog sheet keeps the one store its onLeave clears", () => {
  const index = readFileSync(join(SRC, "features", "backlog", "index.ts"), "utf8");
  const actions = readFileSync(join(SRC, "features", "backlog", "actions.ts"), "utf8");
  assert.match(index, /id: "backlog",[^\n]*onLeave: clearBacklogFocus, keep: keepStores\(backlogCut\) \}/);
  const leave = actions.slice(actions.indexOf("export function clearBacklogFocus("));
  assert.match(leave.slice(0, leave.indexOf("\n}\n")), /^\s*backlogCut\.set\(cutLeft\);$/m);
  const hook = readFileSync(join(SRC, "backlog", "useBacklogFilters.ts"), "utf8");
  assert.deepEqual(hook.match(/useState[<(]|useRef[<(]/g), ["useState<"], "the cut is never local state in the sheet — only the archived toggle is");
});

// ── fire is the manual override: ONE tap, always ────────────────────────────
// It was a `ConfirmButton` into a busy checkout, which disarms on a timer — the
// owner's tap on a held row only ever ARMED it and nothing fired. The busy
// consequence is said (title + `RowNotes`), never asked.
test("fire and re-fire are one tap — never a ConfirmButton", () => {
  const text = readFileSync(join(SRC, "backlog", "RowActions.tsx"), "utf8");
  assert.doesNotMatch(text, /SKIP_QUEUE_BUSY_CONFIRM/);
  for (const m of text.matchAll(/<ConfirmButton[\s\S]*?<\/ConfirmButton>/g)) {
    assert.doesNotMatch(m[0], /backlog\.(fire|refire)|onFire\(/, "a fire verb wrapped in a confirm");
  }
  // A `manual` row (an agent handed it over) wears `primary`: its fire is the only way it runs.
  assert.match(text, /<Button (?:className=\{it\.manual \? "primary" : undefined\} )?data-hint="backlog\.fire"[^>]*onClick=\{\(\) => \{ track\("action:backlog\.fire"\); p\.verbs\.onFire\(it\.id\); \}\}>fire<\/Button>/);
  assert.match(text, /<Button data-hint="backlog\.refire"[^>]*onClick=\{\(\) => \{ track\("action:backlog\.refire"\); p\.verbs\.onFire\(it\.id\); \}\}>re-fire<\/Button>/);
});
