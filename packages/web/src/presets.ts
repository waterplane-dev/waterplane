import { LS, lsDel, lsGet, lsSetJson } from "./storage";
/**
 * Fan-out presets — the routine sweeps you run across every repo, as one-tap
 * chips over the fan-out composer.
 *
 * Fully user-owned: every default can be edited, reordered or deleted, and new
 * ones added. Stored in localStorage and SYNCED through the host (see
 * `settings.ts`), like snippets and the toolbar config — a preset list is a
 * personal habit, and a habit belongs to the person, not to one browser.
 *
 * Storage shape is `{ list, removed }`, not a bare array, for one reason: a
 * later app version that ships a NEW default must be able to show it without
 * resurrecting the defaults this user deliberately deleted. Missing defaults
 * are re-appended on every load unless their id is in `removed`.
 */
export interface Preset { id: string; title: string; text: string }

const KEY = LS.fanoutPresets;
const MAX_ITEMS = 80;
const MAX_TITLE = 48;
const MAX_TEXT = 8000;

/** Where a read-only sweep should drop its report — the phone-facing outbox. */
const OUT = ".claude/outbox";

export const DEFAULT_PRESETS: Preset[] = [
  { id: "init", title: "/init", text: "/init" },
  { id: "cost", title: "/cost", text: "/cost" },
  {
    id: "health",
    title: "repo health",
    text: `Summarize the state of this repo: uncommitted work, unpushed commits, failing or missing tests, and anything obviously stale.

Include an AGENT CONTEXT section, because it is the one cost that is paid on every turn whether or not anyone is using it: the size in characters of CLAUDE.md and any .claude/CLAUDE.md, the number of files under .claude/skills/ with each one's name and size, and the total. Note that a skill's BODY is loaded only when that skill is invoked — only its frontmatter description is always on — so report always-on (CLAUDE.md + descriptions) separately from on-demand (skill bodies), and give tokens as chars/4. Say whether the skills are gitignored, since ignored ones will not survive a fresh clone.

Write it all to ${OUT}/health.md — do not change any code.`,
  },
  {
    id: "wip",
    title: "uncommitted work",
    text: `Report what is in flight here: uncommitted changes, untracked files worth keeping, unpushed commits, and how far the branch has drifted from its remote. Write it to ${OUT}/wip.md. Commit nothing.`,
  },
  {
    id: "tests",
    title: "run tests",
    text: `Find and run this project's test suite the way its README or CI does. Report which tests fail and the shortest plausible cause for each in ${OUT}/tests.md. Do not fix anything yet.`,
  },
  {
    id: "build",
    title: "build check",
    text: `Build this project the way its README or CI does. Report whether it builds and, if not, the first real error with the file and line, in ${OUT}/build.md. Do not fix anything yet.`,
  },
  {
    id: "lint",
    title: "types + lint",
    text: `Run whatever type-check and lint this project has. Summarize the remaining errors grouped by file, worst first, in ${OUT}/lint.md. Change no code.`,
  },
  {
    id: "deps",
    title: "outdated deps",
    text: `Check whether this project's dependencies are outdated or have known vulnerabilities. Write a short report to ${OUT}/deps.md — do not change any code.`,
  },
  {
    id: "deps-update",
    title: "update deps",
    text: `Update dependencies to their latest COMPATIBLE versions, then run the build and the tests. Stop at the first thing that breaks rather than forcing it through. Report what you updated and what broke in ${OUT}/deps-update.md. Do not commit.`,
  },
  {
    id: "security",
    title: "security pass",
    text: `Do a read-only security pass: credentials or tokens committed to the repo, dependencies with known vulnerabilities, and unsafe patterns (shell interpolation of user input, unvalidated paths, missing auth checks). Write the findings ranked by severity to ${OUT}/security.md. Change no code.`,
  },
  {
    id: "docs",
    title: "docs drift",
    text: `Check whether README.md and CLAUDE.md still match the code: commands that no longer exist, moved paths, instructions that are now wrong. Write the drift list to ${OUT}/docs.md — do not edit the docs yet.`,
  },
  {
    id: "todos",
    title: "TODO sweep",
    text: `Collect every TODO / FIXME / HACK comment, group them by area, and rank them by how likely they are to bite. Write the list to ${OUT}/todos.md. Change no code.`,
  },
  {
    id: "deadcode",
    title: "dead code",
    text: `Find plausibly dead code: files nothing imports, exports nobody uses, dependencies nothing references. Write it to ${OUT}/deadcode.md with your confidence per item. Delete nothing.`,
  },
  {
    id: "week",
    title: "last 7 days",
    text: `Summarize what changed in this repo over the last 7 days: commits, which areas they touched, and anything left unfinished. Write it to ${OUT}/week.md. Change no code.`,
  },
  {
    id: "changelog",
    title: "changelog",
    text: "Update the CHANGELOG from the commits since the last release tag, matching the style already used in this repo. Create one if there is none. Touch no other file and do not commit.",
  },
  {
    id: "claudemd-audit",
    title: "CLAUDE.md cost",
    text: `Measure what this repo's always-on context costs, and change nothing.

CLAUDE.md is re-read on every turn of every session and every subagent, so its size is multiplied by everything the repo ever does. Report, in ${OUT}/claudemd.md:

1. The size in characters of CLAUDE.md, any .claude/CLAUDE.md, every file under .claude/skills/, and the long-form docs directory if there is one. Give tokens as chars/4.
2. Which SECTIONS of CLAUDE.md are largest, and for each: is it a RULE (dangerous not to know before acting) or REFERENCE (only needed while editing that area)?
3. Whether the reference half is duplicated in longer-form docs already, so it could be trimmed losslessly.
4. A verdict: under ~12k chars is fine and needs nothing. Over that, say roughly how many tokens per turn the excess costs and which section is the biggest single win.

Read-only. Do not edit any file.`,
  },
  {
    id: "claudemd-groom",
    title: "groom CLAUDE.md",
    text: `Get this repo's always-on context down to what has to be always-on. Measure first and STOP if it is already fine.

WHY: CLAUDE.md is re-read on every turn of every session and every subagent. Measured on one repo, it had grown to 148k chars and was 21% of every token that repo spent in a week.

STEP 1 — measure. Count the characters in CLAUDE.md. **If it is under ~12,000 chars, do nothing at all**: write one line to ${OUT}/claudemd.md saying the size and that no change was needed, and stop. Most repos are already fine and must not be churned.

STEP 2 — classify every section as one of:
- RULE: dangerous not to know BEFORE acting — the security boundary, "never do X", the commands that are mandatory, what the project is. These STAY in CLAUDE.md.
- REFERENCE: only needed while editing that area — module indexes, per-area conventions, test maps, protocol detail. These MOVE.
- REASONING: measurements, past failures, rejected designs. These move to the repo's long-form docs (use the existing convention if there is one, else docs/notes/).

STEP 3 — move, in this order, and never lose a rule:
a) REASONING to the docs directory FIRST. If a module's only description anywhere is its CLAUDE.md entry, write the doc section BEFORE trimming the entry — otherwise trimming deletes knowledge.
b) REFERENCE into .claude/skills/<name>/SKILL.md, one skill per area (e.g. one per package or major subsystem). Each needs YAML frontmatter with \`name\` matching the directory and a \`description\` of at least ~120 characters saying BOTH what it covers and when to load it. A skill is chosen from its description alone, so a vague one silently retires every rule inside it.
c) Leave CLAUDE.md with: what the project is, the mandatory commands, the security model IN FULL, a short "never do these" list, and a table mapping area to skill.

THE ONE HARD RULE: **a skill that is not invoked is a rule that does not exist.** Anything that could cause harm, data loss or a security problem stays in CLAUDE.md. Only reference moves. Delete nothing.

STEP 4 — check .gitignore. If .claude/ is ignored, the skills will not survive a fresh clone. Git cannot re-include below an excluded DIRECTORY, so it needs \`.claude/*\` followed by \`!.claude/skills/\`, not \`.claude/\`. Verify with \`git check-ignore\` that the SKILL.md files are tracked and that any inbox/outbox/local-settings paths are still ignored.

STEP 5 — verify and report. Confirm every rule that was in CLAUDE.md before is still somewhere (file, skill or docs), then write to ${OUT}/claudemd.md: the before and after sizes, what moved where, and anything you deliberately left in place. Do not commit.`,
  },
  {
    id: "commit",
    title: "commit WIP",
    text: "Review the uncommitted changes here. If they are coherent and safe, stage and commit them with a clear message — do not push. If they are unrelated pieces of work, split them into separate commits. If anything looks accidental or half-finished, leave it alone and say why.",
  },
];

/**
 * Which preset answers which failing setup check.
 *
 * A check whose remedy is WORK rather than a patch cannot use the checklist's
 * `fix` mechanism — that one POSTs an idempotent host-side edit, and "decide
 * which half of your CLAUDE.md is reference" is a judgement, not a patch. So
 * the row offers to SEND the prompt instead, through the ordinary send sheet,
 * where the target and the timing are still yours.
 *
 * The map lives here because the prompt text does: naming a preset id keeps one
 * copy of the words, so editing the preset edits the remedy. A row with no entry
 * simply has no button.
 */
export const CHECK_REMEDY: Record<string, string> = {
  "context-weight": "claudemd-groom",
};

/** The preset a check's remedy points at, if it is still in the user's list. */
export function remedyFor(checkId: string, list: Preset[]): Preset | null {
  const id = CHECK_REMEDY[checkId];
  return id ? list.find((p) => p.id === id) ?? null : null;
}

interface Stored { list: Preset[]; removed: string[] }

function clean(p: unknown): Preset | null {
  if (!p || typeof p !== "object") return null;
  const o = p as Record<string, unknown>;
  const id = typeof o.id === "string" ? o.id.slice(0, 64) : "";
  const text = typeof o.text === "string" ? o.text.slice(0, MAX_TEXT) : "";
  const title = typeof o.title === "string" ? o.title.slice(0, MAX_TITLE) : "";
  if (!id || !text.trim()) return null;
  return { id, title: title.trim() || autoTitle(text), text };
}

/** First non-empty line, shortened — the fallback chip label. */
export function autoTitle(text: string): string {
  const line = text.split("\n").map((l) => l.trim()).find(Boolean) ?? "";
  return line.length > 28 ? `${line.slice(0, 28)}…` : line || "untitled";
}

export function loadPresets(): Preset[] {
  let stored: Stored = { list: [], removed: [] };
  try {
    const raw = lsGet(KEY);
    if (!raw) return [...DEFAULT_PRESETS];
    const parsed = JSON.parse(raw) as Partial<Stored>;
    stored = {
      list: Array.isArray(parsed.list) ? parsed.list.map(clean).filter((p): p is Preset => !!p) : [],
      removed: Array.isArray(parsed.removed) ? parsed.removed.filter((r) => typeof r === "string") : [],
    };
  } catch { return [...DEFAULT_PRESETS]; }
  const have = new Set(stored.list.map((p) => p.id));
  const gone = new Set(stored.removed);
  // Defaults this build added since the list was saved — appended, never
  // re-added once explicitly deleted.
  const fresh = DEFAULT_PRESETS.filter((d) => !have.has(d.id) && !gone.has(d.id));
  return [...stored.list, ...fresh].slice(0, MAX_ITEMS);
}

export function savePresets(list: Preset[]): void {
  const kept = list.map(clean).filter((p): p is Preset => !!p).slice(0, MAX_ITEMS);
  const have = new Set(kept.map((p) => p.id));
  const removed = DEFAULT_PRESETS.filter((d) => !have.has(d.id)).map((d) => d.id);
  lsSetJson(KEY, { list: kept, removed } satisfies Stored);
}

/** Back to the shipped list — also forgets which defaults were deleted. */
export function resetPresets(): Preset[] {
  lsDel(KEY);
  return [...DEFAULT_PRESETS];
}
