/**
 * Scenario `repo-health`: a repo vibe-coded for months with no readings, as the health index reads
 * it now. Filmed by `scripts/ui/journey-repo-health.mjs` (docs/media/repo-health.*, R-demo-035).
 *
 * The usual three repos plus `photo-shelf`, a fictional photo app whose health data is the shape of
 * a real one (`host/healthindex.ts` weekly from February, `host/repohealth.ts` the last four weeks):
 * one file climbing from 1,020 to 8,397 lines while every other reading stays fine, so the score
 * slides from ~100 to 46, capped by file length, with two severe alerts — one naming the file. Only
 * the shape is real; the name, the paths and every figure's exact value are invented.
 *
 * The health routes answer (`numbers.repoHealth`) and every repo but trail-log carries its score,
 * so the launcher's chips read 46 / 98 / 63 and the absent case stays visible.
 */
import { PROTOCOL_VERSION } from "@waterplane/shared";
import type { DemoScenario } from "../host/index.ts";
import type { DemoModel } from "../host/model.ts";
import { demoRepoHealthIndex } from "../host/healthindex.ts";
import { CLAUDE_BANNER, claudeBanner } from "../host/banner.ts";
import { DAY, GARDEN, HOUR, MIN, NOTES, TRAIL, bullet, repos, screen, tool } from "./garden.ts";

export const SHELF = "~/dev/photo-shelf";

export function repoHealth(now: number): DemoScenario {
  const ago = (ms: number) => now - ms;
  const s1 = "demo-p1";
  const model: DemoModel = {
    repos: [
      ...repos({ healthIndex: now }),
      {
        id: "r4", repoName: "photo-shelf", branch: "main", isPrimary: true, worktreePath: SHELF, outboxCount: 0, changedCount: 3,
        hasRepoHealth: true, healthIndex: demoRepoHealthIndex("photo-shelf", now),
      },
    ],
    sessions: [
      {
        id: s1, cwd: SHELF, title: "photo-shelf · main", tabTitle: "Retry big album uploads", remoteControl: true, running: true,
        idle: true, idleSince: ago(18 * MIN), createdAt: ago(80 * MIN), claudeSessionId: "c-shelf-1", contextLeft: 44, starred: false,
        firstPrompt: "uploads of big albums stall at 80%, make them retry", lastPrompt: "uploads of big albums stall at 80%, make them retry",
      },
    ],
    screens: {
      [s1]: screen(
        `${claudeBanner(SHELF)}> uploads of big albums stall at 80%, make them retry\r\n` +
          bullet("The stall is in the upload loop of the sync backend.") +
          tool("Update", "lib/services/sync_backend.dart", "Added 212 lines") +
          tool("Bash", "flutter test test/sync_test.dart", "All tests passed!") +
          bullet("Done. A chunk that times out is retried three times before the album is marked failed.") +
          "\r\n",
      ),
    },
    history: {
      [s1]: [
        {
          id: "h-1", kind: "prompt", text: "uploads of big albums stall at 80%, make them retry", sentAt: ago(30 * MIN), outputAt: ago(18 * MIN),
          output: "Done. A chunk that times out is retried three times before the album is marked failed.",
        },
      ],
    },
    recent: [
      { cwd: SHELF, title: "photo-shelf", lastActive: ago(18 * MIN), claudeSessionId: "c-shelf-1", launch: {} },
      { cwd: GARDEN, title: "todo-garden", lastActive: ago(5 * HOUR), claudeSessionId: "c-garden-4", launch: {} },
      { cwd: NOTES, title: "pocket-notes", lastActive: ago(1 * DAY), claudeSessionId: "c-notes-1", launch: {} },
      { cwd: TRAIL, title: "trail-log", lastActive: ago(2 * DAY), claudeSessionId: "c-trail-1", launch: {} },
    ],
    closed: [],
    replies: [],
    numbers: { repoHealth: true },
    banner: CLAUDE_BANNER,
  };

  return {
    meta: { id: "repo-health", protocol: PROTOCOL_VERSION, stamp: "repo-health-1" },
    clock: { start: now },
    state: { bootId: "boot", model: model as unknown as DemoScenario["state"]["model"] },
    script: [],
  };
}
