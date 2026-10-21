/**
 * The pure half of the CLI-health feature: the "did it get worse?" ordering,
 * and what the topbar chip's count filters to. Type-only imports, so
 * `logic.test.mjs` runs it under plain node.
 */
import type { HealthRollup, HealthVerdict } from "@waterplane/shared";
import type { CliHealthSource, InspectFacts } from "../../CliHealthSheet";

/**
 * How bad a CLI-health rollup is, for the "did it get worse?" comparison only.
 *
 * `unknown` ranks with `healthy` and that is the rule the rollup already
 * encodes: several signals are exercised rarely, so treating "not observed
 * today" as a step down would fire an alarm every quiet morning. This is an
 * ORDERING, not a verdict — the verdict is `signalVerdict`'s, in `@waterplane/shared`,
 * and nothing here re-derives it.
 */
export const CLI_RANK: Record<HealthVerdict, number> = { healthy: 0, unknown: 0, degraded: 1, broken: 2 };
export const cliRank = (v: HealthVerdict): number => CLI_RANK[v] ?? 0;

/**
 * Is `next` a WORSENING of the last verdict this page saw? The first frame of a
 * page (`prev == null`) sets the baseline silently: a cold start onto an
 * already-degraded CLI is exactly what the chip is for. `unknown` never counts
 * as a worsening — a badge that goes grey whenever a rarely-exercised signal
 * has not fired today is a badge that is always grey.
 */
export function worsened(prev: HealthVerdict | null, next: HealthVerdict): boolean {
  return prev != null && cliRank(next) > cliRank(prev);
}

/** Does the topbar chip draw at all? `unknown` and `healthy` render NOTHING. */
export function chipShown(r: HealthRollup | null): r is HealthRollup {
  return !!r && (r.verdict === "degraded" || r.verdict === "broken");
}

/** The chip's count is a FILTER: the verdicts its tap opens, never the whole board. */
export function chipVerdicts(r: Pick<HealthRollup, "broken" | "degraded">): HealthVerdict[] {
  const verdicts: HealthVerdict[] = [];
  if (r.broken.length > 0) verdicts.push("broken");
  if (r.degraded.length > 0) verdicts.push("degraded");
  return verdicts;
}

/** "2 broken · 1 degraded" — the split the chip's `title`/`aria-label` carry. */
export function chipSplit(r: Pick<HealthRollup, "broken" | "degraded">): string {
  return [
    r.broken.length > 0 ? `${r.broken.length} broken` : "",
    r.degraded.length > 0 ? `${r.degraded.length} degraded` : "",
  ].filter(Boolean).join(" · ");
}


/**
 * Signals whose captured sample is the CLI's usage-block notice. That text may
 * reach disk, the wire and the phone but never a PTY (`host/clihealth.ts`):
 * typed into a claude session it false-positives the detector it documents. So
 * the prompt points at the file instead of quoting it.
 */
const SAMPLE_NEVER_TYPED = new Set(["limit.reset"]);

/**
 * The prompt "inspect in a session" seeds: the row's facts plus where the
 * evidence lives on this desktop, so the session starts from the record and
 * the kept captures rather than from a description of a screenshot. A seed —
 * the person reads and edits it in the Send sheet before anything runs.
 */
export function inspectPrompt(f: InspectFacts, src: CliHealthSource): string {
  const lines = [
    `Inspect a ${f.verdict} CLI-health signal: \`${f.id}\` — ${f.name}.`,
    "",
    `claude ${f.version ?? "(version unknown)"}`,
    `The board says: ${f.sentence}`,
  ];
  if (f.via) lines.push(`Fell back to: ${f.via}`);
  if (f.stats) lines.push(`Counts: ${f.stats}`);
  if (f.sample && !SAMPLE_NEVER_TYPED.has(f.id)) {
    lines.push(`Last captured input (redacted${f.sampleAgo ? `, ${f.sampleAgo}` : ""}):`, "```", f.sample, "```");
  }
  const record = `${src.stateDir}/clihealth.json`;
  lines.push(
    "",
    "Where to look:",
    `- the record: ${record} — \`signals["${f.id}"]\`${f.sample && SAMPLE_NEVER_TYPED.has(f.id) ? " (its `sample` is a block notice: read it, never print it)" : ""}`,
    `- what this signal read when it WORKED on this CLI: ${src.stateDir}/clifixtures/${f.version ?? "<version>"}/`,
    `- the catalog: packages/shared/src/clihealth/healthcatalog.ts; the observation sites: grep \`"${f.id}"\` in packages/host/src`,
    "",
    "Load the `heuristics` skill first. Find why the primary rule missed on this CLI version: if the CLI changed, fix the reader and pin the new shape with a test (tools/harvestfixtures.mjs for the capture); if the misses are false alarms (a rule correctly declining), fix where the observation is recorded instead. Say which it was.",
  );
  return lines.join("\n");
}
