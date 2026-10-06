/**
 * The narrative, cut into its days — and put back together again.
 *
 * `tools/repohealth/narrate.mjs` writes `.claude/outbox/repohealth.md` one
 * section per day, oldest first (`mergeNarrative`), so the newest day is at
 * the BOTTOM of the file, which on a phone is the worst possible place for the
 * thing a person opened the sheet to read. Cutting it up is therefore the
 * sheet's first act, and it is the one piece of this screen that touches the
 * tool's own prose rather than writing prose of its own.
 *
 * ── Why it lives apart from the sentences ──────────────────────────────────
 *
 * `repoHealthWords.ts` is a file of SENTENCES, held to a word ban and read by
 * a person; this is a cutter, held to a round trip and read by nobody. Two
 * different properties, two different kinds of test, and the words file was
 * over its line cap with both in it.
 *
 * The round trip is the point. `joinNarrativeDays(splitNarrativeDays(text))`
 * is the same bytes, which is what makes "the sheet shows the tool's words,
 * all of them, unchanged" a property a test can check rather than a promise —
 * and a viewer that quietly drops a line of the tool's own words is the
 * failure this whole region is arranged against.
 */
export interface NarrativeDay {
  /** The heading's own text, e.g. `2026-09-21`. */
  day: string;
  /** Everything after the heading LINE, leading newline included, so a day and
   *  its heading can be re-joined byte for byte. */
  body: string;
}

export interface NarrativeSplit {
  /** Everything before the first `## ` heading. Empty when the text starts with
   *  one. The sheet folds this under a toggle: it is the tool's standing
   *  explanation of how to read a row, unchanged between runs. */
  preamble: string;
  /** In FILE order — oldest first, as the tool writes them. The sheet draws
   *  them newest first; reversing here would make the round trip a lie. */
  days: NarrativeDay[];
}

/**
 * Split the narrative into its days.
 *
 * The file is oldest-first and the newest day is at the BOTTOM, which on a phone
 * is the worst possible place for the thing a person opened the sheet to read.
 * Splitting is therefore the sheet's first act. It is pure and round-trips
 * (`joinNarrativeDays`) so that "the sheet shows the tool's words, all of them,
 * unchanged" is a property a test can check rather than a promise.
 */
export function splitNarrativeDays(text: string): NarrativeSplit {
  const chunks = text.split(/\n(?=## )/);
  const days: NarrativeDay[] = [];
  let preamble = "";
  chunks.forEach((chunk, i) => {
    if (i === 0 && !chunk.startsWith("## ")) { preamble = chunk; return; }
    const nl = chunk.indexOf("\n");
    const headline = nl === -1 ? chunk : chunk.slice(0, nl);
    days.push({ day: headline.slice(3).trim(), body: nl === -1 ? "" : chunk.slice(nl) });
  });
  return { preamble, days };
}

/** The inverse of `splitNarrativeDays`, byte for byte. Exists so the split can
 *  be pinned as lossless — a viewer that quietly drops a line of the tool's own
 *  words is the failure this whole module is arranged against. */
export function joinNarrativeDays(split: NarrativeSplit): string {
  const chunks = split.days.map((d) => `## ${d.day}${d.body}`);
  return (split.preamble ? [split.preamble, ...chunks] : chunks).join("\n");
}
