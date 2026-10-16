/**
 * Scenario `first-look` (demo-mode-plan.md §3, WP4; demo-pitch-plan.md §1; R-demo-014, R-demo-033):
 * the first minute with the app. It opens on the repo list; a cue points at todo-garden's `+ now`,
 * and the session that tap starts is Claude Code's own welcome header. The demo types the first
 * prompt into the compose box and sends it by itself: make the add button bigger and check it in
 * the iOS simulator and the Android emulator (`hookReply`). The turn builds, takes a screenshot on
 * each, reads both, and lands them in the outbox (gallery, new-images strip, notifications): ① iOS
 * looks right, ② Android has the button under the keyboard. Combined into one picture, ② circled
 * and sent back with "make ② look like ①", the fix (`fixReply`) changes the Android window, checks
 * both again, lands the after screenshot, and builds the debug APK into the outbox, which reaches
 * the phone as the host's own "Outbox:" notification — a download for the real device. The reader
 * prices every turn under it.
 * Beside it: a session already in todo-garden with a choice box to answer by tap ("sort"), a few
 * backlog items and one schedule so the other tabs are not empty.
 *
 * Shape: the model WP2b reads (`demo/host/model.ts`), seeded from the stub-driven
 * recording (`STUB_MODE=demo`, `tools/demo-scenario.mjs`): the todo-app work
 * lines, the "sorted by due date?" box and its two answers are that recording's
 * script, grown into a longer, readable session. Everything is fictional — no
 * path, name or number comes from this machine; `scenarios.test.mjs` runs the
 * recording tool's scrub (`findLeaks`) over the result so a hand edit cannot
 * leak one. The three simulator screenshots are drawn by `scripts/media/demo-shots.mjs`.
 *
 * Time: every instant is relative to `now`. The shipped build calls
 * `firstLook(Date.now())`, so a reviewer opening the demo in a year still reads
 * "40 min ago"; tests and docs media pass `CLOCK_START` for a fixed picture.
 * The numbers and the work/log lists live in first-look-fill.ts.
 */
import { PROTOCOL_VERSION, costOf, type ContextSpark } from "@waterplane/shared";
import type { DemoScenario } from "../host/index.ts";
import type { DemoModel, DemoStep, DemoTimedStep, DemoTurnFacts } from "../host/model.ts";
import { demoTopConvos } from "../host/ledger.ts";
import { GARDEN_LAST_TOK, GARDEN_SERIES, GARDEN_WINDOW_TOK, numbersFill, windowSchedules, workFill } from "./first-look-fill.ts";
import { CLAUDE_BANNER, claudeBanner } from "../host/banner.ts";

/** Where the session the hook starts stands: what a fresh claude here re-reads before the first
 *  prompt (the welcome, CLAUDE.md, the tools), after the hook turn, and after the fix. */
const GARDEN_LAST = GARDEN_LAST_TOK;
const FRESH_TOK = 56_000;
const HOOK_LAST = 128_000;
const FIX_LAST = 151_000;
/** 2026-10-01 09:00 UTC — what `tools/demo-scenario.mjs` pins recordings to. */
export const CLOCK_START = Date.UTC(2026, 9, 1, 9, 0, 0);

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

const GARDEN = "~/dev/todo-garden";
const NOTES = "~/dev/pocket-notes";
const TRAIL = "~/dev/trail-log";

const SORTED = ".claude/outbox/todo-garden-sorted.png";
/** The hook turn's two screenshots (① the iOS simulator, ② the Android emulator), and the after
 *  picture the fix lands (`scripts/media/demo-shots.mjs` draws all three). */
export const IOS_SHOT = ".claude/outbox/todo-garden-ios.png";
export const ANDROID_SHOT = ".claude/outbox/todo-garden-android.png";
export const ANDROID_FIXED = ".claude/outbox/todo-garden-android-fixed.png";
/** The build the fix ends with: the host's outbox notification offers it to the phone. */
export const APK = ".claude/outbox/todo-garden-debug.apk";
const APK_SIZE = 8_812_544;
/** The prompt the demo types into the box of the session the first tap starts. */
export const HOOK_PROMPT = "make + Add bigger, check iOS sim and Android emulator";
/** What the combine-mark-and-send-back reply matches (`features/demoTour` `HOOK_REPLY_MATCH`). */
export const FIX_MATCH = "look like";
const BEFORE = ".claude/outbox/todo-garden-before.png";
const SKETCH = ".claude/inbox/swipe-sketch.png";
const RIDGE = ".claude/outbox/trail-log-ridge-loop.png";

/** Bytes of what is in `public/demo/media/r1/` — a test pins these to the files. */
export const MEDIA_SIZES = {
  [SORTED]: 31628, [BEFORE]: 31174, [SKETCH]: 2169, [RIDGE]: 4174,
  [IOS_SHOT]: 32068, [ANDROID_SHOT]: 28428, [ANDROID_FIXED]: 31187,
} as const;

/** The model the todo-garden session runs, as its log names it — what `facts` are priced at. */
const MODEL = "claude-opus-5-5";

type Bag = { input: number; output: number; cacheRead: number; cacheWrite: number };
/** One subagent a turn started: its kind, its model and its own log's tokens (5-minute writes, as
 *  an agent's are). */
interface TurnAgent { type: string; model: string; bag: Bag }
/** The running totals a turn's figures are added to — the conversation's own and its agents'. */
interface Cum { main: number; agents: number }

const tokOf = (b: Bag) => b.input + b.output + b.cacheRead + b.cacheWrite;

/**
 * One turn's reader figures, priced the way a real host's `transcript.ts`
 * prices a log (shared `costOf`; the conversation's writes on the 1-hour tier,
 * an agent's on the 5-minute one), so every dollar figure — the turn's, its
 * agents', each model's share — is the split's own answer and never a number
 * typed in beside it.
 */
function turnFacts(bag: Bag, ctxTok: number, cum: Cum, agents: TurnAgent[] = []): DemoTurnFacts {
  const price = (b: Bag, model: string, oneHour: boolean) => {
    const c = costOf({ ...b, cacheWrite1h: oneHour ? b.cacheWrite : 0 }, model);
    if (!c) throw new Error(`${model} has no published rate`);
    return c.total;
  };
  const own = price(bag, MODEL, true);
  const facts: DemoTurnFacts = {
    costUsd: own, cumCostUsd: cum.main + own, ctxTok, tokens: bag, models: [{ id: MODEL, tok: tokOf(bag), costUsd: own }],
    cumAgentCostUsd: cum.agents,
  };
  if (!agents.length) return facts;
  const byModel = new Map<string, { tok: number; costUsd: number }>();
  const byType = new Map<string, number>();
  let spent = 0;
  for (const a of agents) {
    const usd = price(a.bag, a.model, false);
    spent += usd;
    const m = byModel.get(a.model) ?? byModel.set(a.model, { tok: 0, costUsd: 0 }).get(a.model)!;
    m.tok += tokOf(a.bag);
    m.costUsd += usd;
    byType.set(a.type, (byType.get(a.type) ?? 0) + 1);
  }
  return {
    ...facts, agentCostUsd: spent, cumAgentCostUsd: cum.agents + spent,
    agentModels: [...byModel.entries()].map(([id, m]) => ({ id, ...m })),
    agentTypes: [...byType.entries()].map(([type, n]) => ({ type, n })),
  };
}
const cumOf = (f: DemoTurnFacts): Cum => ({ main: f.cumCostUsd ?? 0, agents: f.cumAgentCostUsd ?? 0 });

/** The window the series is a share of (first-look-fill.ts `GARDEN_WINDOW_TOK`). */
const left = (tok: number) => Math.round((1 - tok / GARDEN_WINDOW_TOK) * 100);

const enc = new TextEncoder();
const screen = (data: string, cols = 80, rows = 24) => ({ data, seq: enc.encode(data).length, cols, rows });

const B = "\x1b[1m";
const D = "\x1b[2m";
const G = "\x1b[32m";
const R0 = "\x1b[0m";
const bullet = (t: string) => `● ${t}\r\n`;
const tool = (name: string, arg: string, res: string) => `${B}● ${name}${R0}(${arg})\r\n${D}  ⎿  ${res}${R0}\r\n`;

/** The next Monday 09:00 Berlin (07:00 UTC in summer time, close enough for a seeded row), after `now`. */
function nextMonday(now: number): number {
  const d = new Date(now);
  const add = (8 - d.getUTCDay()) % 7 || 7;
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + add, 7, 0, 0);
}

export function firstLook(now: number): DemoScenario {
  const ago = (ms: number) => now - ms;

  // ── the scripted turn: the recording's work lines and box ───────────────
  const answerYes: DemoTimedStep[] = [
    { kind: "output", text: `${D}You chose: 1. Yes, sort by due date${R0}\r\n`, afterMs: 300 },
    { kind: "output", text: bullet("Sorting by due date, overdue tasks first."), afterMs: 500 },
    { kind: "output", text: tool("Update", "src/store/tasks.ts", "Added 12 lines, removed 2 lines"), afterMs: 700 },
    { kind: "output", text: tool("Bash", "npm test -- tasks", `${G}PASS${R0} src/store/tasks.test.ts (7 tests)`), afterMs: 900 },
    { kind: "output", text: tool("Bash", "npx playwright screenshot", `saved ${SORTED}`), afterMs: 900 },
    {
      kind: "output",
      text: bullet(`Done. Tasks now sort by due date, overdue ones on top (src/store/tasks.ts). Screenshot: ${SORTED}`),
      afterMs: 500,
    },
    { kind: "session", patch: { contextLeft: 66 }, afterMs: 100 },
  ];
  const answerNo: DemoTimedStep[] = [
    { kind: "output", text: `${D}You chose: 2. No, keep creation order${R0}\r\n`, afterMs: 300 },
    { kind: "output", text: bullet("Understood, the order stays as created. No changes made."), afterMs: 600 },
  ];
  const sortReply: DemoTimedStep[] = [
    { kind: "output", text: bullet("I'll look at how the task list is rendered first."), afterMs: 500 },
    { kind: "output", text: tool("Read", "src/components/TaskList.tsx", "Read 84 lines"), afterMs: 700 },
    { kind: "output", text: tool("Read", "src/store/tasks.ts", "Read 61 lines"), afterMs: 700 },
    {
      kind: "output",
      text: `\r\n${B}Should the task list be sorted by due date?${R0}\r\n${G}❯ 1. Yes, sort by due date${R0}\r\n  2. No, keep creation order\r\n`,
      afterMs: 600,
    },
    {
      kind: "prompt",
      afterMs: 0,
      prompt: {
        kind: "select",
        question: "Should the task list be sorted by due date?",
        options: [
          { index: 1, label: "Yes, sort by due date" },
          { index: 2, label: "No, keep creation order" },
        ],
      },
      answers: { "1": answerYes, "2": answerNo },
    },
  ];

  // ── the hook: the session the first tap starts ──────────────────────────
  //
  // The person starts it (`+ now` on todo-garden, cued by `features/demoTour`), so it is a FRESH
  // claude: its context starts at what a new session here re-reads (56k), the hook turn takes it to
  // 128k and the fix to 151k. `contextLeft` and the spark move with it (no session id on these steps:
  // they belong to whichever session the reply runs in), and each turn's `facts` carry the same
  // figure as `ctxTok`.
  const g1 = "demo-g1";
  const sparkAt = (...more: number[]): ContextSpark => {
    const pts = [...GARDEN_SERIES, ...more];
    return { pts, marks: [], peak: Math.max(...pts), windowTok: GARDEN_WINDOW_TOK, windowFrom: "model", autoCompactTok: null, baseTok: GARDEN_SERIES[0], turns: 1 + more.length, spentTok: pts.reduce((a, b) => a + b, 0) };
  };
  const freshSpark = (...pts: number[]): ContextSpark => ({
    pts: [FRESH_TOK, ...pts], marks: [], peak: Math.max(FRESH_TOK, ...pts), windowTok: GARDEN_WINDOW_TOK, windowFrom: "model", autoCompactTok: null,
    baseTok: FRESH_TOK, turns: pts.length, spentTok: pts.reduce((a, b) => a + b, FRESH_TOK),
  });
  const ctx = (tok: number, ...before: number[]): DemoStep => ({ kind: "session", patch: { contextLeft: left(tok), contextSpark: freshSpark(...before, tok) } });
  // The shape of heavy real use: todo-garden's older session climbed from 56k to 282k over an hour
  // and a quarter, and the agents it sent to read the codebase spent most of its money. The hook turn
  // is a fresh session's first prompt — big cache writes, a build, two devices — and the fix sends
  // three agents to look for other inputs the keyboard can cover, which is most of what it costs.
  const firstFacts = turnFacts({ input: 3_100, output: 41_000, cacheRead: 9_800_000, cacheWrite: 290_000 }, GARDEN_LAST, { main: 0, agents: 0 }, [
    { type: "Explore", model: MODEL, bag: { input: 1_200, output: 64_000, cacheRead: 88_000_000, cacheWrite: 1_050_000 } },
    { type: "Explore", model: MODEL, bag: { input: 900, output: 51_000, cacheRead: 76_000_000, cacheWrite: 820_000 } },
  ]);
  const hookFacts = turnFacts({ input: 1_400, output: 33_000, cacheRead: 6_200_000, cacheWrite: 240_000 }, HOOK_LAST, { main: 0, agents: 0 });
  const fixFacts = turnFacts({ input: 700, output: 46_000, cacheRead: 14_000_000, cacheWrite: 60_000 }, FIX_LAST, cumOf(hookFacts), [
    { type: "Explore", model: MODEL, bag: { input: 800, output: 45_000, cacheRead: 48_000_000, cacheWrite: 500_000 } },
    { type: "code-reviewer", model: "claude-fable-5-1", bag: { input: 300, output: 7_000, cacheRead: 3_200_000, cacheWrite: 140_000 } },
    { type: "Explore", model: "claude-sonnet-5-5", bag: { input: 200, output: 6_000, cacheRead: 2_200_000, cacheWrite: 70_000 } },
  ]);

  // The hook turn, as the reply to its prompt: the demo types HOOK_PROMPT into the compose box of the
  // session the first tap started and sends it (`features/demoTour` `typeHookPrompt`). A journey waits
  // on text, never on these numbers.
  //
  // The rhythm is the docs film's too (scripts/ui/pace.mjs): lines under 0.35 s apart are one burst that
  // plays at real speed, and every pause becomes a held picture of 1.2 s or more. So the work comes in
  // bursts: the change with the build, then the two devices and the two reads, then (right behind them)
  // the screenshots landing with the closing line — three pictures, where five held the README's loop
  // twice as long.
  const hookReply: DemoTimedStep[] = [
    { kind: "output", text: bullet("I'll make + Add 44px, then build and check it on both platforms."), afterMs: 150 },
    { kind: "output", text: tool("Update", "src/components/QuickAdd.tsx", "Added 4 lines, removed 2 lines"), afterMs: 100 },
    { ...ctx(74_000), afterMs: 0 },
    { kind: "output", text: tool("Bash", "npm run build && npx cap sync", "Built the web bundle · synced ios and android"), afterMs: 100 },
    { ...ctx(88_000, 74_000), afterMs: 0 },
    {
      kind: "output",
      text: tool("Bash", `xcrun simctl io booted screenshot ${IOS_SHOT}`, `Wrote screenshot to: ${IOS_SHOT}`)
        + tool("Bash", `adb exec-out screencap -p > ${ANDROID_SHOT}`, "(No output)"),
      afterMs: 1_200,
    },
    { kind: "output", text: tool("Read", IOS_SHOT, "Read image (31KB)") + tool("Read", ANDROID_SHOT, "Read image (28KB)"), afterMs: 150 },
    { ...ctx(104_000, 74_000, 88_000), afterMs: 0 },
    { kind: "artifact", repoId: "r1", relPath: IOS_SHOT, size: MEDIA_SIZES[IOS_SHOT], afterMs: 300 },
    { kind: "artifact", repoId: "r1", relPath: ANDROID_SHOT, size: MEDIA_SIZES[ANDROID_SHOT], afterMs: 150 },
    { kind: "output", text: bullet(`Done. + Add is 44px on iOS and Android (src/components/QuickAdd.tsx). Screenshots: ${IOS_SHOT}, ${ANDROID_SHOT}`), afterMs: 150 },
    { kind: "facts", facts: hookFacts, afterMs: 100 },
    { ...ctx(HOOK_LAST, 74_000, 88_000, 104_000), afterMs: 0 },
  ];

  // The combined picture comes back with ② circled and "make ② look like ①": the fix, both devices
  // again, the after picture, and the debug build in the outbox — which the real host announces as
  // "Outbox: <name>" with a tap to download (server/sessionEvents.ts), the way it reaches the phone.
  const fixReply: DemoTimedStep[] = [
    { kind: "output", text: bullet("I see your circle in ②: on Android the keyboard covers the bar, because the window does not resize for it. ① on iOS keeps it above."), afterMs: 150 },
    {
      kind: "output",
      text: tool("Update", "android/app/src/main/AndroidManifest.xml", "Added 1 line, removed 1 line")
        + tool("Update", "src/components/QuickAdd.tsx", "Added 3 lines"),
      afterMs: 150,
    },
    { ...ctx(132_000, HOOK_LAST), afterMs: 0 },
    {
      kind: "output",
      text: bullet("Three agents look for other inputs the keyboard can cover while I check both devices again.")
        + tool("Agent", "Explore: text inputs in src/screens", "Done · 2 sit low on the screen, both scroll")
        + tool("Agent", "Explore: windowSoftInputMode across activities", "Done · 1 activity")
        + tool("Agent", "code-reviewer: the QuickAdd change", "Done · no findings")
        + tool("Bash", `xcrun simctl io booted screenshot ${IOS_SHOT}`, `Wrote screenshot to: ${IOS_SHOT}`)
        + tool("Bash", `adb exec-out screencap -p > ${ANDROID_FIXED}`, "(No output)")
        + tool("Read", ANDROID_FIXED, "Read image (30KB)"),
      afterMs: 150,
    },
    { kind: "artifact", repoId: "r1", relPath: ANDROID_FIXED, size: MEDIA_SIZES[ANDROID_FIXED], afterMs: 150 },
    { kind: "output", text: bullet(`Fixed on both: the bar now sits on the keyboard on Android too, + Add whole. After: ${ANDROID_FIXED}`), afterMs: 150 },
    { ...ctx(146_000, HOOK_LAST, 132_000), afterMs: 0 },
    { kind: "output", text: tool("Bash", "cd android && ./gradlew assembleDebug", `${G}BUILD SUCCESSFUL${R0} in 41s`), afterMs: 1_600 },
    { kind: "deliverable", repoId: "r1", relPath: APK, size: APK_SIZE, afterMs: 900 },
    { kind: "output", text: bullet(`Built the debug APK into the outbox: ${APK} — install it on your phone to try it for real.`), afterMs: 150 },
    { kind: "facts", facts: fixFacts, afterMs: 2_000 },
    { ...ctx(FIX_LAST, HOOK_LAST, 132_000), afterMs: 0 },
  ];

  // ── two sessions already on the desktop ─────────────────────────────────
  // The garden screen keeps the turn before the hook to two short lines (the rest of it lives in the
  // reader): each line above the work pushes the logo off the phone-size terminal sooner.
  const gardenScreen =
    `${claudeBanner("~/dev/todo-garden")}` +
    `> make overdue tasks show a red edge\r\n` +
    bullet("Done. Overdue tasks get a red left edge.") +
    "\r\n";
  const notesScreen =
    `${claudeBanner("~/dev/pocket-notes")}` +
    `> the markdown export drops the title\r\n` +
    bullet("Found it: the exporter skips the first heading.") +
    tool("Update", "src/export/markdown.ts", "Added 3 lines, removed 1 line") +
    tool("Bash", "npm test -- export", `${G}PASS${R0} src/export/markdown.test.ts (9 tests)`) +
    bullet("Fixed. The title is now the first line of the exported file.") +
    "\r\n";

  const model: DemoModel = {
    repos: [
      { id: "r1", repoName: "todo-garden", branch: "main", isPrimary: true, worktreePath: GARDEN, outboxCount: 2, changedCount: 2, hasRepoHealth: true },
      { id: "r2", repoName: "pocket-notes", branch: "main", isPrimary: true, worktreePath: NOTES, outboxCount: 0, changedCount: 0, hasRepoHealth: true },
      { id: "r3", repoName: "trail-log", branch: "main", isPrimary: true, worktreePath: TRAIL, outboxCount: 1, changedCount: 1, hasRepoHealth: true },
    ],
    sessions: [
      {
        // An older session, idle: the hook starts a NEW one beside it (`+ now`), and the tour's rows open this one.
        id: g1, cwd: GARDEN, title: "todo-garden · main", tabTitle: "Red edge for overdue", remoteControl: true, running: true,
        idle: true, idleSince: ago(18 * MIN), lastTurnAt: ago(22 * MIN), createdAt: ago(100 * MIN), claudeSessionId: "c-garden-1",
        contextLeft: left(GARDEN_LAST), contextSpark: sparkAt(), starred: false,
        firstPrompt: "make overdue tasks show a red edge", lastPrompt: "make overdue tasks show a red edge",
      },
      {
        id: "demo-n1", cwd: NOTES, title: "pocket-notes · main", tabTitle: "Markdown export title", remoteControl: true, running: true,
        idle: true, idleSince: ago(2 * HOUR), createdAt: ago(3 * HOUR), claudeSessionId: "c-notes-1", contextLeft: 81, starred: false,
        firstPrompt: "the markdown export drops the title", lastPrompt: "the markdown export drops the title",
      },
    ],
    screens: { "demo-g1": screen(gardenScreen), "demo-n1": screen(notesScreen) },
    history: {
      "demo-g1": [
        {
          id: "h-1", kind: "prompt", text: "make overdue tasks show a red edge", sentAt: ago(95 * MIN), outputAt: ago(22 * MIN),
          output: "Done. An overdue task now has a red left edge and a bold due date. I changed src/components/TaskRow.tsx and added a test; all 4 pass.",
        },
      ],
      "demo-n1": [
        {
          id: "h-2", kind: "prompt", text: "the markdown export drops the title", sentAt: ago(3 * HOUR - 2 * MIN), outputAt: ago(2 * HOUR + 50 * MIN),
          output: "Fixed. The exporter skipped the first heading; the title is now the first line of the file. 9 tests pass.",
        },
      ],
    },
    turnFacts: { [g1]: { "h-1": firstFacts } },
    recent: [
      { cwd: GARDEN, title: "todo-garden", lastActive: ago(18 * MIN), claudeSessionId: "c-garden-1", launch: {} },
      { cwd: NOTES, title: "pocket-notes", lastActive: ago(2 * HOUR), claudeSessionId: "c-notes-1", launch: {} },
      { cwd: TRAIL, title: "trail-log", lastActive: ago(1 * DAY), claudeSessionId: "c-trail-1", launch: {} },
      // The ledger's costliest conversations, named: the Token usage screen looks one up here by id.
      ...demoTopConvos(now).map(({ convo, title }) => ({
        cwd: convo.repo, title, lastActive: convo.lastAt ?? ago(DAY), claudeSessionId: convo.id, launch: {},
      })),
    ],
    closed: [
      {
        id: "demo-t0", cwd: TRAIL, title: "trail-log · main", closedAt: ago(1 * DAY), closedBy: "you", claudeSessionId: "c-trail-1",
        openedAt: ago(1 * DAY + 40 * MIN), lastActiveAt: ago(1 * DAY), turns: 3, tabTitle: "GPX import",
        firstPrompt: "import a GPX file and list the hikes by distance", lastPrompt: "show the total distance on the list",
      },
    ],
    backlog: {
      auto: false,
      items: [
        { id: "b1", text: "Add a due-date picker to the new-task sheet", status: "queued", repoDir: GARDEN, createdAt: ago(1 * DAY), order: 1, label: "Due-date picker" },
        { id: "b2", text: "Group tasks by day in the list", status: "queued", repoDir: GARDEN, createdAt: ago(1 * DAY), order: 2, label: "Group by day" },
        { id: "b3", text: "Make the empty state friendlier", status: "queued", repoDir: GARDEN, createdAt: ago(20 * HOUR), order: 3, label: "Empty state" },
        { id: "b4", text: "Rename 'Tasks' to 'Beds' in the settings screen", status: "done", repoDir: GARDEN, createdAt: ago(2 * DAY), order: 0, label: "Rename in settings", startedAt: ago(2 * DAY - HOUR), finishedAt: ago(2 * DAY - 90 * MIN) },
        { id: "b5", text: "Sync notes in the background every 15 minutes", status: "queued", repoDir: NOTES, createdAt: ago(5 * HOUR), order: 1, label: "Background sync" },
      ],
    },
    schedules: [
      {
        id: "sch1", name: "Weekly dependency check", enabled: true, createdAt: ago(6 * DAY), graceMin: 120,
        nextAt: nextMonday(now),
        rule: { kind: "weekly", days: [1], hour: 9, minute: 0, tz: "Europe/Berlin" },
        action: { kind: "backlog", repoDir: GARDEN, text: "Check for outdated dependencies and list what is safe to update", label: "Dependency check", autoFire: true },
      },
      ...windowSchedules(now),
    ],
    gallery: {
      r1: [
        { name: "todo-garden-sorted.png", relPath: SORTED, size: MEDIA_SIZES[SORTED], mtime: ago(4 * HOUR), ctime: ago(4 * HOUR) },
        { name: "todo-garden-before.png", relPath: BEFORE, size: MEDIA_SIZES[BEFORE], mtime: ago(5 * HOUR), ctime: ago(5 * HOUR) },
      ],
      r3: [
        { name: "trail-log-ridge-loop.png", relPath: RIDGE, size: MEDIA_SIZES[RIDGE], mtime: ago(1 * DAY + 30 * MIN), ctime: ago(1 * DAY + 30 * MIN) },
      ],
    },
    ...workFill(now, { sorted: SORTED, before: BEFORE, sketch: SKETCH, sketchSize: MEDIA_SIZES[SKETCH] }),
    numbers: numbersFill(now),
    replies: [
      { match: HOOK_PROMPT, cwd: GARDEN, steps: hookReply },
      { match: "sort", cwd: GARDEN, steps: sortReply },
      { match: FIX_MATCH, cwd: GARDEN, steps: fixReply },
      // Anything else a person types still gets an answer, in the same voice.
      {
        steps: [
          { kind: "output", text: bullet("I'll start by looking at how the project is laid out."), afterMs: 500 },
          { kind: "output", text: tool("Read", "package.json", "Read 38 lines"), afterMs: 700 },
          { kind: "output", text: bullet("This is the demo desktop, so I stop here. On your own desktop I would carry on and make the change."), afterMs: 600 },
        ],
      },
    ],
    banner: CLAUDE_BANNER,
  };

  return {
    meta: { id: "first-look", protocol: PROTOCOL_VERSION, stamp: "first-look-7" },
    clock: { start: now },
    state: { bootId: "boot", model: model as unknown as DemoScenario["state"]["model"] },
    script: [],
  };
}
