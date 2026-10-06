/**
 * One posted piece of work, one row, for its whole life.
 *
 * ── Why this file exists ────────────────────────────────────────────────────
 *
 * "Did my prompt run?" has no answer screen in this app. A single piece of work
 * migrates between SEVEN partial ledgers as it progresses, and each of them was
 * written to answer a different question:
 *
 *   • the send queue (`QueueSheet`)      — "what is this phone still holding?"
 *   • the host's launch gate             — "what is the desktop holding for me?"
 *   • the give-ups list, buried three    — "what stopped, days ago?"
 *     sections down `NetHealthSheet`
 *   • the backlog (`Backlog`)            — "what is queued for this repo?"
 *   • the schedule list                  — "what fires on Thursday?"
 *   • the fan-out runs                   — "how did that sweep go?"
 *   • the build runs                     — "did the APK come out?"
 *   • the download queue (`PullSheet`)   — "is the APK on the phone yet?"
 *
 * Every one of them is honest about its own half. Together they are a shell
 * game: a prompt typed into the compose bar is a queue row, then it is nothing
 * (delivered, forgotten), then — if the delivery could not be confirmed — it is
 * a red row for an hour, and then it WAS a pad note and a ledger line in a
 * network diagnostics sheet (neither retirement exists any more; the row keeps
 * its own words). Four surfaces, four vocabularies, and at no point does any
 * one of them show the whole life. The user's words for it were: *"I need
 * details for these 39. What was it…"*, and *"Is or was this blocked by
 * something that was not sent?"* — both of which are questions about a row that
 * no longer exists anywhere.
 *
 * So: ONE ranked list, and the rule a row obeys is that it never vanishes on a
 * state change. It changes VERDICT. A prompt that is queued, then sending, then
 * unconfirmed, then settled-absent, then re-sent is one row that said five
 * different things — not five rows in five sheets, four of which are empty by
 * the time anybody looks.
 *
 * ── Why the vocabulary is `@waterplane/shared`'s and not this file's ──────────────
 *
 * `shared/intent.ts` is where deferred work is going: one durable host-side
 * Intent with one `Lifecycle`, one `BlockReason` set and one sentence-writer
 * (`intentReasonText`). This selector is deliberately written against that
 * vocabulary NOW, while the seven sources still speak their own — so the
 * mapping from each source's words onto the shared ones lives in exactly one
 * place (here), and the day a source starts emitting an `Intent` its arm in
 * this file collapses to a passthrough rather than the view having to learn a
 * ninth dialect.
 *
 * ── Four rules this file carries, each of which already exists elsewhere ────
 *
 * 1. **The backlog's waiting reason is HOST-COMPUTED.** `BacklogManager.waiting()`
 *    publishes *why* a queued item is queued, derived from the same ladder that
 *    decides. It is displayed verbatim and never re-derived — a parallel
 *    explanation drifts from the behaviour it explains, which is worse than
 *    silence. (`shared/queue.ts` says the same thing about `SendPlan.blocked`,
 *    which is why the queue's block reason is an INPUT here and not a
 *    recomputation.)
 * 2. **A cached or last-known row says how old it is.** `useRemoteResource`'s
 *    rule. Host-sourced rows carry `asOf` whenever the socket is down; the
 *    phone's own rows never do, because they are not cached — they are the
 *    original.
 * 3. **A disabled action always carries a reason.** Structurally: `disabled` is
 *    not a boolean here, it is `disabledReason`, so an action cannot be greyed
 *    out without saying why.
 * 4. **`unknown` is not `healthy`, and "the host refused this" is not "the host
 *    was unreachable".** `DeliveryTruth` is a SEPARATE axis from `Lifecycle` —
 *    mixing the two is how `unconfirmed` became a terminal state — and it has a
 *    distinct member for each of those three, with no default that collapses
 *    them.
 * 5. **A row knows the repo its words were written for**, so a retry needs no
 *    picker. Every source here already carries a `cwd`; nothing used it.
 *
 * ── Purity ─────────────────────────────────────────────────────────────────
 *
 * No DOM, no `Date.now()`, no `localStorage`, no imports from `./outbox` or
 * `./pull` beyond `import type` (which the compiler erases).
 * That is not tidiness: `./outbox` reaches `./settings`, which PATCHES
 * `localStorage.setItem` at module load, so a value import here would make the
 * rule untestable outside a browser. Everything the rule cannot know about a
 * queue entry or a pad note arrives as an injected predicate on `deps` —
 * exactly the shape `NetHealthSheet` already uses for `hasNote`/`canRetry`.
 *
 * ── This file is the BARREL ──────────────────────────────────────────────
 *
 * The rules live in `activity/`, one file per subject, and every caller keeps
 * importing `./activityRows` (the test imports `./activityRows.ts`, and must
 * pass untouched). Each basename is unique across `packages/`. What each holds:
 *
 *   activityTypes.ts        the model: `ActivityRow`, `ActivityInput`, the
 *                           buckets, actions and subjects — types only
 *   activityPieces.ts       the small shared pieces: row keys, `clip`, the
 *                           action constructor, the recorded-failure sentence
 *   activityQueueRow.ts     the phone's own send queue, one row per entry
 *   activityIntentWords.ts  an intent's kind, title and verdict sentences
 *   activityIntentRow.ts    one intent, one row (never five builders again)
 *   activityPullRow.ts      a download on its way to the phone
 *   activitySelect.ts       bucketing, the ranking, and `activityRows` itself
 *   activityFilters.ts      the chips, the counts, the headline
 *   activityTriage.ts       same-words grouping, debris, sort
 *   activityBulk.ts         what a bulk verb may act on, and its confirmation
 *
 * `tools/activitypins.test.mjs` pins this barrel's export list off the type
 * checker and the row builders' output over a matrix, so neither can drift in
 * a later cut.
 */
export type {
  ActivityAction,
  ActivityActionId,
  ActivityBucket,
  ActivityDeps,
  ActivityFilter,
  ActivityInput,
  ActivityKind,
  ActivityRow,
  ActivitySource,
  ActivitySubject,
  ActivityTarget,
  DeliveryTruth,
} from "./activity/activityTypes.ts";
export {
  SMARTPICK_ORIGIN,
  entryProse,
  intentRowKey,
  onlyUploadsFailed,
  queueRowKey,
  restorableFailed,
} from "./activity/activityPieces.ts";
export {
  intentTitle,
} from "./activity/activityIntentWords.ts";
export {
  activityRows,
  compareActivity,
} from "./activity/activitySelect.ts";
export {
  ACTIVITY_FILTERS,
  activityCounts,
  activityHeadline,
  matchesFilter,
} from "./activity/activityFilters.ts";
export {
  activityTextKey,
  groupActivity,
  isActivityDebris,
  sortActivity,
} from "./activity/activityTriage.ts";
export type {
  ActivityGroup,
  ActivitySort,
} from "./activity/activityTriage.ts";
export {
  bulkLines,
  dismissBlocker,
  partitionBulk,
  refireBlocker,
} from "./activity/activityBulk.ts";
