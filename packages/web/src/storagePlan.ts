/**
 * What this phone is holding, and what clearing any of it would cost — the
 * rules, with no browser in them.
 *
 * ── Why this exists ─────────────────────────────────────────────────────────
 *
 * `SweepSheet` answers the same question about the desktop's transport
 * directories. Nothing answered it about the phone. `NetHealthSheet` printed a
 * single `used 340 MB` stat, which is a number nobody can act on: it says the
 * app is holding a third of a gigabyte and not one word about which part of it
 * is a thumbnail cache that re-fetches in a second and which part is the only
 * copy of a photo nobody has sent yet.
 *
 * Every cache in this app already self-prunes (`thumbCache.ts` 24 MB,
 * `offlineCache.ts` 12 transcripts / 60 tool turns, `pull.ts` 200 records and a
 * 7-day blob eviction). This module is not a second eviction policy and must
 * never become one. It is the READING — what is here, ranked, in bytes — plus
 * the one thing a bound cannot give you: a way to get the space back NOW,
 * before the bound would have.
 *
 * ── The four rules it is built out of ───────────────────────────────────────
 *
 *  - **Nothing applies itself** (CLAUDE.md). Nothing here clears on open, on a
 *    timer, or on a threshold. It measures, it says what each row would cost,
 *    and a person taps.
 *  - **A count is not the decision; bytes are.** Every count in this file
 *    travels with its byte total, for `sweep.ts`' reason: "9 transcripts" reads
 *    as a lot and is 400 KB; "31 thumbnails" reads as nothing and is 21 MB.
 *  - **Two kinds, kept apart, and never a "clear everything".** A `cache` row
 *    costs a re-fetch. A `keep` row is the ONLY copy — a queued photo, a
 *    dictation the desktop has not read, scrollback the TUI never put on the
 *    wire. `sweep.ts` refuses an outbox+inbox "both" for exactly this reason,
 *    and one button that empties both kinds is that same mistake with more
 *    surface. `groupUses` returns two groups and there is no function here that
 *    returns their union.
 *  - **A reading degrades to ABSENT, never to a wrong number** (CLAUDE.md).
 *    `unnamedBytes` answers null rather than a negative, and a store that could
 *    not be measured is `null` bytes, which is a different row from `0`.
 *
 * Pure: no IndexedDB, no `navigator`, no clock. `storageAudit.ts` does the
 * measuring and the clearing; `StorageSheet.tsx` draws it;
 * `storagePlan.test.mjs` runs this file under `node --test`.
 */

import { fmtBytes as bytes } from "@waterplane/shared";

/** One byte formatter per screen — `shared/sweep.ts`', re-exported here so a
 *  caller never reaches for `format.ts`' `fmtStorage` beside it and prints the
 *  same number two ways. */
export { fmtBytes } from "@waterplane/shared";

/**
 * What clearing a row costs.
 *
 * `cache` — the bytes can be fetched again from the desktop. Clearing costs a
 * request and, offline, a blank screen until the tunnel is back.
 *
 * `keep` — the bytes exist here and nowhere else until the desktop has taken
 * them. Clearing is a delete of content, not of a copy.
 */
export type UseKind = "cache" | "keep";

/** One measured store, as a row. */
export interface StoreUse {
  /** Stable id — also what `clearStore` takes, so a row and its button cannot
   *  name two different things. */
  id: string;
  /** What it holds, in words a person recognises. Never a store name. */
  label: string;
  kind: UseKind;
  /** How many entries. Always drawn with `bytes`. */
  count: number;
  /**
   * Bytes held, or **null when it could not be measured**. Null is not zero:
   * an unreadable store (IndexedDB refused, private mode) is an unknown, and a
   * row that reports 0 for one is a wrong number in the one place this screen
   * exists to be right about.
   */
  bytes: number | null;
  /** What is lost by clearing it — one sentence, always present, even for a
   *  cache. "Costs a re-fetch" is the answer; silence is not. */
  cost: string;
  /**
   * Why this row has no clear button, when it has none. A blocked verb is a
   * SENTENCE, never a dimmed control (`Unavailable.tsx`) — and some rows are
   * deliberately actioned elsewhere, where the individual items are visible.
   */
  cant?: string;
}

/** A kind's rows and their totals. */
export interface UseGroup {
  kind: UseKind;
  rows: StoreUse[];
  count: number;
  /** Null when ANY row in the group is unmeasured — a total that silently
   *  omits an unknown is a wrong number. `partial` says which case it is. */
  bytes: number | null;
  /** True when at least one row could not be measured. */
  partial: boolean;
}

/** Sum a group's bytes, or null if anything in it is unknown. */
function sumBytes(rows: StoreUse[]): { bytes: number | null; partial: boolean } {
  let total = 0;
  let partial = false;
  for (const r of rows) {
    if (r.bytes == null) partial = true;
    else total += r.bytes;
  }
  return { bytes: partial ? null : total, partial };
}

/**
 * Split the measured rows into the two kinds and rank each by bytes.
 *
 * Unmeasured rows sort last — a row with no number cannot claim a place in a
 * ranking of numbers — and empty rows are KEPT rather than filtered out:
 * "nothing is queued" is an answer, and a missing row reads as a store this
 * screen forgot about (`SweepSheet`'s empty-chip rule).
 */
export function groupUses(rows: StoreUse[]): { caches: UseGroup; keep: UseGroup } {
  const of = (kind: UseKind): UseGroup => {
    const mine = rows.filter((r) => r.kind === kind)
      .sort((a, b) => (b.bytes ?? -1) - (a.bytes ?? -1));
    const { bytes, partial } = sumBytes(mine);
    return { kind, rows: mine, count: mine.reduce((n, r) => n + r.count, 0), bytes, partial };
  };
  return { caches: of("cache"), keep: of("keep") };
}

/**
 * The bytes the browser says are used that this screen could not put a name to.
 *
 * Deliberately not called "other": it is not a category, it is the size of this
 * screen's own ignorance. The service worker's caches, IndexedDB's own
 * overhead, localStorage and whatever the engine pads its estimate with all
 * land here.
 *
 * Absent (null) when there is no estimate, when anything measured is unknown,
 * or when the estimate is SMALLER than what we named — which happens, because
 * `navigator.storage.estimate()` is an approximation and a phone that has just
 * deleted something can report a stale low figure. A negative gap is not a
 * finding, it is a reason to say nothing.
 */
export function unnamedBytes(named: number | null, estimate: number | undefined): number | null {
  if (named == null || estimate == null || !Number.isFinite(estimate)) return null;
  const gap = estimate - named;
  return gap > 0 ? gap : null;
}

/**
 * UTF-8 byte length of a string, without allocating a copy of it.
 *
 * `TextEncoder().encode(s).length` is exact and allocates the whole string
 * again as bytes — done over a dozen multi-megabyte transcripts on a phone
 * that is already short of memory, which is the one situation this screen is
 * ever opened in. Counting is exact too and allocates nothing.
 *
 * A lone surrogate (a truncated string, which transcripts genuinely contain
 * after a trim) counts as 3, the way an encoder's replacement character does.
 */
export function utf8Len(s: string): number {
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x80) n += 1;
    else if (c < 0x800) n += 2;
    else if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length) {
      const next = s.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) { n += 4; i++; } else n += 3;
    } else n += 3;
  }
  return n;
}

/** A count and its bytes, in the one shape every sentence here uses. Unknown
 *  bytes are said as unknown, never rendered as `0 B`. */
export function tallyText(count: number, b: number | null, noun: string): string {
  const plural = count === 1 ? noun : `${noun}s`;
  return b == null ? `${count} ${plural} · size unknown` : `${count} ${plural} · ${bytes(b)}`;
}

/**
 * What a row's clear button says — **the whole decision, restated**
 * (`SweepSheet`'s rule; this one is destructive too).
 *
 * Never "Clear" alone: the label carries what goes and how much, because the
 * row's own heading scrolls off the moment a thumb is over the button.
 */
export function clearButtonText(u: StoreUse): string {
  if (!u.count) return `Nothing in ${u.label}`;
  return u.bytes == null
    ? `Clear ${u.label} · ${u.count}`
    : `Clear ${u.label} · ${u.count} · ${bytes(u.bytes)}`;
}

/** The second tap's words — a `keep` row names what stops existing, a cache
 *  names what it costs, and neither is the generic "Are you sure?". */
export function clearConfirmText(u: StoreUse): string {
  const size = u.bytes == null ? `${u.count}` : `${u.count} · ${bytes(u.bytes)}`;
  return u.kind === "keep" ? `Yes — delete ${size}` : `Yes — clear ${size}`;
}

/**
 * The group-level control. Only ever offered for `cache`, and the type says so:
 * there is no call site that can hand this a `keep` group, because clearing
 * every only-copy store with one tap is the thing this module exists to not
 * offer.
 */
export function clearGroupText(g: UseGroup & { kind: "cache" }): string {
  const n = g.rows.filter((r) => r.count > 0 && !r.cant).length;
  if (!n) return "Nothing cached here";
  return g.bytes == null
    ? `Clear all ${n} caches`
    : `Clear all ${n} caches · ${bytes(g.bytes)}`;
}

/** What a clear actually did. Split the way `sweepResultText` splits: what went
 *  is one fact, what refused to go is another. */
export interface ClearResult {
  label: string;
  count: number;
  bytes: number | null;
  /** Stores that threw. Named, because "cleared" over a store that is still
   *  full is the one sentence this screen must never print. */
  failed: string[];
}

export function clearResultText(r: ClearResult): string {
  const freed = r.bytes == null ? `${r.count} entries` : `${r.count} entries · ${bytes(r.bytes)}`;
  if (r.failed.length) {
    return `Cleared ${freed}. Still here: ${r.failed.join(", ")} — the browser refused.`;
  }
  return r.count ? `Cleared ${freed} from ${r.label}.` : `${r.label} was already empty.`;
}

/**
 * The line under the total.
 *
 * Says the browser's own figure and, when it is knowable, how much of it this
 * screen can account for — because the difference is the part no button here
 * can free, and a reader staring at a gap with no explanation concludes the
 * buttons are broken.
 */
export function totalText(named: number | null, estimate: number | undefined, quota: number | undefined): string {
  const head = estimate == null
    ? "This browser won’t say how much it is holding."
    : `The browser reports ${bytes(estimate)} used${quota ? ` of ${bytes(quota)}` : ""}.`;
  const gap = unnamedBytes(named, estimate);
  if (named == null) return `${head} Part of what is below could not be measured.`;
  // Measured MORE than the browser admits to. Not a contradiction to resolve
  // by picking one: `estimate()` is an approximation that lags a delete, and
  // "500 B OF IT is named below" about a reported 100 B is a sentence that
  // cannot be true. Say the two readings apart instead of folding them.
  if (estimate != null && named > estimate) {
    return `${head} The stores below measure ${bytes(named)} between them — the browser’s figure is an estimate and lags a delete.`;
  }
  if (gap == null) return `${head} ${bytes(named)} of it is named below.`;
  return `${head} ${bytes(named)} is named below; the other ${bytes(gap)} is the browser’s own overhead and caches this screen cannot itemise.`;
}

/**
 * Downloads held as FILES by the Android shell are invisible to
 * `navigator.storage.estimate()` — they are not in IndexedDB, which is the
 * whole reason a 90 MB APK costs nothing to keep (`pull.ts`). So the total
 * would under-report by exactly the largest thing on the phone unless this is
 * said out loud.
 */
export function nativeNoteText(count: number, b: number): string | null {
  if (!count) return null;
  return `${tallyText(count, b, "download")} sit outside the browser’s figure above — the app holds them as files, so they are not in the number the browser reports.`;
}
