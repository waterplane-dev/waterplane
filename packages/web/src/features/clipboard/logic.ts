/**
 * The clipboard sheets' pure half — no React, no DOM — so `logic.test.mjs`
 * runs it under `node --test`.
 */

/** What the Terminal-text sheet says when there is nothing to copy. The reader
 *  view unmounts the xterm, so with no cached transcript there is no source. */
export function emptyDumpText(hasSession: boolean): string {
  return hasSession
    ? "No text to copy yet.\n\nThe terminal is not on screen (reader view), and no transcript for this session is cached on this phone. Open the reader once while connected, then try again."
    : "No session on screen.";
}

/** "quote in compose": the picked text as a markdown quote with its lead-in,
 *  or null when there is nothing but whitespace to quote. */
export function quoteBlock(picked: string): string | null {
  const t = picked.trim();
  if (!t) return null;
  const indented = t.split("\n").map((l) => `> ${l}`).join("\n");
  return `Quote from your last response:\n${indented}\n\n`;
}

/** One thing on screen a person may want to answer: a numbered or bulleted
 *  item with its wrapped continuation rows joined back on. */
export interface DecisionItem {
  /** "4" for a numbered item, "" for a bullet or a plain picked line. */
  num: string;
  /** What the answer line names it by — the bold-ish lead before a colon
   *  ("Example scope"), else its first words. */
  label: string;
  /** The whole item, rows rejoined. */
  text: string;
  /** Quick answers read off the item's own question ("in 0.1, or after it?"). */
  options: string[];
}

const NUMBERED = /^(\s*)(\d{1,2})[.)]\s+(\S.*)$/;
const BULLET = /^(\s*)[-•*]\s+(\S.*)$/;
/** CLI furniture that is never an item: rules, the prompt line, status rows. */
const FURNITURE = /^\s*(?:[─━—_=-]{3,}|❯|>\s*$|\[[A-Z]+\]$)/;

function labelOf(text: string): string {
  const m = /^\*{0,2}([^:?]{2,40}?)\*{0,2}:\s/.exec(text);
  if (m) return m[1].trim();
  const words = text.split(/\s+/).slice(0, 5).join(" ");
  return words.length < text.length ? `${words.replace(/[,.;:]$/, "")}…` : words;
}

/** "X, or Y?" at the end of an item → ["X", "Y"], when each is short enough
 *  to be a button. Anything longer is left to typing: a guessed option that
 *  is half a sentence is worse than none. */
export function optionsOf(text: string): string[] {
  const body = text.replace(/^[^:?]{2,40}:\s/, "");
  // Sentences end at punctuation FOLLOWED BY SPACE — "0.1" is not a full stop.
  const q = body.split(/(?<=[.?!])\s+/).find((s) => s.endsWith("?"));
  if (!q) return [];
  const parts = q.slice(0, -1).split(/,?\s+or\s+/i).map((p) => p.trim().replace(/^(?:either|whether)\s+/i, "")).filter(Boolean);
  if (parts.length < 2 || parts.length > 3 || parts.some((p) => p.length > 28)) return [];
  return parts;
}

/**
 * The items a block of screen text asks about. Numbered items win (`1.` /
 * `1)`), bullets next; a row indented under an item is its wrapped tail. With
 * neither, every non-blank row is its own item — that is a set of PICKED
 * lines, and each one is what the person chose to answer.
 */
export function decisionItems(lines: readonly string[]): DecisionItem[] {
  const collect = (re: RegExp, numbered: boolean): DecisionItem[] => {
    const out: DecisionItem[] = [];
    let cur: { num: string; indent: number; parts: string[] } | null = null;
    const flush = () => {
      if (!cur) return;
      const text = cur.parts.join(" ");
      out.push({ num: cur.num, label: labelOf(text), text, options: optionsOf(text) });
      cur = null;
    };
    for (const raw of lines) {
      const m = re.exec(raw);
      if (m) {
        flush();
        cur = numbered
          ? { num: m[2], indent: m[1].length, parts: [m[3].trim()] }
          : { num: "", indent: m[1].length, parts: [m[2].trim()] };
        continue;
      }
      const lead = /^\s*/.exec(raw)![0].length;
      if (cur && raw.trim() && lead > cur.indent && !FURNITURE.test(raw)) cur.parts.push(raw.trim());
      else flush();
    }
    flush();
    return out;
  };
  const numbered = collect(NUMBERED, true);
  if (numbered.length) return numbered;
  const bullets = collect(BULLET, false);
  if (bullets.length) return bullets;
  return lines.map((l) => l.trim()).filter((l) => l && !FURNITURE.test(l))
    .map((text) => ({ num: "", label: labelOf(text), text, options: optionsOf(text) }));
}

/** The answers as the lines a person would have typed — "4. Example scope:
 *  both" — under one lead-in, skipping the unanswered. Null when nothing was
 *  answered. The label rides along because a screen often holds two lists
 *  that both have a 4. */
export function decisionBlock(items: readonly DecisionItem[], answers: readonly string[]): string | null {
  const rows = items.flatMap((it, i) => {
    const a = (answers[i] ?? "").trim();
    return a ? [`${it.num ? `${it.num}. ` : ""}${it.label}: ${a}`] : [];
  });
  return rows.length ? `My decisions:\n${rows.join("\n")}\n` : null;
}
