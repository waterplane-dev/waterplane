/**
 * Dictation vocabulary: words the person uses a lot that the transcriber does
 * not know — an app called `BA3`, a repo name, a product name.
 *
 * ── Two levers, both on the person's own list ───────────────────────────────
 *
 * 1. **The prompt.** whisper.cpp takes an initial prompt (`--prompt`) and
 *    conditions its decoding on it, so a term that appears there is far more
 *    likely to be SPELLED the way it appears there. That is the lever that
 *    moves recognition itself, and it is the reason the list lives on the phone
 *    and travels with every clip: the host has no other way to know it.
 * 2. **The corrections.** A prompt biases, it does not guarantee. So each term
 *    may also say what it keeps coming back as (`BA3: bee a three, be a 3`),
 *    and those are replaced after the fact. Without any, a term is still
 *    rejoined when it arrives SPLIT (`BA 3`, `B.A.3`, `B-A-3`) and re-cased
 *    when it is an identifier (`ba3` → `BA3`) — the two shapes a short
 *    identifier reliably comes back in.
 *
 * The re-casing is the one rule that could touch an ordinary word, so it is
 * limited to terms that cannot be one: three characters or more, with a digit
 * or a capital past the first letter. `Go` or `Tiptoi` is never forced onto a
 * sentence that happened to say "go"; `NASA`, `BA3` and `iPhone` are.
 *
 * Nothing here decides anything: the words land in the box the person is
 * editing, same as before, and they read them before anything is sent.
 *
 * ── The list, as written ────────────────────────────────────────────────────
 *
 * One term per line, optionally followed by a colon and what it is misheard
 * as, comma-separated. `#` starts a comment line. Parsed by ONE function on
 * both ends — the phone to say how many terms it has, the host to use them —
 * so the two can never count a line differently.
 */

import { BRAND } from "./brand.js";

/** One entry: the spelling wanted, and what it arrives as instead. */
export interface DictateTerm {
  term: string;
  heard: string[];
}

/** Terms kept. whisper's prompt is capped at half its text context (~224
 *  tokens), so a longer list would be cut by the transcriber, not by us —
 *  silently. Cut here, where the Settings row can say so. */
export const DICTATE_TERMS_MAX = 60;
/** One term or one alias, in characters. A "term" longer than this is a
 *  sentence, and a sentence in the prompt steers style, not spelling. */
export const DICTATE_TERM_MAX_CHARS = 40;
/** Aliases per term. */
export const DICTATE_HEARD_MAX = 8;
/** The prompt handed to whisper, in characters — well inside its token cap. */
export const DICTATE_PROMPT_MAX_CHARS = 600;

const clean = (s: string) => s.replace(/\s+/g, " ").trim().slice(0, DICTATE_TERM_MAX_CHARS).trim();

/** The product's own names, which every list starts out knowing. */
export function brandDictateTerms(): DictateTerm[] {
  return BRAND.dictationTerms.map((term) => ({ term, heard: [] }));
}

/** The list as written in Settings → the entries, deduplicated by term
 *  (case-insensitive, the later line's aliases added to the first) and capped. */
export function parseDictateTerms(text: string | null | undefined): DictateTerm[] {
  const out: DictateTerm[] = [];
  const byKey = new Map<string, DictateTerm>();
  for (const raw of String(text || "").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const colon = line.indexOf(":");
    const term = clean(colon < 0 ? line : line.slice(0, colon));
    if (!term) continue;
    const heard = colon < 0 ? [] : line.slice(colon + 1).split(",").map(clean).filter(Boolean);
    const key = term.toLowerCase();
    let entry = byKey.get(key);
    if (!entry) {
      if (out.length >= DICTATE_TERMS_MAX) continue;
      entry = { term, heard: [] };
      byKey.set(key, entry);
      out.push(entry);
    }
    for (const h of heard) {
      if (entry.heard.length >= DICTATE_HEARD_MAX) break;
      if (h.toLowerCase() === key) continue;
      if (!entry.heard.some((x) => x.toLowerCase() === h.toLowerCase())) entry.heard.push(h);
    }
  }
  return out;
}

/** How many non-comment lines the list has, against what `parseDictateTerms`
 *  kept — so the Settings row can say "60 of 64 kept" instead of dropping four
 *  in silence. */
export function dictateTermsDropped(text: string | null | undefined): number {
  const lines = String(text || "").split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith("#"));
  const distinct = new Set(lines.map((l) => clean(l.split(":")[0]).toLowerCase()).filter(Boolean));
  return Math.max(0, distinct.size - parseDictateTerms(text).length);
}

/** The canonical text of a parsed list — what the phone SENDS, so the query
 *  string carries no comments and no blank lines. Round-trips through
 *  `parseDictateTerms` unchanged. */
export function serializeDictateTerms(terms: DictateTerm[]): string {
  return terms.map((t) => (t.heard.length ? `${t.term}: ${t.heard.join(", ")}` : t.term)).join("\n");
}

/**
 * The initial prompt for whisper: the terms, comma-separated, and nothing
 * else. Deliberately no lead-in like "Glossary:" — a prompt is also read as
 * the text that came BEFORE the clip, and an English word there nudges the
 * language detection and the style of a German dictation.
 *
 * A list of ONE is said twice. Measured (large-v3-turbo, a clip saying
 * "kwixel"): a prompt of `Kwixel.` alone changed nothing — "Quixel" both
 * times — while `Kwixel, Kwixel.` and `BA3, Kwixel.` both spelled it the
 * person's way, and neither changed a German clip in the same run.
 */
export function dictatePrompt(terms: DictateTerm[]): string {
  if (terms.length === 1 && terms[0].term.length * 2 + 3 <= DICTATE_PROMPT_MAX_CHARS) {
    return `${terms[0].term}, ${terms[0].term}.`;
  }
  let out = "";
  for (const t of terms) {
    const next = out ? `${out}, ${t.term}` : t.term;
    if (next.length + 1 > DICTATE_PROMPT_MAX_CHARS) break;
    out = next;
  }
  return out ? `${out}.` : "";
}

const LETTERS = "\\p{L}\\p{N}";
const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** A term whose casing is part of its identity: never an ordinary word. */
function isIdentifier(term: string): boolean {
  return term.length >= 3 && /^\S+$/.test(term) && (/\p{N}/u.test(term) || /\p{Lu}/u.test(term.slice(1)));
}

/**
 * The transcript with the person's terms put back.
 *
 * Longest pattern first, so `bee a three` wins over a shorter alias inside it.
 * Matched on whole words only (letters and digits either side end a match), so
 * a term is never rewritten out of the middle of a longer word.
 */
export function applyDictateTerms(text: string, terms: DictateTerm[]): string {
  if (!text || !terms.length) return text;
  const rules: { re: RegExp; term: string; keep: (m: string) => boolean; len: number }[] = [];
  for (const t of terms) {
    for (const h of t.heard) {
      const src = h.split(" ").map(escape).join("[\\s\\-]+");
      rules.push({ re: new RegExp(`(?<![${LETTERS}])${src}(?![${LETTERS}])`, "giu"), term: t.term, keep: () => false, len: h.length });
    }
    // The term itself, arriving split or re-cased. Only single words: a
    // multi-word term split on its own spaces is simply the term.
    if (/^\S+$/.test(t.term) && t.term.length >= 2 && t.term.length <= 16) {
      const chars = Array.from(t.term).map(escape);
      const src = chars.join("[\\s.\\-]?");
      const ident = isIdentifier(t.term);
      rules.push({
        re: new RegExp(`(?<![${LETTERS}])${src}(?![${LETTERS}])`, "giu"),
        term: t.term,
        // Unchanged, or only re-cased on a term that is an ordinary word: left.
        keep: (m) => m === t.term || (!/[\s.\-]/.test(m) && !ident),
        len: t.term.length,
      });
    }
  }
  rules.sort((a, b) => b.len - a.len);
  let out = text;
  for (const r of rules) {
    out = out.replace(r.re, (m) => (r.keep(m) ? m : r.term));
  }
  return out;
}

const bare = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();

/**
 * Whether a transcript is the prompt handed back.
 *
 * whisper, given a prompt and a clip with no speech in it, sometimes answers
 * with the prompt — the same family of artifact as its subtitle boilerplate,
 * and just as plausible-looking: a list of the person's own words. Refused as
 * "no speech" rather than pasted into the box as if it had been said.
 */
export function isPromptEcho(text: string, terms: DictateTerm[]): boolean {
  const prompt = bare(dictatePrompt(terms));
  return !!prompt && bare(text) === prompt;
}
