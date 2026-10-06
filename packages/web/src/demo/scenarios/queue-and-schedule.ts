/**
 * Scenario `queue-and-schedule` (demo-mode-plan.md §3, WP8a): work that waits.
 *
 * The todo-garden session is mid-turn when the demo opens, and a prompt is
 * already queued behind it ("when it is free" — an `idle` intent aimed at that
 * session, blocked on `sessionBusy`). A few seconds in the turn finishes, the
 * queued prompt is delivered into the same session and runs — the demo's
 * answer to "what happens to what I send while it is working". Its Activity row
 * never vanishes: it goes waiting -> running -> done. Beside it: a
 * backlog with queued / done items, a weekly schedule, a one-off for tomorrow
 * morning and a paused one, so the Backlog and Schedule sheets are full.
 *
 * The queued prompt's run is SCRIPTED (script events), not engine behaviour:
 * the demo never fires an intent or a schedule by itself (plan, WP2b), so the
 * scenario states what the real host would do and nothing else is faked.
 *
 * Time is relative to `now`, like every scenario. Script times (`at`, ms from
 * the demo's start): the first turn ends at 7s, the queued one is delivered at
 * 9s and ends at 17s. A journey waits on text, never on those numbers.
 */
import { PROTOCOL_VERSION, type BacklogItem, type Intent } from "@waterplane/shared";
import type { DemoScenario } from "../host/index.ts";
import type { DemoModel, DemoStep } from "../host/model.ts";
import { DAY, G, GARDEN, HOUR, MIN, NOTES, R0, TRAIL, bullet, nextMonday, repos, screen, tool } from "./garden.ts";
import { CLAUDE_BANNER, claudeBanner } from "../host/banner.ts";

/** What the queued prompt says; the journey and the test both look for it. */
export const QUEUED_PROMPT = "group the tasks by day, today first";

/** The backlog beside the queued prompt: five items over three repos. */
const otherItems = (ago: (ms: number) => number): BacklogItem[] => [
      { id: "b1", text: "Make the empty state friendlier", status: "queued", repoDir: GARDEN, createdAt: ago(20 * HOUR), order: 1, label: "Empty state" },
      { id: "b2", text: "Add a swipe-to-complete gesture on a task row", status: "queued", repoDir: GARDEN, createdAt: ago(1 * DAY), order: 2, label: "Swipe to complete" },
      { id: "b3", text: "Rename 'Tasks' to 'Beds' in the settings screen", status: "done", repoDir: GARDEN, createdAt: ago(2 * DAY), order: 0, label: "Rename in settings", startedAt: ago(2 * DAY - HOUR), finishedAt: ago(2 * DAY - 90 * MIN) },
      { id: "b4", text: "Wire the background sync into app start", status: "queued", repoDir: NOTES, createdAt: ago(40 * MIN), order: 1, label: "Wire the sync" },
      { id: "b5", text: "Show the total distance on the hike list", status: "queued", repoDir: TRAIL, createdAt: ago(1 * DAY), order: 1, label: "Total distance" },
];

export function queueAndSchedule(now: number): DemoScenario {
  const ago = (ms: number) => now - ms;
  const ahead = (ms: number) => now + ms;
  const g1 = "demo-g1";

  const screenNow =
    `${claudeBanner("~/dev/todo-garden")}` +
    `> add a due-date picker to the new-task sheet\r\n` +
    bullet("I'll start with how the new-task sheet is built.") +
    tool("Read", "src/components/NewTaskSheet.tsx", "Read 96 lines") +
    tool("Read", "src/components/DatePicker.tsx", "Read 41 lines");

  /** The queued row at one moment of its life; a row never vanishes, it changes verdict. */
  const queued = (over: Partial<Intent>): Intent => ({
    id: "i1", cwd: GARDEN, payload: { kind: "prompt", steps: [QUEUED_PROMPT] },
    target: { kind: "session", sessionId: g1, resumeConvId: "c-garden-2" }, trigger: { kind: "idle" },
    state: "queued", createdAt: ago(30_000), label: "Group by day", ...over,
  });

  /**
   * The same prompt as the BACKLOG row it is. On a real host a prompt aimed at a session "when it is
   * free" is one intent seen two ways: Activity lists it as the intent, the Backlog as the item with
   * the same id (`isBacklogRow`), and the launcher's "waiting" count opens the Backlog on that id. A
   * scenario that models only the intent leaves that tap on an empty list.
   */
  const backlogItem = (over: Partial<BacklogItem>): BacklogItem => ({
    id: "i1", text: QUEUED_PROMPT, status: "queued", repoDir: GARDEN, targetSessionId: g1, autoFire: true,
    label: "Group by day", createdAt: ago(30_000), order: 0, ...over,
  });
  const backlogList = (items: BacklogItem[]) => ({ t: "backlog.list" as const, items: [...items, ...otherItems(ago)], auto: false, idleMs: 60_000 });

  const script: { at: number; event: DemoStep }[] = [
    // the running turn finishes …
    { at: 3_000, event: { kind: "output", sessionId: g1, text: tool("Update", "src/components/NewTaskSheet.tsx", "Added 18 lines, removed 3 lines") } },
    { at: 5_000, event: { kind: "output", sessionId: g1, text: tool("Bash", "npm test -- NewTaskSheet", `${G}PASS${R0} src/components/NewTaskSheet.test.tsx (6 tests)`) } },
    { at: 7_000, event: { kind: "output", sessionId: g1, text: bullet("Done. The new-task sheet now has a due-date picker (src/components/NewTaskSheet.tsx).") } },
    { at: 7_100, event: { kind: "turnEnd", sessionId: g1 } },
    // … the session is free: the queued prompt is delivered and the row leaves the queue
    { at: 9_000, event: { kind: "frame", msg: { t: "intent.list", intents: [queued({ state: "running", startedAt: ahead(9_000), sessionId: g1 })] } } },
    { at: 9_000, event: { kind: "frame", msg: backlogList([backlogItem({ status: "running", startedAt: ahead(9_000), sessionId: g1 })]) } },
    { at: 9_000, event: { kind: "output", sessionId: g1, text: `\r\n> ${QUEUED_PROMPT}\r\n` } },
    { at: 9_000, event: { kind: "session", sessionId: g1, patch: { turnActive: true, turnStartedAt: ahead(9_000), idle: false, lastPrompt: QUEUED_PROMPT, lastTurnAt: ahead(9_000) }, unset: ["idleSince"] } },
    { at: 11_000, event: { kind: "output", sessionId: g1, text: bullet("Grouping by day: today, tomorrow, later this week.") } },
    { at: 13_000, event: { kind: "output", sessionId: g1, text: tool("Update", "src/store/tasks.ts", "Added 22 lines, removed 4 lines") } },
    { at: 15_000, event: { kind: "output", sessionId: g1, text: tool("Bash", "npm test -- tasks", `${G}PASS${R0} src/store/tasks.test.ts (9 tests)`) } },
    { at: 17_000, event: { kind: "output", sessionId: g1, text: bullet("Done. The list is grouped by day, today first (src/store/tasks.ts).") } },
    { at: 17_100, event: { kind: "turnEnd", sessionId: g1 } },
    { at: 17_200, event: { kind: "frame", msg: { t: "intent.list", intents: [queued({ state: "done", startedAt: ahead(9_000), settledAt: ahead(17_200), sessionId: g1, result: { at: ahead(17_200), ok: true, detail: "ran in Due-date picker" } })] } } },
    { at: 17_200, event: { kind: "frame", msg: backlogList([backlogItem({ status: "done", startedAt: ahead(9_000), finishedAt: ahead(17_200), sessionId: g1 })]) } },
  ];

  const model: DemoModel = {
    repos: repos(),
    sessions: [
      {
        id: g1, cwd: GARDEN, title: "todo-garden · main", tabTitle: "Due-date picker", remoteControl: true, running: true,
        turnActive: true, turnStartedAt: ago(40_000), lastTurnAt: ago(40_000), idle: false, createdAt: ago(25 * MIN), claudeSessionId: "c-garden-2",
        contextLeft: 71, starred: false,
        firstPrompt: "add a due-date picker to the new-task sheet", lastPrompt: "add a due-date picker to the new-task sheet",
      },
      {
        id: "demo-n1", cwd: NOTES, title: "pocket-notes · main", tabTitle: "Background sync", remoteControl: true, running: true,
        idle: true, idleSince: ago(50 * MIN), createdAt: ago(2 * HOUR), claudeSessionId: "c-notes-2", contextLeft: 83, starred: false,
        firstPrompt: "sketch a background sync that runs every 15 minutes", lastPrompt: "sketch a background sync that runs every 15 minutes",
      },
    ],
    screens: {
      [g1]: screen(screenNow),
      "demo-n1": screen(
        `${claudeBanner("~/dev/pocket-notes")}> sketch a background sync that runs every 15 minutes\r\n` +
          bullet("Sketched: a timer in src/sync/scheduler.ts calls the existing push, skipping when offline.") +
          "\r\n",
      ),
    },
    history: {
      [g1]: [],
      "demo-n1": [
        {
          id: "h-1", kind: "prompt", text: "sketch a background sync that runs every 15 minutes", sentAt: ago(2 * HOUR - 2 * MIN), outputAt: ago(50 * MIN),
          output: "Sketched: a timer in src/sync/scheduler.ts calls the existing push, skipping when offline. Not wired in yet.",
        },
      ],
    },
    recent: [
      { cwd: GARDEN, title: "todo-garden", lastActive: ago(1 * MIN), claudeSessionId: "c-garden-2", launch: {} },
      { cwd: NOTES, title: "pocket-notes", lastActive: ago(50 * MIN), claudeSessionId: "c-notes-2", launch: {} },
      { cwd: TRAIL, title: "trail-log", lastActive: ago(1 * DAY), claudeSessionId: "c-trail-1", launch: {} },
    ],
    closed: [],
    backlog: {
      auto: false,
      items: [backlogItem({}), ...otherItems(ago)],
    },
    schedules: [
      {
        id: "sch1", name: "Weekly dependency check", enabled: true, createdAt: ago(6 * DAY), graceMin: 120, nextAt: nextMonday(now),
        rule: { kind: "weekly", days: [1], hour: 9, minute: 0, tz: "Europe/Berlin" },
        action: { kind: "backlog", repoDir: GARDEN, text: "Check for outdated dependencies and list what is safe to update", label: "Dependency check", autoFire: true },
      },
      {
        id: "sch2", name: "Tomorrow: run the full test suite", enabled: true, createdAt: ago(3 * HOUR), graceMin: 60, nextAt: ahead(15 * HOUR),
        rule: { kind: "once", at: ahead(15 * HOUR), offsetMin: 0, tz: "Europe/Berlin" },
        action: { kind: "backlog", repoDir: NOTES, text: "Run the full test suite and summarise anything that fails", label: "Full test run", autoFire: true },
      },
      {
        id: "sch3", name: "Friday: tidy the changelog", enabled: false, createdAt: ago(5 * DAY), graceMin: 120, nextAt: null,
        rule: { kind: "weekly", days: [5], hour: 16, minute: 30, tz: "Europe/Berlin" },
        action: { kind: "backlog", repoDir: TRAIL, text: "Tidy CHANGELOG.md: one line per change, newest first", label: "Changelog tidy", autoFire: false },
      },
    ],
    intents: [queued({ state: "blocked", blockReason: "sessionBusy", blockDetail: "the session is working on its current turn" })],
    replies: [
      { match: "day", cwd: GARDEN, steps: [{ kind: "output", text: bullet("Grouping by day."), afterMs: 600 }] },
    ],
    banner: CLAUDE_BANNER,
  };

  return {
    meta: { id: "queue-and-schedule", protocol: PROTOCOL_VERSION, stamp: "queue-and-schedule-1" },
    clock: { start: now },
    state: { bootId: "boot", model: model as unknown as DemoScenario["state"]["model"] },
    script,
  };
}
