import {
  type BlockReason,
  type FanoutRun,
  INTENT_BLOCK_ORDER,
  fanoutRuns,
} from "@waterplane/shared";
import {
  dismissBlocker,
} from "./activityBulk.ts";
import {
  intentRow,
} from "./activityIntentRow.ts";
import {
  act,
} from "./activityPieces.ts";
import {
  pullRow,
} from "./activityPullRow.ts";
import {
  queueRow,
} from "./activityQueueRow.ts";
import type { ActivityBucket, ActivityInput, ActivityRow } from "./activityTypes.ts";

// ── Bucketing and ranking ───────────────────────────────────────────────────

// Which chip a row lands under is `bucketOf`, in `activityBucket.ts`: the row
// builders imported below stamp it, so here it would close an import cycle.

/** Bucket order, and it is an argument about attention: things a person must
 *  decide, then things that broke, then things happening, then things waiting,
 *  then the future, then history. */
const BUCKET_RANK: Record<ActivityBucket, number> = {
  needsYou: 0, failed: 1, running: 2, waiting: 3, scheduled: 4, done: 5,
};

/** Within `waiting`, several rows blocked for several reasons: the shared
 *  precedence, ordered by what the user can DO about it. */
const REASON_RANK = new Map<BlockReason, number>(INTENT_BLOCK_ORDER.map((r, i) => [r, i]));

export function compareActivity(a: ActivityRow, b: ActivityRow): number {
  const bucket = BUCKET_RANK[a.bucket] - BUCKET_RANK[b.bucket];
  if (bucket) return bucket;
  // The future sorts forwards — the next thing to happen is the one worth
  // seeing first — and everything else sorts backwards, newest on top.
  if (a.bucket === "scheduled") {
    const da = a.dueAt ?? Number.MAX_SAFE_INTEGER;
    const db = b.dueAt ?? Number.MAX_SAFE_INTEGER;
    if (da !== db) return da - db;
  }
  if (a.bucket === "waiting" || a.bucket === "needsYou") {
    const ra = a.blockReason ? REASON_RANK.get(a.blockReason) ?? 99 : 99;
    const rb = b.blockReason ? REASON_RANK.get(b.blockReason) ?? 99 : 99;
    if (ra !== rb) return ra - rb;
  }
  return b.at - a.at;
}

// ── The selector ────────────────────────────────────────────────────────────

/**
 * Every posted piece of work, as one ranked list.
 *
 * Pure: same inputs, same output, no clock of its own. `now` is a parameter for
 * the same reason `launchVerdict` and `nextFireAt` take one — a rule that reads
 * the clock cannot be pinned by a test, and every deadline in this app is
 * absolute rather than a duration precisely so a restart cannot restart it.
 */
export function activityRows(input: ActivityInput): ActivityRow[] {
  const rows: ActivityRow[] = [];
  for (const e of input.outbox ?? []) rows.push(queueRow(e, input));

  const intents = input.intents ?? [];
  // Sweeps are rebuilt ONCE for the whole list, not per row: `fanoutRuns` walks
  // every intent to group by `groupId`, so calling it inside the loop would be
  // quadratic in a list this screen exists to make long.
  const runs = new Map<string, FanoutRun>();
  for (const r of fanoutRuns(intents)) runs.set(r.id, r);

  // A launch's id IS the create op's ackId. While the create is still in the
  // send queue both ledgers hold it, and it is ONE thing that happened —
  // drawing it twice is the exact failure this screen exists to end. The host's
  // row wins: it is the later state of the same work, and it is the one that
  // says what is actually being waited for.
  const queuedAcks = new Set((input.outbox ?? []).map((e) => e.ackId));

  for (const i of intents) {
    // Archived is the store's own "I have seen this" mark. A row that never
    // vanishes is the rule; a row the user explicitly filed away is the
    // exception they asked for.
    if (i.archived) continue;
    // A sweep is ONE row with its targets inside it. Its children — the
    // per-repo rows AND the follow-up rows — are folded into that row by
    // `fanoutRuns` (as `targets` and as `lastRun`), so only the PARENT gets a
    // row of its own. The parent is the one whose id IS the group id, which is
    // the same test `fanoutRuns` uses to find it.
    if (i.groupId != null && i.groupId !== i.id) continue;
    const run = i.groupId ? runs.get(i.groupId) ?? null : null;
    if (queuedAcks.has(i.id) && (i.state === "queued" || i.state === "blocked" || i.state === "starting")) {
      const at = rows.findIndex((r) => r.subject.source === "queue" && r.id === i.id);
      if (at >= 0) rows.splice(at, 1);
    }
    rows.push(intentRow(i, input, run));
  }

  for (const p of input.pulls ?? []) rows.push(pullRow(p, input));

  // Dismissal is stamped LAST and centrally: it is a decision about a row, and
  // no source knows about it. Doing it here rather than in the builders is
  // also what keeps "which rows exist" and "which rows the user is done with"
  // two separate questions — the list is complete, and the filter is what
  // shrinks it.
  const filed = input.dismissed;
  if (filed?.size) for (const r of rows) { const at = filed.get(r.key); if (at != null) r.dismissedAt = at; }

  // Same centrally-stamped shape, for the other decision a person can make
  // about a row the desktop's own detector never settled: it DID run. Bucket
  // and state move to `done` — this is the fact the row is now filed under,
  // same as any other resolved row — but `verdict` says WHOSE finding this is
  // rather than pretending the desktop confirmed it, and `delivery` is left
  // exactly as it was: still a true fact about what the desktop itself
  // established, not something a person's tap gets to overwrite.
  const confirmed = input.confirmedDone;
  if (confirmed?.size) for (const r of rows) {
    const at = confirmed.get(r.key);
    if (at == null) continue;
    r.confirmedDoneAt = at;
    r.bucket = "done";
    r.state = "done";
    r.blockReason = null;
    r.verdict = `you marked this done ${new Date(at).toLocaleString()} — the desktop's own check never confirmed it`;
  }

  // Same reason: "not now, but keep it" is a decision about a row, not a fact
  // any of the eight builders has an opinion on, so it is one line here rather
  // than eight copies of `act("dismiss", …)`. `dismissBlocker` is the same
  // rule the bulk button already enforces — a row that is actually moving
  // says so instead of offering to file it.
  for (const r of rows) r.actions.push(act("dismiss", "save for later", { disabledReason: dismissBlocker(r) ?? undefined }));

  return rows.sort(compareActivity);
}

/** Chip catalog. Labels live here so the sheet cannot invent an eighth. */
