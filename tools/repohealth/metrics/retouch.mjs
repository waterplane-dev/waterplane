/**
 * Re-touch: the share of edits that are re-edits.
 *
 * ── What this measures and why it is the degradation signal ────────────────
 *
 * Lines of code, file count and hatch count all say how big the codebase is.
 * None of them says whether the work is landing. A file edited once and left
 * alone is a decision that held; a file edited again two days later is a
 * decision that did not. The share of touches that are re-touches is therefore
 * the cheapest available proxy for "is this repo converging", and it is the
 * one number here that gets WORSE as the author works harder, which is exactly
 * why it is worth plotting: every other metric in this series can be improved
 * by writing more code.
 *
 * The offenders list is the payload, not decoration. "42% of edits were
 * re-edits" is a number nobody acts on; "sessions.ts rewritten 9x in 14 days"
 * names the file to go and look at. So the top `RETOUCH_OFFENDERS` files are
 * carried by name, and they are the reason this returns a shape rather than a
 * scalar.
 *
 * ── Why the rate never travels alone ───────────────────────────────────────
 *
 * `touches` and `retouches` — the denominator and numerator the rate came
 * from — are returned beside it, because a bare proportion cannot say how
 * much it is standing on. 1.000 over 6 touches and 0.694 over 36 are
 * different claims, and a reader given only the first pair of digits has no
 * way to see that one of them is thin. This repo's narrative rule is that a
 * value is never reported without the number it is compared with, and here
 * that number is the denominator.
 *
 * It is also the deliberate alternative to a minimum-denominator cutoff. A
 * cutoff would delete the thin rows, which is a silent judgment made by a
 * threshold nobody pre-registered; carrying the denominator makes the row
 * self-describing instead — "1.00 of 6 touches" argues its own weight at the
 * point of reading, and costs no new constant.
 *
 * ── Which touches are counted ──────────────────────────────────────────────
 *
 * Source only, by the one definition of source — `source.mjs`'s `isSource`
 * against the extensions, excluded suffixes and test globs the active packs
 * contribute. Whatever that set is in the repo being measured, it is the same
 * set `size`, `hatches`, `dups` and `cochange` count.
 *
 * The `History` handed in stays unfiltered, and so does its `batch` flag.
 * **`batch` is defined on a commit's FULL file count and must never be
 * recomputed on the source subset**: a 160-file `git add` is one day of
 * unrelated work whether or not 160 of those files were TypeScript, and
 * re-deriving the flag from the filtered list silently drops this repo's 18
 * batch commits to 14 — four days of swept-up work would quietly start
 * counting as churn.
 *
 * The filter is here rather than in the caller because this number is read
 * next to `size`, `hatches` and `dups`, all of which count that same
 * population. Measured at HEAD, the difference is not cosmetic: unfiltered,
 * the top three offenders are `docs/notes/web.md` (29), `App.tsx` (27) and
 * `styles.css` (25), and the metric reports how often the notes get rewritten
 * — true, and a different question from the one this series asks.
 *
 * ── Why two clocks ─────────────────────────────────────────────────────────
 *
 * A touch counts as a re-touch when the previous touch of that same file was
 * within `RETOUCH_HOURS` **or** within `RETOUCH_COMMITS` commits. Either one
 * alone misreads this repo, and in opposite directions:
 *
 *   - Hours alone: 77 of these 157 commits landed in the final 16 days. Inside
 *     a burst like that, a whole sprint's worth of genuinely separate edits to
 *     one file all fall inside 48h and the rate saturates — it stops being a
 *     signal and becomes a measure of how fast the author was typing.
 *   - Commit distance alone: a fortnight-long gap with two commits in it makes
 *     the second commit a "re-edit" of the first. Distance says nothing about
 *     whether the author still had the thing in their head.
 *
 * Commit distance is the FIRST-PARENT distance between the two commits that
 * touched the file — `i - prevIndex` in `history.commits` — not the position
 * within that file's own touch sequence. The sequence reading is degenerate:
 * the immediately previous touch of a file is always the 1st previous touch of
 * that file, so every touch after the first would be a re-touch and the metric
 * would report a constant.
 *
 * Only the MOST RECENT prior touch is consulted, which is sound because both
 * clocks are monotone in it: any earlier touch is further away in both hours
 * and commits, so it cannot qualify when the nearest one does not.
 *
 * ── Why the commit clock has a ceiling ─────────────────────────────────────
 *
 * The clocks are OR'd, so an uncapped commit clock reaches straight across a
 * long silence: two commits a fortnight apart are still "within 2 commits" of
 * each other, and a clock that counts commits cannot see that nothing
 * happened in between. So it is ANDed with `RETOUCH_COMMITS_MAX_DAYS` — near
 * in commits counts only while it is also near in time. Its job is to catch a
 * re-edit inside one working burst that happens to straddle 48 hours, and a
 * burst that straddles two weeks is not a burst. Past the ceiling the hours
 * clock decides alone, and a window left with nothing to classify reports
 * absent rather than a rate.
 *
 * **The ceiling is a guard, not a correction.** Replayed over this history it
 * changes no row: of 499 classified pairs, 406 fire on the hours clock and
 * exactly 3 fire on the commit clock alone — all 3 inside the ceiling, none
 * beyond it. The commit clock is nearly inert here, which is the useful thing
 * to know about it: it is insurance against a work pattern this repo has not
 * had yet, and anyone reading the rate should understand it as "same file,
 * within two days" with a rounding allowance.
 *
 * ── What a row of exactly 1.000 means ──────────────────────────────────────
 *
 * Four rows here read 1.000 (2026-08-16, indices 37 to 40) and they are not a
 * defect — the first reading of them, that the commit clock had reached back
 * across the repo's 57-day silence to June, was wrong, and the measurement
 * says so: every prior touch involved is between **0.2 and 8.0 hours** old.
 * Those four commits are same-day follow-ups to the two large ones that
 * landed that morning ("Harden the origin guard", "Apply second-review
 * findings"), so every source file they touch really had been committed hours
 * earlier, by the hours clock, honestly. 1.000 is the true answer to the
 * question asked.
 *
 * It is a thin one: the denominators are 6 to 13 touches, because the two
 * commits that would otherwise fill that window are batches and are excluded.
 * A minimum-denominator rule would turn thin rows into absences, but there is
 * no pre-registered constant for one and inventing a threshold here — after
 * seeing which rows it would silence — is exactly the move `constants.mjs`
 * exists to prevent. The rows stand; the rank window is where a lone outlier
 * is supposed to be put in proportion.
 *
 * ── Why batch commits are excluded as the subject but kept as evidence ─────
 *
 * This is a shared working tree — several agent sessions edit it at once and
 * the day often ends in one `git add`. 102 of these 155 commits touch 1 to 10
 * files and eight touch over 100, three of those titled "Wip". A 160-file
 * commit is a day of unrelated work swept up by one command, not 160 files
 * being re-edited, so classifying its touches would turn this metric into a
 * measure of the author's commit habits. It is therefore removed from BOTH
 * numerator and denominator.
 *
 * Where exactly the line falls is `BATCH_FILES`'s problem, not this module's:
 * it is a pinned judgment, not a boundary anyone discovered in the data, and
 * nothing here re-derives or second-guesses it. The flag is read as the commit
 * recorded it.
 *
 * But those files really were edited that day. Dropping the batch commit from
 * history entirely would make the next real touch of one of its files look
 * like a first touch, which under-reports churn precisely where churn was
 * highest. So a batch commit still updates the "last touched" bookkeeping:
 * excluded as the commit being classified, kept as a prior touch
 * (`PREREG.RETOUCH_BATCH_AS_PRIOR`).
 *
 * ── Purity ─────────────────────────────────────────────────────────────────
 *
 * No git, no filesystem, no network, no model — the `History` handed in is the
 * whole world. Nothing is read past `index`: a row must mean the same thing
 * when it is recomputed years later, and it cannot if it can see its own
 * future. That is also what lets this be tested on six hand-built commits with
 * no repo present.
 */
// What counts as source is decided once — see source.mjs.
import { isSource } from "../source.mjs";

const SECONDS_PER_HOUR = 3600;
const SECONDS_PER_DAY = 86400;

/**
 * The source paths a commit touched. `history.touches` is the authority; the
 * copy on the commit is the fallback so a hand-built literal in a test can
 * carry either one and mean the same thing.
 */
function filesOf(history, commit, prereg) {
  const all = history.touches?.get(commit.sha) ?? commit.filesTouched ?? [];
  return all.filter((path) => isSource(path, prereg));
}

/**
 * Same two-sources rule for the batch flag. Read from the commit as it was
 * recorded, NEVER recomputed on the source-filtered list: batching is a
 * property of how the day was committed, not of how much of it was
 * TypeScript. Re-deriving it here takes this repo from 18 batch commits to
 * 14.
 */
function isBatch(history, commit) {
  return history.batch?.has(commit.sha) ?? commit.batch ?? false;
}

/** Count desc, then path asc — a total order, so the fixture can be compared. */
function byCountThenPath(a, b) {
  if (b[1] !== a[1]) return b[1] - a[1];
  return a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0;
}

/**
 * @param {import("../types.mjs").Snapshot} snapshot  Unused: this metric is
 *   entirely historical. Kept in the signature so every `measure*` has one.
 * @param {import("../types.mjs").History} history
 * @param {number} index  Position of the commit being measured in
 *   `history.commits` (first-parent, oldest first).
 * @param {import("../types.mjs").EffectivePrereg} prereg
 * @returns {import("../types.mjs").Measured<{rate: number, touches: number, retouches: number, offenders: {path: string, n: number}[]}>}
 *   `touches` is the classified denominator for the window and `retouches`
 *   the numerator, so `rate` can always be checked against what produced it.
 *   `types.mjs` declares the same four keys, with the argument for carrying
 *   the denominator rather than cutting thin rows.
 */
export function measureRetouch(snapshot, history, index, prereg) {
  const commits = history?.commits ?? [];
  const here = commits[index];
  if (!here) return { value: null, reason: "no commit at index " + index };
  // The first commit cannot contain a re-touch by construction. Reporting 0
  // there would be a claim ("nothing was re-edited") where the truth is that
  // the question has no answer yet.
  if (index === 0) return { value: null, reason: "no prior commit" };

  const windowStart = here.ts - prereg.RETOUCH_WINDOW_DAYS * SECONDS_PER_DAY;

  /** path -> index in `commits` of the most recent commit that touched it. */
  const lastTouch = new Map();
  /** path -> re-touches inside the window. */
  const offenders = new Map();
  let touches = 0;
  let retouches = 0;

  for (let i = 0; i <= index; i++) {
    const commit = commits[i];
    const batch = isBatch(history, commit);
    // `>=` so a window boundary landing exactly on a commit includes it, the
    // same convention the trailing window uses everywhere else.
    const inWindow = commit.ts >= windowStart;

    for (const path of filesOf(history, commit, prereg)) {
      const prev = lastTouch.get(path);

      if (inWindow && !batch) {
        touches++;
        if (prev !== undefined) {
          // Absolute difference: committer timestamps are not guaranteed
          // monotone along first-parent order, and a pair 3 minutes apart in
          // the wrong direction is still the same sitting.
          const hours = Math.abs(commit.ts - commits[prev].ts) / SECONDS_PER_HOUR;
          const distance = i - prev;
          // The commit clock is ANDed with its own ceiling: near in commits is
          // only evidence of one working burst while it is also near in time.
          const nearInCommits =
            distance <= prereg.RETOUCH_COMMITS &&
            hours <= prereg.RETOUCH_COMMITS_MAX_DAYS * 24;
          if (hours <= prereg.RETOUCH_HOURS || nearInCommits) {
            retouches++;
            offenders.set(path, (offenders.get(path) ?? 0) + 1);
          }
        }
      }

      // Bookkeeping runs for commits outside the window and, when the prereg
      // says so, for batch commits too: those files were edited that day even
      // though the commit is not evidence of churn on its own.
      if (batch && !prereg.RETOUCH_BATCH_AS_PRIOR) continue;
      lastTouch.set(path, i);
    }
  }

  if (touches === 0) {
    return {
      value: null,
      reason: "no non-batch source touches in the trailing " + prereg.RETOUCH_WINDOW_DAYS + "d",
    };
  }

  const top = [...offenders.entries()]
    .sort(byCountThenPath)
    .slice(0, prereg.RETOUCH_OFFENDERS)
    .map(([path, n]) => ({ path, n }));

  // Unrounded on purpose: `a / b` of two integers is the same double on every
  // machine, so the fixture reproduces exactly. Deciding how many digits a
  // human sees is the narrator's job, not the measurement's — and the two
  // integers travel with it so the narrator can say "of 36 touches" without
  // recomputing anything.
  //
  // Key order is fixed and load-bearing: the row is compared to a committed
  // fixture with deepEqual.
  return { value: { rate: retouches / touches, touches, retouches, offenders: top } };
}
