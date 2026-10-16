/**
 * Scenario `limit-and-budget` (demo-pitch-plan.md §2 item 7): a session's own
 * budget holds the next send BEFORE the account's wall, then the wall comes, the
 * session is parked, and at the reset it continues by itself.
 *
 * The story, as the journey walks it (scripts/ui/journey-limit-and-budget.mjs):
 *
 *  1. todo-garden is mid-turn with a budget of 1.2M tokens already set. Each
 *     request the turn makes moves the session's spend (its `contextSpark`) and
 *     the 5-hour window; the third crosses the cap. The demo host judges it with
 *     the host's own rule (demo/host/budget.ts → `sessionBudgetVerdict`) and
 *     tells it the host's way (a notification; no Esc — this cap is set not to
 *     interrupt, so the turn finishes).
 *  2. The next prompt is sent *when it's free* — the deferred send, the one a
 *     budget exists to stop (a tapped *Send now* is a person spending on purpose
 *     and is never held, on either desktop). The host keeps it as an intent and
 *     its ladder holds it on the `sessionBudget` rung; the demo asks the same
 *     ladder (demo/host/waiting.ts → `intentVerdict`), so Activity shows the
 *     host's sentence and the words wait, typed nowhere.
 *  3. The person raises the cap (the budget sheet's 3m pick, `session.budget.set`,
 *     answered by the demo host the way the host answers it); the ladder lets
 *     the row go and the prompt is delivered once.
 *  4. Two requests in, the account's 5-hour window is used up (the `wall` step,
 *     demo/host/usagewall.ts): the session is parked with the host's decision row and
 *     notification. The scripted `clock` step jumps the demo to the reset and the
 *     page's clock follows; the host's auto-continue types "continue", the block
 *     clears as the turn starts, and the held prompt's turn finishes. It ran
 *     ONCE: one echo, one history row; the second turn is "continue".
 *
 * Every figure is fictional and derived here, so they agree with each other:
 * a request's `contextLeft` is its reading against the 200k window, `usageTok`
 * is every reading plus 2k of output per request, `costUsd` is the same
 * requests priced the way a cached Sonnet request roughly prices (cache reads
 * at $0.30/M, 4k written at $3.75/M, 2k out at $15/M), the 5-hour window moves
 * two points a request and the week half a point, and the reset the session is
 * parked until IS the 5-hour window's `sessionResetAt`.
 *
 * The CLI's own banner is never printed: the screen says what happened in the
 * demo's words (heuristics skill — a banner phrase on screen false-positives),
 * on one line in the CLI's error colour (`stopLine`), printed AFTER the park
 * so the spinner is gone under it the way it goes when the CLI halts.
 *
 * The timings serve the docs loop (scripts/ui/journey-limit-and-budget.mjs):
 * the held prompt's reply waits long enough for the phone to be back on the
 * terminal, then races 94 → 97 → 100% into the wall in under two seconds; the
 * clock-skip toast waits until the journey is back on the terminal from the
 * limit sheet and the decision log, the jump comes a couple of seconds after
 * it, the resumed turn ends as the toast goes, and a fresh usage reading lands
 * with the reset, so "continue" is never typed under a red 100%.
 */
import { PROTOCOL_VERSION } from "@waterplane/shared";
import type { ContextSpark, SessionInfo, UsageInfo } from "@waterplane/shared";
import type { DemoScenario } from "../host/index.ts";
import type { DemoModel, DemoStep, DemoTimedStep } from "../host/model.ts";
import { DAY, G, GARDEN, HOUR, MIN, NOTES, R0, TRAIL, bullet, repos, screen, tool } from "./garden.ts";
import { CLAUDE_BANNER, claudeBanner } from "../host/banner.ts";

/** What the turn running when the demo opens was asked. */
export const FIRST_PROMPT = "add a week view to the calendar screen";
/** What the person sends next — held by the budget, run once after the reset. */
export const HELD_PROMPT = "now let a task be dragged to another day";
/** The cap already set, and the one the journey raises it to (a quick pick). */
export const BUDGET_TOK = 1_200_000;
export const RAISED_TOK = 3_000_000;
export const WINDOW_TOK = 200_000;
const OUT_TOK = 2_000;

/** Readings (tokens in the window) of the requests before, during and after. */
export const EARLIER = [22_000, 31_000, 46_000, 52_000, 58_000, 63_000, 69_000, 74_000, 80_000, 86_000, 91_000, 97_000, 104_000];
const FIRST_TURN = [112_000, 121_000, 133_000, 141_000];
const HELD_TURN = [149_000, 156_000];
const RESUMED = [163_000, 171_000];

/** The CLI's error colour (its dark theme's rgb(255,107,128)). */
const ERROR_RGB = "\x1b[38;2;255;107;128m";
const clockText = (ms: number) => new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
/** What the terminal says where the CLI halts at the 5-hour wall, in the demo's own words — never the
 *  CLI's banner, and no phrase `packages/host/src/limit.ts` matches (pinned in
 *  packages/host/test/limit.test.mjs). */
export const stopLine = (resetAt: number): string => `${ERROR_RGB}● 5-hour window used up · back at ${clockText(resetAt)} (demo)${R0}\r\n`;

/** Said while the demo skips the hours to the reset (on a real desktop they are just waited out). */
export const SKIP_TOAST = "Demo: the clock skips ahead to the 5-hour reset.";
/** How long the phone shows it: `toast.ts`'s `toastMs` (3 s + 55 ms a character), not imported because
 *  the scenarios load before the app's modules; the scenario test holds the two equal. */
export const SKIP_TOAST_MS = 3_000 + SKIP_TOAST.length * 55;
/**
 * The scripted moments the docs film sets its captions against (scripts/ui/journey-limit-and-budget.mjs):
 * a caption snaps to the first visible change after it is set, so the journey sets each one a moment
 * before the change it describes, never seconds before, when an unrelated change (the link's traffic
 * meter) could take it. All in ms; multiples of the demo host's 200 ms tick (transport.ts).
 */
export const FILM_TIMING = {
  /** From the held prompt being let go to its reply's first line: the phone is back on the terminal. */
  think: 2_400,
  /** From the wall to the skip toast: the journey has been to the launcher, the limit sheet and the
   *  decision log and is back on the terminal. */
  toastAfterWall: 6_600,
  /** From the toast to the jump to the reset (auto-continue types "continue" as it lands). */
  jumpAfterToast: 2_400,
  /** From the jump to the resumed turn's first line. */
  firstLineAfterJump: 1_000,
};
/** The resumed turn's steps before its last line, after the jump: its first line, then its two tool
 *  calls in one write (a film holds each picture, so two calls a tick apart could cost a second hold). */
const RESUMED_LEAD = [FILM_TIMING.firstLineAfterJump, 1_000];

/** A cached Sonnet request, roughly: the reading as cache reads, 4k written, 2k out. */
const priced = (reading: number) => reading * 0.3e-6 + 4_000 * 3.75e-6 + OUT_TOK * 15e-6;
const cents = (usd: number) => Math.round(usd * 100) / 100;

/** The session's spark after the first `n` requests of `all`. */
function sparkAfter(all: number[], n: number): ContextSpark {
  const pts = all.slice(0, n);
  return {
    pts, marks: [], peak: Math.max(...pts), baseTok: pts[0],
    usageTok: pts.reduce((a, r) => a + r + OUT_TOK, 0),
    costUsd: cents(pts.reduce((a, r) => a + priced(r), 0)),
    windowTok: WINDOW_TOK, windowFrom: "model", autoCompactTok: 180_000,
  };
}

const left = (reading: number) => Math.round(100 * (1 - reading / WINDOW_TOK));

/** Spend over the cap, for the test: the first request of the first turn whose total reaches it. */
export const ALL_READINGS = [...EARLIER, ...FIRST_TURN, ...HELD_TURN, ...RESUMED];
export const usageAfter = (n: number): number => sparkAfter(ALL_READINGS, n).usageTok ?? 0;

export function limitAndBudget(now: number): DemoScenario {
  const ago = (ms: number) => now - ms;
  const g1 = "demo-g1";
  /** The 5-hour window the session runs into, and the week. */
  const resetAt = now + 1 * HOUR + 47 * MIN;
  /** Where the scripted clock jump lands: just past the reset. */
  const resumeAt = resetAt + 30_000;
  const weeklyResetAt = now + 3 * DAY + 4 * HOUR;

  const usage = (sessionPct: number, weeklyPct: number, sessionReset = resetAt): Omit<UsageInfo, "checkedAt"> => ({
    ok: true, sessionPct, weeklyPct, sessionResetAt: sessionReset, weeklyResetAt,
  });
  /** A request lands: the spark, the meter, and a fresh usage reading move together. */
  const request = (n: number, sessionPct: number, weeklyPct: number, afterMs?: number, sessionReset?: number): DemoTimedStep[] => [
    { kind: "session", patch: { contextSpark: sparkAfter(ALL_READINGS, n), contextLeft: left(ALL_READINGS[n - 1]) }, ...(afterMs ? { afterMs } : {}) },
    { kind: "usage", usage: usage(sessionPct, weeklyPct, sessionReset) },
  ];
  const e = EARLIER.length;
  const f = e + FIRST_TURN.length;
  const h = f + HELD_TURN.length;

  // The turn running when the demo opens: four requests, the third over the cap.
  const at = (ms: number, steps: DemoTimedStep[]): { at: number; event: DemoStep }[] =>
    steps.map(({ afterMs: _a, ...s }) => ({ at: ms, event: (s.kind === "session" ? { ...s, sessionId: g1 } : s) as DemoStep }));
  const script: { at: number; event: DemoStep }[] = [
    { at: 800, event: { kind: "output", sessionId: g1, text: tool("Read", "src/screens/CalendarScreen.tsx", "Read 118 lines") } },
    ...at(1_600, request(e + 1, 88, 38)),
    { at: 2_400, event: { kind: "output", sessionId: g1, text: bullet("A week is seven day columns; each column lists that day's tasks.") } },
    ...at(3_200, request(e + 2, 90, 38)),
    { at: 4_200, event: { kind: "output", sessionId: g1, text: tool("Write", "src/screens/WeekView.tsx", "Wrote 96 lines") } },
    ...at(5_000, request(e + 3, 92, 39)),
    { at: 5_800, event: { kind: "output", sessionId: g1, text: tool("Bash", "npm test -- WeekView", `${G}PASS${R0} src/screens/WeekView.test.tsx (5 tests)`) } },
    ...at(6_400, request(f, 94, 39)),
    { at: 7_200, event: { kind: "output", sessionId: g1, text: bullet("Done. The calendar has a week view (src/screens/WeekView.tsx); a tab switches between day and week.") } },
    { at: 7_300, event: { kind: "turnEnd", sessionId: g1 } },
  ];

  // What the held prompt gets back once it is let go: a few seconds of thinking (the phone is back on
  // the terminal and the budget toast gone by then), then two requests that race the 5-hour window
  // from 94 to 100% (one host tick apart: one motion in the film), and the wall. After it the turn's
  // last line lands as the skip toast goes, so the film's last picture is the finished turn with
  // nothing over it.
  const heldReply: DemoTimedStep[] = [
    { kind: "output", text: bullet("A task row becomes draggable; dropping it on a day column sets its due date."), afterMs: FILM_TIMING.think },
    { kind: "output", text: tool("Read", "src/components/TaskRow.tsx", "Read 64 lines"), afterMs: 1_000 },
    ...request(f + 1, 97, 40),
    { kind: "output", text: tool("Update", "src/components/TaskRow.tsx", "Added 21 lines, removed 2 lines"), afterMs: 200 },
    ...request(h, 100, 40),
    {
      kind: "wall", resetAt, afterMs: 200,
      meanwhile: [
        // Printed after the park, so the live region under it is redrawn with no spinner: the CLI halted.
        { kind: "output", text: stopLine(resetAt) },
        { kind: "frame", msg: { t: "toast", text: SKIP_TOAST }, afterMs: FILM_TIMING.toastAfterWall },
        { kind: "clock", to: resumeAt, afterMs: FILM_TIMING.jumpAfterToast },
        // A fresh window: the reading the reset brings, before the first request of the resumed turn.
        { kind: "usage", usage: usage(0, 40, resumeAt + 5 * HOUR) },
      ],
      resumed: [
        { kind: "output", text: bullet("Picking up where it stopped: each day column takes the drop."), afterMs: RESUMED_LEAD[0] },
        {
          kind: "output", afterMs: RESUMED_LEAD[1],
          text: tool("Update", "src/screens/WeekView.tsx", "Added 34 lines, removed 5 lines") + tool("Bash", "npm test -- TaskRow WeekView", `${G}PASS${R0} 2 files (11 tests)`),
        },
        ...request(h + 1, 3, 41, undefined, resumeAt + 5 * HOUR),
        ...request(h + 2, 5, 41, undefined, resumeAt + 5 * HOUR),
        {
          kind: "output", text: bullet("Done. Drag a task onto another day and its due date moves with it (src/components/TaskRow.tsx)."),
          // A fifth of a second before the toast goes.
          afterMs: SKIP_TOAST_MS - FILM_TIMING.jumpAfterToast - RESUMED_LEAD.reduce((a, b) => a + b, 0) - 200,
        },
      ],
    },
  ];

  const g1Info: SessionInfo = {
    id: g1, cwd: GARDEN, title: "todo-garden · main", tabTitle: "Week view", remoteControl: true, running: true,
    turnActive: true, turnStartedAt: ago(20_000), lastTurnAt: ago(20_000), idle: false, createdAt: ago(80 * MIN),
    claudeSessionId: "c-garden-5", contextLeft: left(EARLIER[e - 1]), starred: false, hooked: true,
    firstPrompt: "group the tasks by day, today first", lastPrompt: FIRST_PROMPT,
    contextSpark: sparkAfter(ALL_READINGS, e),
    budget: {
      cfg: { unit: "tok", max: BUDGET_TOK, interrupt: false },
      verdict: { state: "ok", unit: "tok", max: BUDGET_TOK, spent: usageAfter(e), agentShare: null },
    },
  };

  const model: DemoModel = {
    repos: repos(),
    sessions: [
      g1Info,
      {
        id: "demo-n1", cwd: NOTES, title: "pocket-notes · main", tabTitle: "Background sync", remoteControl: true, running: true,
        idle: true, idleSince: ago(55 * MIN), createdAt: ago(3 * HOUR), claudeSessionId: "c-notes-2", contextLeft: 83, starred: false,
        firstPrompt: "sketch a background sync that runs every 15 minutes", lastPrompt: "sketch a background sync that runs every 15 minutes",
      },
    ],
    screens: {
      [g1]: screen(
        `${claudeBanner("~/dev/todo-garden")}` +
          `\x1b[1m>\x1b[0m ${FIRST_PROMPT}\r\n` +
          bullet("I'll start with how the calendar screen lays out a day."),
      ),
      "demo-n1": screen(
        `${claudeBanner("~/dev/pocket-notes")}> sketch a background sync that runs every 15 minutes\r\n` +
          bullet("Sketched: a timer in src/sync/scheduler.ts calls the existing push, skipping when offline.") + "\r\n",
      ),
    },
    history: {
      [g1]: [
        {
          id: "h-1", kind: "prompt", text: "group the tasks by day, today first", sentAt: ago(78 * MIN), outputAt: ago(70 * MIN),
          output: "Done. The list is grouped by day, today first (src/store/tasks.ts).",
        },
        { id: "h-2", kind: "prompt", text: FIRST_PROMPT, sentAt: ago(20_000) },
      ],
      "demo-n1": [],
    },
    recent: [
      { cwd: GARDEN, title: "todo-garden", lastActive: ago(1 * MIN), claudeSessionId: "c-garden-5", launch: {} },
      { cwd: NOTES, title: "pocket-notes", lastActive: ago(55 * MIN), claudeSessionId: "c-notes-2", launch: {} },
      { cwd: TRAIL, title: "trail-log", lastActive: ago(1 * DAY), claudeSessionId: "c-trail-1", launch: {} },
    ],
    closed: [],
    decisions: [],
    notifications: [],
    limitConfig: { enabled: true, mode: "one" },
    numbers: {
      usage: { ...usage(86, 38), checkedAt: ago(1 * MIN) },
    },
    replies: [{ match: "dragged to another day", cwd: GARDEN, steps: heldReply }],
    banner: CLAUDE_BANNER,
  };

  return {
    meta: { id: "limit-and-budget", protocol: PROTOCOL_VERSION, stamp: "limit-and-budget-1" },
    clock: { start: now },
    state: { bootId: "boot", model: model as unknown as DemoScenario["state"]["model"] },
    script,
  };
}
