/**
 * Agent efficiency series — the input shape (one point per conversation log), the
 * readings drawn from it, and the markers drawn beside them.
 *
 * The point shape is the host's per-session point (`wire/agentreadings.ts`), declared
 * here STRUCTURALLY so this module depends on nothing but the fields it reads.
 * Every reading degrades to `{ absent: why }`, never to a number from one or two
 * sessions. Nothing here judges: `inside` is data, the UI words it.
 */


/** One conversation log, as far as these readings need it. */
export interface SeriesPoint {
  id: string;
  /** First record's instant, epoch ms. */
  t0: number;
  repo: string;
  /** Started fresh (not resumed or carried over). */
  fresh: boolean;
  /** A `claude -p` run nobody typed into. */
  headless: boolean;
  /** A subagent's own log. */
  sub?: boolean;
  model?: string;
  /** CLI version that wrote the log. */
  cli?: string;
  /** First request's carried tokens (input + cache write + cache read). */
  start?: number;
  /** First request's chars by source (`StartPart` ids in `wire/agentreadings.ts`; read by key, so a new part needs no change here). */
  parts?: Partial<Record<string, number>>;
  /** Look calls (Read/Grep/Glob/Bash) before the first edit; absent when the session never edited. */
  look?: number;
  /** Requests the session made. */
  req: number;
  /** The session committed (absent on a subagent log, which is not read for it). */
  commit?: boolean;
}

/** A reading that could not be taken, and why — never a zero. */
export interface SeriesAbsent {
  absent: string;
}

export interface SeriesMedian {
  median: number;
  /** Sessions the median is over. */
  n: number;
}

export type SeriesValue = SeriesMedian | SeriesAbsent;

/** The four readings a before/after can be asked about. */
export type SeriesReading = "start" | "subStart" | "look" | "req";

export interface SeriesBucket {
  /** `YYYY-MM-DD`: the local day, or the Monday of the ISO week. */
  key: string;
  /** Fresh, non-subagent sessions in the bucket (headless included). */
  fresh: number;
  /** Median first-request tokens, fresh interactive non-subagent sessions. */
  start: SeriesValue;
  /** Median chars per part over the same sessions; a part below the minimum is absent. */
  parts: Record<string, SeriesValue>;
  /** Median look calls before the first edit, fresh non-subagent sessions that edited. */
  look: SeriesValue;
  /** Median requests, fresh non-subagent sessions that committed. */
  req: SeriesValue;
  /** Median first-request tokens of subagent logs. */
  subStart: SeriesValue;
}

export interface SeriesOpts {
  grain: "day" | "week";
  model?: string;
  repo?: string;
}

export interface CompareOpts {
  /** Days each side of the instant (default 14). */
  days?: number;
  reading: SeriesReading;
  model?: string;
  repo?: string;
}

export interface CompareResult {
  before: number;
  after: number;
  /** after / before. */
  ratio: number;
  /** 2.5–97.5 percentile of the ratio with the day labels shuffled across the window. */
  band: [number, number];
  /** The ratio lies inside the band: no change this data can tell from day-to-day variation. */
  inside: boolean;
  nBefore: number;
  nAfter: number;
  /** Day blocks each side (a day split by the instant is two blocks). */
  daysBefore: number;
  daysAfter: number;
  /** The one model every compared session ran. */
  model?: string;
}

export type AgentMarkerKind = "model" | "cli" | "instructions" | "memory" | "skills" | "switch" | "tag";

/** Something that changed, drawn on the same time axis as the readings. */
export interface AgentMarker {
  t: number;
  kind: AgentMarkerKind;
  label: string;
  repo?: string;
  detail?: string;
  /** Same-kind markers folded into this one on its day (absent = one). */
  count?: number;
}
