import type { ActivityRow } from "./activityTypes.ts";

// ── Triage: getting through eighty-four rows ────────────────────────────────
//
// Every row above is individually actionable, which is correct and which is
// also useless at the size this list actually reaches. The measured state of
// one real phone: 217 rows, 84 of them failed. The workflow that clears that
// is not "read 84 rows and press 84 buttons" — it is
//
//   1. read what never ran, in the user's own words;
//   2. decide, per row: still wanted, already done, or obsolete;
//   3. fire the survivors at the repo the row already knows.
//
// Step 2 is the hard one, and it is the only one an interface can genuinely
// help with. Three facts do almost all of the work, and all three are computed
// here rather than in the view, because they are what a bulk action is aimed at
// and a bulk action aimed at a mis-derived set is the most expensive mistake
// this app can make:
//
//   • **The same words, repeatedly.** The user's own report of the unresolved
//     sends is that they are "mostly repeated re-sends of the same few texts" —
//     which is exactly what a person does when the app tells them their prompt
//     did not run. Collapsing them turns eighty-four rows into a dozen
//     decisions.
//   • **The same words, but one copy RAN.** If a text also appears under
//     `done`, "already done" stops being a guess. This is the single most
//     useful thing on the screen and it is invisible without grouping.
//   • **Words that mean nothing out of context.** "Continue please", "Done?",
//     "/cost". They are not lost work, they are conversational debris, and
//     re-reading them is pure cost.

/**
 * The words a row can be grouped and re-sent by, normalized — or `null` when
 * the row is not words at all (a file, a build, a download).
 *
 * "Near-identical" is deliberately narrow: case, whitespace and a trailing full
 * stop or question mark, and nothing else. Anything cleverer (a similarity
 * score, an edit distance) would merge two prompts that differ by the one word
 * that mattered — and a merge here is not a display choice, it is a decision to
 * fire or file N things on one tap. Under-grouping costs a scroll;
 * over-grouping loses work.
 *
 * A give-up row's `fullText` is `null` by construction — its ledger kept only a
 * 200-character head — so the head is what groups. That is right for grouping
 * (repeated re-sends share their head) and it is why nothing here ever uses
 * this string to SEND: the words come from the row's own source, through the
 * action the row already offers.
 */
export function activityTextKey(row: ActivityRow): string | null {
  if (row.kind === "upload" || row.kind === "download" || row.kind === "build") return null;
  const raw = (row.fullText ?? row.title).trim();
  if (!raw) return null;
  const norm = raw.toLowerCase().replace(/\s+/g, " ").trim();
  // Stripping the trailing stop must not be able to empty the key: "??" is a
  // real (and very groupable) row, and returning `null` for it would say "this
  // row is not words at all", which is what a file says.
  return norm.replace(/[.!?…]+$/u, "").trim() || norm;
}

/**
 * Words that mean nothing away from the screen they were typed on.
 *
 * A curated list and two shapes, never a length heuristic on its own: "ship it"
 * and "fix the login redirect" are both short, and only one of them is debris.
 * The list is the phrases that are *replies* rather than *requests* — they name
 * no subject, so out of their conversation there is nothing left to act on.
 *
 * Being wrong here is cheap by construction: debris is hidden behind a toggle
 * that says how many it hid, and hiding is never deleting. It is off by
 * default, because a filter that silently removes rows from the screen you
 * opened to find a lost prompt would be the same failure this whole rework is
 * about.
 */
const DEBRIS_EXACT = new Set([
  "continue", "continue please", "please continue", "go on", "carry on", "keep going",
  "done", "finished", "did it work", "any progress", "progress", "status", "update",
  "try again", "again", "retry", "redo", "rerun", "run it again",
  "ok", "okay", "k", "yes", "yep", "yeah", "sure", "no", "nope", "n", "y",
  "thanks", "thank you", "ty", "hi", "hello", "test", "ping", "hmm",
  "next", "next step", "proceed", "go", "go ahead", "stop", "wait",
  "fix", "fix it", "fix this", "do it", "continue working", "and",
]);

/**
 * Is this row conversational debris?
 *
 * Three shapes: a phrase from the list above, a bare TUI slash command (`/cost`
 * opens a view — it is not work anybody wants replayed a week later), and a
 * single token of three characters or fewer ("?", "ok", "wat"). A string
 * containing a path, a newline or code is never debris however short, because
 * the one thing that makes a fragment recoverable is a subject in it.
 */
export function isActivityDebris(row: ActivityRow): boolean {
  const key = activityTextKey(row);
  if (!key) return false;
  if (row.clipped) return false;            // a head is not the whole message
  if (/[\n`/.]/.test(key.slice(1))) return false; // a path, a filename, code, a second line
  if (DEBRIS_EXACT.has(key)) return true;
  if (/^\/[a-z][\w-]*$/.test(key)) return true;
  const words = key.split(" ");
  return words.length === 1 && key.length <= 3;
}

/** How the filtered list is ordered before it is grouped. */
export type ActivitySort =
  /** `compareActivity`'s order: attention first. The default. */
  | "ranked"
  /** Oldest first — the triage order. The rows that have been unanswered
   *  longest are both the most likely to be obsolete and the ones a ranked list
   *  buries, which is how eighty-four of them accumulated in the first place. */
  | "oldest";

export function sortActivity(rows: readonly ActivityRow[], sort: ActivitySort): ActivityRow[] {
  if (sort === "ranked") return [...rows];
  return [...rows].sort((a, b) => a.at - b.at);
}

/**
 * One decision, however many rows it covers.
 *
 * `rows` are the rows in view that share their words; `elsewhere` counts the
 * ones with the same words that the current filter is NOT showing, split on the
 * only distinction that changes the decision — whether one of them ran.
 */
export interface ActivityGroup {
  /** React key. The text key when there is one, else the single row's key —
   *  which is why an ungroupable row is still a group of one rather than a
   *  second code path in the view. */
  key: string;
  /** In the order they were given; the first is what the collapsed group shows. */
  rows: ActivityRow[];
  /** Same words, outside this filter. `done > 0` is "you already ran this". */
  elsewhere: { done: number; other: number };
  /** Repos these words were written for, named, deduplicated, in row order.
   *  A group spanning three repos is three work items, and the confirm says so. */
  cwds: string[];
  oldestAt: number;
  newestAt: number;
}

/**
 * Collapse the visible list onto one group per distinct text.
 *
 * `all` is the whole ranked list and not the filtered one on purpose: the
 * "already ran once" fact lives in the `done` bucket, which is precisely the
 * chip a person triaging failures is not looking at. Grouping the visible rows
 * while COUNTING against everything is what makes that fact reachable without
 * mixing the two lists.
 *
 * With `group` off every row is its own group and `elsewhere` is still
 * computed, so the fact does not depend on a toggle nobody found.
 */
export function groupActivity(
  shown: readonly ActivityRow[],
  all: readonly ActivityRow[],
  opts: { group: boolean },
): ActivityGroup[] {
  const byText = new Map<string, ActivityRow[]>();
  for (const r of all) {
    const k = activityTextKey(r);
    if (!k) continue;
    const list = byText.get(k);
    if (list) list.push(r); else byText.set(k, [r]);
  }

  const groups: ActivityGroup[] = [];
  const at = new Map<string, ActivityGroup>();
  for (const r of shown) {
    const text = activityTextKey(r);
    const key = opts.group && text ? `t:${text}` : r.key;
    const existing = at.get(key);
    if (existing) {
      existing.rows.push(r);
      existing.oldestAt = Math.min(existing.oldestAt, r.at);
      existing.newestAt = Math.max(existing.newestAt, r.at);
      if (r.cwd && !existing.cwds.includes(r.cwd)) existing.cwds.push(r.cwd);
      continue;
    }
    const g: ActivityGroup = {
      key,
      rows: [r],
      elsewhere: { done: 0, other: 0 },
      cwds: r.cwd ? [r.cwd] : [],
      oldestAt: r.at,
      newestAt: r.at,
    };
    at.set(key, g);
    groups.push(g);
  }

  // `elsewhere` is computed against the group's OWN membership, so a row that
  // is in view is never also counted as being somewhere else.
  for (const g of groups) {
    const text = activityTextKey(g.rows[0]);
    if (!text) continue;
    const mine = new Set(g.rows.map((r) => r.key));
    for (const r of byText.get(text) ?? []) {
      if (mine.has(r.key)) continue;
      if (r.dismissedAt != null) continue;   // filed rows are not evidence of anything
      if (r.bucket === "done") g.elsewhere.done += 1;
      else g.elsewhere.other += 1;
    }
  }
  return groups;
}
