/**
 * A repo's requirements list: what the person asked the project to do,
 * reconstructed from their prompts and the commits that shipped them.
 *
 * Four readers must agree on what counts, so it lives here once:
 *  - `scripts/requirements/update.mjs` builds the list (imports shared/dist);
 *  - the host's setup row counts what arrived since the last build;
 *  - the preset written into the repo tells that repo's agent the format;
 *  - the requirements sheet (packages/extensions/requirements) lists the items.
 * A prompt the script extracts and the row does not count, or the reverse, is
 * a "N new prompts" that never goes to zero.
 */
import { BRAND } from "./brand.js";

export const REQUIREMENT_STATUSES = ["requested", "shipped", "superseded", "dropped"] as const;
export type RequirementStatus = (typeof REQUIREMENT_STATUSES)[number];

/** Repo-relative paths, named in full everywhere they are mentioned. */
export const REQ_DIR_REL = "docs/requirements";
export const REQ_STATE_REL = "docs/requirements/.state.json";
export const REQ_SKILL_REL = ".claude/skills/requirements/SKILL.md";

/**
 * New prompts after which a set-up list reads as behind. A count, not an age:
 * a repo nobody touched for a month has nothing new to extract, and one that
 * had forty prompts yesterday does.
 */
export const REQ_STALE_PROMPTS = 20;

/** What the build run leaves in `.state.json`. Every field may be absent. */
export interface RequirementsState {
  promptsThrough?: string | null;
  commitsThrough?: string | null;
  lastRun?: string;
  lastCostUsd?: number;
}

/** The CLI's transcript folder name for a directory: every non-alphanumeric becomes "-". */
export function transcriptDirName(absPath: string): string {
  return absPath.replace(/[^a-zA-Z0-9]/g, "-");
}

export interface TranscriptPrompt {
  ts: string;
  uuid: string;
  /** First 8 chars of the session id — enough to find the conversation again. */
  session: string;
  text: string;
}

/** Shorter than this is "New apk", "yes", "commit" — never a requirement. */
const MIN_PROMPT_CHARS = 12;
const ECHO = /^<(command|local-command|system-reminder|task-notification|agent-message|bash-)/;

/**
 * One transcript line → the person's own prompt, or null.
 *
 * Headless calls (`entrypoint: "sdk-cli"` — the host's own summaries, this list's own
 * build) are not the person; tool results, meta turns, slash-command echoes and
 * sidechains are not prompts.
 */
export function transcriptPrompt(entry: unknown, fallbackSession = ""): TranscriptPrompt | null {
  if (!entry || typeof entry !== "object") return null;
  const j = entry as Record<string, any>;
  if (j.type !== "user" || j.isMeta || j.isSidechain || j.entrypoint === "sdk-cli") return null;
  if (typeof j.timestamp !== "string") return null;
  let c = j.message?.content;
  if (Array.isArray(c)) {
    if (c.some((x) => x?.type === "tool_result")) return null;
    c = c.filter((x) => x?.type === "text").map((x) => x.text).join("\n");
  }
  if (typeof c !== "string") return null;
  const text = c.trim();
  if (text.length < MIN_PROMPT_CHARS || ECHO.test(text)) return null;
  return {
    ts: j.timestamp,
    uuid: String(j.uuid ?? ""),
    session: String(j.sessionId || fallbackSession).slice(0, 8),
    text,
  };
}

/**
 * The dedupe key set for one pass. A resumed session copies its history into a
 * new file, so the same prompt appears under two uuids with the same words.
 */
export function promptSeen(seen: Set<string>, p: TranscriptPrompt): boolean {
  const key = p.text.slice(0, 500);
  if ((p.uuid && seen.has(p.uuid)) || seen.has(key)) return true;
  if (p.uuid) seen.add(p.uuid);
  seen.add(key);
  return false;
}

/** Item heading, as the format writes it: `### R-<area>-<nnn> · <status>`. */
export const REQ_ITEM_HEAD = /^### (R-[a-z0-9-]+-\d+) · (\w+)/gm;

export function countRequirements(md: string): Record<RequirementStatus, number> {
  const out = { requested: 0, shipped: 0, superseded: 0, dropped: 0 };
  for (const m of md.matchAll(REQ_ITEM_HEAD)) {
    if ((REQUIREMENT_STATUSES as readonly string[]).includes(m[2]!)) out[m[2] as RequirementStatus]++;
  }
  return out;
}

/**
 * The skill written into a repo (the `requirements` setup fix, or the build
 * run's first pass). `updateCmd` is how THIS machine runs the build, so the
 * agent never has to guess where the engine lives.
 *
 * `generated-by:` for the same reason as the visual-check preset: a repo that
 * checks its own `.claude/skills/` against a routing table exempts
 * machine-written presets on that marker.
 */
export function requirementsSkillText(updateCmd: string): string {
  return `---
name: requirements
description: What this repo is expected to do, as a person asked for it — one file per area under docs/requirements/, stable IDs, status + source. Load before changing behaviour someone relies on, or when asked how something should work.
generated-by: ${BRAND.slug} requirements (packages/shared/src/requirements.ts) — a machine-written preset, not one of this repo's hand-authored skills. Edit it freely; nothing overwrites it.
---

# Requirements

The list of what this project is expected to do, reconstructed from the prompts
that asked for it and the commits that shipped it. Index:
\`docs/requirements/README.md\` — read it, then only the area file you need.

## Before you change behaviour

Grep the area file for the thing you are about to change. If an item says it
must work another way, **say so before acting** — the person may have forgotten
they asked for it, or may be superseding it on purpose. Either way it is their
call, not yours.

## Item format

\`\`\`
### R-<area>-<nnn> · <status>
One or two sentences: observable behaviour, from the user's side, as an end state.
- asked: 2026-08-25 (session 1a2b3c4d)
- shipped: 3f9e2a1
- superseded-by: R-<area>-<nnn>
\`\`\`

- **status** — \`requested\` (asked, no evidence it shipped), \`shipped\` (a commit
  or the code shows it), \`superseded\` (a later item replaced it —
  \`superseded-by\` says which), \`dropped\` (the person withdrew it).
- **IDs are stable.** Never renumber, never reuse, never delete an item: change
  its status. A later request that contradicts an item supersedes it.
- Behaviour, not implementation: "Child mode has one canvas and no save", not
  "ChildActivity hides the save button".

## Who updates it

\`${updateCmd}\` reads the prompts and commits since
\`docs/requirements/.state.json\` — a cheap model extracts, a stronger one merges
as add/amend/status operations — and leaves an **uncommitted diff** for a
person to review. It preserves every item it was not told to change, byte for
byte, so hand edits are safe. ${BRAND.displayName}'s setup checklist says when it is behind.
`;
}

export interface RequirementItem {
  id: string;
  /** The area file's name without `.md`. */
  area: string;
  status: RequirementStatus;
  text: string;
  asked: string[];
  shipped: string[];
  supersededBy: string | null;
}

/**
 * One area file → its items. The same split and bullet grammar as `parseArea` in
 * `scripts/requirements/update.mjs` (`### R-…` blocks; `- asked|shipped|superseded-by: `; asked and
 * shipped split on commas; every other non-blank line joined by a space into the text). An item
 * whose status is not in `REQUIREMENT_STATUSES` is DROPPED — `countRequirements`' rule, so the
 * list on the phone and the row's count never disagree.
 */
export function parseRequirementsArea(area: string, md: string): RequirementItem[] {
  const out: RequirementItem[] = [];
  for (const raw of md.split(/^(?=### R-)/m).slice(1)) {
    const lines = raw.split("\n");
    const m = /^### (R-[a-z0-9-]+-\d+) · (\w+)/.exec(lines[0]!);
    if (!m || !(REQUIREMENT_STATUSES as readonly string[]).includes(m[2]!)) continue;
    const it: RequirementItem = { id: m[1]!, area, status: m[2] as RequirementStatus, text: "", asked: [], shipped: [], supersededBy: null };
    const text: string[] = [];
    for (const l of lines.slice(1)) {
      const b = /^- (asked|shipped|superseded-by): (.*)$/.exec(l);
      if (!b) { if (l.trim()) text.push(l.trim()); continue; }
      if (b[1] === "superseded-by") it.supersededBy = b[2]!.trim();
      else it[b[1] as "asked" | "shipped"] = b[2]!.split(/,\s*/).filter(Boolean);
    }
    it.text = text.join(" ");
    out.push(it);
  }
  return out;
}

/**
 * One `asked:` entry → the parts it has: "2026-09-16 (session 61c1e521)", "c40d28d7" (a bare session),
 * "2026-09-27 (user request)". Nothing is guessed — an absent part is null.
 */
export function askedRef(s: string): { date: string | null; session: string | null; note: string | null } {
  const t = s.trim();
  const date = /^\d{4}-\d{2}-\d{2}/.exec(t)?.[0] ?? null;
  // Only "session X" names a session: the build always writes `DATE (session X)`, so a BARE 8-hex is
  // not one — it is kept as written (a note) and drawn bare, never labelled.
  const sess = /session ([0-9a-f]{8})/.exec(t)?.[1] ?? null;
  const paren = /\(([^)]*)\)/.exec(t)?.[1]?.trim() ?? null;
  const note = paren && !sess ? paren : (!date && /^[0-9a-f]{8}$/.test(t) ? t : null);
  return { date, session: sess, note };
}
