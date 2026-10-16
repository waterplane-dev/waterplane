/**
 * The readings a contributed usage probe took, kept — one file per source.
 *
 * `usagelog.ts`'s rules for claude's `/usage` readings, applied to every OTHER
 * source (Copilot's quota, a plugin's probe): `<state dir>/usagelog-<source>.jsonl`.
 * claude's own `usagelog.jsonl` is untouched and has no migration — its row
 * shape is a different, older contract the phone already reads.
 *
 * The same rules, and for the same reasons:
 * - **nothing is probed for this file** — it records what the registry already
 *   fetched (`usagesources.ts`), so the series is IRREGULAR and a gap is a gap;
 * - a reading with no usable window is DROPPED, not recorded as nulls — a failed
 *   probe is a fact about this daemon, not about the account;
 * - an unchanged reading is kept every `REPEAT_MS` anyway, because "flat for
 *   four hours" and "nobody looked" are opposite facts;
 * - the reset instants ride along so a rollover is not read as a refund;
 * - CAP and RETAIN bound it both ways; a corrupt line is skipped, a corrupt
 *   file starts again — a usage chart is not worth taking the daemon down for.
 *
 * A row on disk carries a little more than the wire sample (the window's unit
 * and count form) so a restart can re-offer the last reading as `remembered`
 * with the chip's text intact; `read()` answers exactly `UsageSourceHistoryDoc`.
 * The knobs are `usagelog.ts`'s own env names, so one setting bounds every log.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { isUsageSourceId, usageWindowPct, type UsageReading, type UsageSourceHistoryDoc, type UsageSourceId, type UsageSourceSample } from "@waterplane/shared";
import { hostStateDir } from "./branddirs.js";
import { writeTextAtomic } from "./jsonstore.js";
import { USAGELOG_KNOBS } from "./usagelog.js";

const { CAP, RETAIN_MS, REPEAT_MS, SLACK } = USAGELOG_KNOBS;

/** One window as kept on disk: the wire sample's three fields plus what the chip draws. */
export interface SourceWindowRow {
  id: string; pct: number | null; resetAt: number | null;
  unit?: string; used?: number; limit?: number; unitName?: string;
}
/** One kept reading on disk. */
export interface SourceUsageRow { t: number; w: SourceWindowRow[] }

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
/** Out-of-range is null rather than clamped (`usagelog.ts`'s rule). */
const pct = (v: unknown): number | null => { const n = num(v); return n != null && n >= 0 && n <= 100 ? n : null; };
const count = (v: unknown): number | undefined => { const n = num(v); return n != null && n >= 0 ? n : undefined; };
const str = (v: unknown, max: number): string | undefined => (typeof v === "string" && v.length > 0 && v.length <= max ? v : undefined);

function windowRow(o: unknown): SourceWindowRow | null {
  if (!o || typeof o !== "object") return null;
  const r = o as Record<string, unknown>;
  const id = str(r.id, 32);
  if (!id) return null;
  const w: SourceWindowRow = { id, pct: pct(r.pct), resetAt: num(r.resetAt) };
  const unit = str(r.unit, 3); if (unit) w.unit = unit;
  const used = count(r.used); const limit = count(r.limit);
  if (used != null && limit != null && limit > 0) { w.used = used; w.limit = limit; }
  const unitName = str(r.unitName, 24); if (unitName) w.unitName = unitName;
  return w;
}

/** A window says something when it has a percentage or a count to compute one from. */
const speaks = (w: SourceWindowRow): boolean => w.pct != null || (w.used != null && w.limit != null);

/** One line ⇄ one row, validated field by field: the file outlives any one build. */
export function parseSourceLine(line: string): SourceUsageRow | null {
  if (!line || line.charCodeAt(0) !== 123 /* { */) return null;
  let row: Record<string, unknown>;
  try { row = JSON.parse(line) as Record<string, unknown>; } catch { return null; }
  const t = num(row.t);
  if (t == null || t <= 0 || !Array.isArray(row.w)) return null;
  const w = row.w.map(windowRow).filter((x): x is SourceWindowRow => !!x && speaks(x));
  return w.length ? { t, w } : null;
}

/** A reading as a row; null when no window says anything (DROPPED, never nulls). */
export function rowOfReading(r: UsageReading): SourceUsageRow | null {
  if (!r.checkedAt) return null;
  const w = r.windows.map(windowRow).filter((x): x is SourceWindowRow => !!x && speaks(x));
  return w.length ? { t: r.checkedAt, w } : null;
}

const sameRow = (a: SourceUsageRow, b: SourceUsageRow): boolean =>
  a.w.length === b.w.length && a.w.every((x, i) => {
    const y = b.w[i]!;
    return x.id === y.id && x.pct === y.pct && x.resetAt === y.resetAt && x.used === y.used && x.limit === y.limit;
  });

/**
 * A source id as a file-name part, one-to-one: `_` is the escape (`_` → `__`, `:` → `_c`), so
 * `a:b` (`a_cb`) and `a_b` (`a__b`) are two files — a plain `:`→`_` gave two plugins one log.
 * An id with neither character (`copilot`) is its own name.
 */
export const sourceFilePart = (source: string): string => source.replace(/[_:]/g, (c) => (c === "_" ? "__" : "_c"));

/** Where a source's log lives. Null for an id that is not a source id, or claude's (its own file). */
export function sourceLogPath(root: string, source: UsageSourceId): string | null {
  if (!isUsageSourceId(source) || source === "claude") return null;
  return join(hostStateDir(root), `usagelog-${sourceFilePart(source)}.jsonl`);
}

export class SourceUsageLog {
  private rows: SourceUsageRow[] = [];
  private appended = 0;
  private readonly path: string;

  constructor(root: string, readonly source: UsageSourceId) {
    const path = sourceLogPath(root, source);
    if (!path) throw new Error(`not a usage source id: ${JSON.stringify(source)}`);
    this.path = path;
    try { mkdirSync(hostStateDir(root), { recursive: true }); } catch { /* best-effort */ }
    this.load();
  }

  /** Whether a log was ever written for this source (the route answers only those). */
  static exists(root: string, source: UsageSourceId): boolean {
    const p = sourceLogPath(root, source);
    return !!p && existsSync(p);
  }

  private load(): void {
    try {
      if (!existsSync(this.path)) return;
      const rows: SourceUsageRow[] = [];
      for (const line of readFileSync(this.path, "utf8").split("\n")) {
        const r = parseSourceLine(line);
        if (r) rows.push(r);
      }
      rows.sort((a, b) => a.t - b.t);
      this.rows = this.trim(rows);
    } catch { this.rows = []; }
  }

  private trim(rows: SourceUsageRow[], now = Date.now()): SourceUsageRow[] {
    const from = now - RETAIN_MS;
    const kept = rows.filter((r) => r.t >= from);
    return kept.length > CAP ? kept.slice(kept.length - CAP) : kept;
  }

  /** Offer a reading; kept only when it says something the last one did not (or `REPEAT_MS` passed). */
  note(r: UsageReading): void {
    if (r.remembered) return; // a re-offer of what is already on disk
    const row = rowOfReading(r);
    if (!row) return;
    const last = this.rows[this.rows.length - 1];
    if (last) {
      if (row.t <= last.t) return;
      if (sameRow(last, row) && row.t - last.t < REPEAT_MS) return;
    }
    this.rows.push(row);
    try {
      appendFileSync(this.path, `${JSON.stringify(row)}\n`);
      this.appended++;
      if (this.rows.length > CAP * SLACK || this.appended > CAP) this.compact();
    } catch { /* best-effort */ }
  }

  private compact(): void {
    this.rows = this.trim(this.rows);
    try {
      writeTextAtomic(this.path, this.rows.map((r) => JSON.stringify(r)).join("\n") + (this.rows.length ? "\n" : ""));
      this.appended = 0;
    } catch { /* best-effort */ }
  }

  /** The newest kept row, or null — boot's re-offer (`UsageSourceRegistry.seed`). */
  last(): SourceUsageRow | null {
    return this.rows.length ? this.rows[this.rows.length - 1]! : null;
  }

  /** The kept readings as the wire doc, newest last; `sinceMs` narrows, never widens. */
  read(sinceMs?: number): UsageSourceHistoryDoc {
    const rows = this.trim(this.rows);
    this.rows = rows;
    const from = sinceMs && sinceMs > 0 ? Date.now() - sinceMs : 0;
    const kept = from ? rows.filter((r) => r.t >= from) : rows;
    const samples: UsageSourceSample[] = kept.map((r) => ({ t: r.t, w: r.w.map((w) => ({ id: w.id, pct: w.pct ?? usageWindowPct({ ...w, unit: w.unit ?? "" }), resetAt: w.resetAt })) }));
    return { source: this.source, samples, keptFrom: rows.length ? rows[0]!.t : null, cap: CAP, retainMs: RETAIN_MS };
  }

  /** The retention rewrite, on SIGTERM beside `usagelog.ts`'s. */
  flush(): void {
    if (this.appended > 0) this.compact();
  }
}

/** Test seam: the knobs as this process read them. */
export const SOURCE_LOG_KNOBS = { CAP, RETAIN_MS, REPEAT_MS };

/**
 * The registry's `openLog`: a source's log under `root`'s state dir; with `mustExist`, only one
 * that was ever written (the history route answers no source it never kept).
 */
export const sourceLogOpener = (root: string) => (source: UsageSourceId, mustExist: boolean): SourceUsageLog | null => {
  if (!sourceLogPath(root, source)) return null;
  if (mustExist && !SourceUsageLog.exists(root, source)) return null;
  return new SourceUsageLog(root, source);
};
