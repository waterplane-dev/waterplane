/**
 * What the daemon's global state dir (`hostStateDir`, once `<root>/<state dir>`) holds, by owner and by bound — and the two parts of it a
 * phone may remove.
 *
 * ── Why the READING is most of the point ────────────────────────────────────
 *
 * Measured on this desktop: 28 MB, of which 21 MB is the thumbnail cache. That
 * is not a lot, and the interesting half of the answer is WHY it is not a lot —
 * almost everything in here is already bounded by whoever writes it:
 * `sentlog.ts` a 1000-entry ring, `decisionlog.ts` a 500-entry ring,
 * `limit-events.jsonl` a 256 KB rotation, `usagelog.ts` 5000 rows / 30 days,
 * `history/`, `summaries/` and `ctxseries/` a boot sweep behind a 7-day gate and an
 * alive-set guard, `thumbs/` a 256 MB prune.
 *
 * So this module is not a second eviction policy — it is the report that makes
 * those bounds visible, and the one finding inside it: `tokenstats.json` is the
 * file with no bound of its own (2.2 MB and growing), which nothing said out
 * loud before.
 *
 * ── What may be removed, and what may not ───────────────────────────────────
 *
 *  - `thumbs/` — a cache. Its owner re-makes it and already prunes it; a clear
 *    costs one `sips` per picture the gallery next shows.
 *  - migration leftovers (`*.json.bak`, `*.json.migrated`) — copies a one-time
 *    upgrade took in case it was wrong. The file each one shadows has been
 *    rewritten hundreds of times since; they are the only bytes here a person
 *    cannot otherwise get rid of.
 *  - **everything else is reported and never offered.** A ledger is history,
 *    not a cache: deleting `usagelog.jsonl` does not cost a re-read, it costs
 *    the record. Live state (`intents.json`, `acks.json`, the session stores)
 *    is worse than slow to lose — `acks.json` IS the at-most-once memory, so
 *    removing it can make a queued prompt run twice. Each of those rows carries
 *    a `cant` naming its own bound, which is what makes the row readable as
 *    "already handled" rather than as something the screen forgot to offer.
 *  - **a file this catalogue does not name is `unknown`**: counted, shown, and
 *    never touched. A sweep that removes what it cannot identify is a sweep
 *    that removes the next feature's store.
 *
 * ── Containment, exactly ────────────────────────────────────────────────────
 *
 * This directory is NOT inside a repo worktree, so `contained(worktree, rel)` —
 * the guard every transport delete goes through — does not apply and is
 * deliberately not used. What guards it instead:
 *
 *  - **No path arrives from the client.** A clear request carries a catalogue
 *    id and an instant, nothing else. Every filename is derived here.
 *  - The directory is `hostStateDir(root)` (`branddirs.ts`), the directory
 *    every store constructor in this daemon writes under, with `root` the
 *    daemon's own configured root and never a request field.
 *  - A name is matched against a strict regex per kind and **refused, never
 *    sanitised** (`sessions/knobs.ts`' `STORE_FILE_RE` posture) — so `..json.bak`
 *    is not a leftover, it is a non-match.
 *  - `lstat`, files only, symlinks skipped, no recursion into anything the
 *    catalogue does not name.
 *  - `inRoot(dir, full)` as the realpath-resolving belt, because the dir
 *    itself may be a symlink and the two guards in `paths.ts` exist precisely
 *    so this one does not have to guess which kind it needs.
 *
 * **Nothing applies itself**: no clear on boot, on a timer or at a threshold.
 * The report is a list; a person taps one row and confirms.
 *
 * `packages/host/test/hoststore.test.mjs`.
 */
import { lstatSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { HostStoreOutcome, HostStoreReport, HostStoreRow } from "@waterplane/shared";
import { hostStoreTotal } from "@waterplane/shared";
import { hostStateDir } from "./branddirs.js";
import { inRoot } from "./paths.js";
import { clearThumbCache, thumbCacheUsage } from "./thumbs.js";

/** The store directory — the one every store constructor writes under. */
export function hostStoreDir(root: string): string {
  return hostStateDir(root);
}

/**
 * A migration's leftover copy.
 *
 * Anchored at both ends and with no separator in the stem, so nothing with a
 * path in it can match. `..json.bak` fails on the stem, which is the point of
 * writing it as a match rather than as a strip.
 */
const ROLLBACK_RE = /^[A-Za-z0-9_-]+\.json\.(bak|migrated)$/;

/**
 * Records with a bound their own writer enforces. The value is that bound, said
 * in the words the row shows — a `cant` that only says "no" teaches nothing,
 * and the whole value of this report is knowing which files are handled.
 */
const BOUNDED_LEDGERS: Record<string, string> = {
  "sent.json": "a 1000-entry ring — it cannot grow past that.",
  "decision-log.json": "a 500-entry ring — it cannot grow past that.",
  "limit-events.jsonl": "rotates itself at 256 KB.",
  "usagelog.jsonl": "capped at 5000 rows and 30 days.",
  "deliveries.json": "bounded by its own writer.",
  "ui-usage.json": "bounded by its own writer.",
  "netstats.json": "one rolling window, rewritten in place.",
  "usage-meter.json": "one rolling window, rewritten in place.",
  "localusage.json": "120 days per local model, rewritten in place.",
};

/** The unbounded record — the finding this report exists to surface. */
const TOKENSTATS = "tokenstats.json";

/** Directories the catalogue knows, and what they are. `thumbs` is handled by
 *  its owner (`thumbs.ts`) and never walked here. */
const KNOWN_DIRS: Record<string, "live"> = {
  history: "live",
  summaries: "live",
  /** A source session's recorded context series (`sessions/ctxseries.ts`), swept with `history/`. */
  ctxseries: "live",
  live: "live",
  /** Each plugin's `settings.json` and its own `dataDir` (`plugins/pluginregistry.ts`). */
  plugins: "live",
};

/** Bytes and files directly inside one flat directory. Files only, symlinks
 *  skipped, no recursion — every directory this is called for is flat by
 *  construction, and a nested one would be something this catalogue does not
 *  know about. */
function flatUsage(dir: string): { count: number; bytes: number } | null {
  try {
    let count = 0;
    let bytes = 0;
    for (const n of readdirSync(dir)) {
      const full = join(dir, n);
      try {
        const st = lstatSync(full);
        if (!st.isFile()) continue;
        count++;
        bytes += st.size;
      } catch { /* raced */ }
    }
    return { count, bytes };
  } catch {
    return null;
  }
}

/**
 * Files the daemon is actively using. A fixed list rather than "everything not
 * matched above", because the fallback for an unrecognised name must be
 * `unknown` — a new store that lands in `live` by default would be described to
 * a person as something it may not be, and a new store that landed in
 * `rollback` by default would be deleted.
 */
const LIVE_FILES = new Set([
  // Dotfiles included: `readdirSync` returns them, and `.env` in particular
  // must land here rather than in `unknown`. It is the most sensitive file in
  // the directory, `unknown` is already unclearable so nothing was ever at
  // risk — but a row reading "not in this catalogue" about the daemon's own
  // credentials is a sentence that invites somebody to go and look.
  ".env",
  // `branddirs.ts` boot move: where this dir came from, so an interrupted move can be finished.
  "moved-from.json",
  // `oracle.json` is the retired in-core oracle's config: kept, because the
  // oracle PLUGIN reads it once to seed its own settings.
  "acks.json", "assess.json", "auth.json", "backend-catalogue.json", "backlog-config.json", "backlog.json",
  "budget.json", "burnwatch.json", "clihealth.json", "closed.json", "contextlimits.json", "ctxwindow.json",
  "installs.json", "intents-archive.jsonl", "intents.json", "launches.json", "limit.json",
  "notify.json", "oracle.json", "peer-jobs.json", "plugins.json", "pulls.json", "push-subs.json", "reviews.json",
  "schedules.json", "sessions.json", "settings.json", "setup.json",
  "stars.json", "tmux.conf", "updates.json", "vapid.json",
]);

/** Fold a bucket of files into one row. A row per file would be forty rows
 *  nobody reads; a row per KIND is the reading a person actually wants. */
interface Bucket { count: number; bytes: number; known: boolean }

/**
 * What the store holds, as rows.
 *
 * Never throws: an unreadable store answers an empty report with `partial`, the
 * way every other reading in this daemon degrades to absent rather than to a
 * wrong number.
 */
export function hostStoreReport(root: string, now = Date.now()): HostStoreReport {
  const dir = hostStoreDir(root);
  const rollback: Bucket = { count: 0, bytes: 0, known: true };
  const ledgers: Bucket = { count: 0, bytes: 0, known: true };
  const live: Bucket = { count: 0, bytes: 0, known: true };
  const unknown: Bucket = { count: 0, bytes: 0, known: false };
  let tokenstats: { count: number; bytes: number } | null = null;
  let readable = true;

  let names: string[] = [];
  try { names = readdirSync(dir); } catch { readable = false; }

  for (const n of names) {
    const full = join(dir, n);
    let st;
    try { st = lstatSync(full); } catch { continue; }
    // A symlink in here is not this daemon's, and following one is how a walk
    // of a private directory becomes a walk of somewhere else.
    if (st.isSymbolicLink()) continue;
    if (st.isDirectory()) {
      if (n === "thumbs") continue;               // its owner reports it
      const usage = flatUsage(full);
      const bucket = KNOWN_DIRS[n] ? live : unknown;
      if (usage) { bucket.count += usage.count; bucket.bytes += usage.bytes; }
      continue;
    }
    if (!st.isFile()) continue;
    if (n === TOKENSTATS) { tokenstats = { count: 1, bytes: st.size }; continue; }
    const bucket = ROLLBACK_RE.test(n) ? rollback
      : BOUNDED_LEDGERS[n] ? ledgers
        : LIVE_FILES.has(n) ? live
          : unknown;
    bucket.count++;
    bucket.bytes += st.size;
  }

  const thumbs = thumbCacheUsage();
  const rows: HostStoreRow[] = [
    {
      id: "thumbs",
      label: "thumbnail cache",
      kind: "cache",
      count: thumbs?.count ?? 0,
      bytes: thumbs ? thumbs.bytes : null,
      cost: "The gallery re-makes each one the next time it shows that picture. Already pruned at 256 MB by its own writer — clearing is only about getting the space back sooner.",
    },
    {
      id: "rollback",
      label: "migration leftovers",
      kind: "rollback",
      count: rollback.count,
      bytes: rollback.bytes,
      cost: "Copies an upgrade took of a store before rewriting it. The live file has moved on many times since; these are here in case the upgrade was wrong.",
    },
    {
      id: "tokenstats",
      label: "token statistics",
      kind: "ledger",
      count: tokenstats?.count ?? 0,
      bytes: tokenstats?.bytes ?? 0,
      cost: "Every token this desktop has ever used, per day, model and repo.",
      // Reported and not offered, deliberately. It CAN be re-derived from the
      // CLI's own conversation logs — but only as far back as the CLI still
      // keeps them, so a rebuild silently shortens the history rather than
      // restoring it. That is a loss wearing a cache's clothes.
      cant: "it is the one store here with no bound of its own — and rebuilding it only reaches as far back as the CLI still keeps its logs, so a clear would quietly shorten the history.",
    },
    {
      id: "ledgers",
      label: "bounded records",
      kind: "ledger",
      count: ledgers.count,
      bytes: ledgers.bytes,
      cost: "Deliveries, usage, limit events, the decision log. History rather than cache.",
      cant: "each of these is already bounded by whoever writes it — a ring, a row cap or a size rotation — so none of them can grow without limit.",
    },
    {
      id: "live",
      label: "in use right now",
      kind: "live",
      count: live.count,
      bytes: live.bytes,
      cost: "The intent ledger, the ack memory, per-session stores, settings and credentials.",
      cant: "the daemon is reading these. Losing the ack memory can make a queued prompt run twice, which is worse than any amount of space.",
    },
    {
      id: "unknown",
      label: "not in this catalogue",
      kind: "unknown",
      count: unknown.count,
      bytes: unknown.bytes,
      cost: "Files this build does not recognise — a newer store, or something left by hand.",
      cant: "this screen will not remove what it cannot name.",
    },
  ];

  const { total, partial } = hostStoreTotal(rows);
  return { at: now, dir, rows, total, partial: partial || !readable };
}

/**
 * Remove one clearable row's files.
 *
 * `at` is the instant the report a person read was taken: nothing written since
 * goes. That is the same promise the transport sweep makes by sending its rows,
 * kept here with one number because the individual files were never the
 * decision — nobody chooses which thumbnails to keep.
 *
 * Refuses in words rather than silently doing nothing: an id that is not
 * clearable, or not a catalogue id at all, comes back as a sentence with
 * `deleted: 0`.
 */
export function clearHostStore(root: string, store: string, at: number): HostStoreOutcome {
  const dir = hostStoreDir(root);
  // Nothing below ever joins a client string onto this path. The directory is
  // the daemon's own global state dir (outside the code root since it moved —
  // `branddirs.ts`), so the realpath belt is per FILE: every removal must
  // resolve inside `dir` itself, which a symlinked state dir also passes.
  if (store === "thumbs") {
    const r = clearThumbCache(at);
    return { deleted: r.deleted, bytes: r.bytes, failed: r.failed };
  }
  if (store === "rollback") {
    const out: HostStoreOutcome = { deleted: 0, bytes: 0, failed: 0 };
    let names: string[];
    try { names = readdirSync(dir); } catch { return out; }
    for (const n of names) {
      // A match, never a strip: `..json.bak` fails the stem and is simply not a
      // leftover.
      if (!ROLLBACK_RE.test(n)) continue;
      const full = join(dir, n);
      let st;
      try { st = lstatSync(full); } catch { continue; }
      if (!st.isFile()) continue;
      if (st.mtimeMs > at) continue;
      if (!inRoot(dir, full)) { out.failed++; continue; }
      try { rmSync(full); out.deleted++; out.bytes += st.size; } catch { out.failed++; }
    }
    return out;
  }
  return {
    deleted: 0, bytes: 0, failed: 0,
    refused: `“${store}” is not something this screen removes. Only the thumbnail cache and the migration leftovers are ever cleared from here.`,
  };
}
