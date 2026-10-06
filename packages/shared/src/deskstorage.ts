/**
 * What the DESKTOP is holding, as the phone reads it — the two shapes and
 * every sentence said about them.
 *
 * `sweep.ts` clears ONE repo's transport directory, and the phone's own
 * `storagePlan.ts` asks the same question about the device. Between them sat
 * two gaps this module closes:
 *
 *  1. **Which repo.** Measured here: 7.5 GB across fourteen repos, 4.5 GB of it
 *     in one and 2.5 GB in a second. The per-repo sweep is reached from one
 *     repo's gallery, so using it means already knowing which repo is fat —
 *     fourteen trips to find out. `TransportSurvey` is that ranking.
 *  2. **The daemon's own store.** The state dir under the root (`BRAND.stateDirName`) is 28 MB on this desktop, and
 *     almost all of it is already bounded by whoever writes it (rings, row
 *     caps, a size rotation, a boot sweep behind a 7-day gate). `HostStoreReport`
 *     says so per row — the reading is the point, because it is what identifies
 *     the two or three things that are NOT bounded.
 *
 * ── Why the sentences live here and not on the phone ────────────────────────
 *
 * The host CLASSIFIES (`host/hoststore.ts` knows which file is which) and the
 * phone DRAWS. If the phone kept its own table of what a kind means, the two
 * would word "this is a cache" and "this is a ledger you cannot delete" apart
 * the first time a store changed hands — and one of those sentences is the only
 * thing standing between a person and a delete they cannot undo.
 *
 * ── The rules ───────────────────────────────────────────────────────────────
 *
 *  - **A reading degrades to ABSENT, never to a wrong number** (CLAUDE.md).
 *    Every byte figure here is nullable, and a `null` poisons the total it
 *    belongs to rather than being folded in as zero. A survey that walked past
 *    its budget reports `null` for that repo — a lower bound printed as a total
 *    is the one lie a screen about deleting must not tell.
 *  - **A count on a control is a filter.** A survey row's outbox figure opens
 *    exactly that repo's outbox sweep, which is why the two scopes are separate
 *    fields and separate tap targets and there is deliberately no combined
 *    "transport bytes" number to tap.
 *  - **Nothing applies itself.** Nothing here decides, schedules, or deletes;
 *    it is two DTOs and the words for them.
 *
 * Pure: no fs, no clock of its own (`at` is passed in by whoever measured).
 * `shared/test/deskstorage.test.mjs`.
 */
import { fmtBytes, type SweepTally } from "./sweep.js";

// ── The cross-repo transport survey ─────────────────────────────────────────

/** One discovered worktree and what its two transport directories hold. */
export interface TransportSurveyRow {
  /** `targetId(worktreePath)` — what the per-repo sweep routes take. */
  repoId: string;
  repoName: string;
  branch: string;
  isPrimary: boolean;
  /**
   * What the outbox holds, or **null when it could not be counted** — the walk
   * hit its entry budget, or the directory was unreadable. Null is not zero:
   * one means "this repo is clean", the other means "this screen does not
   * know", and only the first is a reason to skip it.
   */
  outbox: SweepTally | null;
  /** Same, for the inbox. Separate from `outbox` because they are opposite
   *  directions and the sweep refuses to treat them as one thing: an outbox is
   *  re-derivable by running the build again, an inbox may be a photo's only
   *  copy. */
  inbox: SweepTally | null;
}

export interface TransportSurvey {
  /** When the walk ran, by the desktop's clock. Every row is from this instant
   *  — a survey stitched from two moments would rank repos against each other
   *  using numbers taken at different times. */
  at: number;
  /** Ranked, biggest first. A repo with nothing in either directory is still a
   *  row: "this one is clean" is an answer, and a missing row reads as a repo
   *  the survey failed to see. */
  repos: TransportSurveyRow[];
  /** Every repo's bytes, or null when any row is uncounted. */
  total: SweepTally | null;
  /** True when at least one row could not be counted — the flag that lets a
   *  screen say "at least this much" instead of quietly under-reporting. */
  partial: boolean;
}

/** A row's two directories together, or null when either is unknown. Used for
 *  the RANKING only — never drawn as a tap target, because tapping it could not
 *  say which scope it meant. */
export function rowBytes(r: TransportSurveyRow): number | null {
  if (!r.outbox || !r.inbox) return null;
  return r.outbox.bytes + r.inbox.bytes;
}

/**
 * Rank the rows and total them, in one place so the order and the sum cannot
 * come from two different readings.
 *
 * Uncounted rows sort LAST — a row with no number cannot claim a place in a
 * ranking of numbers — and any of them turns the total null.
 */
export function summarizeSurvey(rows: readonly TransportSurveyRow[]): { repos: TransportSurveyRow[]; total: SweepTally | null; partial: boolean } {
  const sorted = [...rows].sort((a, b) => (rowBytes(b) ?? -1) - (rowBytes(a) ?? -1));
  let count = 0;
  let bytes = 0;
  let partial = false;
  for (const r of sorted) {
    if (!r.outbox || !r.inbox) { partial = true; continue; }
    count += r.outbox.count + r.inbox.count;
    bytes += r.outbox.bytes + r.inbox.bytes;
  }
  return { repos: sorted, total: partial ? null : { count, bytes }, partial };
}

/** The line above the list. Says the total AND, when anything is uncounted,
 *  that it is a floor rather than a figure. */
export function surveyHeadText(s: TransportSurvey): string {
  const n = s.repos.length;
  const repos = `${n} repo${n === 1 ? "" : "s"}`;
  if (!s.total) {
    return `${repos}. Some directories could not be counted, so there is no total — the rows that answered are below.`;
  }
  if (!s.total.count) return `${repos}, and nothing in any transport directory.`;
  return `${s.total.count} file${s.total.count === 1 ? "" : "s"} · ${fmtBytes(s.total.bytes)} across ${repos}.`;
}

/** What one scope's chip says. A count and its bytes, never one without the
 *  other, and "not counted" said as itself. */
export function scopeChipText(t: SweepTally | null): string {
  if (!t) return "not counted";
  if (!t.count) return "empty";
  return `${t.count} · ${fmtBytes(t.bytes)}`;
}

// ── The daemon's own store ──────────────────────────────────────────────────

/**
 * What kind of thing a file under the root's state dir is — which decides whether a
 * phone may remove it, and what the row says when it may not.
 *
 * `cache` — re-made on demand by whoever owns it. The only kind that is free.
 * `rollback` — a one-time copy taken by a migration, kept in case the migration
 *   was wrong. Useful for as long as the thing it shadows has not moved on.
 * `ledger` — an append-only record. Deleting it is a loss of HISTORY, not a
 *   cache miss, so it is reported and never offered.
 * `live` — state the daemon is using right now (the intent ledger, the ack
 *   memory, session stores). Removing one is not slow, it is wrong.
 * `unknown` — a file this catalogue does not name. Reported with its bytes,
 *   never touched: a sweep that removes what it cannot identify is a sweep that
 *   removes the next feature's store.
 */
export type HostStoreKind = "cache" | "rollback" | "ledger" | "live" | "unknown";

export const HOST_STORE_KIND_LABEL: Record<HostStoreKind, string> = {
  cache: "cache — re-made when it is next needed",
  rollback: "migration leftover — a copy kept in case the upgrade was wrong",
  ledger: "record — history, not a cache",
  live: "in use — the daemon is reading this now",
  unknown: "not in this app's catalogue",
};

/** One entry of the store, as a row. Structurally the phone's own `StoreUse`
 *  where it overlaps, so `StorageSheet` draws both with one component. */
export interface HostStoreRow {
  /** Catalogue id — and the ONLY thing a clear request carries. No path from a
   *  client ever reaches the filesystem here (`host/hoststore.ts` states the
   *  full guard). */
  id: string;
  label: string;
  kind: HostStoreKind;
  count: number;
  /** Bytes, or null when it could not be measured. Never 0 for an unknown. */
  bytes: number | null;
  /** What removing it would cost — required, even for a cache. */
  cost: string;
  /** Why there is no clear button. A blocked verb is a sentence, never a dimmed
   *  control; for a bounded ledger this names the bound, which is the fact that
   *  makes the row readable as "already handled". */
  cant?: string;
}

export interface HostStoreReport {
  at: number;
  /** The directory itself, so the screen can say WHERE this is — a person
   *  reading it on a phone has no other way to know. */
  dir: string;
  rows: HostStoreRow[];
  total: number | null;
  partial: boolean;
}

/** The rows a phone may actually act on — one predicate, so the count on the
 *  section header and the buttons below it cannot disagree. */
export function clearableRows(rows: readonly HostStoreRow[]): HostStoreRow[] {
  return rows.filter((r) => !r.cant && r.count > 0);
}

/** Sum what is on the report, or null if anything is unmeasured. */
export function hostStoreTotal(rows: readonly HostStoreRow[]): { total: number | null; partial: boolean } {
  let total = 0;
  let partial = false;
  for (const r of rows) {
    if (r.bytes == null) partial = true;
    else total += r.bytes;
  }
  return { total: partial ? null : total, partial };
}

/** What a clear button says — the whole decision restated, `sweepButtonText`'s
 *  rule. */
export function hostStoreButtonText(r: HostStoreRow): string {
  if (!r.count) return `Nothing in ${r.label}`;
  return r.bytes == null
    ? `Clear ${r.label} · ${r.count}`
    : `Clear ${r.label} · ${r.count} · ${fmtBytes(r.bytes)}`;
}

/** What a clear DID. `SweepOutcome`'s shape and `sweepResultText`'s split:
 *  "already gone" is the clear succeeding by another route, "could not be
 *  removed" is bytes still on disk under a message that says done. */
export interface HostStoreOutcome {
  deleted: number;
  bytes: number;
  /** Files the clear refused or could not unlink. Named, never counted alone. */
  failed: number;
  /** A refusal of the whole request — an unknown id, a kind that is never
   *  clearable. Said in words, and then nothing was touched. */
  refused?: string;
}

export function hostStoreResultText(label: string, o: HostStoreOutcome): string {
  if (o.refused) return o.refused;
  const parts: string[] = [];
  parts.push(o.deleted
    ? `Cleared ${o.deleted} file${o.deleted === 1 ? "" : "s"} · ${fmtBytes(o.bytes)} from ${label}.`
    : `${label} was already empty.`);
  if (o.failed) parts.push(`${o.failed} could not be removed — still on disk.`);
  return parts.join(" ");
}
