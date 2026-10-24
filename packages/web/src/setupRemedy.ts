/**
 * The setup checklist's OTHER answer: a finding no host-side patch can close,
 * turned into words for the agent that owns the repo.
 *
 * `compliance.ts` can only carry a `fix` for a finding whose remedy is a small,
 * additive, idempotent edit it can write blind — a gitignore line, a CLAUDE.md
 * section, a helper script. Most findings are not that. Untracking a committed
 * transport file is `git rm --cached` plus a judgement about what is in it; a
 * dotenv that is really a template wants nobody to touch it at all; trimming a
 * CLAUDE.md is a decision about which half is reference. Those rows shipped
 * with a sentence and no affordance, which reads as "we found this, good luck".
 *
 * So this file builds the prompt instead. It is the second half of the rule the
 * sheet already follows: **nothing applies itself** — the words go to the one
 * send surface with the repo pre-chosen, and WHEN they run stays a decision
 * made with them on screen.
 *
 * Pure — no DOM, no React — so `node --test` runs it straight over the
 * TypeScript:
 *
 *     node --test packages/web/src/setupRemedy.test.mjs
 *
 * Its value imports — `isSetupFinding` above all — come from `@waterplane/shared` (resolved from
 * `shared/dist`, which is node-runnable for exactly this reason). That import
 * is the point rather than a concession: the predicate behind the badge's
 * count and the predicate behind this sheet's cut have to be the same
 * function, or a badge reading 3 opens a list of 4.
 */
import {
  AUTO_COMPACT_SUGGESTED, BRAND, CONFIRM_GATED_FIXES, REPOHEALTH_OWN_FILE, REPOHEALTH_SERIES, REPOHEALTH_TOOL, SIGNING_KEY_CONSENT,
  androidToolchainConsent, isSetupFinding, sharedRel, type ComplianceCheck,
} from "@waterplane/shared";
import type { SetupRowDef } from "./sdk/types.ts";

/**
 * What the agent should actually DO about a finding, keyed by check id.
 *
 * The check's own `detail` says what is wrong; this says what closing it looks
 * like, in the repo, including the part that is a judgement rather than an
 * edit. One copy of the words — the bulk prompt and the single-row prompt both
 * read from here, so the two can never drift into saying different things about
 * the same finding.
 */
const GUIDANCE: Record<string, string> = {
  "claude-md":
    "Run `/init` so the instructions describe what is really in this repo — a stub is worse than nothing — " +
    "then add a short section saying that artifacts meant for the phone go in `.claude/outbox/` and that " +
    "uploads from the phone arrive in `.claude/inbox/`.",
  "claude-md-outbox":
    "Add a few lines to CLAUDE.md telling the agent that artifacts a person should look at go in " +
    "`.claude/outbox/`, that uploads arrive in `.claude/inbox/`, and that neither is ever committed. " +
    "Graft it onto what is already there; rewrite nothing else.",
  "context-weight":
    "CLAUDE.md is re-read on every turn of every session and every subagent, so its size is multiplied by " +
    "everything this repo ever does. Classify each section as a RULE (dangerous not to know BEFORE acting — " +
    "security, \"never do X\", mandatory commands) or REFERENCE (only needed while editing that area). Rules " +
    "stay; reference moves into `.claude/skills/<name>/SKILL.md` with a frontmatter description that says both " +
    "what it covers and when to load it. Delete nothing, and if a rule's only statement anywhere is the line " +
    "you are about to trim, write it somewhere else first.",
  "auto-compact":
    `The check above names where the value comes from. If it is the environment variable of the ${BRAND.displayName} daemon or ` +
    "`.claude/settings.local.json`, say so and change nothing — those are the person's own settings, not this " +
    "repo's. Otherwise set `\"autoCompactWindow\": \"400k\"` in `.claude/settings.json`, keeping every other key.",
  "apk-install":
    "Make the Android build leave its APK in `.claude/outbox/` with a dated or commit-stamped name (a copy task " +
    `at the end of the build, or the build command in \`${sharedRel("builds.json")}\`), and keep one signing key for every ` +
    "build of the app. If targetSdk is flagged, raise it and say what the raise needs (API changes, permissions). " +
    `The phone half — first install through ${BRAND.displayName} — is the person's to do; say so rather than attempting it.`,
  "builds-configured":
    `Read the repo's own manifests and CI, then write \`${sharedRel("builds.json")}\` as a JSON list of ` +
    "`{id, name, cmd, dir?}` — one entry per command a person would tap (build, test, a debug APK). Leave " +
    "publishing and deploying commands out unless asked, and keep any existing entries.",
  "gitignore-transport":
    "Add the transport dirs to `.gitignore` as bare paths (no trailing slash, so `git check-ignore` matches " +
    "before the directory exists). Append — never rewrite the file.",
  "transport-tracked":
    "These are already tracked, so a gitignore line will not untrack them: `git rm --cached` each one, which " +
    "leaves the file on disk, and make sure the ignore rule covers it. If any of them turns out to be real " +
    "source rather than phone↔repo plumbing, say so and leave it alone.",
  "env-gitignored":
    "Gitignore each one and `git rm --cached` it so it stops being tracked while staying on disk. First check " +
    "what is actually in them: a file that holds only placeholders is a TEMPLATE and is meant to be committed — " +
    "say so and change nothing. If any of them ever held a real credential, say that too, in the report, and do " +
    "not rotate anything yourself.",
  // No `visual-check` entry, deliberately. `compliance.ts` emits that row ONLY
  // when the preset is absent, and always with `fix: "visual-check"` — so
  // `agentFindings()` below (status !== pass, no fix, not host scope) can never
  // select it and nothing here could ever render. The two cases that would make
  // it reachable do not exist: a host old enough not to know the fix id is a host
  // that does not emit the row at all (both landed together), and a preset
  // already on disk suppresses the row rather than producing a fix-less one.
  // An entry here would be words nobody can reach, kept in step with a patch by
  // hand. Add one the day a fix-less `visual-check` row can actually arrive.
};

/**
 * Rows an extension's host half contributes (`api.setupCheck`) bring their own words with them
 * (`SetupRowDef`, from the extension's manifest). The core's own guidance keys and fix ids can never
 * be overridden from there: such a def is REFUSED, listed in `refused`, and changes nothing.
 */
export interface SetupRowLookup {
  byCheck(id: string): SetupRowDef | undefined;
  byFix(fix: string): SetupRowDef | undefined;
  refused: string[];
}

export const NO_ROWS: SetupRowLookup = { byCheck: () => undefined, byFix: () => undefined, refused: [] };

let rowSource: () => SetupRowLookup = () => NO_ROWS;

/**
 * `core/extensionPoints.ts`'s, once: where `setupRows()` reads the contributed rows from. Bound
 * rather than imported — `SetupSheet` reads them, `features/setup` draws `SetupSheet`, and the
 * registry imports `features/setup`, so `SetupSheet` importing the registry reader was an import
 * cycle (`sdk/ledgers.ts`'s `bindLedgerViews`, the same shape). The launcher imports that reader,
 * so it is bound before any sheet renders.
 */
export function bindSetupRows(source: () => SetupRowLookup): void {
  rowSource = source;
}

/** The contributed setup-row words, as bound — `NO_ROWS` until then. */
export const setupRows = (): SetupRowLookup => rowSource();

/** The fix ids the core's own rows carry — an extension's row may not take them over. */
const CORE_FIXES = ["gitignore", "claude-md", "visual-check", "auto-compact", "state-dir", "android-toolchain", "signing-key", "builds-configured"];

export function setupRowLookup(defs: readonly SetupRowDef[]): SetupRowLookup {
  const byCheck = new Map<string, SetupRowDef>();
  const byFix = new Map<string, SetupRowDef>();
  const refused: string[] = [];
  for (const d of defs) {
    if (Object.hasOwn(GUIDANCE, d.check) || (d.fix !== undefined && CORE_FIXES.includes(d.fix))) { refused.push(d.check); continue; }
    if (!byCheck.has(d.check)) byCheck.set(d.check, d);
    if (d.fix !== undefined && !byFix.has(d.fix)) byFix.set(d.fix, d);
  }
  return { byCheck: (id) => byCheck.get(id), byFix: (fix) => byFix.get(fix), refused };
}

const FALLBACK = "Close this finding if it is real. If the check is wrong about this repo, say why and change nothing.";

/**
 * The findings that are an agent's job: not passing, no host-side `fix`, and
 * about THIS repo.
 *
 * `scope: "host"` is excluded on purpose — the Gemini credential is one fact
 * about the daemon, so handing it to a repo's agent would ask every repo on the
 * machine to fix the same thing, and none of them can (`summarize()` keeps it
 * out of the badge for the same reason).
 */
export function agentFindings(checks: ComplianceCheck[]): ComplianceCheck[] {
  return checks.filter((c) => isSetupFinding(c) && !c.fix);
}

/**
 * Findings a host-side patch can close — what "Fix all" actually covers.
 *
 * `isSetupFinding` and not `status !== "pass"`: this predicate omitted the
 * host-scope exclusion its sibling above has always had, so the bulk button
 * counted the daemon's one Gemini credential as a finding in whichever repo
 * happened to be on screen — a count that disagreed with the badge beside it,
 * which has excluded host scope since `summarize()` was written. A count on a
 * control is a filter, and three copies of one predicate is how the count and
 * the cut drift apart. The row's own `fix` button is untouched: the credential
 * is still patchable where it is stated, it is simply not a repo's finding.
 */
export function patchFindings(checks: ComplianceCheck[]): ComplianceCheck[] {
  return checks.filter((c) => isSetupFinding(c) && !!c.fix && !fixNeedsConfirm(c.fix));
}

/**
 * Fixes that CHOOSE a setting rather than repair a convention (`@waterplane/shared`'s
 * `CONFIRM_GATED_FIXES`, which the host's `fixable` count reads too), so they
 * are never part of "Fix all" and their row button takes two taps (`ConfirmButton`).
 * These are the armed labels.
 * `auto-compact` writes `"autoCompactWindow": "<size>"` into the repo's
 * `.claude/settings.json` — a number somebody should see before it is theirs.
 * The size is the host's (`ComplianceReport.autoCompactDefault`, chosen in
 * Settings); an older desktop that does not send one wrote the suggested one.
 */
const CONFIRM_FIXES: Record<string, (size: string) => string> = {
  "auto-compact": (size) => `write ${size} into .claude/settings.json?`,
  // The armed label IS the consent text (what, how big, where, the licence). A checklist row has
  // no derived size — only the onboarding plan does — so the sentence says the size depends.
  "android-toolchain": () => androidToolchainConsent(null),
  "signing-key": () => SIGNING_KEY_CONSENT,
};

export function fixNeedsConfirm(fix: string): boolean {
  return CONFIRM_GATED_FIXES.includes(fix);
}

/** The armed label of a confirm-gated fix — what the second tap will do. */
export function fixConfirmWords(fix: string, size: string = AUTO_COMPACT_SUGGESTED): string | null {
  return CONFIRM_FIXES[fix]?.(size) ?? null;
}

/**
 * The verb on a row's host-side patch. `fix` everywhere except where the row is
 * not broken: an extension's opt-in offered on a PASS row (requirements) says its
 * own verb through `rows`, because "fix" beside a tick reads as a contradiction.
 */
export function fixVerb(fix: string, size: string = AUTO_COMPACT_SUGGESTED, rows: SetupRowLookup = NO_ROWS): string {
  if (fix === "auto-compact") return `set ${size} in this repo's .claude/settings.json`;
  if (fix === "builds-configured") return "write build list";
  if (fix === "android-toolchain") return "install the Android build tools (JDK and SDK) on this desktop";
  if (fix === "signing-key") return "create or link the desktop signing key";
  return rows.byFix(fix)?.fixVerb ?? "fix";
}

/** The full effect of a short row-fix verb, drawn as text under the finding (never a `title`). */
export function fixTitle(fix: string): string | undefined {
  if (fix === "builds-configured") {
    return `write ${sharedRel("builds.json")} from this repo's build commands; existing lists stay untouched`;
  }
  return undefined;
}

/**
 * The verb on a row's hand-to-the-agent button. A contributed row may name its own
 * (the requirements row's finding is "the list is behind", and what the tap starts
 * is a build of it — "fix" would promise a repair).
 */
export function agentVerb(id: string, rows: SetupRowLookup = NO_ROWS): string {
  return rows.byCheck(id)?.agentVerb ?? "fix in this repo";
}

/** The distinct fix ids behind those findings (one pass closes all of them). */
export function patchIds(checks: ComplianceCheck[]): string[] {
  return Array.from(new Set(patchFindings(checks).map((c) => c.fix as string)));
}

/**
 * One prompt for one or more findings, quoting each check's OWN sentence.
 *
 * Quoted rather than paraphrased because the detail carries the specifics — the
 * file names, the measured numbers — and a paraphrase of a checklist is how the
 * agent ends up fixing a finding that was never made.
 */
export function remedyPrompt(findings: ComplianceCheck[], repoName: string, rows: SetupRowLookup = NO_ROWS): string {
  const items = findings.map((c, i) => {
    const how = GUIDANCE[c.id] ?? rows.byCheck(c.id)?.guidance ?? FALLBACK;
    return `${i + 1}. ${c.label} — ${c.detail}\n   ${how}`;
  });
  const head = findings.length === 1
    ? `${BRAND.displayName}'s setup checklist has one open finding in ${repoName}. Close it.`
    : `${BRAND.displayName}'s setup checklist has ${findings.length} open findings in ${repoName}. Close them.`;
  return `${head}

${items.join("\n\n")}

Rules for this pass: change only what a finding names, delete no file, and commit nothing. A finding you decide is WRONG about this repo is an answer, not a failure — say which and why, and leave it alone. Finish with a short list of what you changed and what you left.`;
}

/** What the bulk button says, given what it is about to do. */
export function bulkLabel(patch: number, agent: number): string {
  if (patch && agent) return `Fix all (${patch + agent})`;
  if (patch) return `Fix all (${patch})`;
  return `Hand ${agent === 1 ? "it" : `all ${agent}`} to the agent`;
}

/**
 * The line under the bulk button, when one tap is about to do two different
 * things. Absent when it is only doing one — a button that says "Fix all (2)"
 * and patches two files needs no footnote.
 */
export function bulkNote(patch: number, agent: number, repoName: string): string | null {
  if (!patch || !agent) return null;
  return `${patch} patched here; the other ${agent} ${agent === 1 ? "needs" : "need"} work, so ${agent === 1 ? "it goes" : "they go"} to ${repoName}'s agent as a prompt you send yourself.`;
}

/* ───────────────────────────────────────────────────────────────────────────
 * The OTHER region's verb, and why it is a different one.
 *
 * `Repo readings` holds two kinds of statement about a repo, separated by
 * their comparator. A `ComplianceCheck` compares a fact to a line somebody
 * chose, so it can be on the wrong side of it: it has a status, a stripe, a
 * place in the badge, and — where the host can write the patch — a `fix`. A
 * SERIES row compares a fact to the same fact on earlier commits. There is no
 * side to be on, so there is nothing to fix, nothing to count and nothing to
 * hand over as a finding.
 *
 * What there is, is a question. "The p95 file length is at the 89th percentile
 * of the last 22 readings, rising" is a fact a person may well want explained,
 * and the agent that owns the repo is who can explain it. So the row gets a
 * prompt of its own — through the same `onRemedy` path, opening the same send
 * sheet, sending nothing — and that prompt asks for an explanation and a
 * proposal and explicitly does NOT ask for a change. A reading that arrives on
 * a phone and quietly starts an edit is the exact failure "nothing applies
 * itself" names, one step further out than the setup half, because here there
 * is not even a finding to justify it.
 * ─────────────────────────────────────────────────────────────────────────── */

export interface SeriesSubject {
  /**
   * The tool's own key (`size.p95`) — the name the measurement has, which is
   * true in every repo.
   *
   * It is NOT a path. The prompt used to add "the series is
   * `tools/repohealth.mjs`", which is false in twelve of the thirteen repos on
   * this desktop: `repohealth.ts` runs the worktree's own copy where there is
   * one and this desktop's bundled waterplane copy otherwise, so over any repo that
   * does not ship the tool the prompt named a file that is not there — and an
   * agent told a file exists goes and looks for it.
   */
  key: string;
  /** The tool's own label — a noun phrase reading as the subject of "…is now". */
  label: string;
  /** The value as the screen printed it, unit included. */
  value: string;
  /**
   * The tool's reading of that value against its own past, as ONE sentence,
   * already worded (`rankSentence` in `repoHealthWords.ts`, the single place a
   * rank fraction becomes a percentile on this side). Passed in rather than
   * built here so "the prompt quotes it verbatim" is a property a test can
   * check against an arbitrary string, rather than two copies of a wording
   * that have to be kept in step.
   */
  reading: string | null;
  /**
   * Whether `reading` is a READING or the tool's refusal to give one.
   *
   * `rankSentence` returns the percentile when there is a rank and the tool's
   * own reason when there is not — "not enough history (2 of 14 readings)" —
   * and the prompt wrapped both in the same frame: *waterplane's repo-health series
   * reads it as:*. So a prompt asserted a reading that does not exist, and
   * handed the agent a row with no comparative content in it at all. The only
   * thing left in that prompt with any substance was how the number is built,
   * which is exactly what the agent then wrote about.
   *
   * Absent means unranked, not "an older caller": a prompt that cannot tell
   * the two apart must not claim the stronger one.
   */
  ranked?: boolean;
  /** The tool's second sentence — the numbers behind the value, a rate's
   *  denominator, its top offenders. `""` when the series has none. */
  detail: string;
  /**
   * Why this reading has no number, as one finished sentence — built by
   * `seriesAbsenceWords` below, never the raw wire field.
   *
   * Carried because an absence is a fact about the repo and not a gap in the
   * list: "duplicate blocks — no parser for kotlin" is the sentence that stops
   * an agent from going to look for a number nothing measured. Unused by the
   * single-row prompt, whose row is drawn with the same sentence on screen
   * beside it; the set has no such screen, because the set is the prompt.
   */
  absent?: string;
}

/**
 * Why a reading has no number — the THREE cases, kept apart.
 *
 * The first cut of the set prompt printed a value and stopped, so a series the
 * latest day never read arrived as `the always-on skill descriptions — —`:
 * an em-dash with nothing behind it, in a document whose whole claim is that
 * it says what was measured. On screen that never happened, because the tile
 * has `tileAbsentWords` beside it; the prompt has no tile.
 *
 * The three are separated because their answers are opposite. A family the
 * metric could not read has the metric's own reason and there is nothing to
 * look for. A value missing on the latest day alone is a CUT in a series that
 * otherwise has one — a fact about that commit. And a series with no reading
 * anywhere is a fact about the repo: nothing of that kind exists here to
 * measure. One sentence for all three would send an agent hunting for a figure
 * in two cases out of three.
 */
export function seriesAbsenceWords(a: {
  /** The metric's own reason, off the wire's `absent`. */
  absent?: string;
  /** The latest day's value. */
  last: number | null;
  /** How many days in the series hold a value at all. */
  readings: number;
}): string | undefined {
  if (a.absent) return `not read on the latest day — ${a.absent}`;
  if (a.last != null) return undefined;
  return a.readings
    ? "no value on the latest day, though earlier days in the series have one"
    : "no reading anywhere in the series — nothing of this kind has ever been measured here";
}

/**
 * One series reading, as a question for the repo's agent.
 *
 * The reading and the detail are QUOTED, for the reason `remedyPrompt` quotes
 * a check's `detail`: the specifics — the denominator, the file names, the
 * size of the window — are the only part that says what to look at, and a
 * paraphrase of a measurement is a measurement with the evidence removed.
 *
 * The instructions are deliberately all in the negative direction. There is no
 * threshold in the tool and none on the screen, so the prompt must not smuggle
 * one in by asking for the number to come down; and a reading is not a brief,
 * so it must not authorise an edit. Disagreeing with the reading is a valid
 * answer and is named as one.
 *
 * WHAT THE FIRST VERB DECIDES, and the failure that taught it. This prompt
 * opened with *Explain what is behind this reading*, and an agent handed it
 * spent seventeen tool calls inside the measuring script, produced a section
 * headed "What 2.210 is", and reproduced the number exactly. Correct work: the
 * subject of the sentence was the reading, so the reading is what got
 * explained. The person had to type the question again by hand — *is the skill
 * setup we have beneficial for my coding, or should it be adjusted?* — and the
 * answer to THAT was the one they kept.
 *
 * The prompt already asked for the judgment: *propose what could be done about
 * it*, *finish with the options as you see them*. It was ignored, and that is
 * the lesson. The FIRST VERB decides what the agent goes and researches;
 * everything after it decides only how the research is written up. A late
 * clause cannot redirect an investigation an opening verb already aimed. So
 * the subject of the opening sentence is the THING — the skills, the files,
 * the tests — and the number demotes to what prompted the question.
 *
 * JUDGMENT IS NOT A THRESHOLD, and the old wording conflated them. *It is not
 * a finding, there is no line this number is on the wrong side of* was written
 * to stop the prompt smuggling in a threshold the tool does not hold. It was
 * read as "form no opinion". But "five skills is too few FOR THIS REPO, and
 * you have budget for three or four more" holds no threshold anywhere in it:
 * it was formed by reading the repo, it names what it rests on, and it does
 * not transfer to another repo. That is the operational difference, and it is
 * the test for any future wording here. The ban on verdict words is scoped to
 * `repoHealthWords.ts`, which is what the SCREEN says; this file is what a
 * person asks their own agent, and `remedyPrompt` above it already ships
 * "Close it."
 *
 * AND "CHANGE NOTHING" IS A COMPLETE ANSWER, said early. The old prompt
 * granted metrology a terminus — *that is the answer; say so* — and nothing
 * else. Asking six tiles whether they are serving you, with no way to say yes,
 * turns six readings into six manufactured to-dos, which is worse than
 * metrology: metrology was at least true.
 */
export function seriesRemedyPrompt(s: SeriesSubject, repoName: string, scope?: string | null): string {
  const lines = [
    `${s.label} in ${subjectOfReading(repoName, scope)} is ${s.value}.`,
    readingLineOf(s),
    s.detail ? s.detail.trim() : null,
    scopeNoteOf(scope),
  ].filter(Boolean);
  return `${lines.join("\n")}

Is this serving ${subjectOfReading(repoName, scope)}, and what would you change? Answer it about the thing itself — the skills, the files, the tests, whatever this reading is a reading OF — by reading this repo and what the work in it actually needs. The number above is what prompted the question, not the subject of it.

"It is serving you; change nothing" is a complete answer, and so is "this is an artefact of how it was measured". If either is what you find, say so and stop. \`${s.key}\` is the tool's own name for this measurement; the tool is ${BRAND.displayName}'s, run against this tree, and is probably not in this repo — open it only if you come to doubt the number, and do not go hunting for it here.

This is not a brief and it is not a finding: the tool holds no threshold, so there is no line this number is on the wrong side of, and nothing above says it is too much or too little. A judgment you form by reading this repo is a different thing, and it is exactly what is being asked for — say what it rests on, and keep it about this repo rather than repos in general. Change no file, run no fix, commit nothing. Finish with the options as you see them, in order of what each would cost.`;
}

/**
 * The verb under a failure of the REPO'S OWN engine copy. That copy wins over
 * the desktop's (a repo carrying the tool is the authority on its root), so
 * when it cannot even start — an import its tree never built, a version that
 * predates the wire — nothing here can read the repo, and a refresh tap runs
 * the same broken file again. What closes it is a change in the repo, so the
 * verb seeds a prompt for that repo's agent; nothing is sent by the tap.
 */
export const ENGINE_ADOPT_LABEL = "ask the agent to adopt this desktop's engine";

/**
 * The repo's own `tools/repohealth.mjs` failed, and it is what reads this repo:
 * a repo carrying the engine outranks the desktop's, so the refresh cannot get
 * past it. The ask is to bring the repo onto the engine this desktop ships —
 * by updating its copy, or by dropping it so the desktop's reads the tree —
 * and to carry any reading only this repo has into its committed declaration,
 * which the desktop's engine runs.
 *
 * The failure is QUOTED, and the desktop's engine is named by PATH when the
 * host sent one: "the latest engine" with no location sends the agent looking
 * in its own tree, which is the copy that failed. Options in order of cost,
 * and the agent decides; a repo that IS the engine's source is told so,
 * because there deleting the copy is deleting the product.
 */
export function engineAdoptPrompt(repoName: string, failure: string | null, bundled: string | null | undefined): string {
  const tool = REPOHEALTH_TOOL;
  const own = REPOHEALTH_OWN_FILE;
  const where = bundled
    ? `The engine this desktop ships is \`${bundled}\` (its modules sit beside it, under \`${tool.replace(/\.mjs$/, "/")}\` in that tree). It takes \`--root=<repo>\` and reads any repo from outside it.`
    : `This desktop did not say where its own engine is — ask before guessing a path.`;
  return `${BRAND.displayName}'s repo-health charts for ${repoName} cannot be drawn: this repo carries its own \`${tool}\`, which outranks the desktop's engine, and it failed.
${failure ? `\nIt said: ${failure.trim()}\n` : ""}
${where}

Bring this repo onto the latest engine. In order of cost, pick the one that fits:
1. If the copy here is stale or half-built, and nothing in it is specific to this repo, remove \`${tool}\` and \`${tool.replace(/\.mjs$/, "/")}\` so the desktop's engine reads the repo.
2. If the copy carries readings only this repo has, move them into \`${own}\` (committed; \`readings\` is a list of argv commands that each print one number), then remove the copy as in 1.
3. If this repo is where the engine is developed (it is the engine's own source), keep the copy and make it run here instead — the failure above says what is missing.

Do not delete the measured series (\`${REPOHEALTH_SERIES}\`) — the desktop's engine reads it. Run \`node <engine> status --root=.\` with the engine you end up on to show it loads, say which option you took and why, and commit it.`;
}

/**
 * The reading line, or the tool's refusal to read — never one frame over both.
 *
 * `rankSentence` answers with the percentile when there is a rank and with the
 * tool's own reason when there is not, and both used to arrive wrapped in
 * *reads it as:*. That frame turns "not enough history (2 of 14 readings)"
 * into a claim the series made a reading, when what the series said is that it
 * cannot. The unranked wording says so, and says the consequence out loud: the
 * question below is then entirely about the repo, because the series has
 * contributed nothing to it.
 */
function readingLineOf(s: SeriesSubject): string | null {
  if (!s.reading) return null;
  return s.ranked
    ? `${BRAND.displayName}'s repo-health series reads it as: ${s.reading}`
    : `${BRAND.displayName}'s repo-health series has no reading of it yet — ${s.reading}. So the series has nothing to ` +
      "say about this one, and the question below is entirely about the repo.";
}

/**
 * What the findings cut is hiding, and what the count it came from was.
 *
 * The badge on a repo says "3", and a tap on it opens exactly those three:
 * `isSetupFinding` is the one predicate behind both, so the number and the cut
 * cannot disagree. The bar then says `n of N` against the UNFILTERED list,
 * because a list that silently shows a subset is a list claiming the rest does
 * not exist — and it carries the only way back out.
 */
export function findingsCutWords(shown: number, all: number): string {
  return `${shown} of ${all} — open findings only, the rest of the checklist is hidden`;
}

/**
 * Every reading at once, as one question for the repo's agent.
 *
 * The row prompt above and this one are not the same question asked at two
 * sizes. A row compares one fact to its own past, and that is all its prompt
 * can honestly hold. The reading a person on a phone usually wants explained
 * is the one BETWEEN rows — the file-length curve flat while the re-touch rate
 * falls, duplication absent on a tree whose file count doubled — and ten
 * separate prompts cannot produce it, because none of them is told the other
 * nine exist. Sending them one after another produces ten answers that each
 * re-derive the tree and none that compares anything.
 *
 * So the whole set travels: every series in the order the sheet drew it, the
 * value as the screen printed it, the tool's reading sentence and its detail
 * verbatim for the reason `remedyPrompt` quotes a check's detail, and the
 * absences WITH their reasons. The engine line rides along because a reading
 * is only legible beside what was measured — "duplication absent" is a
 * different claim over a Kotlin tree than over a TypeScript one.
 *
 * What does NOT travel is the narrative. It is the desktop's own prose about
 * these same rows, so quoting it here would put the tool's cross-reading
 * inside a prompt asking for one — an answer handed to the agent as evidence.
 * The readings are the evidence; the narrative is somebody else's answer.
 *
 * The instructions are the row prompt's, in the same negative direction and
 * for the same reasons, plus the one clause only this prompt can carry: these
 * are one tree on one day, so which readings move together is a question and
 * not an assumption.
 */
/**
 * WHAT was measured — a repo, or one subtree of it.
 *
 * A scoped reading is of `apps/ba3-web` and not of the monorepo it sits in,
 * and a prompt that says the repo's name is a prompt about the wrong tree: the
 * agent would go looking for a p95 across eighteen apps to explain a number
 * that is about one.
 */
function subjectOfReading(repoName: string, scope?: string | null): string {
  return scope ? `${repoName}, under ${scope}` : repoName;
}

/**
 * The clause a scoped prompt cannot leave out: what a path in it resolves
 * against, and which commits the reading was taken over.
 *
 * Both are consequences of measuring a subtree as though it were a repo. A
 * path printed relative to the scope and read as repo-relative names a file
 * that does not exist, and a window of readings taken over the subtree's own
 * commits is a different window from the repo's.
 */
function scopeNoteOf(scope?: string | null): string | null {
  return scope
    ? `This reading is of ${scope} alone, measured as though it were the repo: only the commits that ` +
      `touched it are in the series, and every path above is relative to ${scope}/.`
    : null;
}

export function seriesAllRemedyPrompt(
  series: readonly SeriesSubject[],
  repoName: string,
  /** `engineLineWords`'s sentence, or null on a host too old to say. */
  engine?: string | null,
  /** The subtree these readings are of, when they are of one. */
  scope?: string | null,
): string {
  const items = series.map((s, i) => {
    const lines = [`${i + 1}. ${s.label} (\`${s.key}\`) — ${s.absent ? "no reading" : s.value}`];
    if (s.absent) lines.push(`   ${s.absent}`);
    // The same cut the row prompt makes, for the same reason: a rank and the
    // tool's refusal to rank arrive from one function, and listing the refusal
    // bare under a value reads as a reading of it.
    else if (s.reading) lines.push(`   ${s.ranked ? s.reading : `no reading of it yet — ${s.reading}`}`);
    if (s.detail) lines.push(`   ${s.detail.trim()}`);
    return lines.join("\n");
  });
  const n = series.length;
  const head =
    `${BRAND.displayName}'s repo-health series holds ${n} reading${n === 1 ? "" : "s"} of ${subjectOfReading(repoName, scope)}, ` +
    "all taken from the same commit. Here they are, worded as the tool words them.";
  return `${head}
${engine ? `\n${engine}\n` : ""}
${items.join("\n\n")}

Every key above is the tool's own name for that measurement. The tool is ${BRAND.displayName}'s, run against this tree, and is probably not in this repo — do not go hunting for it here.${scopeNoteOf(scope) ? `\n${scopeNoteOf(scope)}` : ""}

Is ${subjectOfReading(repoName, scope)} in a shape that serves the work happening in it, and what would you change? Answer it about the things themselves — the files, the skills, the tests, the dependencies these readings are readings OF — by reading this repo. The numbers are what prompted the question, not the subject of it.

Read them together: they are one tree on one day, so say which of them move for the same reason, which only coincide, and whether any two of them disagree. A reading that is absent is a fact about this repo as much as a number is — say what its absence means here rather than looking for the missing figure.

"It is serving you; change nothing" is a complete answer for any of these, and so is "this one is an artefact of how it is measured" — say which ones, and stop there on those. This is not a brief and it is not a finding: the tool holds no threshold, so there is no line any of these numbers is on the wrong side of, and nothing above says any of them is too much or too little. A judgment you form by reading this repo is a different thing, and it is exactly what is being asked for — say what each one rests on, and keep it about this repo rather than repos in general. Change no file, run no fix, commit nothing. Finish with the options as you see them, in order of what each would cost.`;
}

// The health-index asks live in their own module; re-exported so callers keep one import.
export * from "./healthAskPrompts.ts";
