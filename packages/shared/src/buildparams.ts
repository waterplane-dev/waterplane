/**
 * What a build button ASKS before it runs.
 *
 * A build command was a constant: one name, one command line, one working dir,
 * and every tap ran exactly the same shell. That is the right shape for "Release
 * APK" and the wrong shape for the thing a monorepo actually has — one command
 * that does the same job to a DIFFERENT member of it. The Garmin tree is the
 * case that forced this: one screenshot pipeline, forty apps under `apps/`, and
 * the only way to say which one was forty near-identical buttons or a command
 * typed out on a phone keyboard, which is the friction this whole app exists to
 * remove.
 *
 * So an entry may declare parameters, and the value is asked for at the moment
 * you tap run.
 *
 * ── The four rules, each of them load-bearing ──────────────────────────────
 *
 *  • **A value is substituted VERBATIM into `cmd` and `dir`** at `{{id}}`, and
 *    is ALSO exported as `<PREFIX>PARAM_<ID>`. Verbatim rather than shell-quoted
 *    because a parameter is as legitimately a flag fragment as it is a word,
 *    and real entries already place it bare (`echo {{app}}`) or inside their own
 *    double quotes (`[ "{{mode}}" = publish ]`) — quoting would double-quote the
 *    second and still be wrong in a third context. So instead a value carrying a
 *    SHELL METACHARACTER (`unsafeParamIds`) REFUSES the run, with a sentence: a
 *    repo-supplied default or option must not be able to smuggle `; curl … | sh`
 *    onto a command line. The env copy is what a command that wants an
 *    arbitrary string reads (`"$<PREFIX>PARAM_APP"`), and it is there for every
 *    parameter whether or not the command line names it.
 *  • **A value is ONE LINE.** A newline substituted into a command line is a
 *    second command, and nobody typed it. Control characters are stripped on
 *    the way in, here, once, so neither end has to remember to.
 *  • **A placeholder nothing declares is LEFT EXACTLY AS WRITTEN.** The tempting
 *    alternative — substitute an empty string — turns `--app {{ap}}` (a typo)
 *    into `--app`, which builds something, successfully, that nobody asked for.
 *    Left alone the shell sees the braces and the build fails loudly, which is
 *    the only outcome that can be read off the log afterwards.
 *  • **A declared parameter with no value and no default REFUSES the run**,
 *    synchronously, naming what it needs. It is what an unattended fire — a
 *    schedule, a chain, Activity's *run it now* — hits, and the alternative is a
 *    build that runs on whatever was last picked, at 3 a.m., and reports success.
 *
 * Pure, and everything here is pinned by `test/buildparams.test.mjs`: the host
 * runs the shell and the phone draws the form, but both of them ask this module
 * what a value means.
 */

import type { BuildConfig, BuildParam } from "./wire/work.js";
import { envName, legacyEnvNames } from "./brand.js";

/** How many parameters one build may declare. A form longer than this is a
 *  script's own argument parsing, not a button. */
export const PARAMS_MAX = 8;
/** How many options a discovered list may offer before it is cut (and the cut
 *  is SAID — a silently truncated list of apps is a missing app). */
export const PARAM_OPTIONS_MAX = 200;
/** Longest single value. Generous — a path with a couple of segments — and a
 *  bound all the same, since this ends up on a command line. */
export const PARAM_VALUE_MAX = 512;

/** A parameter id: what `{{…}}` names and what `<PREFIX>PARAM_…` is built from.
 *  Deliberately the intersection of "a shell env var name" and "readable in a
 *  command line" — anything else is refused rather than mangled into shape. */
const ID_RE = /^[A-Za-z][A-Za-z0-9_]{0,31}$/;

/** `{{id}}`, with or without the spaces somebody will inevitably type. */
const REF_RE = /\{\{\s*([A-Za-z][A-Za-z0-9_]{0,31})\s*\}\}/g;

const str = (v: unknown): string => (typeof v === "string" ? v : "");

/**
 * One value, as it is allowed to reach a command line: one line, bounded, no
 * control characters. Applied on the way IN — when a form is submitted, when a
 * discovered option list is read, when a stored default is loaded — so nothing
 * downstream has to remember the rule.
 */
export function cleanParamValue(v: unknown): string {
   
  return str(v).replace(/[\x00-\x1f\x7f]/g, " ").trim().slice(0, PARAM_VALUE_MAX);
}

/** One declared parameter, sanitized — `null` where nothing usable is left. */
function cleanParam(v: unknown): BuildParam | null {
  const raw = (v && typeof v === "object" ? v : {}) as Record<string, unknown>;
  const id = str(raw.id).trim();
  // No id means nothing can reference it and nothing can fill it: a row that
  // could only ever be a puzzle on the form. Dropped, never repaired into
  // `param1` — a name nobody wrote is a name nobody's command line uses.
  if (!ID_RE.test(id)) return null;
  const options = Array.isArray(raw.options)
    ? raw.options.map(cleanParamValue).filter((s) => !!s).slice(0, PARAM_OPTIONS_MAX)
    : [];
  const optionsCmd = str(raw.optionsCmd).trim().slice(0, 500);
  // A choice with nowhere to get its choices from is a field you cannot fill.
  // It degrades to the free-text field it effectively is, rather than drawing
  // an empty drop-down and a person wondering which of the two of us is broken.
  const kind: BuildParam["kind"] = raw.kind === "choice" && (options.length || optionsCmd) ? "choice" : "text";
  const p: BuildParam = { id, kind };
  const label = str(raw.label).trim().slice(0, 60);
  if (label) p.label = label;
  if (kind === "choice") {
    if (options.length) p.options = options;
    if (optionsCmd) p.optionsCmd = optionsCmd;
  }
  const def = cleanParamValue(raw.default);
  if (def) p.default = def;
  const hint = str(raw.hint).trim().slice(0, 200);
  if (hint) p.hint = hint;
  return p;
}

/**
 * A build's whole parameter list, sanitized. Absent (rather than `[]`) when
 * there is nothing to ask — `BuildConfig` is written to a file a person and an
 * agent both edit, and an empty array in every entry is noise in the diff.
 *
 * Duplicate ids collapse to the FIRST: two rows named `app` are one question
 * asked twice, and the second silently winning is the shape where the form you
 * filled in is not the one the command read.
 */
export function cleanBuildParams(v: unknown): BuildParam[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const out: BuildParam[] = [];
  const seen = new Set<string>();
  for (const raw of v) {
    if (out.length >= PARAMS_MAX) break;
    const p = cleanParam(raw);
    if (!p || seen.has(p.id)) continue;
    seen.add(p.id);
    out.push(p);
  }
  return out.length ? out : undefined;
}

/** Characters that let a value end the word it was substituted into and start
 *  another command: separators, pipes, redirects, substitutions, quotes, and the
 *  backslash that escapes them. Spaces, `-`, `_`, `.`, `/`, `=`, `:`, `,`, `@`,
 *  `+` and globs are NOT here: a flag fragment or a path is a legitimate value. */
const SHELL_META_RE = /[;&|`$()<>\\"'\n\r]/;

/** The wire answer for one parameter's discovered options. `needsApproval`
 *  means the `optionsCmd` came from the repo's COMMITTED file and this desktop
 *  has not yet been told to run that exact command: `cmd` carries its text so
 *  the person can read it before a tap runs it. Never set together with
 *  `options`. */
export interface BuildParamAnswer {
  options?: string[];
  total?: number;
  error?: string;
  needsApproval?: boolean;
  cmd?: string;
}

/** Ids whose value would reach `cmd` carrying a shell metacharacter. */
export function unsafeParamIds(cmd: string, values: Record<string, string>): string[] {
  return paramRefs(cmd).filter((id) => typeof values[id] === "string" && SHELL_META_RE.test(values[id]));
}

/** The refusal sentence for `unsafeParamIds`; empty when there is none. */
export function unsafeParamsText(ids: string[]): string {
  if (!ids.length) return "";
  const list = ids.map((n) => `“${n}”`).join(", ");
  return `the value for ${list} contains a shell character (; & | \` $ ( ) < > \\ quotes) and would be run as part of the command — change it, or have the command read $${paramEnvName(ids[0])} instead`;
}

/** Every `{{id}}` a string references, in order, deduped. */
export function paramRefs(text: string): string[] {
  const out: string[] = [];
  for (const m of str(text).matchAll(REF_RE)) if (!out.includes(m[1])) out.push(m[1]);
  return out;
}

/**
 * Placeholders in this entry's command or dir that no parameter declares.
 *
 * Not an error and never a refusal — the editor SAYS it, because the two ways
 * to arrive here are a typo and a half-finished edit, and both of them are
 * cheaper to see before the build runs than in a shell error afterwards.
 */
export function unknownParamRefs(cfg: Pick<BuildConfig, "cmd" | "dir" | "params">): string[] {
  const declared = new Set((cfg.params ?? []).map((p) => p.id));
  return [...paramRefs(cfg.cmd ?? ""), ...paramRefs(cfg.dir ?? "")]
    .filter((id, i, a) => a.indexOf(id) === i && !declared.has(id));
}

/**
 * Substitute what we have. An id with no value is left EXACTLY as written —
 * see the header: an empty substitution is a different command that succeeds.
 */
export function applyParams(text: string, values: Record<string, string>): string {
  return str(text).replace(REF_RE, (whole, id: string) => {
    const v = values[id];
    return typeof v === "string" && v !== "" ? v : whole;
  });
}

/** `app` → `<PREFIX>PARAM_APP`. */
export function paramEnvName(id: string): string {
  return envName(`PARAM_${id.toUpperCase()}`);
}

/** The same variable under every past identity, newest first. */
export function legacyParamEnvNames(id: string): string[] {
  return legacyEnvNames(`PARAM_${id.toUpperCase()}`);
}

/** Every value as an environment variable, for a command that would rather
 *  read `"$<PREFIX>PARAM_APP"` than trust a verbatim substitution. */
export function paramEnv(values: Record<string, string>): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [id, v] of Object.entries(values)) if (ID_RE.test(id)) {
    const clean = cleanParamValue(v);
    env[paramEnvName(id)] = clean;
    // One release of both names: a driven repo's build script still reads the old one.
    for (const old of legacyParamEnvNames(id)) env[old] = clean;
  }
  return env;
}

/** What the form calls this field. The id is the fallback, never a blank. */
export function paramLabel(p: BuildParam): string {
  return p.label || p.id;
}

/**
 * The values this run will actually use, and what is still missing.
 *
 * Order: what was handed in, then the stored default, then nothing. A parameter
 * with nothing left is MISSING — never blank, never the first option of a list
 * it happens to have (picking for somebody is the quiet half of running the
 * wrong build).
 */
export function resolveParamValues(
  params: BuildParam[] | undefined,
  given: Record<string, string> | undefined,
): { values: Record<string, string>; missing: BuildParam[] } {
  const values: Record<string, string> = {};
  const missing: BuildParam[] = [];
  for (const p of params ?? []) {
    const v = cleanParamValue(given?.[p.id]) || cleanParamValue(p.default);
    if (v) values[p.id] = v;
    else missing.push(p);
  }
  return { values, missing };
}

/** Why a run was refused, as the sentence the toast and the host's ack both
 *  say. Names the fields — "this build needs a value" leaves a person guessing
 *  which of three it meant. */
export function missingParamsText(missing: BuildParam[]): string {
  const names = missing.map(paramLabel);
  if (!names.length) return "";
  const list = names.length === 1 ? `“${names[0]}”` : names.map((n) => `“${n}”`).join(", ");
  return `needs a value for ${list}`;
}

/** `app=acorn-squirrel · flavour=debug` — what separates two runs of one
 *  button. Empty when nothing was asked, so a paramless build reads exactly as
 *  it always did. */
export function paramSummary(values: Record<string, string> | undefined): string {
  const pairs = Object.entries(values ?? {}).filter(([, v]) => !!v);
  return pairs.map(([id, v]) => `${id}=${v}`).join(" · ");
}

/**
 * What the run is CALLED. Five rows reading "Screenshot · done · 17s" are five
 * rows nobody can tell apart, and with parameters they are five DIFFERENT
 * builds — so the values go in the title, which is snapshotted onto the intent
 * at fire time and is what Activity, the notification and the run row all read.
 */
export function buildRunTitle(name: string, values: Record<string, string> | undefined): string {
  const s = paramSummary(values);
  return s ? `${name} · ${s}` : name;
}

/** The option list a discovered command produced: one per line, cleaned, capped.
 *  `total` rides beside it so the UI can say what it is not showing — a silently
 *  cut list of apps is a missing app. */
export function parseParamOptions(stdout: string): { options: string[]; total: number } {
  const all = str(stdout).split("\n").map(cleanParamValue).filter((s) => !!s);
  const seen = new Set<string>();
  const uniq = all.filter((s) => (seen.has(s) ? false : (seen.add(s), true)));
  return { options: uniq.slice(0, PARAM_OPTIONS_MAX), total: uniq.length };
}
