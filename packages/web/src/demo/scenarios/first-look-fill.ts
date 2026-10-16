/**
 * What `first-look` carries beyond its scripted turn, so no headline screen is
 * empty when a person opens the demo: the numbers (usage, budget, meter, one
 * context series per session, CLI health) and the work/log lists (notifications,
 * decisions, sent log, Activity, deliveries, pulls, installs, inbox).
 *
 * Kept apart from first-look.ts so that file stays the story of the turn. Every
 * instant is relative to `now`; every figure is fictional and agrees with its
 * neighbours: each session's `contextLeft` is what its series' last sample says
 * (282k of a 1M window → 72% left; 38k of 200k → 81%), the budget verdict is
 * `budgetVerdict`'s answer for the usage reading, and the CLI-health rollup is
 * computed by the shared `healthRollup` over the very record it ships.
 */
import { CLI_SIGNALS, blankSignal, healthRollup, nextFireAt, type ScheduleRule, type CliHealth, type DecisionLogEntry, type Intent, type LaunchIntent, type SentCommand } from "@waterplane/shared";
import type { DemoModel } from "../host/model.ts";
import { DAY, GARDEN, HOUR, MIN, NOTES, TRAIL } from "./garden.ts";

/** pocket-notes' window (a 200k model) and todo-garden's (a 1M one), and where each series ends
 *  (→ `contextLeft` 72 / 81). */
export const WINDOW_TOK = 200_000;
export const GARDEN_WINDOW_TOK = 1_000_000;
export const GARDEN_LAST_TOK = 282_000;
export const NOTES_LAST_TOK = 38_000;
/** todo-garden's readings before the hook turn (its spark and its context series): a long session
 *  climbing from what a fresh one here starts with (56k) — the shape that makes every next prompt
 *  dear, which is what the reader's cost line is there to say. */
export const GARDEN_SERIES: readonly number[] = [
  56_000, 71_000, 88_000, 104_000, 126_000, 148_000, 167_000, 189_000, 208_000, 231_000, 249_000, 264_000, 276_000, GARDEN_LAST_TOK,
];

export interface FillPaths {
  sorted: string;
  before: string;
  sketch: string;
  sketchSize: number;
}

/** CLI health: every signal exercised recently and answering — a healthy record. */
function healthyCli(now: number): CliHealth {
  const version = "2.1.0";
  const signals: CliHealth["signals"] = {};
  CLI_SIGNALS.forEach((spec, i) => {
    const s = blankSignal(spec.id, version);
    const n = 12 + (i % 4);
    s.window = Array.from({ length: n }, (_, k) => ({ at: now - (n - k) * 17 * MIN - i * MIN, ok: true }));
    s.totalGood = n + 40 + i * 3;
    s.lastGoodAt = now - (3 + i * 2) * MIN;
    signals[spec.id] = s;
  });
  return { version, versionSeenAt: now - 5 * MIN, versionChangedAt: now - 4 * DAY, signals };
}

export function numbersFill(now: number): NonNullable<DemoModel["numbers"]> {
  const ago = (ms: number) => now - ms;
  const health = healthyCli(now);

  // todo-garden: the first prompt's climb, from 95 to 22 minutes ago.
  const gT0 = ago(95 * MIN);
  const gToks = GARDEN_SERIES;
  const gSamples = gToks.map((tok, i) => ({ t: gT0 + Math.round((i * 73 * MIN) / (gToks.length - 1)), tok }));

  // pocket-notes: a longer session that crossed the auto-compact line once.
  const nT0 = ago(178 * MIN);
  const nClimb = [20_000, 34_000, 51_000, 72_000, 98_000, 127_000, 148_000, 161_000];
  const nAfter = [31_000, 34_000, 36_000, NOTES_LAST_TOK];
  const nSamples = [
    ...nClimb.map((tok, i) => ({ t: nT0 + i * 5 * MIN, tok })),
    ...nAfter.map((tok, i) => ({ t: nT0 + (nClimb.length + 1 + i) * 5 * MIN, tok })),
  ];
  const compactAt = nT0 + (nClimb.length - 1) * 5 * MIN + 3 * MIN;

  return {
    ledger: true,
    repoHealth: true,
    usage: {
      ok: true, sessionPct: 42, weeklyPct: 61, checkedAt: ago(2 * MIN),
      sessionResetAt: now + 2 * HOUR + 10 * MIN, weeklyResetAt: now + 3 * DAY + 5 * HOUR,
    },
    budget: {
      budget: { enabled: true, sessionMax: 80, weeklyMax: 90, leftoverMax: 20 },
      verdict: { blocked: false, state: "ok", which: "weekly", pct: 61, max: 90 },
    },
    meter: {
      calls: 14, inTok: 41_200, outTok: 3_100, costUsd: 0.07,
      today: { calls: 6, inTok: 17_800, outTok: 1_300, costUsd: 0.03 },
      byModel: [
        { model: "haiku", calls: 11, inTok: 30_400, outTok: 2_300, costUsd: 0.04 },
        { model: "sonnet", calls: 3, inTok: 10_800, outTok: 800, costUsd: 0.03 },
      ],
      lastAt: ago(9 * MIN),
    },
    clihealth: { health, rollup: healthRollup(health, now) },
    context: {
      "demo-g1": {
        sessionId: "demo-g1", claudeSessionId: "c-garden-1", updatedAt: now, samples: gSamples, events: [],
        windowTok: GARDEN_WINDOW_TOK, windowFrom: "model", model: "opus", autoCompactTok: null, truncated: false, turns: gSamples.length,
      },
      "demo-n1": {
        sessionId: "demo-n1", claudeSessionId: "c-notes-1", updatedAt: now, samples: nSamples,
        events: [{ t: compactAt, kind: "compact", trigger: "auto", preTok: 161_000, postTok: 31_000 }],
        windowTok: WINDOW_TOK, windowFrom: "model", model: "sonnet", autoCompactTok: 161_000, truncated: false, turns: nSamples.length,
      },
    },
  };
}

export function workFill(now: number, p: FillPaths): Partial<DemoModel> {
  const ago = (ms: number) => now - ms;
  const LIMIT_SID = "demo-t0";
  const TRAIL_TITLE = "trail-log · main";
  const WAITING = "The session window was used up; waiting for it to reset.";

  const decisions: DecisionLogEntry[] = [
    { id: "d3", ts: ago(1 * DAY + 5 * MIN), sessionId: LIMIT_SID, sessionTitle: TRAIL_TITLE, source: "limit", phase: "resumed",
      question: WAITING, options: [], outcome: "limit", choice: null,
      answer: "continue", rationale: "The window reset; the session was continued where it stopped." },
    { id: "d2", ts: ago(1 * DAY + 8 * MIN), sessionId: LIMIT_SID, sessionTitle: TRAIL_TITLE, source: "limit", phase: "attempt",
      question: WAITING, options: [], outcome: "limit", choice: null,
      rationale: "Reset time reached; trying to continue." },
    { id: "d1", ts: ago(1 * DAY + 16 * MIN), sessionId: LIMIT_SID, sessionTitle: TRAIL_TITLE, source: "limit", phase: "blocked",
      question: WAITING, options: [], outcome: "limit", choice: null,
      rationale: "Parked until the window resets; nothing was lost." },
  ];

  const sent: SentCommand[] = [
    { id: "s4", ts: ago(95 * MIN), sessionId: "demo-g1", sessionTitle: "todo-garden · main", repoDir: GARDEN, actor: "user", source: "compose",
      kind: "prompt", text: "make overdue tasks show a red edge", result: "ok" },
    { id: "s3", ts: ago(3 * HOUR - 2 * MIN), sessionId: "demo-n1", sessionTitle: "pocket-notes · main", repoDir: NOTES, actor: "user", source: "compose",
      kind: "prompt", text: "the markdown export drops the title", result: "unconfirmed", detail: "The echo window closed first; the conversation log later showed it ran." },
    { id: "s2", ts: ago(2 * DAY - 60 * MIN), sessionId: "demo-b4", sessionTitle: "todo-garden · main", repoDir: GARDEN, actor: "auto", source: "backlog",
      kind: "prompt", text: "Rename 'Tasks' to 'Beds' in the settings screen", result: "ok", detail: "Backlog item, opened in a new session" },
    { id: "s1", ts: ago(1 * DAY + 8 * MIN), sessionId: LIMIT_SID, sessionTitle: TRAIL_TITLE, repoDir: TRAIL, actor: "auto", source: "limit",
      kind: "command", text: "continue", result: "ok", detail: "Window reset, session continued" },
  ];

  const prompt = (id: string, cwd: string, text: string, over: Partial<Intent>): Intent => ({
    id, cwd, payload: { kind: "prompt", steps: [text] }, target: { kind: "repo", fresh: true }, trigger: { kind: "now" },
    state: "done", createdAt: ago(1 * DAY), ...over,
  });
  const intents: Intent[] = [
    prompt("b4", GARDEN, "Rename 'Tasks' to 'Beds' in the settings screen", {
      label: "Rename in settings", createdAt: ago(2 * DAY), startedAt: ago(2 * DAY - HOUR), settledAt: ago(2 * DAY - 90 * MIN),
      result: { at: ago(2 * DAY - 90 * MIN), ok: true, detail: "ran in a new todo-garden session" },
    }),
    prompt("i-dep", GARDEN, "Check for outdated dependencies and list what is safe to update", {
      label: "Dependency check", createdAt: ago(3 * DAY + 2 * HOUR), startedAt: ago(3 * DAY + 2 * HOUR - MIN), settledAt: ago(3 * DAY + 2 * HOUR - 6 * MIN),
      result: { at: ago(3 * DAY + 2 * HOUR - 6 * MIN), ok: true, detail: "3 packages are safe to update; listed in the session" },
    }),
  ];

  const launches: LaunchIntent[] = [
    { id: "l1", cwd: TRAIL, repoName: "trail-log", prompt: "Draw the route in the attached map on the hike page", needs: [".claude/inbox/trail-map.png"],
      createdAt: ago(8 * MIN), deadlineAt: now + 6 * HOUR - 8 * MIN, state: "waiting", missing: [".claude/inbox/trail-map.png"], title: "Trail map" },
    { id: "l2", cwd: NOTES, repoName: "pocket-notes", prompt: "Import the sample notes and check the markdown export on them", needs: [".claude/inbox/sample-notes.zip"],
      createdAt: ago(25 * MIN), deadlineAt: now + 6 * HOUR - 25 * MIN, state: "waiting", missing: [".claude/inbox/sample-notes.zip"], title: "Sample import" },
  ];

  const pullItem = (id: string, rel: string, size: number, mtime: number) => ({
    id, repoId: "r1", repoDir: GARDEN, repoName: "todo-garden", name: rel.slice(rel.lastIndexOf("/") + 1), relPath: rel, size, mtime,
    ts: mtime + 2_000, source: "outbox" as const,
  });

  return {
    notifications: [
      { id: "n1", ts: ago(18 * MIN), kind: "image", title: "New screenshot in todo-garden", body: "todo-garden-sorted.png", sessionId: "demo-g1",
        image: { repoId: "r1", relPath: p.sorted } },
      { id: "n2", ts: ago(5 * HOUR), kind: "artifact", title: "todo-garden-before.png is ready", body: "A file landed in the outbox of todo-garden.",
        file: { repoId: "r1", relPath: p.before, name: "todo-garden-before.png", size: 31174, mtime: ago(5 * HOUR) } },
      { id: "n3", ts: ago(20 * HOUR), kind: "backlog", title: "Backlog groomed", body: "3 items in todo-garden were ordered and given names.",
        backlog: { cwd: GARDEN, ids: ["b1", "b2", "b3"] } },
      { id: "n4", ts: ago(3 * DAY + 2 * HOUR - 6 * MIN), kind: "autofire", title: "Dependency check ran in todo-garden",
        body: "3 packages are safe to update." },
    ],
    decisions,
    sent,
    intents,
    launches,
    deliveries: [
      { id: "dl1", sessionId: "demo-n1", sessionTitle: "pocket-notes · main", cwd: NOTES, repoName: "pocket-notes",
        text: "the markdown export drops the title", head: "the markdown export drops the title", kind: "prompt", source: "compose",
        reported: "unconfirmed", startedAt: ago(3 * HOUR - 2 * MIN), verdict: "landed", alive: true, asks: 1,
        nextAskAt: ago(3 * HOUR - 4 * MIN), deadlineAt: ago(3 * HOUR - 2 * MIN) + 20 * MIN, resolvedAt: ago(3 * HOUR - 3 * MIN),
        reason: "The conversation log shows the prompt ran, so nothing needs sending again." },
    ],
    pulls: [
      pullItem("pu1", p.sorted, 31628, ago(4 * HOUR)),
      pullItem("pu2", p.before, 31174, ago(5 * HOUR)),
    ],
    install: {
      entries: [
        { key: "dev-pixel:pu-apk3:1", deviceId: "dev-pixel", deviceName: "Pixel 8", deviceModel: "Pixel 8", reportedAt: ago(26 * HOUR) + 4_000,
          pullId: "pu-apk3", pkg: "app.todogarden.debug", label: "todo-garden", version: "0.4.1", code: 42, file: "todo-garden-debug.apk",
          repo: "todo-garden", outcome: "installed", auto: true, at: ago(26 * HOUR) },
        { key: "dev-pixel:pu-apk2:1", deviceId: "dev-pixel", deviceName: "Pixel 8", deviceModel: "Pixel 8", reportedAt: ago(3 * DAY) + 4_000,
          pullId: "pu-apk2", pkg: "app.todogarden.debug", label: "todo-garden", version: "0.4.0", code: 41, file: "todo-garden-debug.apk",
          repo: "todo-garden", outcome: "failed", error: "Not enough storage on the device", auto: false, at: ago(3 * DAY) },
        { key: "dev-pixel:pu-apk1:1", deviceId: "dev-pixel", deviceName: "Pixel 8", deviceModel: "Pixel 8", reportedAt: ago(3 * DAY - 10 * MIN) + 4_000,
          pullId: "pu-apk1", pkg: "app.todogarden.debug", label: "todo-garden", version: "0.4.0", code: 41, file: "todo-garden-debug.apk",
          repo: "todo-garden", outcome: "installed", auto: false, at: ago(3 * DAY - 10 * MIN) },
      ],
      devices: [{ id: "dev-pixel", name: "Pixel 8", model: "Pixel 8", lastAt: ago(26 * HOUR), installs: 2, failures: 1 }],
      total: 3,
    },
    inbox: {
      r1: [{ name: "swipe-sketch.png", relPath: p.sketch, size: p.sketchSize, mtime: ago(2 * HOUR), ctime: ago(2 * HOUR) }],
    },
  };
}

/**
 * The schedule anchored to a USAGE WINDOW rather than a clock — "spend what is
 * left of the week before it resets" — so the schedule sheet's week bar has a
 * rule pinned to the weekly reset beside the Monday clock rule. Its `nextAt` is
 * `nextFireAt` over the very usage reading `numbersFill` ships, so the pin, the
 * reset line and the usage chip agree by construction.
 */
export function windowSchedules(now: number): NonNullable<DemoModel["schedules"]> {
  const rule: ScheduleRule = { kind: "window", window: "weekly", edge: "before", offsetMin: -180, minPctLeft: 20 };
  return [{
    id: "sch-week", name: "Spend what is left of the week", enabled: true, createdAt: now - 4 * DAY, graceMin: 120,
    nextAt: nextFireAt(rule, now, numbersFill(now).usage ?? undefined),
    rule,
    action: { kind: "backlog", repoDir: GARDEN, text: "Work through the queued backlog items while this week's allowance is still there", label: "Use the week", autoFire: true },
  }];
}
