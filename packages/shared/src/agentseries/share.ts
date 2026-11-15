/**
 * The setup block (R-metrics-073): what one person's desktop carries into a session on a repo, as a
 * small versioned JSON text another person's phone imports to draw the two side by side. Built from
 * the same per-session points as the Agent readings headline, and NOTHING else: start-context part
 * sizes as medians grouped by whose they are (the repo's / yours / the CLI's / not split), the median
 * first-request tokens, model and CLI version, the date range in
 * whole days, the repo's identity (the remote's name and a hash of its normalised URL, never a local
 * path), the exporter's chosen display name, and an optional probe summary slot.
 *
 * Never in it, by construction (the builder names every field it writes; the parser rebuilds from
 * the fields it names, so an extra field cannot ride through): markers (they carry file, skill and tag
 * names), session counts (a figure below `SHARE_MIN_N` sessions is left out, never counted), times
 * finer than a day, behaviour readings (looks, requests, skill loads), prompts, paths — and no setup
 * cost figure: cost tokens ÷ start tokens is requests per session, a behaviour reading (owner,
 * 2026-11-14; a block from P5 that still carries `cost` has it dropped by the parser). A part key this
 * version does not name could name a plugin or connector, so it is folded into its group's
 * `unlisted` part before anything is measured.
 *
 * Side by side (`setupShareCompare`) is two figures per row, never a difference, a ranking or a
 * verdict; the repo's half is identical by construction and says so, or says that it is NOT.
 */
import { normalizeModel } from "../pricing.js";
import { START_GROUPS, START_PARTS, startGroupOf, type StartGroup } from "../wire/agentreadings.js";
import { seriesFilter, seriesReadingOf, SERIES_MIN_N } from "./series.js";
import { SETUP_COST_DAYS } from "./setupcost.js";
import { localDayOf, medianOf } from "./stats.js";
import { addLocalDays } from "../calday.js";
import type { SeriesAbsent, SeriesPoint } from "./types.js";

/** What the block's `kind` says, so a pasted text is recognised as one before anything else is read. */
export const SETUP_SHARE_KIND = "agent-setup-block";
/** The block's format. A newer one is refused with a sentence, never half read. */
export const SETUP_SHARE_SCHEMA = 1;
/** Fewest sessions behind any figure in the block (the region's own minimum); never said as a count. */
export const SHARE_MIN_N = SERIES_MIN_N;
/** The part every key this version does not name is folded into. */
export const SHARE_UNLISTED = "unlisted";

/** The repo, as two people on it both know it: the remote's last path segment and a hash of the normalised remote URL. */
export interface SetupShareRepo {
  name: string;
  /** 16 hex: the first 64 bits of sha-256 over shared `remoteKey(url)`. */
  key: string;
}

/**
 * The probe's summary, filled by the probe card from the newest non-void result: one run, its day, its kind, the share of
 * answers right and the tokens per question at that correctness, with its repeats (a probe result
 * carries its own repeat count; it is not a session count).
 */
export interface SetupShareProbe {
  /** `YYYY-MM-DD` the run ended. */
  day: string;
  /** `models` | `baseline` | `against`, open. */
  kind: string;
  /** Share of answers right, 0..1. */
  correct: number;
  /** Median tokens per question. */
  tokPerQuestion: number;
  repeats: number;
  /**
   * The model the probe ran on. Absent from a block an older version wrote. A probe's model is typed at
   * the card and need not be one the sessions ran, so the block's `models` cannot stand in for it.
   */
  model?: string;
  /** How many questions were asked. Absent from an older block. */
  questions?: number;
  /**
   * 8 hex: a fingerprint of the sorted ids of the questions asked (`probeDrawKey`), so two blocks can say whether
   * the same draw was asked without carrying the ids. Each desktop draws its own random questions from the pool.
   */
  draw?: string;
}

/** 8 hex over the sorted, distinct question ids (FNV-1a, not a secret: it only tells two draws apart). */
export function probeDrawKey(ids: readonly string[]): string {
  let h = 0x811c9dc5;
  for (const ch of [...new Set(ids)].sort().join("\n")) {
    h ^= ch.codePointAt(0)!;
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

export interface SetupShareGroup {
  group: StartGroup;
  /** Median over sessions of the group's characters (rounded to tens). */
  chars: number;
  /** Median characters per part, open keys (`START_PARTS` ids or `unlisted`), rounded to tens. */
  parts: Record<string, number>;
}

export interface SetupShareBlock {
  kind: typeof SETUP_SHARE_KIND;
  schema: typeof SETUP_SHARE_SCHEMA;
  /** The exporter's chosen display name (asked once, remembered per phone). */
  from: string;
  /** Which backend wrote the logs (`claude` today). */
  backend: string;
  /** Models the sessions ran (normalised ids, most sessions first, at most 4). */
  models: string[];
  /** CLI versions the sessions ran (most sessions first, at most 4). */
  cli: string[];
  /** Absent when the repo has no remote another machine shares: then nothing says it is the same repo. */
  repo?: SetupShareRepo;
  /** Whole local days, inclusive. */
  days: { from: string; to: string };
  /** Median first-request tokens (input + cache read + cache write), rounded to hundreds. */
  startTok: number;
  groups: SetupShareGroup[];
  probe?: SetupShareProbe;
}

export const SHARE_NAME_MAX = 40;
const NAME_RE = /^[\p{L}\p{N}][\p{L}\p{N} ._'-]{0,39}$/u;
export const SHARE_MODEL_RE = /^[a-z0-9][a-z0-9._:@\-[\]]{0,63}$/i;
export const SHARE_CLI_RE = /^\d{1,4}(\.\d{1,6}){0,3}([-+][0-9A-Za-z.]{1,20})?$/;

/** The display name as it will be written, or null with nothing usable (`shareNameProblem` says why). */
export function cleanShareName(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const s = raw.trim().replace(/\s+/g, " ");
  return NAME_RE.test(s) ? s : null;
}

export function shareNameProblem(raw: string): string | null {
  const s = raw.trim();
  if (!s) return "Type the name the others will see beside your figures.";
  if (s.length > SHARE_NAME_MAX) return `At most ${SHARE_NAME_MAX} characters.`;
  return cleanShareName(s) ? null : "Letters, digits, spaces and . _ ' - only, starting with a letter or a digit.";
}

const round = (x: number, to: number): number => Math.round(x / to) * to;
/** The key a part is exported under: a part this version names keeps its id, anything else folds into `unlisted`. */
export function shareKeyOf(id: string): string {
  return START_PARTS.some((p) => p.id === id) ? id : SHARE_UNLISTED;
}
/** The group a key belongs to in a block; `unlisted` is `mixed` (its source is not known). */
export function shareGroupOf(key: string): StartGroup {
  return key === SHARE_UNLISTED ? "mixed" : startGroupOf(key);
}

function topSafe(xs: readonly (string | null | undefined)[], re: RegExp, max: number): string[] {
  const n = new Map<string, number>();
  for (const x of xs) if (x && re.test(x)) n.set(x, (n.get(x) ?? 0) + 1);
  return [...n.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, max).map(([x]) => x);
}

/**
 * The block for one repo's points, or `{ absent }` with the sentence why. `now` closes the window
 * (`days` back, the headline's 14 by default).
 */
export function setupShareOf(points: readonly SeriesPoint[], opts: {
  now: number; from: string; backend: string; repo?: SetupShareRepo | null; days?: number; repoFilter?: string; probe?: SetupShareProbe | null;
}): SetupShareBlock | SeriesAbsent {
  const from = cleanShareName(opts.from);
  if (!from) return { absent: "No name to put on the block yet." };
  const backend = SHARE_MODEL_RE.test(opts.backend) ? opts.backend : null;
  if (!backend) return { absent: "The backend's name cannot be written into the block." };
  const days = Math.max(1, Math.min(90, Math.floor(opts.days ?? SETUP_COST_DAYS)));
  const to = opts.now;
  const t0 = addLocalDays(to, -days);
  const ps = seriesFilter(points, opts.repoFilter === undefined ? {} : { repo: opts.repoFilter })
    .filter((p) => p.t0 >= t0 && p.t0 < to && seriesReadingOf(p, "start") !== undefined);
  if (ps.length < SHARE_MIN_N) {
    return { absent: `Too few fresh interactive sessions in the last ${days} days to share: every figure in the block is a median over at least ${SHARE_MIN_N}.` };
  }
  // Fold every key first: a name this version does not know never reaches a median.
  const perKey = new Map<string, number[]>();
  const perGroup = new Map<StartGroup, number[]>();
  for (const p of ps) {
    if (!p.parts) continue;
    const keys = new Map<string, number>();
    const groups = new Map<StartGroup, number>();
    for (const [id, c] of Object.entries(p.parts)) {
      if (typeof c !== "number" || !Number.isFinite(c) || c <= 0) continue;
      const k = shareKeyOf(id);
      keys.set(k, (keys.get(k) ?? 0) + c);
      const g = shareGroupOf(k);
      groups.set(g, (groups.get(g) ?? 0) + c);
    }
    for (const [k, c] of keys) perKey.set(k, [...(perKey.get(k) ?? []), c]);
    for (const [g, c] of groups) perGroup.set(g, [...(perGroup.get(g) ?? []), c]);
  }
  const order = [...START_PARTS.map((p) => p.id), SHARE_UNLISTED];
  const groups: SetupShareGroup[] = [];
  for (const g of START_GROUPS) {
    const gs = perGroup.get(g.id) ?? [];
    if (gs.length < SHARE_MIN_N) continue;
    const parts: Record<string, number> = {};
    for (const k of order) {
      if (shareGroupOf(k) !== g.id) continue;
      const xs = perKey.get(k) ?? [];
      if (xs.length >= SHARE_MIN_N) parts[k] = round(medianOf(xs)!, 10);
    }
    groups.push({ group: g.id, chars: round(medianOf(gs)!, 10), parts });
  }
  const repo = opts.repo && cleanShareRepo(opts.repo);
  const probe = opts.probe ? cleanShareProbe(opts.probe) : null;
  return {
    kind: SETUP_SHARE_KIND,
    schema: SETUP_SHARE_SCHEMA,
    from,
    backend,
    models: topSafe(ps.map((p) => normalizeModel(p.model) ?? p.model), SHARE_MODEL_RE, 4),
    cli: topSafe(ps.map((p) => p.cli), SHARE_CLI_RE, 4),
    ...(repo ? { repo } : {}),
    days: { from: localDayOf(t0), to: localDayOf(to) },
    startTok: round(medianOf(ps.map((p) => p.start!))!, 100),
    groups,
    ...(probe ? { probe } : {}),
  };
}

/** The exact text that leaves: canonical (fields in the builder's order), two-space JSON. The preview shows this string and nothing else. */
export function setupShareText(b: SetupShareBlock): string {
  return JSON.stringify(b, null, 2);
}

// ── Cleaning, shared by the builder and the parser ─────────────────────────

export const SHARE_DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const HEX16 = /^[0-9a-f]{16}$/;
const REPO_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;

export function cleanShareRepo(raw: unknown): SetupShareRepo | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.name !== "string" || !REPO_NAME_RE.test(r.name) || typeof r.key !== "string" || !HEX16.test(r.key)) return null;
  return { name: r.name, key: r.key };
}

const fin = (x: unknown, lo: number, hi: number): x is number => typeof x === "number" && Number.isFinite(x) && x >= lo && x <= hi;

export function cleanShareProbe(raw: unknown): SetupShareProbe | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.day !== "string" || !SHARE_DAY_RE.test(r.day)) return null;
  if (typeof r.kind !== "string" || !/^[a-z][a-z-]{0,23}$/.test(r.kind)) return null;
  if (!fin(r.correct, 0, 1) || !fin(r.tokPerQuestion, 0, 1e8) || !fin(r.repeats, 1, 100) || !Number.isInteger(r.repeats)) return null;
  const out: SetupShareProbe = { day: r.day, kind: r.kind, correct: r.correct, tokPerQuestion: Math.round(r.tokPerQuestion), repeats: r.repeats };
  if (r.model !== undefined) { if (typeof r.model !== "string" || !SHARE_MODEL_RE.test(r.model)) return null; out.model = r.model; }
  if (r.questions !== undefined) { if (!fin(r.questions, 1, 1000) || !Number.isInteger(r.questions)) return null; out.questions = r.questions; }
  if (r.draw !== undefined) { if (typeof r.draw !== "string" || !/^[0-9a-f]{8}$/.test(r.draw)) return null; out.draw = r.draw; }
  return out;
}
