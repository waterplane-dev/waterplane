// A slice of the repo-health words (../repoHealthWords.ts is the facade; docs/notes/webclient-architecture.md).
import { spanWords, nf } from "./repoHealthWordsFmt.ts";

/**
 * An engine can read this repo and nothing has been measured yet: the size of
 * the job, what happens if it does not finish, and what it costs in tokens.
 *
 * It used to say "about 20 seconds here" — a figure about ONE desktop reading
 * ONE repo of 175 commits, on a screen that now opens on repos of 1,329. Both
 * numbers ride the wire instead (`measure.commits`, `stepTimeoutMs`). A run
 * past the cap is not a loss: the engine appends as it walks, so the next tap
 * carries on. The token clause is not decoration — every other spender on this
 * screen has a cost gate, so silence about this one reads as something hidden.
 */
export function emptySeriesWords(commits?: number | null, stepTimeoutMs?: number | null): string {
  const job = commits != null && Number.isFinite(commits) && commits > 0
    ? `${nf(commits)} first-parent commit${commits === 1 ? "" : "s"}`
    : "every first-parent commit";
  const cap = stepTimeoutMs != null && Number.isFinite(stepTimeoutMs) && stepTimeoutMs > 0
    ? `this desktop's cap of ${spanWords(stepTimeoutMs)} on one step`
    : "this desktop's cap on one step";
  return (
    `Nothing has been measured yet. A first run walks ${job} in this repo. Rows are appended as it ` +
    `goes, so a run that hits ${cap} keeps every row it measured and the next tap carries on from ` +
    "there. It spends no tokens: git, regex and arithmetic, and the one module that can call a " +
    "model is not on this path."
  );
}

/** The engine ran and could not read this repo, in its own words. A failed
 *  read used to be a null series and silence — the picture of a repo nobody
 *  has measured yet, which wants the opposite thing from the reader. "not a
 *  git repository: …" is about the tree, and no tap on *build the series*
 *  answers it. Quoted whole: a paraphrase is where the path goes missing. */
export function readFailedWords(error: string): string {
  return (
    `The engine could not read this repo, and said: ${error} Nothing was measured, so there is ` +
    "nothing here to draw."
  );
}

/** What this region is, above everything in it. It used to end "measured by
 *  `tools/repohealth.mjs`" — a file twelve of the thirteen repos on this
 *  desktop do not have. One engine reads every tree now, and WHICH engine read
 *  this one is `engineLineWords` below, which can name either. */
export function seriesHeadWords(): string {
  return (
    "One row per first-parent commit: file sizes, escape hatches, co-change, untested modules, " +
    "the weight of the agent instructions. It spends no tokens."
  );
}

/**
 * Which engine measured this repo, and what it found the repo to be written
 * in.
 *
 * This is what makes an absence legible: a reader who sees duplication
 * reported absent has to see "kotlin" on the screen to know why, or the
 * missing number reads as a gap in the data rather than as a pack with no
 * parser for that language. The counts are the census's and are the
 * denominator of every such absence — the same sentence over 4 Kotlin files
 * and over 400 is two claims. Every part is separately absent, because an
 * older engine prints none of them; an EMPTY pack list is a measurement with
 * its own clause, and a null one is the engine not saying.
 */
export function engineLineWords(a: {
  kind?: "repo" | "bundled" | null;
  ownSkipped?: string | null; // why the repo's own copy was passed over (host's words)
  version?: string | null;
  packs?: readonly { name: string; files?: number | null }[] | null;
}): string | null {
  const bits: string[] = [];
  if (a.kind === "repo") bits.push("read by this repo's own copy of the engine");
  else if (a.kind === "bundled") bits.push(a.ownSkipped ? `read by this desktop's engine, because ${a.ownSkipped}` : "read by this desktop's engine, pointed at the worktree");
  if (a.version) bits.push(`version ${a.version}`);
  // **Nothing recognised, said in words** — the one reachable form of that
  // state, and it used to print `packs common 0` while the tiles beside it
  // said it properly. Read off the COUNTS, not off a pack's name: a pack with
  // extensions activates only on files ending in one, so an active pack the
  // census counted at 0 claims no extension at all — and the phone can tell
  // without holding a copy of which pack is the always-on one.
  const nothingRead = !!a.packs?.length && a.packs.every((p) => p.files === 0);
  if (a.packs) {
    const n = a.packs.length;
    const only = a.packs.map((p) => p.name).join(", ");
    if (!n) bits.push("the engine named no language pack for this tree");
    else if (nothingRead) bits.push(`no language pack reads this tree's source — ${only} ${n === 1 ? "is" : "are"} active and claim${n === 1 ? "s" : ""} no file extension`);
    else bits.push(`packs ${a.packs.map((p) => (p.files == null ? `${p.name} (no count)` : `${p.name} ${nf(p.files)}`)).join(", ")}`);
  }
  if (!bits.length) return null;
  // The counts want their owner named, or `common 0` reads as a pack that
  // found nothing rather than as the census counting that pack's own
  // extensions — of which the TODO-and-FIXME one has none. Not said where no
  // count was printed: a legend for figures that are not there.
  const census = a.packs?.length && !nothingRead
    ? " — the figure beside a pack is the extension census's count for it."
    : "";
  return `${bits.join(" · ")}${census}`;
}

/** What the refresh control is called. Two cases, because building a series
 *  from nothing and adding the commits since the last row are different
 *  promises about how long the tap takes. */
export function refreshLabel(series: { rows?: number } | null | undefined): string {
  return series && (series.rows ?? 0) > 0 ? "update the series" : "build the series";
}

/** The same control while a run of this phone's is out. The elapsed seconds are
 *  the point: a cold run is ~18 s, and a control that cannot say whether it is
 *  running is the defect `useRemoteResource`'s header describes, whether it
 *  spends that on a grey or on a spinner. */
export function refreshBusyLabel(series: { rows?: number } | null | undefined, elapsedMs: number): string {
  const verb = series && (series.rows ?? 0) > 0 ? "updating" : "building";
  return `${verb}… ${Math.max(0, Math.round(elapsedMs / 1000))} s`;
}
