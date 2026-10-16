/**
 * Scenario `gallery-and-files` (demo-mode-plan.md §3, WP8a): what a repo hands
 * the phone, and what the phone hands back.
 *
 * todo-garden's outbox holds four screenshots, an HTML preview page and a
 * markdown file (release notes); trail-log has one image; the inbox holds a
 * sketch "uploaded from the phone". A session whose last turn produced them
 * says so by their full `.claude/outbox/...` path. The files are bundled under
 * `public/demo/media/<repoId>/` (the transport maps a host file's URL there,
 * `demo/media.ts`) and every entry's `size` is pinned to its file by
 * `scenarios.test.mjs` — a number here that disagrees with the bytes fails.
 *
 * Time is relative to `now`; the gallery's mtimes are hours ago so its dates
 * group the way a real day's output would.
 */
import { PROTOCOL_VERSION } from "@waterplane/shared";
import type { DemoScenario } from "../host/index.ts";
import type { DemoModel } from "../host/model.ts";
import { DAY, GARDEN, HOUR, MIN, NOTES, TRAIL, bullet, repos, screen, tool } from "./garden.ts";
import { CLAUDE_BANNER, claudeBanner } from "../host/banner.ts";

const O = ".claude/outbox/";
export const FILES = {
  empty: `${O}todo-garden-empty-state.png`,
  picker: `${O}todo-garden-date-picker.png`,
  grouped: `${O}todo-garden-grouped.png`,
  sorted: `${O}todo-garden-sorted.png`,
  html: `${O}todo-garden-preview.html`,
  md: `${O}todo-garden-release-notes.md`,
  ridge: `${O}trail-log-ridge-loop.png`,
  sketch: ".claude/inbox/swipe-sketch.png",
} as const;

/** Bytes of what is in `public/demo/media/<repoId>/` — a test pins these to the files. */
export const MEDIA_SIZES = {
  [FILES.empty]: 4324,
  [FILES.picker]: 6080,
  [FILES.grouped]: 6142,
  [FILES.sorted]: 31628,
  [FILES.html]: 852,
  [FILES.md]: 430,
  [FILES.ridge]: 4174,
  [FILES.sketch]: 2169,
} as const;

export function galleryAndFiles(now: number): DemoScenario {
  const ago = (ms: number) => now - ms;
  const file = (rel: keyof typeof MEDIA_SIZES, at: number) => ({
    name: rel.slice(rel.lastIndexOf("/") + 1), relPath: rel, size: MEDIA_SIZES[rel], mtime: at, ctime: at,
  });

  const gardenScreen =
    `${claudeBanner("~/dev/todo-garden")}` +
    `> show me the new screens and write release notes for 0.4\r\n` +
    bullet("I'll render the three screens and collect them in the outbox.") +
    tool("Bash", "npx playwright screenshot", `saved ${FILES.empty}`) +
    tool("Bash", "npx playwright screenshot", `saved ${FILES.picker}`) +
    tool("Bash", "npx playwright screenshot", `saved ${FILES.grouped}`) +
    tool("Write", FILES.md, "Wrote 19 lines") +
    tool("Write", FILES.html, "Wrote 18 lines") +
    bullet(`Done. Screens: ${FILES.empty}, ${FILES.picker}, ${FILES.grouped}. Notes: ${FILES.md}. Preview page: ${FILES.html}`) +
    "\r\n";

  const model: DemoModel = {
    repos: repos({ outbox: { r1: 6, r3: 1 } }),
    sessions: [
      {
        id: "demo-g1", cwd: GARDEN, title: "todo-garden · main", tabTitle: "Screens and release notes", remoteControl: true, running: true,
        idle: true, idleSince: ago(25 * MIN), createdAt: ago(70 * MIN), claudeSessionId: "c-garden-3", contextLeft: 68, starred: false,
        firstPrompt: "show me the new screens and write release notes for 0.4", lastPrompt: "show me the new screens and write release notes for 0.4",
      },
    ],
    screens: { "demo-g1": screen(gardenScreen) },
    history: {
      "demo-g1": [
        {
          id: "h-1", kind: "prompt", text: "show me the new screens and write release notes for 0.4", sentAt: ago(68 * MIN), outputAt: ago(25 * MIN),
          output: `Done. Screens: ${FILES.empty}, ${FILES.picker}, ${FILES.grouped}. Notes: ${FILES.md}. Preview page: ${FILES.html}`,
        },
      ],
    },
    recent: [
      { cwd: GARDEN, title: "todo-garden", lastActive: ago(25 * MIN), claudeSessionId: "c-garden-3", launch: {} },
      { cwd: NOTES, title: "pocket-notes", lastActive: ago(1 * DAY), claudeSessionId: "c-notes-1", launch: {} },
      { cwd: TRAIL, title: "trail-log", lastActive: ago(3 * HOUR), claudeSessionId: "c-trail-1", launch: {} },
    ],
    closed: [],
    gallery: {
      r1: [
        file(FILES.md, ago(26 * MIN)),
        file(FILES.html, ago(27 * MIN)),
        file(FILES.grouped, ago(29 * MIN)),
        file(FILES.picker, ago(31 * MIN)),
        file(FILES.empty, ago(33 * MIN)),
        file(FILES.sorted, ago(4 * HOUR)),
      ],
      r3: [file(FILES.ridge, ago(3 * HOUR))],
    },
    inbox: { r1: [file(FILES.sketch, ago(2 * HOUR))] },
    replies: [],
    banner: CLAUDE_BANNER,
  };

  return {
    meta: { id: "gallery-and-files", protocol: PROTOCOL_VERSION, stamp: "gallery-and-files-1" },
    clock: { start: now },
    state: { bootId: "boot", model: model as unknown as DemoScenario["state"]["model"] },
    script: [],
  };
}
