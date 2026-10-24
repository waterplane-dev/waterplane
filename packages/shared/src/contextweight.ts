/**
 * What a repo costs to have open, before anyone types anything.
 *
 * ── The thing being measured ────────────────────────────────────────────────
 *
 * `CLAUDE.md` is re-read on every turn of every session and every subagent, so
 * its size is multiplied by everything the repo ever does. Measured on this
 * desktop: one repo's had grown to 148,582 chars — ~37k tokens — and was **21%
 * of every token that repo spent in a week**. Nobody did that on purpose. Each
 * edit added a clause, every clause was worth writing, and none of them was the
 * one that broke it.
 *
 * That is the shape of a problem a CHECK catches and a person does not: it has
 * no moment of failure, only a slope.
 *
 * ── Always-on is not the same as total ─────────────────────────────────────
 *
 * A skill's BODY is loaded only when the skill is invoked, so a 20k skill costs
 * nothing on a turn that never needed it. Its DESCRIPTION is in the listing on
 * every turn. So the weight that matters is
 *
 *     CLAUDE.md + every skill's description
 *
 * and the skill bodies are reported beside it as what was successfully moved
 * OFF the always-on path — a large body is evidence the split is working, not a
 * problem. Counting them together would tell somebody who did the right thing
 * that they had made it worse.
 *
 * ── Why it warns and never fails ───────────────────────────────────────────
 *
 * There is no correct size. A repo with genuine hard-won invariants may need a
 * bigger file than a scratch project, and the person who wrote it is the only
 * one who can say which half is reference. So this produces a number, a
 * comparison and a sentence; the fix is a judgement call and is offered as a
 * prompt, never applied.
 */

/** Chars per token, near enough for prose+markdown. Only ever used to SAY what
 *  a size costs, never to decide anything — the thresholds are in chars. */
export const CHARS_PER_TOKEN = 4;

export interface ContextWeightLimits {
  /** Always-on chars (CLAUDE.md + skill descriptions) before this warns. */
  maxChars: number;
  /** Always-on chars before it is called out loudly. */
  hardChars: number;
  /** Skills before their descriptions alone are worth a mention. */
  maxSkills: number;
}

/**
 * The defaults, and where they come from.
 *
 * `maxChars` 16,000 ≈ 4k tokens on every turn. Calibrated against the repo this
 * was written in, after its reference had been moved into skills: 9,672 chars of
 * CLAUDE.md plus 2,762 of skill descriptions = 12,434. A threshold that flags a
 * repo which has already done the right thing is a threshold people learn to
 * ignore, and the 2,762 is GOOD spend — it is what keeps 58k of reference off
 * every turn. So the line sits above a well-organised repo and well below the
 * 148k (37k tokens a turn) that prompted any of this.
 *
 * `hardChars` 40,000 ≈ 10k tokens a turn, where the cost stops being a rounding
 * error on anything. `maxSkills` 30 is about descriptions, not bodies; they are
 * already counted in `maxChars`, so the count trips only a listing that is itself
 * a page — a router-plus-sub-skills split (24 here) is the shape the chars rule
 * asks for.
 *
 * Override per host with `WATERPLANE_CONTEXT_WARN_CHARS` / `WATERPLANE_CONTEXT_HARD_CHARS` /
 * `WATERPLANE_CONTEXT_MAX_SKILLS`.
 */
export const DEFAULT_CONTEXT_LIMITS: ContextWeightLimits = {
  maxChars: 16_000,
  hardChars: 40_000,
  maxSkills: 30,
};

export interface SkillWeight {
  name: string;
  /** Frontmatter `description:` length — the part that is ALWAYS loaded. */
  descChars: number;
  /** Whole file. On-demand, reported as context, never counted against. */
  bodyChars: number;
}

export interface ContextWeightInput {
  /** `CLAUDE.md` plus any `.claude/CLAUDE.md`, in chars. */
  claudeMdChars: number;
  skills: SkillWeight[];
}

export type ContextWeightVerdict = "lean" | "heavy" | "steep";

export interface ContextWeightReading {
  verdict: ContextWeightVerdict;
  /** What every turn carries: CLAUDE.md + all skill descriptions. */
  alwaysOnChars: number;
  alwaysOnTokens: number;
  /** What was moved off the always-on path. Evidence, not debt. */
  onDemandChars: number;
  skillCount: number;
  /** One sentence of fact. */
  note: string;
  /** What to do, when there is something worth doing. */
  advice: string | null;
}

/** `750` / `3k` / `12.4k` / `148k`. One decimal only when it says something —
 *  "3.0k chars" reads as a measurement precise to a hundred characters, which
 *  it is not. */
function shorten(n: number): string {
  if (n < 1_000) return String(n);
  const k = n / 1_000;
  if (k >= 10) return `${Math.round(k)}k`;
  const one = Math.round(k * 10) / 10;
  return `${Number.isInteger(one) ? one : one.toFixed(1)}k`;
}
const fmtTok = shorten;
const fmtChars = shorten;

/**
 * How a threshold is referred to in the sentence that quotes it.
 *
 * "you asked to be warned at" is true of a number the user actually set and a
 * lie about a shipped default — and it was being said about the default on
 * every desktop, which is how a check ends up crediting somebody with a
 * decision they were never offered. `repo` is named as a repo decision because
 * the whole point of setting one is that this repo is not like the others.
 */
function attributed(kind: "size" | "skills", value: string, source: ContextLimitSource): string {
  const at = kind === "size" ? `over the ${value}` : `past the ${value}`;
  if (source === "repo") return `${at} you set for this repo`;
  if (source === "env") return `${at} you asked to be warned at`;
  return `${at} default`;
}

export function weighContext(
  input: ContextWeightInput,
  limits: ContextWeightLimits = DEFAULT_CONTEXT_LIMITS,
  /** Where each of those numbers came from. Absent = all shipped defaults,
   *  which is what a caller with no store to consult is looking at. */
  sources: Partial<ContextLimitSources> = {},
): ContextWeightReading {
  const descChars = input.skills.reduce((n, s) => n + s.descChars, 0);
  const alwaysOnChars = Math.max(0, input.claudeMdChars) + descChars;
  const onDemandChars = input.skills.reduce((n, s) => n + Math.max(0, s.bodyChars - s.descChars), 0);
  const alwaysOnTokens = Math.round(alwaysOnChars / CHARS_PER_TOKEN);
  const skillCount = input.skills.length;

  const verdict: ContextWeightVerdict =
    alwaysOnChars >= limits.hardChars ? "steep"
    : alwaysOnChars >= limits.maxChars || skillCount > limits.maxSkills ? "heavy"
    : "lean";

  const moved = onDemandChars > 0
    ? ` ${fmtChars(onDemandChars)} more is in ${skillCount} skill${skillCount === 1 ? "" : "s"}, loaded only when needed.`
    : "";

  if (verdict === "lean") {
    return {
      verdict, alwaysOnChars, alwaysOnTokens, onDemandChars, skillCount,
      note: `Every turn here carries ${fmtChars(alwaysOnChars)} chars of agent instructions (~${fmtTok(alwaysOnTokens)} tokens).${moved}`,
      advice: null,
    };
  }

  // The count can be the only thing over, and then the size sentence would be
  // reporting a number that is inside its limit — say which one actually tripped.
  const overSize = alwaysOnChars >= limits.maxChars;
  const note = overSize
    ? `Every turn here carries ${fmtChars(alwaysOnChars)} chars of agent instructions (~${fmtTok(alwaysOnTokens)} tokens), ${attributed("size", fmtChars(limits.maxChars), sources.maxChars ?? "default")}.${moved}`
    : `${skillCount} skills, ${attributed("skills", String(limits.maxSkills), sources.maxSkills ?? "default")} — their descriptions are loaded on every turn even when no skill is.${moved}`;

  return {
    verdict, alwaysOnChars, alwaysOnTokens, onDemandChars, skillCount,
    note,
    advice: overSize
      ? "This is paid on every turn of every session and every subagent here. What has to stay is what is dangerous not to know before acting; reference belongs in a skill and reasoning in the docs. The “groom CLAUDE.md” fan-out preset does exactly that."
      : "Descriptions are the always-on part of a skill. Merging near-duplicates, or shortening the descriptions of ones you rarely load, costs nothing on-demand.",
  };
}

const DESC_KEY = /^["']?description["']?[ \t]*:[ \t]*/;

/**
 * A file's YAML frontmatter as raw lines, or null when it has none. Tolerates what YAML loaders
 * do — a UTF-8 BOM, blank lines before the opening `---`, CRLF and an empty block — because a
 * strict match read such a skill's description as 0 chars and its whole text as body.
 */
export function frontmatterLines(text: string): string[] | null {
  const fm = /^(?:[ \t]*\r?\n)*---[ \t]*\r?\n(?:([\s\S]*?)\r?\n)?---[ \t]*(?:\r?\n|$)/.exec(text.replace(/^\uFEFF/, ""));
  return fm ? (fm[1] ?? "").split(/\r?\n/) : null;
}

/**
 * The always-loaded length of one skill file: its `description:` frontmatter.
 *
 * Walked line by line rather than matched with one regex, because the obvious
 * `/^description:([\s\S]*?)(?=\n\w+:|$)/m` is wrong in a way that reads as right:
 * under `/m` the `$` is a LINE end, so a description wrapped across three lines
 * measures as its first line — reporting a third of the cost of exactly the
 * skills whose descriptions are worth looking at.
 */
export function skillDescChars(text: string): number {
  const lines = frontmatterLines(text);
  if (!lines) return 0;
  const start = lines.findIndex((l) => DESC_KEY.test(l));
  if (start < 0) return 0;
  // A `>` / `|` block-scalar indicator is YAML syntax, not words the model reads.
  const first = lines[start].replace(DESC_KEY, "").trim();
  const parts = /^[>|][+-]?\d*$/.test(first) ? [] : [first];
  for (let i = start + 1; i < lines.length; i++) {
    if (/^[A-Za-z_-]+:/.test(lines[i])) break;   // the next top-level key
    parts.push(lines[i].trim());
  }
  return parts.join(" ").trim().length;
}

// ── Where a threshold came from ─────────────────────────────────────────────
//
// The row used to say "over the 16k you asked to be warned at" about a number
// nobody had ever been offered: the knobs were env-only and host-wide, so on a
// desktop that had never exported one, the sentence credited the user with a
// decision they had not made and could not change from the phone. A repo with
// genuinely hard-won invariants then sat amber for ever with no way to say
// "16k is the wrong line HERE".
//
// So a threshold now has a SOURCE, three layers deep — a per-repo override, the
// host's env, the shipped default — and the sentence names the layer it is
// quoting. `default` is the only one that is not the user's own decision, and it
// is the one worded as a default.

export type ContextLimitSource = "default" | "env" | "repo";
export type ContextLimitSources = Record<keyof ContextWeightLimits, ContextLimitSource>;

/** What the check used, where each number came from, and what is on file for
 *  this repo — everything an editor needs to open on the right values without
 *  hardcoding a default the host may change. */
export interface ContextLimitsView {
  /** The numbers the reading was actually taken against. */
  effective: ContextWeightLimits;
  source: ContextLimitSources;
  /** The shipped defaults, for a truthful "back to default" label. */
  defaults: ContextWeightLimits;
  /** The env layer, as set on this host (absent fields = not exported). Shown
   *  so a repo override that is being shadowed... cannot happen (repo wins),
   *  but so "you set 20k on this host" is visible when a repo has no override. */
  env: Partial<ContextWeightLimits>;
  /** This repo's stored override, or null when it has none. The editor opens on
   *  THIS, never on `effective`: they differ whenever env is doing the work. */
  repo: Partial<ContextWeightLimits> | null;
  /** Set only when resolution had to move a number the user gave — today the
   *  single case is a `hardChars` left below a raised `maxChars`. Never silent. */
  note?: string;
}

/** Bounds for a hand-typed threshold. Wide on purpose: this is a guard against a
 *  typo and a zero, not an opinion about the right size — the module's whole
 *  premise is that there isn't one. */
export const CONTEXT_LIMIT_BOUNDS: Record<keyof ContextWeightLimits, { min: number; max: number }> = {
  maxChars: { min: 1_000, max: 2_000_000 },
  hardChars: { min: 1_000, max: 4_000_000 },
  maxSkills: { min: 1, max: 500 },
};

const LIMIT_KEYS: (keyof ContextWeightLimits)[] = ["maxChars", "hardChars", "maxSkills"];

/** A refusal sentence for one field, or null when the value is usable. Words,
 *  not a clamp: a silently corrected threshold is a threshold that reports a
 *  number the user never chose. */
export function contextLimitError(field: keyof ContextWeightLimits, value: unknown): string | null {
  const b = CONTEXT_LIMIT_BOUNDS[field];
  const n = Number(value);
  if (!Number.isFinite(n)) return `${field} must be a number.`;
  if (!Number.isInteger(n)) return `${field} must be a whole number.`;
  if (n < b.min) return `${field} must be at least ${b.min}.`;
  if (n > b.max) return `${field} must be at most ${b.max}.`;
  return null;
}

/**
 * Read a client's patch into an override.
 *
 * A field that is absent or `null` is "leave it to the layer below" — that is
 * how one knob is overridden without freezing the other two at whatever they
 * happen to be today. An out-of-range field is REFUSED and named; the caller
 * writes nothing and says so, rather than storing a repaired number.
 */
export function sanitizeContextLimits(patch: unknown): { limits: Partial<ContextWeightLimits>; errors: string[] } {
  const out: Partial<ContextWeightLimits> = {};
  const errors: string[] = [];
  const rec = (patch && typeof patch === "object" ? patch : {}) as Record<string, unknown>;
  for (const k of LIMIT_KEYS) {
    const v = rec[k];
    if (v === undefined || v === null || v === "") continue;
    const err = contextLimitError(k, v);
    if (err) { errors.push(err); continue; }
    out[k] = Number(v);
  }
  return { limits: out, errors };
}

/**
 * The three layers, resolved: repo override > host env > shipped default.
 *
 * `hardChars` below `maxChars` would make "steep" swallow "heavy" and leave the
 * warn number quoted in a sentence that can never fire — the likely way to get
 * there is raising a repo's warn line above the default hard line, i.e. the
 * exact thing this feature is for. It is raised to match, and the move is
 * REPORTED in `note` rather than applied quietly.
 */
export function resolveContextLimits(
  env: Partial<ContextWeightLimits> = {},
  repo: Partial<ContextWeightLimits> | null = null,
): ContextLimitsView {
  const effective = { ...DEFAULT_CONTEXT_LIMITS };
  const source = { maxChars: "default", hardChars: "default", maxSkills: "default" } as ContextLimitSources;
  for (const k of LIMIT_KEYS) {
    if (typeof env[k] === "number") { effective[k] = env[k]!; source[k] = "env"; }
    if (repo && typeof repo[k] === "number") { effective[k] = repo[k]!; source[k] = "repo"; }
  }
  let note: string | undefined;
  if (effective.hardChars < effective.maxChars) {
    note = `The steep line (${fmtChars(effective.hardChars)}) was below the warn line (${fmtChars(effective.maxChars)}), so it is being read as ${fmtChars(effective.maxChars)}. Set a steep line above the warn line to make it mean something.`;
    effective.hardChars = effective.maxChars;
  }
  return { effective, source, defaults: { ...DEFAULT_CONTEXT_LIMITS }, env: { ...env }, repo: repo ? { ...repo } : null, ...(note ? { note } : {}) };
}
