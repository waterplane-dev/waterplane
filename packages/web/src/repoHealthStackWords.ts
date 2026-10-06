/**
 * The captions under the magnitudes and the stacked charts.
 *
 * Split out of `repoHealthWords.ts` when that file reached this repo's 900-line
 * lint cap for the second time, and along the line the region itself already
 * draws: a TILE is a value read against its own past and carries a percentile,
 * and everything in here sits under something that is not a reading at all —
 * a size, a split of a whole, a distribution of one day. Same rules, though,
 * and the same test: no verdict word, no status colour, nothing that turns a
 * magnitude into a judgement about it.
 *
 * Pure strings and numbers, no DOM, so `node --test` runs it straight over the
 * TypeScript beside its siblings.
 */
/**
 * Grouped digits — a second copy of `repoHealthWords.ts`'s, and deliberately.
 *
 * Every words module in this region is imported by a `node --test` file
 * straight over the TypeScript, and node resolves `./repoHealthWords` to
 * nothing: a sibling import here costs the whole suite. So these modules carry
 * no local imports at all, and the price is this one four-line function. It is
 * `toLocaleString` over a rounded integer; drift would be visible in both
 * modules' tests on the same string.
 */
function nf(n: number): string {
  return Math.round(n).toLocaleString();
}

/**
 * What the magnitudes are, said once above them.
 *
 * The distinction this whole region turns on: a tile above is a value read
 * against its own past and carries a percentile; these are sizes read against
 * nothing and carry none. Without the sentence, a reader who has just learnt
 * that every number here has a rank will look for the missing one and take
 * its absence for a gap in the data rather than for the point.
 */
export function magnitudesNoteWords(): string {
  return (
    "These are sizes, not readings: nothing compares them to anything, which is why no percentile " +
    "and no direction appears beside them. They are what the percentiles above are percentiles OF " +
    "— a position in a window means nothing without a feel for the magnitude being positioned."
  );
}

/**
 * The source-group stack's caption.
 *
 * Says the two things the mark itself cannot: the top edge is the total (so
 * there is no separate total-lines curve to look for), and a colour belongs
 * to a group and not to a rank. **A band is a source GROUP, never a package**
 * — on this repo they include `tools`, `deploy` and `.`, and on a Flutter
 * tree not one of them is a package. The wire still calls the field
 * `packages`; what the reader is told they are looking at has to be true.
 */
export function packageStackWords(): string {
  return (
    "Lines of source per group, stacked, so the top edge is the whole tree — there is no separate " +
    "total to compare it against, because this IS it. A group is a top-level boundary the engine " +
    "derived from the tree, not necessarily a package. A colour follows a group and not its size, " +
    "so one overtaking another never swaps their bands. Past four groups the rest fold into one " +
    "band with no colour of its own, named in the legend."
  );
}

/** The stacked-weight chart's caption. The one chart here that prints a total,
 *  so it prints it as a split in the same mark. */
export function weightStackWords(): string {
  return (
    "Always-on weight over the series: CLAUDE.md and the skill descriptions, stacked, so the top edge " +
    "IS the total every turn of every session re-sends. Skill BODIES are on demand and are not in it. " +
    "A day where either half has no reading is a gap in both — a top edge short by an unknown amount " +
    "is the one mark a reader takes as the sum."
  );
}

/** The magnitudes fold's lead line: the two figures that give the rest a
 *  scale. Absent rather than zeroed when either was not read. */
export function magnitudeLeadWords(files: number | null, loc: number | null): string | null {
  if (files == null && loc == null) return null;
  const f = files != null ? `${nf(files)} source file${files === 1 ? "" : "s"}` : "an unread file count";
  const l = loc != null ? `${nf(loc)} lines` : "an unread line count";
  return `${f} · ${l}`;
}

/**
 * The tape's own numbers, as WORDS.
 *
 * Every other dashed mark in this app is a threshold, so drawing the p95 and
 * the longest file as rules over this distribution would say somebody chose
 * them. Nobody did: they are two readings of the same tape, and they belong in
 * the sentence under it.
 */
export function tapeWords(
  n: number,
  longest: number | null,
  p95: number | null,
  files: number | null,
  /** The longest file's own path, when the wire carries it. Named because
   *  "the longest file is 16,291 lines" is a number nobody can act on and
   *  "App.tsx is" is a file somebody can open — the same argument the tool's
   *  `size` metric makes for carrying `maxPath` beside `max` at all. */
  path?: string | null,
): string {
  const bits = [`the ${nf(n)} longest source files, biggest first`];
  if (longest != null) bits.push(`longest ${nf(longest)} lines${path ? ` — ${path}` : ""}`);
  if (p95 != null) bits.push(`p95 ${nf(p95)} lines`);
  // Against the file COUNT off the same reading, never against a cap written
  // down here: the tool decides how long the tape is, and a constant copied to
  // this side would keep answering after it changed.
  if (files != null && files > n) bits.push(`the other ${nf(files - n)} files in the tree are not in this row`);
  return `${bits.join(" \u00b7 ")}. Neither figure is drawn as a rule: a dashed line means a threshold on every other chart here, and nobody chose these.`;
}

/**
 * The line under the tape: the bar under the finger, or how to pick one.
 *
 * `path` null on a picked bar is its own sentence — the reading carried a
 * length and no name (an engine older than `tapePaths`), and a bar with a
 * blank where the name goes reads as a file with no name.
 */
export function tapePickWords(pick: { rank: number; lines: number; path: string | null } | null, named: boolean): string {
  if (!pick) return named ? "tap a bar to name its file" : "tap a bar for its length";
  const head = `#${nf(pick.rank)} \u00b7 ${nf(pick.lines)} lines`;
  if (pick.path) return `${head} \u00b7 ${pick.path}`;
  return `${head} \u00b7 this reading carries no file name — re-run the readings to get one`;
}

/** Production dependencies, and the clause that keeps the number from reading
 *  as every dependency this repo has. */
export function depsWords(deps: number | null): string | null {
  if (deps == null) return null;
  return `${nf(deps)} production dependenc${deps === 1 ? "y" : "ies"} across the manifests — dev dependencies are a separate count the series does not carry.`;
}

/**
 * The other cut of the same lines: by file TYPE rather than by where it lives.
 *
 * Both charts draw the identical total, and that is the point rather than a
 * duplication. A group says which part of the tree grew; a type says what grew
 * in it, and in a monorepo the two coincide often enough — one app, one
 * language — that a reader given only the first will answer the second from it
 * and be wrong the first time an app is half Kotlin.
 *
 * The extension is the unit, not the language: `.ts` and `.tsx` are one pack
 * and two different things to be looking at, and the pack each belongs to
 * travels beside it so the filter can still speak in languages.
 */
export function typeStackWords(): string {
  return (
    "Lines of source per file type, stacked, so the top edge is the whole tree — the same total the " +
    "chart above draws, cut by what the code IS rather than by where it lives. The extension is the " +
    "unit and the language pack that claims it is named beside it. A colour follows a type and not " +
    "its size, and past four types the rest fold into one band with no colour of its own."
  );
}

/**
 * What the filter is hiding, against the unfiltered whole.
 *
 * A stack whose top edge is no longer the tree is a chart that has silently
 * changed what it claims, so the count and the LINES both travel: `4 of 11`
 * says how much of the list is gone and `121,204 of 217,021 lines` says how
 * much of the tree went with it — which is the figure a reader is about to
 * read the top edge as.
 *
 * Null when nothing is filtered. The unfiltered chart already says what its
 * top edge is, and a permanent "11 of 11" beside it is a control that looks
 * like a state.
 */
export function typeFilterWords(shown: number, all: number, shownLoc: number | null, allLoc: number | null): string | null {
  if (shown >= all) return null;
  const lines = shownLoc != null && allLoc != null ? ` — ${nf(shownLoc)} of ${nf(allLoc)} lines` : "";
  return `${shown} of ${all} types${lines}. The top edge is those ${shown}, not the tree.`;
}

/** One type's chip: the extension, its pack, and its share on the latest day. */
export function typeChipWords(ext: string, pack: string | null, loc: number | null): string {
  const size = loc == null ? "" : ` · ${nf(loc)}`;
  return `${ext}${pack ? ` · ${pack}` : ""}${size}`;
}

/** The way back out of a filtered chart, named by what it restores. */
export const TYPE_FILTER_CLEAR = "every type";

/**
 * Why the section is not drawn at all.
 *
 * An engine older than the reading says nothing about types, and so does every
 * row written before it existed — which is every repo on this desktop until
 * its series is re-cut. That is not the same fact as a tree with no source in
 * it, which takes the whole magnitudes block down and is answered above; and a
 * chart that is simply not there reads as one that failed.
 *
 * It names the RE-CUT and not "the next run", because the next run of a
 * current engine over rows of an older definition is refused rather than
 * appended to — that is what the version string is for, and sending a reader
 * to press a button that will exit 3 is worse than saying nothing.
 */
export function typesAbsentWords(): string {
  return (
    "No per-type reading here — every row in this series was measured before the tool counted types. " +
    "It appears once the series is re-cut under the current definition; nothing above is affected."
  );
}

/**
 * The longest file's crosshair: the day, the length, WHICH file, the commit.
 *
 * The name is the point of this chart — a length on its own cannot say
 * whether the same file grew or another one took over — so a reading with no
 * name says that rather than leaving the slot out.
 */
export function longestPickWords(
  p: { day: string; sha7?: string; v: number | null } | null | undefined,
  path: string | null | undefined,
  named: boolean,
): string | null {
  if (!p) return null;
  const len = p.v == null || !Number.isFinite(p.v) ? "no reading that day" : `${nf(p.v)} lines`;
  const who = path ?? (named ? "no file named that day" : null);
  return `${p.day} · ${len}${who ? ` · ${who}` : ""}${p.sha7 ? ` · ${p.sha7}` : ""}`;
}

/** One legend row: the file, and the stretch of the series it held the crown. */
export function holderWords(
  h: { path: string; readings: number },
  firstDay: string | null | undefined,
  lastDay: string | null | undefined,
  total: number,
): string {
  const span = h.readings === total
    ? `longest on every one of the ${nf(total)} readings`
    : `longest on ${nf(h.readings)} of ${nf(total)} readings${firstDay && lastDay ? `, ${firstDay} to ${lastDay}` : ""}`;
  return `${h.path} — ${span}`;
}

/**
 * The caption under the longest-file chart.
 *
 * Says what a change of hue is, how many there were, and what an unnamed
 * stretch is — without calling the curve anything. Whether one file holding
 * a growing share of the tree matters is the reader's call; this says only
 * that it is the same file, or that it is not.
 */
export function longestCaptionWords(o: {
  handovers: number;
  folded: number;
  unnamed: boolean;
  named: boolean;
}): string {
  if (!o.named) {
    return (
      "The length of the single longest source file at each reading. This reading carries no file " +
      "names per day, so a new file taking the top spot cannot be told from the same one growing — " +
      "re-run the readings to get them."
    );
  }
  const bits = [
    "The length of the single longest source file at each reading, one hue per file.",
    o.handovers === 0
      ? `The same file held the top spot on every named reading.`
      : `The top spot changed hands ${o.handovers === 1 ? "once" : `${nf(o.handovers)} times`}; each change is a ring where the new file's line begins, joined to the old one by a thin step.`,
  ];
  if (o.folded > 0) {
    bits.push(`The ${nf(o.folded)} earliest holder${o.folded === 1 ? "" : "s"} share one ink line — four hues is the palette.`);
  }
  if (o.unnamed) bits.push("A stretch in ink with no legend entry is readings that carried a length and no name.");
  bits.push("Same axis rules as the tiles: fitted to its own low and high, by position, a missing day cuts the line.");
  return bits.join(" ");
}
