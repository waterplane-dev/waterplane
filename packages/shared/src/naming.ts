/**
 * What a machine may call somebody else's words.
 *
 * ── Why this file exists ───────────────────────────────────────────────────
 *
 * A headline is the one string in this app that a MODEL writes FOR a person,
 * over words the person wrote themselves. Everything else a model produces here
 * either runs (a prompt), cites (evidence) or explains (a note); a headline sits
 * on top of a row in a list and is the thing a reader scans instead of the
 * sentence underneath it. That makes it the one string that can quietly replace
 * somebody's own writing in the only place they look.
 *
 * So three rules, and each is enforced here rather than asked for politely:
 *
 *   • **It never stands in for them.** `itemHeadline` is the ONE display rule
 *     for both ends: a title a person typed wins, always, and a derived headline
 *     is what a row falls back to. Two copies of that rule is two answers to
 *     "whose words are on this row".
 *   • **It never replaces a name they typed.** Every headline and every kind
 *     carries an AUTHOR (`NameAuthor`) and is stored with it or not at all — a
 *     title that cannot say who wrote it cannot say whether a person may be
 *     overwritten, so the pair travels together and is dropped together.
 *   • **It is never guessed.** `cleanCategory` knows four words and no
 *     synonyms: `"bugfix"` is `undefined`, never `chore`. A synonym table is a
 *     second vocabulary, and a second vocabulary is how "no kind" becomes
 *     "chore" for every row nobody looked at.
 *
 * And a fourth, which is the shape of the caps: a headline is a LABEL, so it is
 * CLIPPED rather than dropped for length — the opposite of `assess.ts`'s
 * prompts, which are dropped rather than cut, because half a title is still a
 * title and half an instruction is a different instruction.
 *
 * ── What is deliberately NOT here ──────────────────────────────────────────
 *
 * No filesystem, no clock, no host imports, and — deliberately — no import of
 * `assess.ts`, which imports THIS. The vocabulary has to be nameable by the
 * module that judges it, so it lives one level below it.
 */

import { typedName } from "./schedule.js";

// ── The vocabulary ───────────────────────────────────────────────────────────

/**
 * What KIND of thing one item is, in four words and no more.
 *
 * Four because the list is read as a filter on a phone, and a taxonomy a person
 * has to learn is a taxonomy they will not use. Absent is a real answer here:
 * it means NOBODY SAID, which is different from every one of these four.
 */
export type ItemCategory = "bug" | "feature" | "enhancement" | "chore";

export const ITEM_CATEGORIES: readonly ItemCategory[] = ["bug", "feature", "enhancement", "chore"];

/**
 * Who wrote the title or the kind on a row.
 *
 * `hand` is a person — the one value that makes a title un-overwritable, which
 * is the entire reason this field exists. `assess` is a verdict a person
 * applied; `name` is a naming run, whose whole job is titles.
 *
 * Stored with the value it describes and never separately: an author with no
 * value names nothing, and a value with no author is a title that cannot say
 * whether it may be replaced — both are dropped rather than defaulted, because
 * defaulting either way is a claim about who typed something.
 */
export type NameAuthor = "hand" | "assess" | "name";

export const NAME_AUTHORS: readonly NameAuthor[] = ["hand", "assess", "name"];

/**
 * A headline is a LABEL, so it is clipped, never dropped for length. 80 =
 * `cleanIntentRow`'s label cap, so the prompt and the store name one number.
 */
export const MAX_HEADLINE_CHARS = 80;

/**
 * How many refusal notes a naming document may produce.
 *
 * The same number as `MAX_ASSESS_NOTES`, for the same reason and kept here
 * rather than imported because `assess.ts` imports this module and a cycle over
 * one integer is not a trade worth making. It is nearly unreachable by
 * construction: the notes below are AGGREGATED — one per kind of drop, with a
 * count — so a run that mis-names two hundred rows produces four sentences, not
 * two hundred.
 */
export const MAX_NAMING_NOTES = 40;

/** The word a row shows when nothing said what kind of thing it is. Absent is
 *  an answer, and this is how that answer is spelled — never a fifth category,
 *  and never "chore". */
export const NO_CATEGORY_LABEL = "no kind";

// ── Cleaning one value ───────────────────────────────────────────────────────

/** One pair of wrapping quotes, in the shapes a model actually emits. */
const QUOTE_PAIRS: readonly [string, string][] = [
  ['"', '"'], ["'", "'"], ["“", "”"], ["‘", "’"], ["`", "`"],
];

/**
 * A title a model wrote about `text`, or nothing.
 *
 * Tolerant about shape — a quoted string, a trailing full stop, ragged
 * whitespace and a run-on past the cap are all cosmetics, and refusing a whole
 * naming run over punctuation just means the user pays for it twice. Strict
 * about ONE thing: a "title" that is merely the first words of its own item is
 * not a title.
 *
 * ── Why the test here is ONE-directional, and `typedName`'s is two ──────────
 *
 * `typedName` answers a different question: *is the string in the name slot a
 * name, or is it the derivation this app itself wrote there?* Both ends fill
 * that slot with `text.slice(0, sliceLen)` when nobody typed one, so it has to
 * refuse in both directions — the text starting with the name (the ordinary
 * case) AND the name starting with the text's own leading slice, which is what
 * a multi-line prompt shorter than the slice looks like.
 *
 * A HEADLINE has no such derivation behind it. Nothing in this app ever writes
 * one out of the prompt, so the only shape worth refusing is the one that means
 * *this is a truncation of the item*: `text` starts with the headline. Borrowing
 * the second clause refused a whole class of perfectly good titles — for any
 * prompt under 40 characters, EVERY title that opens with the whole prompt.
 * Text `dark mode`, title `dark mode toggle for settings`: dropped, and (before
 * `edit()` learned to say so) dropped in silence.
 *
 * Both sides are whitespace-collapsed before the comparison, because `s` above
 * already is: without it a prompt that wraps between two of its own opening
 * words would read as a different string and the truncation would go through.
 *
 * `text` may be empty — a build or a capture has no prose — and an empty text is
 * "there is nothing to be a truncation of", never "everything is one".
 */
export function cleanHeadline(raw: unknown, text: string): string | undefined {
  if (typeof raw !== "string") return undefined;
  let s = raw.trim().replace(/\s+/g, " ");
  for (const [open, close] of QUOTE_PAIRS) {
    if (s.length >= 2 && s.startsWith(open) && s.endsWith(close)) { s = s.slice(1, -1).trim(); break; }
  }
  // One trailing full stop, and only when it is alone: an ellipsis is a model
  // saying the title was cut off, and turning "…" into ".." would keep the
  // claim while making it look like a typo.
  if (s.endsWith(".") && !s.endsWith("..")) s = s.slice(0, -1).trim();
  if (!s) return undefined;
  if (s.length > MAX_HEADLINE_CHARS) s = s.slice(0, MAX_HEADLINE_CHARS).trim();
  const t = (text ?? "").trim().replace(/\s+/g, " ");
  if (t && t.startsWith(s)) return undefined;
  return s;
}

/**
 * **Why a title somebody typed was not written**, in one sentence.
 *
 * Here, beside the rule that refuses it, because the refusal and its wording
 * are the same fact: `cleanHeadline` returning `undefined` used to be a silent
 * drop — the editor closed, the row kept its old title, and the words a person
 * had just typed were gone with nothing on any screen about it. CLAUDE.md's
 * *never overwrite typed words with words nobody typed* has a quieter twin, and
 * this is it: never DROP typed words without saying so.
 *
 * It names what was refused, because a sentence about "the title" on a screen
 * with two of them is a sentence the reader has to guess at.
 */
export function headlineRefusedText(headline: string): string {
  return `"${headline.trim().replace(/\s+/g, " ").slice(0, MAX_HEADLINE_CHARS)}" is how this item already starts, so it would say the same words twice — the title you had was kept`;
}

/** The same, for a kind that is not one of the four. No synonym table here and
 *  none in the sentence: it says the four words rather than guessing which was
 *  meant (`cleanCategory`). */
export function categoryRefusedText(category: string): string {
  return `"${category.trim().slice(0, 40)}" is not one of ${ITEM_CATEGORIES.join("/")} — the kind was left as it was`;
}

/**
 * One of the four words, or nothing at all.
 *
 * Case and surrounding space are cosmetics. Everything else is refused: there
 * is no synonym table here and there must not be one, because the cost of a
 * wrong kind is a row filed under a heading its author never chose and would
 * never think to look under.
 */
export function cleanCategory(raw: unknown): ItemCategory | undefined {
  if (typeof raw !== "string") return undefined;
  const s = raw.trim().toLowerCase();
  return ITEM_CATEGORIES.find((c) => c === s);
}

/** Who wrote it — one of three, or nothing. Same posture as `cleanCategory`:
 *  an author this app does not know is not an author. */
export function cleanAuthor(raw: unknown): NameAuthor | undefined {
  if (typeof raw !== "string") return undefined;
  const s = raw.trim().toLowerCase();
  return NAME_AUTHORS.find((a) => a === s);
}

// ── Cleaning a whole document ────────────────────────────────────────────────

/** What a run concluded a row should be CALLED. Either half may be absent —
 *  a title with no kind and a kind with no title are both honest answers. */
export interface ItemName {
  headline?: string;
  category?: ItemCategory;
}

/**
 * One row of the document, as the caller knows it.
 *
 * A bare id is enough to accept a name; the `text` is what lets the prefix rule
 * run, and a caller that has the words should pass them — without them a
 * headline that is just the first line of its own item cannot be recognised as
 * one. `readonly string[]` is therefore still a valid argument, and a caller
 * that upgrades to objects loses nothing.
 */
export type NamingTarget = string | { id: string; text?: string };

/** The finished sentences, so both drops are worded once. `assess.ts` says the
 *  same two things about its own rows and must not word them differently. */
export function headlineDropNote(n: number): string {
  return `${n} headline(s) were only the first words of their item and were left off`;
}
export function categoryDropNote(n: number): string {
  return `${n} kind(s) were not one of ${ITEM_CATEGORIES.join("/")} and were left off`;
}

/**
 * Whatever a naming run wrote, plus the rows it was asked about, in — one name
 * per KNOWN row, out.
 *
 * `cleanAssessment`'s posture, for `cleanAssessment`'s reasons. Tolerant about
 * SHAPE: a bare array, `{items:[…]}` and `{rows:[…]}` are all the same
 * document, because the difference is the model's and the cost is the user's.
 * Strict about CLAIMS: a name for an id nobody asked about is dropped, and an
 * id named TWICE loses both names — two titles for one row say two things about
 * what it is, neither is trustworthy, and picking the first is picking at
 * random.
 *
 * The notes are AGGREGATED — one sentence per kind of drop, carrying the count.
 * A naming run touches every row in a repo, so one note per row would be a
 * scroll nobody reads, and the fact worth showing is "eleven of these were
 * thrown away", not which eleven.
 */
export function cleanNamingDoc(
  raw: unknown,
  ids: readonly NamingTarget[],
): { names: Record<string, ItemName>; notes: string[] } {
  const texts = new Map<string, string>();
  for (const t of ids) {
    if (typeof t === "string") { if (t) texts.set(t, ""); continue; }
    if (t && typeof t.id === "string" && t.id) texts.set(t.id, typeof t.text === "string" ? t.text : "");
  }

  const doc = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const arr = (v: unknown): Record<string, unknown>[] =>
    (Array.isArray(v) ? v : []).filter((x): x is Record<string, unknown> => !!x && typeof x === "object");
  const rows = Array.isArray(raw) ? arr(raw) : arr(doc.items).length ? arr(doc.items) : arr(doc.rows);

  const names: Record<string, ItemName> = {};
  const seen = new Set<string>();
  const duplicated = new Set<string>();
  let unknown = 0;
  let headlineDrops = 0;
  let categoryDrops = 0;

  for (const r of rows) {
    const id = typeof r.id === "string" ? r.id.trim() : "";
    if (!id) continue;
    if (!texts.has(id)) { unknown++; continue; }
    if (seen.has(id)) { duplicated.add(id); continue; }
    seen.add(id);

    const headline = cleanHeadline(r.headline ?? r.title, texts.get(id) ?? "");
    if (headline === undefined && typeof (r.headline ?? r.title) === "string") headlineDrops++;
    const category = cleanCategory(r.category ?? r.kind);
    if (category === undefined && typeof (r.category ?? r.kind) === "string") categoryDrops++;
    if (headline === undefined && category === undefined) continue;
    names[id] = { ...(headline !== undefined ? { headline } : {}), ...(category !== undefined ? { category } : {}) };
  }

  for (const id of duplicated) delete names[id];

  const notes: string[] = [];
  const note = (s: string): void => { if (notes.length < MAX_NAMING_NOTES) notes.push(s); };
  if (unknown) note(`${unknown} name(s) were for items that were not in the list and were dropped`);
  if (duplicated.size) note(`${duplicated.size} item(s) were named more than once, so neither name was used`);
  if (headlineDrops) note(headlineDropNote(headlineDrops));
  if (categoryDrops) note(categoryDropNote(categoryDrops));

  return { names, notes };
}

// ── Display ──────────────────────────────────────────────────────────────────

/**
 * **The ONE display rule**: what this row is CALLED, on both ends.
 *
 * A `label` is what a person typed, so it wins — but only when it is a name and
 * not a slice of the row's own prose, which is what `typedName` is for and what
 * the backlog's own 40-character derivation makes the common case. A `headline`
 * is the machine's, and stands only where a person put nothing.
 *
 * `null`, never the text, when neither: the caller decides whether a nameless
 * row shows its first line or shows nothing, and that decision differs by
 * screen. What must not differ by screen is which of the two strings wins.
 */
export function itemHeadline(it: { label?: string; text: string; headline?: string }): string | null {
  const typed = typedName(it.label, it.text, 40);
  if (typed) return typed;
  const machine = (it.headline ?? "").trim();
  return machine || null;
}

/**
 * The ONE place a kind becomes a word.
 *
 * The four words are their own labels today, which is exactly why this is a
 * function: `assessVerdictLabel`'s rule — when a heading is re-worded it has to
 * be re-worded once, and a `switch` is what makes the compiler say so when a
 * fifth kind appears.
 */
export function categoryLabel(c: ItemCategory): string {
  switch (c) {
    case "bug": return "bug";
    case "feature": return "feature";
    case "enhancement": return "enhancement";
    case "chore": return "chore";
  }
}

// ── The session tab's own title ──────────────────────────────────────────────

/**
 * How many words a tab title may be, and how many characters that is allowed to
 * cost.
 *
 * Four words, and the strip is sized for three tabs by default — the two
 * numbers moved together, because they are the same trade seen from each end:
 * how much of a name there is to read, and how much room there is to read it
 * in. The words are what the SESSION SCREEN shows in full when you open it
 * (`App.tsx`'s header), so the cap is set by what is worth having there rather
 * than by what fits a 90 px tab, which clips to its own width regardless.
 *
 * The character cap is the second half of the same fact — four words can still
 * be four long ones, and the cap is what stops one name from being the whole
 * strip. It is a REFUSAL boundary, not a clip: see below.
 */
export const MAX_TAB_WORDS = 4;
export const MAX_TAB_CHARS = 30;

/**
 * The ≤4-word title a model wrote for a session tab, or nothing.
 *
 * `cleanHeadline`'s tolerance about shape, with two differences that are both
 * about the strip this lands in:
 *
 *  - **Words are CUT, never joined with an ellipsis.** A tab is a label, and
 *    "fix the auth…" in 90 px reads as a truncation of something longer, which
 *    is exactly what it is not: the model was asked for four words and this
 *    keeps the first four it wrote.
 *  - **It refuses rather than guesses.** An empty answer, a refusal sentence
 *    ("I cannot"), or anything past the character cap once the words are cut,
 *    comes back `undefined` — and the tab then wears the repo and branch it
 *    always had. CLAUDE.md's rule for every heuristic here: degrade to absent,
 *    never to a wrong number, and a wrong TITLE is the version of that which a
 *    person taps.
 *
 * Deliberately not `cleanHeadline` with a smaller cap: that one clips mid-word
 * on purpose (a headline is prose and a cut word still reads), and it also
 * refuses a title that is how its own text starts — a rule about backlog rows
 * that has no meaning for a terminal session, which has no "text" to be a
 * truncation of.
 */
export function cleanTabTitle(raw: unknown): string | undefined {
  if (typeof raw !== "string") return undefined;
  let s = raw.trim().replace(/\s+/g, " ");
  for (const [open, close] of QUOTE_PAIRS) {
    if (s.length >= 2 && s.startsWith(open) && s.endsWith(close)) { s = s.slice(1, -1).trim(); break; }
  }
  // A trailing full stop on a two-word label is a model finishing a sentence it
  // was not asked for. An ellipsis is left alone for `cleanHeadline`'s reason —
  // but a title carrying one is a title the model says it cut, so it is refused
  // below rather than shown with the claim intact.
  if (s.endsWith(".") && !s.endsWith("..")) s = s.slice(0, -1).trim();
  if (!s || /[…]|\.\.\./.test(s)) return undefined;
  const words = s.split(" ").filter(Boolean).slice(0, MAX_TAB_WORDS);
  // Words come OFF THE END until the label fits, rather than the whole title
  // being refused for length: two of the three words is still a title, and the
  // model's first words are the ones it led with. Only a single word that is
  // longer than the strip has nothing left to drop, and that one is refused —
  // clipping it would put an ellipsis back on a label that is not prose.
  while (words.length > 1 && words.join(" ").length > MAX_TAB_CHARS) words.pop();
  s = words.join(" ");
  if (!s || s.length > MAX_TAB_CHARS) return undefined;
  return s;
}

// ── The branch a row does not need to say ────────────────────────────────────

/**
 * The branch names that mean "the ordinary place", and so say nothing.
 *
 * Two, and no pattern. `main` and `master` are the two names git itself
 * creates; anything else was CHOSEN, and a chosen name is information. A repo
 * whose default really is `develop` keeps seeing `develop` — which is the safe
 * direction for a guess about somebody else's repo: the failure mode of this
 * list is showing a word that could have been hidden, never hiding one that
 * had to be read.
 *
 * There is no default-branch field on the wire to ask instead: `RepoTarget`
 * carries the branch a worktree is ON, not the branch the repo considers home.
 */
export const DEFAULT_BRANCH_NAMES: readonly string[] = ["main", "master"];

/** Whether a branch name is one of the two git makes on its own. */
export function isDefaultBranch(raw: unknown): boolean {
  return typeof raw === "string" && DEFAULT_BRANCH_NAMES.includes(raw.trim().toLowerCase());
}

/**
 * What a row should SAY about the branch it is on — or nothing.
 *
 * `undefined` means "saying this adds nothing", and every caller falls back to
 * the repo's own name rather than drawing a blank. On a phone the session list
 * is one row of ~30 characters per session, and on a desktop where every repo
 * sits on `main` that word was the FIRST thing on every row, pushing the
 * derived name, the status tags and the age off the end of the line — the same
 * space that now carries what the session is actually about.
 *
 * **Only on the PRIMARY worktree.** A worktree's branch is its whole identity —
 * `RepoPicker` titles it with nothing else — so a worktree that happens to be
 * on `main` still says so, or the row loses the only thing that tells it from
 * its siblings. Pass `isPrimary: false` (or nothing) for those.
 *
 * This is display only. `GitView` and `BranchPicker` are ABOUT branches and
 * never call this: hiding the current branch on the screen you switch branches
 * from is not tidiness, it is a missing fact.
 */
export function branchLabel(r: { branch?: string; isPrimary?: boolean }): string | undefined {
  const b = (r.branch ?? "").trim();
  if (!b) return undefined;
  if (r.isPrimary && isDefaultBranch(b)) return undefined;
  return b;
}

/** "<repo> · <branch>", with the branch dropped when it says nothing. */
export function repoBranchLabel(r: { repoName: string; branch?: string; isPrimary?: boolean }): string {
  const b = branchLabel(r);
  return b ? `${r.repoName} · ${b}` : r.repoName;
}

/**
 * A STORED session title with a trailing default branch taken off.
 *
 * New sessions are named `repoBranchLabel`-style and never carry the word, but
 * a title is persisted with the session and every conversation opened before
 * this rule still reads `myapp · main`. Trimming at the point it is DRAWN fixes
 * those without rewriting anybody's stored title — including the ones a person
 * renamed by hand, where an edit would be exactly the overwrite this file
 * exists to refuse.
 *
 * Only the LAST segment, only when something is left in front of it: a session
 * somebody called `main` is called `main`.
 */
export function trimDefaultBranch(title: unknown): string {
  const t = typeof title === "string" ? title.trim() : "";
  const cut = t.lastIndexOf(" \u00b7 ");
  if (cut <= 0) return t;
  return isDefaultBranch(t.slice(cut + 3)) ? t.slice(0, cut) : t;
}

/**
 * **The desktop's own ≤4-word name for a session, or "".**
 *
 * `SessionInfo.tabTitle` is derived once per conversation by the host and is
 * the only string in this app that says what a session is ABOUT — `s.title` is
 * `<repo> · <branch>`, which four sessions open in one repo all share. The tab
 * strip wears the name, the session header wears it and the launcher row wears
 * it; every surface that asks *which session?* was still offering the repo
 * name four times and the answer never.
 *
 * One reader, here beside `branchLabel` and `trimDefaultBranch`, because it is
 * the same question those two answer: which part of a session's name a row has
 * to SAY. Trimmed, and "" when the host has derived nothing — never an invented
 * name, and never the repo wearing the derived name's clothes.
 */
export function sessionName(s: { tabTitle?: string }): string {
  return (s.tabTitle ?? "").trim();
}

/**
 * What a sentence calls a session it is WAITING on ("waiting for 'fix webkit
 * sync'") — the derived name, else the item it was opened for, else its first
 * prompt, and only then the title. Five hand sessions in one repo all wear
 * `myrepo` as their title, so "waiting for 'myrepo'" named none of them; the first
 * prompt is at least something a person recognises. Clipped by the sentence,
 * not here. `undefined` when there is nothing to say.
 */
export function waitedSessionName(s: { tabTitle?: string; title?: string; firstPrompt?: string }, itemLabel?: string): string | undefined {
  const firstLine = (t?: string) => (t ?? "").split("\n")[0]!.trim();
  return sessionName(s) || firstLine(itemLabel) || firstLine(s.firstPrompt) || trimDefaultBranch(s.title) || undefined;
}

/**
 * A session named where there is room for exactly one string — a `<select>`
 * option, a group head, a toast.
 *
 * Repo and branch FIRST, the derived name after: the first part is what tells
 * two sessions in different repos apart and the second is what tells two in
 * the SAME repo apart, and a picker read top to bottom needs them in that
 * order. A row with room for two spans draws them side by side instead
 * (`web/SessionName.tsx`), which is what the launcher does.
 */
export function sessionPickLabel(s: { title: string; tabTitle?: string }): string {
  const name = sessionName(s);
  return name ? `${s.title} · ${name}` : s.title;
}

// ── The commit message a model wrote for a working tree ──────────────────────

/**
 * How long a suggested commit message may be, subject and whole.
 *
 * The subject cap is a REFUSAL boundary, not a clip — same rule as
 * `cleanTabTitle`'s. A subject is the one line every `git log` shows, and
 * cutting one mid-thought produces a sentence nobody wrote; a model that came
 * back with a 200-character first line ignored its contract, and the honest
 * answer is to say so and leave the box alone.
 *
 * The WHOLE cap is a different kind of edge and is enforced differently: body
 * lines come OFF THE END until it fits, because a message's first paragraph is
 * the part that was asked for and the rest is elaboration. The subject alone is
 * never dropped — if it does not fit on its own, the message is refused.
 */
export const MAX_COMMIT_SUBJECT = 100;
export const MAX_COMMIT_CHARS = 1200;

/**
 * Lines a suggestion may never carry into a person's commit.
 *
 * The models this runs on have written a great many commits with a co-author
 * trailer and a "generated with" line, and they reproduce them unasked. On a
 * commit a PERSON is about to make from their phone, both are false claims
 * about who wrote the change — the model wrote the sentence describing it and
 * nothing else. Dropped silently rather than refused: the message around them
 * is usually fine, and a refusal here would read as the model having failed.
 */
const TRAILER_RE = /^(?:co-authored-by:|claude-session:|generated with|🤖)/i;

/** A model saying it will not answer, in the shapes it actually says it. */
const REFUSAL_RE = /^(?:i\s+(?:cannot|can't|am unable|won't|will not)\b|sorry\b|unable to\b)/i;

/**
 * The commit message a model wrote for a diff, or nothing.
 *
 * Tolerant about the wrapper a model puts around prose — a code fence, quotes
 * around the whole thing, `Subject:` labels, ragged blank lines — because those
 * are cosmetics and refusing over one means the call is paid for twice. Strict
 * about the two things that would put words nobody wrote into a commit: a
 * refusal sentence dressed as a message, and an attribution trailer.
 *
 * Degrades to `undefined`, never to something approximate. The caller then says
 * so and the box keeps whatever was typed in it — CLAUDE.md's rule that a draft
 * is the last copy of somebody's words, and a suggestion that could not be made
 * must never be a delete.
 */
export function cleanCommitMessage(raw: unknown): string | undefined {
  if (typeof raw !== "string") return undefined;
  let s = raw.replace(/\r\n?/g, "\n").trim();
  // A whole answer inside one fence — ```text … ``` — is the commonest wrapper.
  const fence = /^```[a-zA-Z]*\n([\s\S]*?)\n?```$/.exec(s);
  if (fence) s = fence[1].trim();
  for (const [open, close] of QUOTE_PAIRS) {
    if (s.length >= 2 && s.startsWith(open) && s.endsWith(close) && !s.slice(1, -1).includes("\n")) {
      s = s.slice(1, -1).trim();
      break;
    }
  }
  if (!s || REFUSAL_RE.test(s)) return undefined;
  const lines = s.split("\n")
    .map((l) => l.replace(/\s+$/, ""))
    .filter((l) => !TRAILER_RE.test(l.trim()));
  // `Subject:` / `Commit message:` on the first line is a label, not the words.
  if (lines.length) lines[0] = lines[0].replace(/^(?:subject|commit message|message)\s*:\s*/i, "").trim();
  while (lines.length && !lines[0].trim()) lines.shift();
  while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
  if (!lines.length) return undefined;
  const subject = lines[0].trim().replace(/\.$/, "");
  if (!subject || subject.length > MAX_COMMIT_SUBJECT) return undefined;
  lines[0] = subject;
  // A subject with a body needs the blank line between them — git reads the
  // second line as body otherwise and `%s` swallows the lot.
  if (lines.length > 1 && lines[1].trim()) lines.splice(1, 0, "");
  // Collapse runs of blank lines, which a model produces freely.
  const out: string[] = [];
  for (const l of lines) {
    if (!l.trim() && out.length && !out[out.length - 1].trim()) continue;
    out.push(l);
  }
  // Body lines come off the END until the whole fits. The subject never does.
  while (out.length > 1 && out.join("\n").length > MAX_COMMIT_CHARS) out.pop();
  while (out.length > 1 && !out[out.length - 1].trim()) out.pop();
  const text = out.join("\n").trim();
  if (!text || text.length > MAX_COMMIT_CHARS) return undefined;
  return text;
}
