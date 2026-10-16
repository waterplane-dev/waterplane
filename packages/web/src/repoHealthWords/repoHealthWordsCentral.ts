// A slice of the repo-health words (../repoHealthWords.ts is the facade; docs/notes/webclient-architecture.md).
//
// A repo's say over ONE central reading (`central` in its committed
// health.json): disabled — still measured and drawn, out of the health index —
// or overridden — the index reads the repo's own command instead. Said ON the
// tile it changes, attributed to the repo (its `why` is the repo's sentence),
// never as this sheet's verdict on either.
import type { RepoHealthPlotCentral, RepoHealthVariant } from "@waterplane/shared";
import { seriesValueWords } from "./repoHealthWordsRank.ts";

export interface VariantWords {
  /** What the repo did to this reading, in one line. */
  lead: string;
  /** The repo's own reason, attributed — null where it is already in `lead`. */
  why: string | null;
  /** An override that printed no number on the latest day, in the run's own words. */
  absent: string | null;
}

/**
 * One tile's variant line. Disabled: `disabled here — <why>`. Override: `this
 * repo's own version — <means>; since <first day>`, the value the index reads
 * from it, and the repo's why. The engine's curve is not the repo's number, so
 * the override's own value is printed beside it rather than in its place.
 */
/** A sentence ends in its own stop: the repo's words are quoted as written. */
const stop = (t: string): string => (/[.!?]$/.test(t.trim()) ? t.trim() : `${t.trim()}.`);

export function variantWords(v: RepoHealthVariant): VariantWords {
  if (v.kind === "disabled") {
    return { lead: `Disabled here — ${stop(v.why)} Still measured; the health index leaves it out.`, why: null, absent: null };
  }
  const means = v.means.trim() ? ` — ${v.means.trim().replace(/[.]$/, "")}` : "";
  const since = v.since ? `; since ${v.since}` : "; not measured yet";
  const now = v.last != null ? ` The index reads ${seriesValueWords(v.last, v.unit)} from it, not the curve below.` : "";
  return {
    lead: `This repo's own version${means}${since}.${now}`,
    why: `The repo's reason: ${stop(v.why)}`,
    absent: v.absent ? `On the latest day it printed no number: ${stop(v.absent)}` : null,
  };
}

/** Whether a tile draws its curve: a disabled reading says so INSTEAD of a chart. */
export function variantHidesChart(v: RepoHealthVariant | undefined): boolean {
  return v?.kind === "disabled";
}

/**
 * The lines under the central heading when the repo has a `central` block:
 * the file, then each entry it ignored and why, one line each.
 */
export function centralFileLines(central: RepoHealthPlotCentral | null | undefined): string[] {
  if (!central) return [];
  return [
    `This repo's say over these readings is in ${central.file} — what it disables or overrides is said on the reading's own tile.`,
    ...(central.problems ?? []).map((p) => `Ignored in ${central.file}: ${stop(p)}`),
  ];
}
