/**
 * The instruction preset the capture loop ships with: how an agent working in a
 * repo should LOOK at a screenshot without leaving it resident in a conversation
 * that will re-send it on every remaining turn.
 *
 * Why this is a file written into a repo rather than a paragraph somewhere in
 * waterplane: the agent that needs the rule is the `claude` process running in THAT
 * repo, and it reads that repo's `.claude/skills/`. A rule kept on the host is a
 * rule the agent never sees.
 *
 * Why it is a compliance FIX and not a scaffold: `scaffold.ts` only ever seeds a
 * NEW repo and `setupwatch.ts` never writes into one at all, so the only
 * sanctioned path that puts a file into an existing repo is a fix the user taps
 * — additive, idempotent, and never a delete (`compliance.ts`'s header). This
 * follows the `gemini-script` fix exactly: mkdir, write only when absent, and
 * say which of the two happened.
 *
 * Why it is offered only where capture is configured: configuring a capture
 * target IS the opt-in. A repo with no `.waterplane/capture.json` targets has nothing
 * to look at and must never be nagged about how to look at it.
 */
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { env } from "./env.js";
import { BRAND, envName } from "@waterplane/shared";

/** Where the preset lands, repo-relative. Named in full everywhere it is mentioned. */
export const VISUAL_SKILL_REL = ".claude/skills/visual-check/SKILL.md";

/** The port this daemon answers on — same resolution as `main.ts`. */
const DEFAULT_PORT = 8770;
function hostPort(): number {
  const n = Number(env("PORT") || DEFAULT_PORT);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : DEFAULT_PORT;
}

/**
 * The preset's text.
 *
 * The port is templated at write time rather than hardcoded, because the
 * one-liner in it is the whole point of the section it sits in: an agent that
 * has to guess the port goes and looks at the image instead, which is the
 * expensive thing this file exists to avoid. When the port IS the documented
 * default we say so, so a reader who moved their host knows the number came from
 * somewhere rather than from nowhere.
 *
 * ── Why the frontmatter says who wrote it ──────────────────────────────────
 *
 * `generated-by:` is not decoration. A repo may hold a check over its own
 * `.claude/skills/` — waterplane's `tools/claudemd.test.mjs` asserts that every
 * directory there is named in the "which skill to load" table — and this preset
 * lands in exactly that directory. It is not a routing entry for an area of that
 * codebase; it is a machine-written artifact aimed at the agent working in the
 * repo. So it SAYS it is one, and such a check exempts it on that marker. A
 * marker on the artifact still works the day a second preset exists; a list of
 * names inside the checker does not.
 */
export function visualSkillText(port = hostPort()): string {
  const portNote = port === DEFAULT_PORT
    ? `${DEFAULT_PORT} is ${BRAND.name}'s documented default port; \`${envName("PORT")}\` moves it.`
    : `This host answers on ${port} (\`${envName("PORT")}\`); the documented default is ${DEFAULT_PORT}.`;
  return `---
name: visual-check
description: How to look at a screenshot during a development loop without permanently polluting the conversation's context — what a frame actually costs on every remaining turn, and the five-rung ladder from a deterministic check, through a text verdict and the phone's gallery, to looking at the image yourself. Load BEFORE asking to see a screenshot, before assembling a contact sheet, and before handing frames to a subagent.
generated-by: ${BRAND.name} capture (packages/host/src/visualskill.ts) — a machine-written preset, not one of this repo's hand-authored skills. Edit it freely; nothing overwrites it.
---

# Looking at a screen without paying for it on every turn

This repo has capture targets configured, so frames are cheap to produce. Frames
are not cheap to KEEP. This file is about the difference.

## The cost, stated once

Every turn re-sends the whole conversation. An image is therefore not paid for
once — it is paid for again on every remaining turn of the session.

An image costs roughly \`(width x height) / 750\` tokens:

| frame | approx. tokens |
| --- | --- |
| 390x844 phone | ~440 |
| 1440x900 desktop | ~1,730 |
| a six-frame viewport/theme matrix | ~6,000 |

Multiply by the turns that come after it. A 6k matrix dropped at turn 10 of a
40-turn session costs about 180k tokens, not 6k. That is the number to have in
mind, and it is the reason the rest of this file is a ladder rather than a
preference.

## The ladder

Five rungs. Use the cheapest one that actually answers the question you have.

### 1. A deterministic check — zero tokens, and it cannot hallucinate

Most questions in a development loop are mechanical, not aesthetic, and this
rung answers all of them:

- **Pixel diff** — did anything change at all?
- **Blank/variance floor and shot-score** — is this a real frame, or a white
  rectangle?
- **DOM / uiautomator / OCR anchor** — is the expected text on the screen?
- **Console and network sidecar** — did it error while rendering?

"Did my change take effect", "is the button there", "did it blow up" are all
answered here, for nothing, by something that cannot be wrong in the confident
way a model can.

### 2. A text verdict into the conversation (~50 tokens)

\`\`\`
verified:anchor · score 91 · 390x844 dark · console: clean · net: clean
\`\`\`

That line is capture's DEFAULT output, and it is the rung to prefer. It carries
the level of verification, whether the frame scored as a real screen, the
geometry, and whether anything errored — at roughly one percent of the price of
the frame it describes.

### 3. The human's eyes, through the phone gallery — zero model tokens

Artifacts written to \`.claude/outbox/\` are looked at over HTTP. **They never
enter a conversation at all.** The person asking for this work is already
holding the phone, and their judgement on "does this look right" beats any
model's.

A contact sheet belongs HERE and never in a conversation: six tiles still cost
about 1,730 tokens as one image, and each tile is then too small to read
anything on. A grid is a thing for a human to scan, not a thing to pay context
for.

### 4. A subagent

A subagent burns the image in its own window and returns a sentence. Worth it
when there are many frames, or the parent session is long-lived, or the
judgement is specifiable in a prompt.

Break-even is roughly:

\`\`\`
subagent_baseline / (image_tokens x remaining_turns)
\`\`\`

A single 440-token phone frame late in a session does not clear it. A six-frame
matrix early in one clears it easily.

Two costs the rule usually forgets:

- **A subagent pays a fresh system prompt and tool schemas before it looks at
  anything.** That baseline is the numerator above and it is not small. Measure
  it (see below) rather than assuming it.
- **A subagent that is not told what changed answers vaguely but confidently**,
  which is worse than not asking. Give it the diff, the expectation, and the
  question — not just the frame.

### 5. Look at it yourself

Legitimate for one small frame in a short session, or inside a tight visual loop
— look, nudge 4px, look. This is not a sin; it is simply the most expensive rung,
and it should be a choice rather than a reflex.

### Never

An image left resident in a long session with no active reason. Once it has
answered its question it goes on costing the same as it did when it was useful.

## Naming a file so it resolves

Name any artifact by its FULL path every time you mention it —
\`.claude/outbox/capture-home-2026-09-13-a1b2.png\`, never a bare filename and
never "the PNG in the outbox". That path is what the reader turns into the
picture; a bare name only resolves when the listing holds exactly one media file
by that name, and never in prose.

## Triggering a capture without spending tokens on it

Ask the host for the run and read the verdict out of the response body. Nothing
here puts an image in the conversation:

\`\`\`bash
curl -sS -X POST http://127.0.0.1:${port}/api/repos/<repoId>/capture/run \\
  -H 'content-type: application/json' \\
  -d '{"target":"<targetId>","wait":true}'
\`\`\`

${portNote}

\`<repoId>\` comes from \`GET http://127.0.0.1:${port}/api/repos\`; \`<targetId>\` is the \`id\` of an
entry in this repo's \`${BRAND.stateDirName}/capture.json\`.

With \`"wait":true\` the response carries the verdict line, the sidecar path and
the frame paths. That is rung 2 for the price of an HTTP round trip: you get the
~50-token sentence, and the image stays on disk where rung 3 can reach it.

## Measure the baseline before trusting the arithmetic

**The numbers above are estimates, and this repo checks rather than remembers.**
Before leaning on the rung-4 break-even, measure the real subagent baseline on
THIS machine: start a fresh subagent and read its FIRST-turn input tokens, which
is the whole cost it pays before it has looked at anything.

Two places already hold that number:

- ${BRAND.name}'s token-stats document (\`packages/host/src/tokenstats.ts\`, served over the
  API) — every conversation on this desktop, with subagents counted.
- \`packages/shared/src/sessioncost.ts\` — the per-session baseline, the same
  arithmetic the UI says out loud.

Then **edit the measured figure into this file**, and say that it was measured
and when. A number nobody checked is how the estimate above becomes folklore.

> **Measured baseline:** not yet measured on this machine. Until someone does,
> treat the break-even above as an estimate and prefer rungs 1-3.
`;
}

/**
 * Write the preset into a worktree if it is not already there.
 *
 * Additive and idempotent, like every other fix: an existing file is left
 * exactly as it is — someone may have edited the measured baseline into it, and
 * overwriting that would delete the one part of the file that was ever true
 * about this machine.
 */
export function writeVisualCheckSkill(worktree: string): { written: boolean; relPath: string } {
  const path = join(worktree, VISUAL_SKILL_REL);
  if (existsSync(path)) return { written: false, relPath: VISUAL_SKILL_REL };
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, visualSkillText());
  return { written: true, relPath: VISUAL_SKILL_REL };
}
