/**
 * Scenario `numbers` (demo-mode-plan.md §3, WP8a): the usage, budget, meter and
 * context readings, so the screens that draw them have something to draw.
 *
 * The model already carries all of it (`DemoModel.numbers`: usage, meter,
 * budget, context) — nothing was added to demo/host for this. What is NOT here
 * is `numbers.clihealth`, `update` and `notifyPrefs` (their frames stay absent,
 * the way a host with no reading sends none).
 *
 * The all-conversations token ledger (`/api/tokenstats`, `/api/tokenwindows`, `/api/usagelog`) IS
 * faked, on request: `numbers.ledger` makes `host/ledger.ts` answer with an invented, self-consistent
 * fortnight (~300 conversations over three repos, shaped like real heavy use) so the Token usage screen
 * has something to sell.
 * The demo has no logs to count; none of it is real, and it sits under the demo line like the rest.
 *
 * Every figure is fictional and sits under the demo line the whole time the
 * scenario runs. They are also self-consistent, because a reading that
 * disagrees with its neighbour looks wrong whether or not it is real:
 *  - the session's `contextLeft` (61) is what the context series' last sample
 *    says (78k of a 200k window → 61% left);
 *  - the budget verdict is `budgetVerdict`'s own answer for the usage reading
 *    (weekly 61% against a 90% ceiling is the tightest, so it names weekly);
 *  - the usage reading is "checked 2 minutes ago", inside the budget's
 *    staleness window, so the verdict is `ok` and not `unknown`.
 */
import { PROTOCOL_VERSION } from "@waterplane/shared";
import type { DemoScenario } from "../host/index.ts";
import { demoTopConvos } from "../host/ledger.ts";
import type { DemoModel } from "../host/model.ts";
import { DAY, GARDEN, HOUR, MIN, NOTES, TRAIL, bullet, repos, screen, tool } from "./garden.ts";
import { CLAUDE_BANNER, claudeBanner } from "../host/banner.ts";

/** Window the demo session runs in, and what the series ends at. */
export const WINDOW_TOK = 200_000;
export const LAST_TOK = 78_000;

export function numbers(now: number): DemoScenario {
  const ago = (ms: number) => now - ms;
  const g1 = "demo-g1";

  // 14 requests over the last hour and a half: a climb, one auto-compaction, a climb again.
  const climb = [18_000, 26_000, 35_000, 44_000, 55_000, 67_000, 81_000, 96_000, 112_000, 124_000];
  const after = [34_000, 41_000, 52_000, LAST_TOK];
  const t0 = ago(95 * MIN);
  const samples = [...climb, ...after].map((tok, i) => ({ t: t0 + i * 6 * MIN + (i >= climb.length ? 4 * MIN : 0), tok }));
  const compactAt = t0 + (climb.length - 1) * 6 * MIN + 3 * MIN;

  const model: DemoModel = {
    repos: repos(),
    sessions: [
      {
        id: g1, cwd: GARDEN, title: "todo-garden · main", tabTitle: "Group by day", remoteControl: true, running: true,
        idle: true, idleSince: ago(6 * MIN), createdAt: ago(100 * MIN), claudeSessionId: "c-garden-4", contextLeft: 61, starred: false,
        firstPrompt: "group the tasks by day, today first", lastPrompt: "add a test for the empty day",
      },
    ],
    screens: {
      [g1]: screen(
        `${claudeBanner("~/dev/todo-garden")}> add a test for the empty day\r\n` +
          bullet("A day with no tasks should not draw a heading.") +
          tool("Update", "src/store/tasks.test.ts", "Added 14 lines") +
          tool("Bash", "npm test -- tasks", "PASS src/store/tasks.test.ts (10 tests)") +
          bullet("Done. An empty day draws nothing; the test pins it.") +
          "\r\n",
      ),
    },
    history: {
      [g1]: [
        {
          id: "h-1", kind: "prompt", text: "add a test for the empty day", sentAt: ago(12 * MIN), outputAt: ago(6 * MIN),
          output: "Done. An empty day draws nothing; the test pins it. 10 tests pass.",
        },
      ],
    },
    recent: [
      { cwd: GARDEN, title: "todo-garden", lastActive: ago(6 * MIN), claudeSessionId: "c-garden-4", launch: {} },
      { cwd: NOTES, title: "pocket-notes", lastActive: ago(1 * DAY), claudeSessionId: "c-notes-1", launch: {} },
      { cwd: TRAIL, title: "trail-log", lastActive: ago(2 * DAY), claudeSessionId: "c-trail-1", launch: {} },
      // The ledger's costliest conversations, named: the Token usage screen looks a conversation up
      // here by its id, and would otherwise print "todo-garden · demo-tok".
      ...demoTopConvos(now).map(({ convo, title }) => ({
        cwd: convo.repo, title, lastActive: convo.lastAt ?? ago(DAY), claudeSessionId: convo.id, launch: {},
      })),
    ],
    closed: [],
    replies: [],
    numbers: {
      ledger: true,
      repoHealth: true,
      usage: {
        ok: true, sessionPct: 42, weeklyPct: 61, checkedAt: ago(2 * MIN),
        sessionResetAt: now + 2 * HOUR + 10 * MIN, weeklyResetAt: now + 3 * DAY + 5 * HOUR,
      },
      budget: {
        budget: { enabled: true, sessionMax: 80, weeklyMax: 90 },
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
      context: {
        [g1]: {
          sessionId: g1, claudeSessionId: "c-garden-4", updatedAt: now, samples,
          events: [{ t: compactAt, kind: "compact", trigger: "auto", preTok: 130_000, postTok: 30_000 }],
          windowTok: WINDOW_TOK, windowFrom: "model", model: "sonnet", autoCompactTok: 160_000, truncated: false, turns: 14,
        },
      },
    },
    banner: CLAUDE_BANNER,
  };

  return {
    meta: { id: "numbers", protocol: PROTOCOL_VERSION, stamp: "numbers-1" },
    clock: { start: now },
    state: { bootId: "boot", model: model as unknown as DemoScenario["state"]["model"] },
    script: [],
  };
}
