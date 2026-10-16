/**
 * The readings `usage.ts` took, kept — so the two live windows have a history.
 *
 * ── Why this exists at all ──────────────────────────────────────────────────
 *
 * `UsageInfo` is a point in time with no memory. It answers "can I run
 * something now", which is the question the launcher chip asks, and it cannot
 * answer the one a person asks next: am I burning this week faster than usual,
 * and will the answer still be yes in four hours. The CLI prints a percentage
 * and no history, and there is no file on disk holding one — so the only place
 * a history can come from is the readings this daemon already takes.
 *
 * ── The one rule ────────────────────────────────────────────────────────────
 *
 * **Nothing is scraped for this file.** It records what was already fetched for
 * some other reason (the auto-fire gate's poll, a phone opening the sheet, a
 * manual refresh). Spawning a `claude` PTY on a timer purely to draw a line
 * would make a chart the most expensive thing on the host, and it would be a
 * chart of its own polling.
 *
 * That makes the series IRREGULAR by construction, which the reader is told
 * (`UsageHistoryDoc`) and the chart honours: a gap is drawn as a gap. Nothing
 * here resamples, interpolates or carries a value forward — a straight line
 * across six unobserved hours is a claim about six hours nobody looked at.
 *
 * ── Why the reset instants ride along ───────────────────────────────────────
 *
 * The 5-hour figure sawtooths: it climbs, then a window rolls over and it drops
 * to near zero. Drawn as one polyline that is indistinguishable from usage
 * being refunded, which is not a thing that happens. The reading carries the
 * reset instant the screen NAMED at the time, so a drop can be attributed:
 * `sr` changed ⇒ a new window, draw a break; `sr` the same ⇒ the number really
 * did go down, which is worth seeing rather than smoothing.
 *
 * ── Best-effort, like every other cache here ────────────────────────────────
 *
 * JSONL, appended, compacted in place when it outgrows the cap. A corrupt line
 * is skipped; a corrupt file starts again. A usage chart is not worth taking
 * the daemon down for, and the CLI's own screen remains the source of truth for
 * the only number anybody acts on.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { UsageHistoryDoc, UsageInfo, UsageSample } from "@waterplane/shared";
import { env } from "./env.js";
import { hostStateDir } from "./branddirs.js";
import { writeTextAtomic } from "./jsonstore.js";

/** Most readings retained. At the 8-minute poll that is ~28 days of dense
 *  polling, and polling is normally off, so in practice the age cap bites
 *  first. Both exist because either one alone has a pathological case: a cap
 *  alone lets one busy week evict a quiet month, an age alone lets a host that
 *  polls hard for a fortnight write an unbounded file. */
const CAP = Math.max(100, Number(env("USAGELOG_CAP") || 5000));
/** How far back readings are kept. */
const RETAIN_MS = Math.max(
  60 * 60 * 1000,
  Number(env("USAGELOG_RETAIN_MS") || 30 * 24 * 60 * 60 * 1000),
);
/**
 * How long an UNCHANGED reading waits before it is kept anyway.
 *
 * A run of identical readings is not noise: flat at 15% for four hours and
 * unobserved for four hours look identical in a series that only records
 * changes, and they are opposite facts. So a repeat is kept every half hour —
 * enough to draw the flat, cheap enough not to fill the file with it.
 */
const REPEAT_MS = Math.max(60_000, Number(env("USAGELOG_REPEAT_MS") || 30 * 60 * 1000));
/** Compact once the file is this much over the cap, rather than on every
 *  append — a rewrite per reading is pointless IO for a line-at-a-time log. */
const SLACK = 1.25;

/** The knobs as this process read them — ONE read, shared with every source's log
 *  (`usagesourcelog.ts`), so claude's file and the others' cannot drift apart. */
export const USAGELOG_KNOBS = { CAP, RETAIN_MS, REPEAT_MS, SLACK } as const;

const num = (v: unknown): number | null =>
  typeof v === "number" && Number.isFinite(v) ? v : null;

/** One kept reading ⇄ one line. Explicit rather than `JSON.parse` straight into
 *  the DTO: this file outlives any one build, and a row that grew a field
 *  should widen the type, not arrive unvalidated on a phone. */
function parseLine(line: string): UsageSample | null {
  if (!line || line.charCodeAt(0) !== 123 /* { */) return null;
  let row: Record<string, unknown>;
  try { row = JSON.parse(line) as Record<string, unknown>; } catch { return null; }
  const t = num(row.t);
  if (t == null || t <= 0) return null;
  return { t, s: pct(row.s), w: pct(row.w), sr: num(row.sr), wr: num(row.wr) };
}

/** A percentage, or null. Out-of-range is null rather than clamped: 100% and
 *  "the parse produced 4,300" must not look the same on a gauge. */
function pct(v: unknown): number | null {
  const n = num(v);
  return n != null && n >= 0 && n <= 100 ? n : null;
}

const same = (a: UsageSample, b: UsageSample): boolean =>
  a.s === b.s && a.w === b.w && a.sr === b.sr && a.wr === b.wr;

export class UsageLog {
  private path: string;
  private rows: UsageSample[] = [];
  private appended = 0;

  constructor(root: string) {
    const dir = hostStateDir(root);
    try { mkdirSync(dir, { recursive: true }); } catch { /* best-effort */ }
    this.path = join(dir, "usagelog.jsonl");
    this.load();
  }

  private load(): void {
    try {
      if (!existsSync(this.path)) return;
      const rows: UsageSample[] = [];
      for (const line of readFileSync(this.path, "utf8").split("\n")) {
        const r = parseLine(line);
        if (r) rows.push(r);
      }
      // The file is written in order, but a half-written line or a clock that
      // went backwards is cheaper to sort away than to reason about.
      rows.sort((a, b) => a.t - b.t);
      this.rows = this.trim(rows);
    } catch { this.rows = []; }
  }

  /** Drop what is past either retention bound. */
  private trim(rows: UsageSample[], now = Date.now()): UsageSample[] {
    const from = now - RETAIN_MS;
    const kept = rows.filter((r) => r.t >= from);
    return kept.length > CAP ? kept.slice(kept.length - CAP) : kept;
  }

  /**
   * Offer a reading. Kept only when it says something the last one did not —
   * see `REPEAT_MS`.
   *
   * A reading that did not parse (`ok:false`) is DROPPED rather than recorded
   * as two nulls: the history is of what the CLI printed, and a failed probe is
   * a fact about this daemon, not about the account's limits.
   */
  note(u: UsageInfo): void {
    if (!u.ok || !u.checkedAt) return;
    const row: UsageSample = {
      t: u.checkedAt,
      s: pct(u.sessionPct), w: pct(u.weeklyPct),
      sr: num(u.sessionResetAt), wr: num(u.weeklyResetAt),
    };
    if (row.s == null && row.w == null) return;
    const last = this.rows[this.rows.length - 1];
    if (last) {
      // Out-of-order or duplicate readings happen: two callers can resolve the
      // same in-flight scrape and both report it.
      if (row.t <= last.t) return;
      if (same(last, row) && row.t - last.t < REPEAT_MS) return;
    }
    this.rows.push(row);
    this.append(row);
  }

  private append(row: UsageSample): void {
    try {
      appendFileSync(this.path, `${JSON.stringify(row)}\n`);
      this.appended++;
      if (this.rows.length > CAP * SLACK || this.appended > CAP) this.compact();
    } catch { /* a usage chart is not worth taking the daemon down for */ }
  }

  /** Rewrite the file as exactly what is retained. tmp+rename, so a crash
   *  mid-write loses the history rather than corrupting it into something that
   *  parses as a different one. */
  private compact(): void {
    this.rows = this.trim(this.rows);
    try {
      writeTextAtomic(this.path, this.rows.map((r) => JSON.stringify(r)).join("\n") + (this.rows.length ? "\n" : ""));
      this.appended = 0;
    } catch { /* best-effort */ }
  }

  /**
   * The newest kept reading, or null.
   *
   * The one caller is boot: `usage.ts` re-offers it as a REMEMBERED reading so
   * a restart — which is what shipping a new web bundle is — does not blank the
   * phone's gauge while nothing about the account has changed. Nothing is
   * scraped for it, which is this file's whole rule, and what may be claimed
   * from it (only a window whose reset is still ahead) is decided there.
   */
  last(): UsageSample | null {
    return this.rows.length ? this.rows[this.rows.length - 1] : null;
  }

  /**
   * The kept readings, newest last.
   *
   * `sinceMs` narrows the window; it never widens it past what is retained, and
   * `keptFrom` reports what is actually there rather than what was asked for.
   */
  read(sinceMs?: number, everyMs = 0): UsageHistoryDoc {
    const rows = this.trim(this.rows);
    this.rows = rows;
    const from = sinceMs && sinceMs > 0 ? Date.now() - sinceMs : 0;
    const samples = from ? rows.filter((r) => r.t >= from) : rows.slice();
    return {
      samples,
      keptFrom: rows.length ? rows[0].t : null,
      cap: CAP,
      retainMs: RETAIN_MS,
      everyMs,
    };
  }

  /** Write now. Called on SIGTERM beside the other stores — losing the tail of
   *  an append-only log costs at most the readings since the last compaction,
   *  which are already on disk, so this is only the retention rewrite. */
  flush(): void {
    if (this.appended > 0) this.compact();
  }
}
