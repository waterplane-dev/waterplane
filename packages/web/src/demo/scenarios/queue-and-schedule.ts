/**
 * Scenario `queue-and-schedule` (demo-mode-plan.md §3, WP8a): work that waits.
 *
 * The todo-garden session is mid-turn when the demo opens, and a prompt is
 * already queued behind it ("when it is free" — an `idle` intent aimed at that
 * session, blocked on `sessionBusy`). Auto is ON on this desktop, so nothing on
 * screen says the prompt "does not start on its own" two screens before it
 * does. A few seconds in the turn finishes, the queued prompt is delivered into
 * the same session and runs — the demo's answer to "what happens to what I send
 * while it is working". Its Activity row never vanishes: it goes waiting ->
 * running -> done. Beside it: a backlog with queued / done items and three
 * standing schedules — one on a clock (every night), two anchored to the
 * WEEKLY usage reset (two hours before it, to spend what is left; right after
 * it, when the allowance is back). Each schedule is also the intent a real host
 * keeps it as, so Activity counts them under *scheduled* like the repo list does.
 *
 * The queued prompt's run is SCRIPTED (script events), not engine behaviour:
 * the demo never fires an intent or a schedule by itself (plan, WP2b), so the
 * scenario states what the real host would do and nothing else is faked.
 *
 * Time is relative to `now`, like every scenario. Script times (`at`, ms from
 * the demo's start): the first turn ends at `TURN_END` (late enough that the
 * film has reached Activity), the queued one is delivered half a second later
 * and is done two seconds after that, so "done" is on screen when its caption
 * is. A journey waits on text, never on those numbers.
 */
import { ORIGIN_SCHEDULE_WORK, PROTOCOL_VERSION, intentVerdict, nextFireAt, type BacklogItem, type Intent, type ScheduleRule } from "@waterplane/shared";
import type { DemoScenario } from "../host/index.ts";
import { demoUsage } from "../host/handlers.ts";
import type { DemoModel, DemoStep } from "../host/model.ts";
import { DAY, G, GARDEN, HOUR, MIN, NOTES, R0, TRAIL, bullet, repos, screen, tool } from "./garden.ts";
import { CLAUDE_BANNER, claudeBanner } from "../host/banner.ts";

/** What the queued prompt says; the journey and the test both look for it. */
export const QUEUED_PROMPT = "group the tasks by day, today first";

/**
 * When the running turn ends (ms from the demo's start); the queued one follows half a second later.
 * A film reaches Activity about two and a half seconds in (a test run in under one) and must still find
 * the row waiting there; any later and the film holds a screen whose only motion is the link strip's
 * ticks, each one a picture the film's pacing holds.
 */
export const TURN_END = 4_500;
/** After `TURN_END`: the queued prompt is delivered (its row goes running), then its turn is done. */
export const QUEUED_STARTS = 500;
export const QUEUED_DONE = 2_500;

/** The backlog beside the queued prompt: five items over three repos. */
const otherItems = (ago: (ms: number) => number): BacklogItem[] => [
      { id: "b1", text: "Make the empty state friendlier", status: "queued", repoDir: GARDEN, createdAt: ago(20 * HOUR), order: 1, label: "Empty state" },
      { id: "b2", text: "Add a swipe-to-complete gesture on a task row", status: "queued", repoDir: GARDEN, createdAt: ago(1 * DAY), order: 2, label: "Swipe to complete" },
      { id: "b3", text: "Rename 'Tasks' to 'Beds' in the settings screen", status: "done", repoDir: GARDEN, createdAt: ago(2 * DAY), order: 0, label: "Rename in settings", startedAt: ago(2 * DAY - HOUR), finishedAt: ago(2 * DAY - 90 * MIN) },
      { id: "b4", text: "Wire the background sync into app start", status: "queued", repoDir: NOTES, createdAt: ago(40 * MIN), order: 1, label: "Wire the sync" },
      { id: "b5", text: "Show the total distance on the hike list", status: "queued", repoDir: TRAIL, createdAt: ago(1 * DAY), order: 1, label: "Total distance" },
];

type Usage = ReturnType<typeof demoUsage>;
type Entry = NonNullable<DemoModel["schedules"]>[number];

/**
 * The three standing rules, soonest first. One clock rule and two anchored to the weekly usage reset
 * (`rule.kind: "window"`), armed against the desktop's usage reading the way the host arms them
 * (`nextFireAt` with the reading's resets), so the week bar and the cards place them where a real
 * desktop would.
 */
function schedules(now: number, usage: Usage): Entry[] {
  const nightly: ScheduleRule = { kind: "weekly", days: [], hour: 2, minute: 0, tz: "Europe/Berlin" };
  const spend: ScheduleRule = { kind: "window", window: "weekly", edge: "before", offsetMin: -120, minPctLeft: 20 };
  const back: ScheduleRule = { kind: "window", window: "weekly", edge: "after", offsetMin: 0 };
  const arm = (rule: ScheduleRule) => nextFireAt(rule, now, usage);
  return [
    {
      id: "sch1", name: "Nightly: run the full test suite", enabled: true, createdAt: now - 6 * DAY, graceMin: 120, nextAt: arm(nightly), rule: nightly,
      action: { kind: "backlog", repoDir: NOTES, text: "Run the full test suite and summarise anything that fails", label: "Full test run", autoFire: true },
    },
    {
      id: "sch2", name: "Before the weekly reset: spend what is left", enabled: true, createdAt: now - 4 * DAY, graceMin: 120, nextAt: arm(spend), rule: spend,
      action: { kind: "backlog", repoDir: GARDEN, text: "Work through the queued backlog items while this week's allowance is still there", label: "Use the week", autoFire: true },
    },
    {
      id: "sch3", name: "When the week is back: dependency check", enabled: true, createdAt: now - 5 * DAY, graceMin: 120, nextAt: arm(back), rule: back,
      action: { kind: "backlog", repoDir: TRAIL, text: "Check for outdated dependencies and list what is safe to update", label: "Dependency check", autoFire: true },
    },
  ];
}

/**
 * A schedule as the intent the host stores it as (`scheduleToIntent`), waiting for its time with the
 * verdict the shared ladder gives it — the row Activity files under *scheduled*. The repo list counts
 * these, so an Activity that left them out said "scheduled 0" beside a list advertising three.
 */
function scheduleIntent(e: Entry, now: number): Intent {
  const a = e.action as { repoDir: string; text: string; label?: string; autoFire?: boolean };
  const row: Intent = {
    id: e.id, cwd: a.repoDir, payload: { kind: "prompt", steps: [a.text] },
    target: { kind: "repo", fresh: true }, trigger: { kind: "at", rule: e.rule, graceMin: e.graceMin },
    title: e.name, label: a.label, auto: a.autoFire !== false, origin: ORIGIN_SCHEDULE_WORK,
    state: "blocked", createdAt: e.createdAt, nextAt: e.nextAt,
  };
  const v = intentVerdict(row, {
    present: new Set(), sessions: [], busyCwds: new Set(), budgetBlocked: false, autoFire: true,
    knownDirs: new Set([GARDEN, NOTES, TRAIL]), hostBusy: false, autoSlotsFree: 1,
  }, now);
  return v.kind === "wait" ? { ...row, blockReason: v.reason, blockDetail: v.detail } : row;
}

export function queueAndSchedule(now: number): DemoScenario {
  const ago = (ms: number) => now - ms;
  const ahead = (ms: number) => now + ms;
  const g1 = "demo-g1";
  const T = TURN_END;
  /** The reading the host would hold anyway (`demoUsage`), carried here so the window rules are armed
   *  against the very resets the header meter and the week bar show. */
  const usage = demoUsage(now);
  const scheduleList = schedules(now, usage);
  const scheduleIntents = scheduleList.map((e) => scheduleIntent(e, now));

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
  const intentList = (row: Intent) => ({ t: "intent.list" as const, intents: [row, ...scheduleIntents] });

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
  const backlogList = (items: BacklogItem[]) => ({ t: "backlog.list" as const, items: [...items, ...otherItems(ago)], auto: true, idleMs: 60_000 });

  const run = T + QUEUED_STARTS;
  const done = T + QUEUED_DONE;
  const script: { at: number; event: DemoStep }[] = [
    // the running turn finishes …
    { at: T - 6_000, event: { kind: "output", sessionId: g1, text: tool("Update", "src/components/NewTaskSheet.tsx", "Added 18 lines, removed 3 lines") } },
    { at: T - 3_000, event: { kind: "output", sessionId: g1, text: tool("Bash", "npm test -- NewTaskSheet", `${G}PASS${R0} src/components/NewTaskSheet.test.tsx (6 tests)`) } },
    { at: T - 100, event: { kind: "output", sessionId: g1, text: bullet("Done. The new-task sheet now has a due-date picker (src/components/NewTaskSheet.tsx).") } },
    { at: T, event: { kind: "turnEnd", sessionId: g1 } },
    // … the session is free: the queued prompt is delivered and the row leaves the queue
    { at: run, event: { kind: "frame", msg: intentList(queued({ state: "running", startedAt: ahead(run), sessionId: g1 })) } },
    { at: run, event: { kind: "frame", msg: backlogList([backlogItem({ status: "running", startedAt: ahead(run), sessionId: g1 })]) } },
    { at: run, event: { kind: "output", sessionId: g1, text: `\r\n> ${QUEUED_PROMPT}\r\n` } },
    { at: run, event: { kind: "session", sessionId: g1, patch: { turnActive: true, turnStartedAt: ahead(run), idle: false, lastPrompt: QUEUED_PROMPT, lastTurnAt: ahead(run) }, unset: ["idleSince"] } },
    { at: run + 300, event: { kind: "output", sessionId: g1, text: bullet("Grouping by day: today, tomorrow, later this week.") } },
    { at: run + 800, event: { kind: "output", sessionId: g1, text: tool("Update", "src/store/tasks.ts", "Added 22 lines, removed 4 lines") } },
    { at: run + 1_300, event: { kind: "output", sessionId: g1, text: tool("Bash", "npm test -- tasks", `${G}PASS${R0} src/store/tasks.test.ts (9 tests)`) } },
    { at: done - 200, event: { kind: "output", sessionId: g1, text: bullet("Done. The list is grouped by day, today first (src/store/tasks.ts).") } },
    { at: done - 100, event: { kind: "turnEnd", sessionId: g1 } },
    { at: done, event: { kind: "frame", msg: intentList(queued({ state: "done", startedAt: ahead(run), settledAt: ahead(done), sessionId: g1, result: { at: ahead(done), ok: true, detail: "ran in Due-date picker" } })) } },
    { at: done, event: { kind: "frame", msg: backlogList([backlogItem({ status: "done", startedAt: ahead(run), finishedAt: ahead(done), sessionId: g1 })]) } },
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
        // The session's own agent flagged it for follow up (R-sessions-044),
        // with its one line — the docs' example of a teal flag and its reason.
        followUp: { by: "agent", at: ago(50 * MIN), reason: "two ways to schedule the sync — pick one before I build it" },
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
      auto: true,
      items: [backlogItem({}), ...otherItems(ago)],
    },
    schedules: scheduleList,
    intents: [queued({ state: "blocked", blockReason: "sessionBusy", blockDetail: "the session is working on its current turn" }), ...scheduleIntents],
    numbers: { usage },
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
