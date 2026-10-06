// A slice of the repo-health words (../repoHealthWords.ts is the facade; docs/notes/webclient-architecture.md).
import { msWords } from "./repoHealthWordsStale.ts";

/**
 * The series holds rows measured under more than one definition.
 *
 * Said BEFORE anyone taps, because the tap will be refused: appending would put
 * rows measured under two definitions of one metric on a single plot, and
 * recomputing the old ones is the same rewrite with the evidence removed. Every
 * version is named with its row count — that is the whole evidence for the
 * refusal — and the remedy is quoted as something the reader runs at the
 * desktop, because it deletes the series and that is their call.
 * ONE old definition is refused too, so `current` is the ENGINE's version.
 */
export function mixedVersionWords(
  versions: readonly { version: string; rows: number }[] | null | undefined,
  current?: string | null,
  /** The re-cut line for THIS root and THIS engine, off the wire
   *  (`measure.recut`). Never composed here: the constant this replaced said
   *  a path right only in the engine's own checkout; the line starts with
   *  `rm`, which is why a wrong one may not be printed at all. */
  recut?: string | null,
): string | null {
  const list = versions ?? [];
  const stale = list.length === 1 && !!current && list[0].version !== current;
  if (list.length < 2 && !stale) return null;
  const named = list.map((v) => `${v.version}${v.version === current ? " (current)" : ""}: ${v.rows} row${v.rows === 1 ? "" : "s"}`).join(", ");
  const remedy = recut
    ? `To re-cut the whole history under the current definition, run this at the desktop: ${recut}`
    : "To re-cut the whole history under the current definition, ask the desktop for the command — " +
      "this engine did not print one, and the line that re-cuts a repo deletes a file, so a guess " +
      "written down here is not offered.";
  const what = stale
    ? `every row in the series was measured under ${list[0].version} (${list[0].rows} row${list[0].rows === 1 ? "" : "s"}), and the engine now measures under ${current}`
    : `the series holds rows measured under ${list.length} definitions of the same metric — ${named}`;
  return (
    `${what}. ` +
    `A refresh will refuse rather than put them on one plot, and nothing here rewrites the file. ${remedy}`
  );
}

export interface OutcomeInput {
  ok?: boolean;
  ms?: number;
  step?: string | null;
  /** `null` is "the summary could not be read", which is NOT 0 — 0 is the
   *  measurement that the series was already current. */
  added?: number | null;
  refused?: { code?: number | string; text?: string } | null;
  error?: string | null;
}

/**
 * What the last run did — the summary line above the tool's own words.
 *
 * A refusal is a ran-and-said-no, not a failure, and it is worded as one: the
 * tool's `refused.text` is printed verbatim underneath, never summarised. An
 * error carries the host's own sentence for the same reason a refusal does —
 * the paraphrase is where the file names go missing.
 */
export function outcomeWords(o: OutcomeInput): string {
  const took = o.ms != null ? ` after ${msWords(o.ms)}` : "";
  if (o.refused) {
    const code = o.refused.code != null ? ` (exit ${o.refused.code})` : "";
    return `the last run ran and declined to append${code}${took} — its own words below, in full.`;
  }
  if (o.ok === false) {
    const at = o.step ? ` at ${o.step}` : "";
    return `the last run stopped${at}${took}${o.error ? `: ${o.error}` : "."}`;
  }
  // `null` and 0 are opposite claims about the same run, and the difference is
  // the whole reason the wire carries a nullable number here.
  if (o.added == null) return `the last run finished${took}; its summary did not say how many rows it appended.`;
  if (o.added === 0) return `the last run added no rows${took} — the series already reached HEAD.`;
  return `the last run added ${o.added} row${o.added === 1 ? "" : "s"}${took}.`;
}

/** A run of the tool is out on the desktop right now. Its age, not a claim
 *  about whether it is progressing — the tool prints nothing until it appends. */
export function runningWords(run: { startedAt?: number; note?: string | null } | null | undefined, now: number): string | null {
  if (!run) return null;
  const since = run.startedAt != null ? ` — started ${Math.max(0, Math.round((now - run.startedAt) / 1000))} s ago` : "";
  const note = run.note ? `: ${run.note}` : "";
  return `a run is going on the desktop${since}${note}`;
}

/**
 * Where the desktop copy lives, as a SENTENCE and not a button.
 *
 * The tool also draws `.claude/outbox/repohealth.html`, and this sheet used to
 * carry an *open the drawn page* button down at the bottom. Every card on that
 * page is now on this screen — the tape, the file count, the dependencies, the
 * per-package split, and the numbers table that was the last one missing — so
 * the button sent a reader to a second surface to see what they were already
 * looking at. It is named here instead, in full, because the file is still
 * written and still worth opening on a screen with room to put the four cards
 * side by side.
 */
export function drawnPageWords(written: boolean): string {
  // Two sentences, because "the page exists and holds nothing extra" and "the
  // page has not been written" are different facts and the second one used to
  // be the only one this sheet could say. Claiming a file is there when the
  // html step never ran — or failed — is a pointer at nothing.
  return written
    ? "Everything above is also drawn to .claude/outbox/repohealth.html on the desktop, where the " +
      "cards fit side by side. Nothing on it is missing from this screen."
    : ".claude/outbox/repohealth.html is not written yet — a refresh draws it. It is the same cards " +
      "as above, laid out for a desktop; nothing on this screen is waiting on it.";
}
