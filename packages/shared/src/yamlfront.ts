/**
 * Whether a file's frontmatter is STRICT YAML — the half of a skill another agent may refuse.
 *
 * Claude Code reads a SKILL.md's `description:` leniently, so an unquoted value containing `: `
 * loads fine there. GitHub Copilot CLI (measured on 1.0.98) parses the same block as strict YAML,
 * reads that `: ` as a second mapping key, and SKIPS the skill: `copilot skill list` printed
 * "mapping values are not allowed in this context" for 18 of this repo's 24 skills, and an agent
 * told to load one got "Skill not found". Nobody noticed, because the agent the repo was written
 * for never complained.
 *
 * Deliberately not a YAML parser: it judges only the top-level `key: value` lines (and the
 * indented lines continuing a plain value), by the handful of rules that decide whether a PLAIN
 * scalar is legal. Quoted, block (`|`/`>`) and flow (`[`/`{`) values are accepted as written,
 * except a quote that never closes on its own line. Null means "nothing found", never "valid".
 */
import { frontmatterLines } from "./contextweight.js";

/** A top-level key, bare (`name`) or quoted, up to and including its `:`. */
const KEY_HEAD = /^([A-Za-z0-9_][\w.-]*|"[^"]*"|'[^']*')[ \t]*:/;

/**
 * A top-level `key: value` line as `[key, value]`, the value untrimmed; null when the line is not
 * one. Answers what `/^(KEY)[ \t]*:(?:[ \t]+(.*))?[ \t]*$/` did (its value only ever read trimmed),
 * but that regex was quadratic on a long tab run ending in a line terminator (CodeQL
 * `js/polynomial-redos`). Same refusals: something other than a space or tab right after the `:`,
 * and any character `.` would not cross — so a CRLF line still is not a key line.
 */
export function keyLine(line: string): [string, string] | null {
  const m = KEY_HEAD.exec(line);
  if (!m) return null;
  const rest = line.slice(m[0].length);
  if (rest && rest[0] !== " " && rest[0] !== "\t") return null;
  if (/[\n\r\u2028\u2029]/.test(rest)) return null;
  return [m[1], rest];
}
/** Characters that may not START a plain YAML scalar. */
const INDICATOR = /^[-?:,\]}#&*!%@`]/;

/** Index just past the closing quote of a quoted scalar starting at 0, or -1 when it never closes. */
function closeQuote(s: string): number {
  const q = s[0];
  for (let i = 1; i < s.length; i++) {
    if (q === '"' && s[i] === "\\") { i++; continue; }
    if (s[i] !== q) continue;
    if (q === "'" && s[i + 1] === "'") { i++; continue; }   // '' is an escaped ' in single quotes
    return i + 1;
  }
  return -1;
}

/** Why a PLAIN (unquoted) value is not strict YAML, or null. */
function plainProblem(v: string): string | null {
  if (/: /.test(v) || v.endsWith(":")) return `is unquoted and contains ": ", which strict YAML reads as a second key`;
  if (/[ \t]#/.test(v)) return `is unquoted and contains " #", which strict YAML reads as the start of a comment`;
  return null;
}

/**
 * A short sentence naming the first frontmatter key whose value is not strict YAML, and why;
 * null when the file has no frontmatter or nothing in it trips these rules.
 */
export function frontmatterYamlProblem(text: string): string | null {
  const lines = frontmatterLines(text);
  if (!lines) return null;
  let key: string | null = null;
  let plain = false;
  for (const line of lines) {
    if (!line.trim() || /^[ \t]*#/.test(line)) continue;
    if (/^[ \t]/.test(line)) {
      // A continuation of the previous key's value: a plain one keeps the plain-scalar rules.
      if (key && plain) {
        const why = plainProblem(line.trim());
        if (why) return `The \`${key}\` value continues onto a line that ${why.replace(/^is unquoted and /, "")}.`;
      }
      continue;
    }
    const m = keyLine(line);
    if (!m) { key = null; plain = false; continue; }
    key = m[0].replace(/^["']|["']$/g, "");
    const v = m[1].trim();
    plain = false;
    if (!v) continue;
    const c = v[0];
    if (c === '"' || c === "'") {
      const end = closeQuote(v);
      if (end < 0) return `The \`${key}\` value opens a ${c === '"' ? "double" : "single"}-quoted string that does not close on that line.`;
      const after = v.slice(end).trim();
      if (after && !after.startsWith("#")) return `The \`${key}\` value has text after its closing quote.`;
      continue;
    }
    if (c === "|" || c === ">" || c === "[" || c === "{") continue;
    plain = true;
    if (INDICATOR.test(v)) return `The \`${key}\` value is unquoted and starts with "${c}", which strict YAML reserves.`;
    const why = plainProblem(v);
    if (why) return `The \`${key}\` value ${why}.`;
  }
  return null;
}
