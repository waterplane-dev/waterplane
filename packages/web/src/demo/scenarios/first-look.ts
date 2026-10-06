/**
 * Scenario `first-look` (demo-mode-plan.md §3, WP4; demo-pitch-plan.md §1): the
 * first minute with the app. It opens on a session ALREADY WORKING — the
 * todo-garden turn "add a quick-add bar" streams its tool lines and moves the
 * context meter with no tap (`HOOK_SCRIPT`), ends with a screenshot in the
 * outbox (gallery, new-images strip, notification), and the reader prices it
 * under the turn. Marking that screenshot up and sending it back with "make
 * this bigger" gets a scripted fix and an "after" screenshot (`biggerReply`).
 * Beside it: a choice box to answer by tap ("sort"), a few backlog items and
 * one schedule so the other tabs are not empty.
 *
 * Shape: the model WP2b reads (`demo/host/model.ts`), seeded from the stub-driven
 * recording (`STUB_MODE=demo`, `tools/demo-scenario.mjs`): the todo-app work
 * lines, the "sorted by due date?" box and its two answers are that recording's
 * script, grown into a longer, readable session. Everything is fictional — no
 * path, name or number comes from this machine; `scenarios.test.mjs` runs the
 * recording tool's scrub (`findLeaks`) over the result so a hand edit cannot
 * leak one.
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

/** Where todo-garden's context stands before the hook turn, after it, and after the fix. */
const GARDEN_LAST = GARDEN_LAST_TOK;
const HOOK_LAST = 295_000;
const BIGGER_LAST = 306_000;

/** 2026-10-01 09:00 UTC — what `tools/demo-scenario.mjs` pins recordings to. */
export const CLOCK_START = Date.UTC(2026, 9, 1, 9, 0, 0);

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

const GARDEN = "~/dev/todo-garden";
const NOTES = "~/dev/pocket-notes";
const TRAIL = "~/dev/trail-log";

const SORTED = ".claude/outbox/todo-garden-sorted.png";
/** The hook turn's screenshot, and the one the annotate-and-send-back reply makes. */
export const QUICK_ADD = ".claude/outbox/todo-garden-quick-add.png";
export const BIGGER = ".claude/outbox/todo-garden-bigger-add.png";
/** The prompt the session is working on when the demo opens. */
export const HOOK_PROMPT = "add a quick-add bar above the task list";
/** What the annotate-and-send-back reply matches (`features/demoTour` `HOOK_REPLY_MATCH`). */
export const BIGGER_MATCH = "bigger";
const BEFORE = ".claude/outbox/todo-garden-before.png";
const SKETCH = ".claude/inbox/swipe-sketch.png";
const RIDGE = ".claude/outbox/trail-log-ridge-loop.png";

/** Bytes of what is in `public/demo/media/r1/` — a test pins these to the files. */
export const MEDIA_SIZES = { [SORTED]: 31628, [BEFORE]: 31174, [SKETCH]: 2169, [RIDGE]: 4174, [QUICK_ADD]: 30968, [BIGGER]: 31814 } as const;

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

  // ── the hook: the turn already running when the demo opens ──────────────
  //
  // Context per step (tokens): the series ends at 282k before this turn; the
  // turn's reads take it to 295k, the fix to 306k. `contextLeft` and the spark
  // move with it, and each turn's `facts` carry the same figure as `ctxTok`.
  const g1 = "demo-g1";
  const sparkAt = (...more: number[]): ContextSpark => {
    const pts = [...GARDEN_SERIES, ...more];
    return { pts, marks: [], peak: Math.max(...pts), windowTok: GARDEN_WINDOW_TOK, windowFrom: "model", autoCompactTok: null, baseTok: GARDEN_SERIES[0], turns: 1 + more.length, spentTok: pts.reduce((a, b) => a + b, 0) };
  };
  const ctx = (tok: number, ...more: number[]): DemoStep => ({ kind: "session", sessionId: g1, patch: { contextLeft: left(tok), contextSpark: sparkAt(...more, tok) } });
  // The shape of a heavy real session: the first prompt climbed from the 56k a fresh session
  // starts with to 282k over an hour and a quarter, and the agents it sent to read the codebase
  // spent most of its money; the hook turn is a dozen requests on a full window; the fix sends three
  // agents to check every other tap target, which is most of what that prompt costs.
  const firstFacts = turnFacts({ input: 3_100, output: 41_000, cacheRead: 9_800_000, cacheWrite: 290_000 }, GARDEN_LAST, { main: 0, agents: 0 }, [
    { type: "Explore", model: MODEL, bag: { input: 1_200, output: 64_000, cacheRead: 88_000_000, cacheWrite: 1_050_000 } },
    { type: "Explore", model: MODEL, bag: { input: 900, output: 51_000, cacheRead: 76_000_000, cacheWrite: 820_000 } },
  ]);
  const hookFacts = turnFacts({ input: 600, output: 9_000, cacheRead: 4_000_000, cacheWrite: 16_000 }, HOOK_LAST, cumOf(firstFacts));
  const biggerFacts = turnFacts({ input: 700, output: 48_000, cacheRead: 17_000_000, cacheWrite: 14_000 }, BIGGER_LAST, cumOf(hookFacts), [
    { type: "Explore", model: MODEL, bag: { input: 800, output: 45_000, cacheRead: 50_000_000, cacheWrite: 500_000 } },
    { type: "code-reviewer", model: "claude-fable-5-1", bag: { input: 300, output: 7_000, cacheRead: 3_200_000, cacheWrite: 140_000 } },
    { type: "Explore", model: "claude-sonnet-5-5", bag: { input: 200, output: 6_000, cacheRead: 2_200_000, cacheWrite: 70_000 } },
  ]);

  /** `at` ms after the demo opens. A journey waits on text, never on these numbers. */
  const script: { at: number; event: DemoStep }[] = [
    { at: 1_200, event: { kind: "output", sessionId: g1, text: tool("Read", "src/components/TaskList.tsx", "Read 84 lines") } },
    { at: 1_300, event: ctx(286_000) },
    { at: 2_600, event: { kind: "output", sessionId: g1, text: tool("Write", "src/components/QuickAdd.tsx", "Wrote 38 lines") } },
    { at: 2_700, event: ctx(290_000) },
    { at: 4_000, event: { kind: "output", sessionId: g1, text: tool("Update", "src/components/TaskList.tsx", "Added 3 lines") } },
    { at: 4_100, event: ctx(293_000) },
    { at: 5_800, event: { kind: "output", sessionId: g1, text: tool("Bash", "npm test -- QuickAdd", `${G}PASS${R0} src/components/QuickAdd.test.tsx (3 tests)`) } },
    { at: 7_400, event: { kind: "output", sessionId: g1, text: tool("Bash", "npx playwright screenshot", `saved ${QUICK_ADD}`) } },
    { at: 8_100, event: { kind: "artifact", sessionId: g1, repoId: "r1", relPath: QUICK_ADD, size: MEDIA_SIZES[QUICK_ADD] } },
    { at: 8_800, event: { kind: "output", sessionId: g1, text: bullet(`Done. A quick-add bar now sits above the list (src/components/QuickAdd.tsx). Screenshot: ${QUICK_ADD}`) } },
    { at: 8_900, event: { kind: "facts", sessionId: g1, facts: hookFacts } },
    { at: 8_900, event: ctx(HOOK_LAST) },
    { at: 9_000, event: { kind: "turnEnd", sessionId: g1 } },
  ];

  // The marked-up screenshot comes back with "make this bigger": the fix, and the after picture.
  const biggerReply: DemoTimedStep[] = [
    { kind: "output", text: bullet("I can see the circled button: the + in the quick-add bar is 22px, well under the 44px a finger needs."), afterMs: 700 },
    { kind: "output", text: tool("Read", "src/components/QuickAdd.tsx", "Read 38 lines"), afterMs: 700 },
    { kind: "output", text: tool("Update", "src/components/QuickAdd.tsx", "Added 4 lines, removed 2 lines"), afterMs: 1_000 },
    { kind: "output", text: bullet("Three agents will check every other tap target in the app against 44px while I fix this one."), afterMs: 600 },
    { kind: "output", text: tool("Agent", "Explore: tap targets in src/components", "Done · 6 under 44px"), afterMs: 900 },
    { kind: "output", text: tool("Agent", "Explore: tap targets in src/screens", "Done · 2 under 44px"), afterMs: 700 },
    { kind: "output", text: tool("Agent", "code-reviewer: the QuickAdd change", "Done · no findings"), afterMs: 700 },
    { ...ctx(300_000, HOOK_LAST), afterMs: 100 },
    { kind: "output", text: tool("Bash", "npm test -- QuickAdd", `${G}PASS${R0} src/components/QuickAdd.test.tsx (3 tests)`), afterMs: 1_100 },
    { kind: "output", text: tool("Bash", "npx playwright screenshot", `saved ${BIGGER}`), afterMs: 1_100 },
    { kind: "artifact", repoId: "r1", relPath: BIGGER, size: MEDIA_SIZES[BIGGER], afterMs: 600 },
    { kind: "output", text: bullet(`Done. The add button is now a 44px "+ Add" with a label (src/components/QuickAdd.tsx); the agents found 8 more buttons under 44px, listed above. Screenshot: ${BIGGER}`), afterMs: 700 },
    { kind: "facts", facts: biggerFacts, afterMs: 100 },
    { ...ctx(BIGGER_LAST, HOOK_LAST), afterMs: 0 },
  ];

  // ── two sessions already on the desktop ─────────────────────────────────
  // The garden screen keeps the turn before the hook to two short lines (the rest of it lives in the
  // reader): each line above the work pushes the logo off the phone-size terminal sooner.
  const gardenScreen =
    `${claudeBanner("~/dev/todo-garden")}` +
    `> make overdue tasks show a red edge\r\n` +
    bullet("Done. Overdue tasks get a red left edge.") +
    "\r\n" +
    `> ${HOOK_PROMPT}\r\n` +
    bullet("I'll add a quick-add bar above the task list, then check it on screen.");
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
        // Mid-turn when the demo opens: the hook script carries it to the end.
        id: g1, cwd: GARDEN, title: "todo-garden · main", tabTitle: "Red edge for overdue", remoteControl: true, running: true,
        idle: false, turnActive: true, turnStartedAt: ago(6_000), lastTurnAt: ago(6_000), createdAt: ago(100 * MIN), claudeSessionId: "c-garden-1",
        contextLeft: left(GARDEN_LAST), contextSpark: sparkAt(), starred: false,
        firstPrompt: "make overdue tasks show a red edge", lastPrompt: HOOK_PROMPT,
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
        // The turn running as the demo opens: no stored answer, so the reader reads it off the PTY.
        { id: "h-hook", kind: "prompt", text: HOOK_PROMPT, sentAt: ago(6_000) },
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
      { match: "sort", cwd: GARDEN, steps: sortReply },
      { match: BIGGER_MATCH, cwd: GARDEN, steps: biggerReply },
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
    meta: { id: "first-look", protocol: PROTOCOL_VERSION, stamp: "first-look-3" },
    clock: { start: now },
    state: { bootId: "boot", model: model as unknown as DemoScenario["state"]["model"] },
    script,
  };
}
