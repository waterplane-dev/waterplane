// healthindex/coverage: Which dimensions apply, which were measured, the repo's gates, and the caps both put on the headline. Barrel: ../healthindex.ts (read the header there).
/**
 * **An honest headline: coverage and gates.**
 *
 * picture-app — a fully vibe-coded app, 60k lines of Dart and 20k of Python —
 * read 100 (owner, 2026-11-09: "it can not be 100 good"). Two causes:
 *
 * 1. Each entry saturates at its good line, so clearing five size/hygiene
 *    lines reads 100. (More dimensions fix that; P2/P3/P6 add them.)
 * 2. The index scored what the packs COULD read and said nothing about the
 *    rest. The Dart pack has no test rule, so `untested` skipped all 391 Dart
 *    files and divided the Python/Kotlin leftovers by all 537: 12%, "good".
 *    It has no Dart escape-hatch patterns either, so hatches per kLOC counted
 *    TODOs over most of the code.
 *
 * ── The dimensions ─────────────────────────────────────────────────────────
 *
 * `HEALTH_DIMENSIONS` is every reading the index is meant to judge. Only the
 * ones with `scored: true` are APPLICABLE today — those are the index entries
 * (`HEALTH_ENTRIES`). The rest are named so a later package flips one on when
 * it adds the entry; until then they are not counted at all, neither as
 * measured nor as unknown (a dimension nobody scores is not a hole in THIS
 * repo's reading). `perLanguage` says the reading needs a pack that can read
 * the language; the others (file length, rework, CLAUDE.md, git history) read
 * any tree.
 *
 * ── Measured or unknown ────────────────────────────────────────────────────
 *
 * A per-language entry is UNKNOWN when the source files of languages whose
 * pack cannot read it are more than `HEALTH_COVERAGE_MAX_UNREAD` (a fifth) of
 * the source files. Under that it is measured, and the unread languages are
 * still named in a note. A fifth, because a TypeScript repo with a handful
 * of shell scripts must not lose its untested reading over them, while a
 * repo where most of the code was never opened must not get one. The row's
 * `reach` (engine `tools/repohealth/reach.mjs`) carries the pack facts; a row
 * from an engine before `reach` STATES no coverage — its entries are taken as
 * measured (as they always were) and the words say coverage was not recorded.
 *
 * An unknown entry is out of the mean, out of the worst-entry cap and out of
 * the alerts: its value is real but its denominator is not, and an average
 * that includes it would be a number about files nobody read.
 *
 * ── The coverage cap ───────────────────────────────────────────────────────
 *
 * `headline ≤ 100 · measured / applicable`. Arguments:
 *
 * - An unknown dimension could score anywhere from very bad to 100. The
 *   score over the measured part alone is therefore an UPPER bound on what
 *   could be claimed, and showing it as the headline claims the unread part
 *   is perfect. The cap credits an unknown dimension with nothing: the
 *   headline vouches for at most the share of the basket that was read.
 * - It is monotone and sayable: "capped at 60, 3 of 5 dimensions measured".
 *   A range (low–high) was the alternative; its lower end is always near 0
 *   under the worst-entry cap, so it says nothing a person can act on, and
 *   it does not fit a ring or a chip.
 * - It never raises a score: a fully measured repo is unaffected, and the
 *   score over the measured part still binds when it is lower.
 *
 * ── Gates ──────────────────────────────────────────────────────────────────
 *
 * A gate is one of the repo's OWN readings (`health.json`, engine `own.mjs`)
 * that the repo marked critical: `gate: { fails: "below" | "above", at }`.
 * A gate can only LOWER the headline, never raise it: a passing gate is not
 * counted in the coverage cap at all (declaring easy gates would otherwise
 * dilute the unread code: 3 of 5 → 6 of 8), a gate with no reading (or a
 * refused declaration) is UNKNOWN — one more applicable dimension nobody
 * measured, never passed — and an entry the repo overrode with its own
 * whole-repo command (`central.override`) is measured by that command. A FAILING gate caps the headline at `HEALTH_GATE_CAP` (49): just
 * under the alert warn line, so a repo failing a line it called critical
 * never reads as healthy, whatever the averages say — the same idea as the
 * worst-entry cap, at a fixed height because a gate is pass/fail with no
 * score to add 30 to.
 *
 * `healthHeadlineWords` is the ONE wording of all three caps and the coverage
 * line; the phone card and the VS Code Health view (the same chart) both call
 * it, as does the launcher chip's title.
 */
import { centralOf } from "./readings.js";
import { type HealthEntry, HEALTH_ENTRIES, HEALTH_OPTIONAL_ENTRIES, HEALTH_ALERT_WARN, HEALTH_SCORE_CAP_GAP, type HealthSeriesRow } from "./types.js";

/** Every dimension the index is meant to judge. Order = the order words list them. */
export const HEALTH_DIMENSIONS = [
  "size", "retouch", "hatches", "context", "untested",
  "dups", "deadExports", "cycles", "cochange", "fixAfterChange", "testsWithCode", "analyzer", "vulnDeps",
] as const;
export type HealthDimension = (typeof HEALTH_DIMENSIONS)[number];

export interface HealthDimensionDef {
  /** Plain words, as a coverage line names it. */
  label: string;
  /** In the index today (an entry of `HEALTH_ENTRIES`). False = named, not counted. */
  scored: boolean;
  /** Needs a pack that reads the language (`reach.packs[].reads`). */
  perLanguage: boolean;
}

/**
 * The dimension table. A package that adds an index entry flips `scored` and,
 * for a per-language one, teaches `tools/repohealth/reach.mjs` which packs
 * read it. A test pins `scored` ⇔ membership of `HEALTH_ENTRIES`.
 */
export const HEALTH_DIMENSION_DEFS: Record<HealthDimension, HealthDimensionDef> = {
  size: { label: "file length", scored: true, perLanguage: false },
  retouch: { label: "re-touches", scored: true, perLanguage: false },
  hatches: { label: "escape hatches", scored: true, perLanguage: true },
  context: { label: "CLAUDE.md + skill descriptions", scored: true, perLanguage: false },
  untested: { label: "untested modules", scored: true, perLanguage: true },
  dups: { label: "duplicate code", scored: true, perLanguage: true },
  deadExports: { label: "dead exports", scored: true, perLanguage: true },
  cycles: { label: "import cycles", scored: true, perLanguage: true },
  cochange: { label: "files that change together", scored: true, perLanguage: false },
  fixAfterChange: { label: "fixes after a change", scored: true, perLanguage: false },
  testsWithCode: { label: "tests changed with code", scored: true, perLanguage: false },
  analyzer: { label: "analyzer findings", scored: false, perLanguage: true },
  vulnDeps: { label: "vulnerable dependencies", scored: false, perLanguage: false },
};

/** A per-language entry is unknown when languages that cannot read it hold MORE than this share of source files. */
export const HEALTH_COVERAGE_MAX_UNREAD = 0.2;
/** The headline with a failing gate is at most this: one under the alert warn line. */
export const HEALTH_GATE_CAP = HEALTH_ALERT_WARN - 1;

/** One applicable dimension (an entry or a gate) and whether it was measured. */
export interface HealthCoverageItem {
  /** The dimension id, or `gate:<key>` for a repo gate. */
  key: string;
  kind: "entry" | "gate";
  label: string;
  state: "measured" | "unknown";
  /** Why it is unknown (always set then), or a note on a measured entry with an unread minority. */
  reason?: string;
}

/** One gate the repo declared, judged on this row. */
export interface HealthGate {
  key: string;
  name: string;
  unit: string;
  /** Absent where the declaration was refused. */
  fails?: "below" | "above";
  at?: number;
  value: number | null;
  state: "pass" | "fail" | "unknown";
  /** Why an unknown gate is unknown; absent on a pass or fail. */
  why?: string;
  /** One sentence, phone and VS Code alike. */
  text: string;
}

export interface HealthCoverage {
  /** Index entries read. Gates never add to it: a passing gate cannot raise the cap. */
  measured: number;
  /** Index entries that apply, plus each UNKNOWN gate (a gate with no reading is unmeasured, never passed). */
  applicable: number;
  /** Whether the row said which languages each reading covers (engine `reach`); false = an older engine. */
  reach: boolean;
  items: HealthCoverageItem[];
  gates: HealthGate[];
  /** What was measured, as a fingerprint: a change of it marks the week a gap (the basket moved). */
  key: string;
}

const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const isEntry = (k: string): k is HealthEntry => (HEALTH_ENTRIES as readonly string[]).includes(k);

/** `A`, `A and B`, `A, B and C`. */
const listWords = (xs: readonly string[]): string =>
  xs.length <= 1 ? (xs[0] ?? "") : `${xs.slice(0, -1).join(", ")} and ${xs[xs.length - 1]}`;
const commas = (n: number): string => Math.round(n).toLocaleString("en-US");
const LANG: Record<string, string> = {
  typescript: "TypeScript", python: "Python", dart: "Dart", kotlin: "Kotlin", c: "C", shell: "shell",
};
const langName = (n: string): string => LANG[n] ?? n;

/** The row's `reach` packs, parsed field by field; null where the row carries none (an older engine). */
export function healthReachOf(row: HealthSeriesRow): { name: string; files: number; reads: string[] }[] | null {
  const v = (row as { reach?: { value?: { packs?: unknown } | null } | null }).reach?.value;
  if (!v || !Array.isArray(v.packs)) return null;
  const out: { name: string; files: number; reads: string[] }[] = [];
  for (const p of v.packs as unknown[]) {
    const o = p as { name?: unknown; files?: unknown; reads?: unknown } | null;
    if (!o || typeof o.name !== "string" || !isNum(o.files) || o.files < 0 || !Array.isArray(o.reads)) return null;
    out.push({ name: o.name, files: o.files, reads: o.reads.filter((r): r is string => typeof r === "string") });
  }
  return out;
}

/** Why an unread dimension is unread, per dimension, in words. */
function unreadWhy(dim: HealthDimension, langs: string): string {
  if (dim === "untested") return `no rule for how a ${langs} test names a module`;
  if (dim === "hatches") return `no ${langs} escape-hatch patterns, only TODO/FIXME counted`;
  if (dim === "dups" || dim === "deadExports") return `no ${langs} parser`;
  if (dim === "cycles") return `no ${langs} import-graph rule`;
  return `no ${langs} reader`;
}

function fmtGate(v: number, unit: string): string {
  const r = Math.abs(v) >= 100 ? Math.round(v) : Math.round(v * 10) / 10;
  return `${r.toLocaleString("en-US")}${unit ? (unit === "%" ? "%" : ` ${unit}`) : ""}`;
}

/**
 * The repo's gates on this row (`row.own.readings[].gate`), judged. [] where the
 * row carries no `own`. A declaration that exists but could not be read in
 * full is never a pass: a refused file is one UNKNOWN gate (we cannot know
 * what it declared), each dropped entry that asked for a gate (`unreadGates`)
 * is another, and a row measured with the repo's commands unapproved
 * (`own.notRun`, `own.gates`) carries each declared gate with no value.
 */
export function healthGatesOf(row: HealthSeriesRow): HealthGate[] {
  const own = (row as { own?: { readings?: unknown; gates?: unknown; refused?: unknown; unreadGates?: unknown } | null }).own;
  if (!own || typeof own !== "object") return [];
  const out: HealthGate[] = [];
  if (typeof own.refused === "string") {
    out.push({ key: "declaration", name: "health.json", unit: "", value: null, state: "unknown", why: own.refused, text: `The repo's gates are unknown: ${own.refused}.` });
    return out;
  }
  const list = Array.isArray(own.readings) ? own.readings : Array.isArray(own.gates) ? own.gates : [];
  if (isNum(own.unreadGates) && own.unreadGates > 0) {
    const n = Math.floor(own.unreadGates);
    const why = `${n} declared ${n === 1 ? "gate has" : "gates have"} no usable key and could not be read`;
    out.push({ key: "unreadGates", name: "unreadable entries", unit: "", value: null, state: "unknown", why, text: `Gates are unknown: ${why}.` });
  }
  for (const raw of list as unknown[]) {
    const r = raw as { key?: unknown; name?: unknown; unit?: unknown; value?: unknown; reason?: unknown; gate?: unknown } | null;
    if (!r || typeof r.key !== "string" || r.gate === undefined || r.gate === null) continue;
    const name = typeof r.name === "string" && r.name ? r.name : r.key;
    const unit = typeof r.unit === "string" ? r.unit : "";
    const g = r.gate as { fails?: unknown; at?: unknown; invalid?: unknown };
    const value = isNum(r.value) ? r.value : null;
    const reason = typeof r.reason === "string" && r.reason ? r.reason : null;
    if (typeof g !== "object" || (g.fails !== "below" && g.fails !== "above") || !isNum(g.at)) {
      const why = typeof g?.invalid === "string" ? g.invalid : "the gate's declaration could not be read";
      out.push({ key: r.key, name, unit, value, state: "unknown", why, text: `Gate "${name}" is unknown: ${why}.` });
      continue;
    }
    const fails = g.fails;
    const at = g.at;
    const need = `${fails === "below" ? "at least" : "at most"} ${fmtGate(at, unit)}`;
    if (value === null) {
      const why = `no reading${reason ? ` (${reason})` : ""}`;
      out.push({ key: r.key, name, unit, fails, at, value, state: "unknown", why, text: `Gate "${name}" is unknown: ${why}; it needs ${need}.` });
      continue;
    }
    const failing = fails === "below" ? value < at : value > at;
    out.push({
      key: r.key, name, unit, fails, at, value, state: failing ? "fail" : "pass",
      text: failing
        ? `Gate "${name}" fails: ${fmtGate(value, unit)}, the repo requires ${need}.`
        : `Gate "${name}" passes: ${fmtGate(value, unit)}, needs ${need}.`,
    });
  }
  return out;
}

/**
 * What applies to this row and what was measured. `enabled` are the index
 * entries the repo has not disabled; a core entry absent from the row is not
 * this function's business (the week has no score then). `absent` names the
 * OPTIONAL entries the row could not read (`readings.ts`), each with the
 * engine's reason: those are unknown whatever the packs could read.
 *
 * A per-language entry whose value IS on the row while no pack in `reach`
 * lists it was measured by an engine whose `reach` predates the entry (P2
 * added `dups`/`deadExports`/`cycles` to `reach.mjs`): measured, with a note
 * that its language coverage was not recorded — the P1 rule for a row with no
 * `reach` at all, applied per dimension. Never unknown for that alone: the
 * engine only writes a value when some pack read the files.
 */
export function healthCoverage(row: HealthSeriesRow, enabled: readonly HealthEntry[], absent: Partial<Record<HealthEntry, string>> = {}): HealthCoverage {
  const packs = healthReachOf(row);
  // An entry the repo replaced with its own whole-repo command is measured by
  // that command, whatever the packs can read (`readings.ts` uses its number).
  const overridden = centralOf(row).overridden;
  const total = packs ? packs.reduce((s, p) => s + p.files, 0) : 0;
  const items: HealthCoverageItem[] = [];
  for (const dim of HEALTH_DIMENSIONS) {
    const def = HEALTH_DIMENSION_DEFS[dim];
    if (!def.scored || !isEntry(dim) || !enabled.includes(dim)) continue;
    const item: HealthCoverageItem = { key: dim, kind: "entry", label: def.label, state: "measured" };
    const why = absent[dim];
    if (why) {
      item.state = "unknown";
      item.reason = why;
    } else if (def.perLanguage && HEALTH_OPTIONAL_ENTRIES.includes(dim) && packs && total > 0 && !overridden.includes(dim) && !packs.some((p) => p.reads.includes(dim))) {
      item.reason = "which languages it covers was not recorded by the engine that measured this week";
    } else if (def.perLanguage && packs && total > 0 && !overridden.includes(dim)) {
      // Biggest unread language first: the one the absence is mostly about.
      const unread = packs.filter((p) => p.files > 0 && !p.reads.includes(dim)).sort((a, b) => b.files - a.files);
      const n = unread.reduce((s, p) => s + p.files, 0);
      if (n > 0) {
        const langs = listWords(unread.map((p) => langName(p.name)));
        const why = `${unreadWhy(dim, langs)} (${commas(n)} of ${commas(total)} source files)`;
        if (n / total > HEALTH_COVERAGE_MAX_UNREAD) item.state = "unknown";
        item.reason = why;
      }
    }
    items.push(item);
  }
  const gates = healthGatesOf(row);
  for (const g of gates) {
    items.push({
      key: `gate:${g.key}`, kind: "gate", label: `gate "${g.name}"`,
      state: g.state === "unknown" ? "unknown" : "measured",
      ...(g.why ? { reason: g.why } : {}),
    });
  }
  // Gates only ever LOWER the cap: a passing gate is neither measured nor
  // applicable here (declaring easy gates must not dilute unread code), a
  // failing one caps at 49 (`healthHeadline`), an unknown one is an
  // applicable dimension nobody measured.
  const measured = items.filter((i) => i.kind === "entry" && i.state === "measured").length;
  const applicable = items.filter((i) => i.kind === "entry" || i.state === "unknown").length;
  const key = [
    ...items.map((i) => `${i.key}=${i.state === "measured" ? "m" : "u"}`),
    ...gates.map((g) => `${g.key}:${g.fails ?? "?"}${g.at ?? ""}`),
  ].join(",");
  return { measured, applicable, reach: packs !== null, items, gates, key };
}

/** The coverage cap: `100 · measured / applicable`; 100 when everything (or nothing) applicable was read. */
export function healthCoverageCap(c: Pick<HealthCoverage, "measured" | "applicable">): number {
  return c.applicable > 0 ? (100 * c.measured) / c.applicable : 100;
}

/** Which cap set the headline. */
export type HealthCapKind = "worst" | "coverage" | "gate";

/**
 * The headline from its parts: `min(mean, worst + 30, coverage cap, gate cap)`.
 * `capKind` is the cap that set it (null when the mean did); on a tie the
 * gate is named first, then coverage — the cap the repo can do the most about
 * by itself, then the one the engine owes it.
 */
export function healthHeadline(mean: number, worst: number, coverage: HealthCoverage | null): { index: number; capKind: HealthCapKind | null } {
  const caps: [HealthCapKind, number][] = [];
  if (coverage?.gates.some((g) => g.state === "fail")) caps.push(["gate", HEALTH_GATE_CAP]);
  if (coverage) caps.push(["coverage", healthCoverageCap(coverage)]);
  caps.push(["worst", worst + HEALTH_SCORE_CAP_GAP]);
  let index = mean;
  let capKind: HealthCapKind | null = null;
  for (const [k, v] of caps) {
    if (v < index - 1e-9) { index = v; capKind = k; }
  }
  return { index, capKind };
}

/** What `healthHeadlineWords` reads — a point, or the wire summary. */
export interface HealthHeadlineSubject {
  value: number;
  mean: number;
  cappedBy: HealthEntry | null;
  capKind?: HealthCapKind | null;
  coverage?: HealthCoverage | null;
}

export interface HealthHeadlineWords {
  /** The cap that set the number, said once; null when the mean did (or the host did not say). */
  cap: string | null;
  /** `3 of 5 dimensions measured. Unknown: …`; null where everything was measured (and recorded as such) or the host sent no coverage. */
  coverage: string | null;
  /** Measured entries with an unread minority, one sentence; null where none. */
  notes: string | null;
  /** Every failing or unknown gate's sentence, failing first. */
  gates: string[];
}

/**
 * THE wording of the headline's caps and coverage — the phone card, the
 * launcher chip's title and the VS Code Health view all print these. The
 * worst-entry sentence is `healthCapWords`'s (score.ts), restated here so a
 * caller needs this one function.
 */
export function healthHeadlineWords(s: HealthHeadlineSubject): HealthHeadlineWords {
  const c = s.coverage ?? null;
  const v = Math.round(s.value);
  const unknown = c ? c.items.filter((i) => i.state === "unknown") : [];
  // A gate's reason is its own sentence in `gates`; the coverage line only names it, so no fact is said twice.
  const unknownWords = unknown.map((i) => (i.kind === "gate" ? i.label : `${i.label}: ${i.reason ?? "not read"}`));
  const failing = c ? c.gates.filter((g) => g.state === "fail") : [];
  let cap: string | null = null;
  // An older host sends no capKind: the worst-entry cap is the only one it knew.
  const kind = s.capKind === undefined ? (s.cappedBy && s.value < s.mean ? "worst" : null) : s.capKind;
  if (kind === "gate" && failing.length) {
    cap = `Capped at ${v}: ${failing.length === 1 ? "a gate the repo declared fails" : `${failing.length} gates the repo declared fail`} (${listWords(failing.map((g) => `"${g.name}"`))}), and a failing gate holds the score under ${HEALTH_ALERT_WARN}.`;
  } else if (kind === "coverage" && c) {
    cap = `Capped at ${v}: only ${c.measured} of ${c.applicable} dimensions could be measured, and an unmeasured one counts for nothing, never for 100.`;
  } else if (kind === "worst" && s.cappedBy && s.value < s.mean) {
    const worst = Math.round(s.value - HEALTH_SCORE_CAP_GAP);
    cap = `Capped at ${v} by ${HEALTH_DIMENSION_DEFS[s.cappedBy]?.label ?? "an entry this app version cannot name"} (${worst} of 100): the entries average ${Math.round(s.mean)}, and the score stays within ${HEALTH_SCORE_CAP_GAP} of its worst entry.`;
  }
  let coverage: string | null = null;
  if (c) {
    // Full coverage is no news: a line only where something was not read, or where the engine could not say.
    const notRecorded = "Which languages each reading covers was not recorded by the engine that measured this week.";
    if (c.measured !== c.applicable) {
      const head = `${c.measured} of ${c.applicable} dimensions measured. Unknown: ${unknownWords.join("; ")}.`;
      coverage = c.reach ? head : `${head} ${notRecorded}`;
    } else if (!c.reach) {
      coverage = notRecorded;
    }
  }
  const partial = c ? c.items.filter((i) => i.state === "measured" && i.reason) : [];
  const notes = partial.length
    ? `Read without part of the code: ${partial.map((i) => `${i.label}: ${i.reason}`).join("; ")}.`
    : null;
  const gates = c ? [...failing, ...c.gates.filter((g) => g.state === "unknown")].map((g) => g.text) : [];
  return { cap, coverage, notes, gates };
}
