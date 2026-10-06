/** A slice of smartpick.ts — moved whole from smartpick.ts, see docs/notes/smartpick-architecture.md (host). */
import { env } from "../env.js";

// ── The knobs ───────────────────────────────────────────────────────────────

/** The model the claude engine runs on. `.env.example` carries the why. */
export const SMARTPICK_MODEL = env("SMARTPICK_MODEL") || "haiku";

/**
 * How long the pass may take before the item fires anyway.
 *
 * Deliberately not the sidecar's 120 s: a person's next backlog item is held
 * behind this call. On expiry the hold is released, a `timeout` record is
 * written against the same fingerprint, and the next tick fires the order the
 * repo already had.
 */
export const SMARTPICK_TIMEOUT_MS = Math.max(100, Number(env("SMARTPICK_TIMEOUT_MS") || 20_000));

/**
 * The floor between two passes for one repo.
 *
 * Belt-and-braces, and it should never fire: a pass records the fingerprint of
 * the state it LEFT BEHIND, so the confirming tick reads "nothing changed" and
 * spends nothing. If it ever does fire it means a pass's own result keeps moving
 * the fingerprint, which without this floor is a repo buying a completion per
 * tick for ever — so the guard exists, and it SAYS so in the strip rather than
 * skipping quietly.
 */
export const SMARTPICK_MIN_INTERVAL_MS = Math.max(0, Number(env("SMARTPICK_MIN_INTERVAL_MS") || 15_000));

/**
 * How long a row NOBODY TYPED waits before it may be the one that fires.
 *
 * The safety case for applying a merge automatically rests on `undo` being
 * there, and it was not: the pass picks and applies in the same breath, the
 * merged row may be the pick, and the tick right behind the apply fires it — so
 * a person who was asleep met *"it has already run"* instead of the button the
 * notification had just promised them. A merged row therefore wears its own
 * short hold, and the item that fires is one somebody wrote.
 *
 * Small on purpose: the whole cost of the hold is that a repo's next item
 * starts this much later, and the guarantee it buys is only "the pick was not
 * written by a machine in the last half minute". The post-run `unmerge`
 * (see `undo`) is what covers the sleeper; this covers the person who is awake
 * and reading the notification.
 */
export const MERGE_HOLD_MS = Math.max(0, Number(env("SMARTPICK_MERGE_HOLD_MS") || 30_000));

/** How long repo facts are reused. Long enough that the confirming tick after
 *  an apply pays no second `git` spawn, short enough that a commit made while
 *  an agent works is seen by the next pick. */
export const FACTS_TTL_MS = 5_000;

/** An item past the character budget goes in as its first few hundred
 *  characters, marked `clipped` — sortable, never mergeable. */
export const CLIP_CHARS = 240;

/** Dirty paths in the prompt, capped. Past this the count of the rest is
 *  appended, because "and 200 more" is a fact and a truncated list is a lie. */
export const MAX_DIRTY = 40;

/** Passes kept per repo, and undone merges remembered per repo. Both are lists
 *  a person reads or a sanitiser scans, not an audit trail. */
export const MAX_PASSES = 10;
export const MAX_REFUSED = 50;

/**
 * Merges kept per host, newest first.
 *
 * `passes` and `refused` were capped from the start and this was not: one record
 * per merge, for the life of the desktop. A record is small, but "grows for
 * ever" is not a property a store on a machine that runs for months may have.
 *
 * Evicted OLDEST first and never while it is `applying` — that state is boot's
 * to-do list and dropping one would leave a half-applied merge nothing will ever
 * finish. What an eviction costs is the *put them back* button on a merge this
 * old: the originals are still in the store, archived, with every word they had.
 */
export const MAX_MERGES = 200;