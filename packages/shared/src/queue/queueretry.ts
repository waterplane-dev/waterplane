// Cut from queue.ts (move only): the retry contract
// The one door stays `./queue.js`; this slice imports its siblings directly, never the barrel.

/** Backoff floor/ceiling for a requeued entry. Doubling from 2 s to 60 s: fast
 *  enough that a blip costs one flush, slow enough that a permanently broken
 *  request stops being a busy-loop. */
export const RETRY_BACKOFF_MS = 2000;
export const RETRY_BACKOFF_MAX_MS = 60000;

/** When may an entry that just failed be tried again? */
export function retryDelay(tries: number): number {
  return Math.min(RETRY_BACKOFF_MAX_MS, RETRY_BACKOFF_MS * Math.pow(2, Math.max(0, tries - 1)));
}

/**
 * The floor under giving up: a delivery is never declared undelivered until it
 * has been TRYING for at least this long.
 *
 * The attempts cap alone is a count, and a count is not a duration. Eight
 * receipt windows on a bad radio — each one a socket that went away mid-flight,
 * none of them a host that said no — could run out inside a few seconds of
 * wall-clock and put a red "delivery kept failing" row on screen while the link
 * was still coming back. From the phone that reads as a fatal verdict on words
 * you just typed, and it is nothing of the kind.
 *
 * So the two bounds are ANDed: the host must have refused it `maxAttempts`
 * times AND a minute must have passed since the first attempt. Past that the
 * entry still does not die — see `roundDelay`.
 */
export const MIN_TRY_MS = 60_000;

/**
 * How long an entry waits before trying the whole attempts ladder AGAIN.
 *
 * Exhausting the ladder means the host never answered — a refusal it did
 * answer is failed by the client on the spot and never reaches here. "Never
 * answered" is a statement about the link, and a link that is down now is the
 * one condition this queue exists to ride out, so the answer is to wait longer,
 * not to stop: 5 minutes, doubling, capped at half an hour, for ever.
 *
 * Safe to repeat because delivery is keyed on `ackId` in the host's durable
 * Intent store — a re-send of something it already ran is re-acked, never typed
 * twice. Do not raise the cap without checking that ledger still outlives it.
 */
export const RETRY_ROUND_MS = 5 * 60_000;
export const RETRY_ROUND_MAX_MS = 30 * 60_000;

export function roundDelay(round: number): number {
  return Math.min(RETRY_ROUND_MAX_MS, RETRY_ROUND_MS * Math.pow(2, Math.max(0, round - 1)));
}

/**
 * Did this failed upload attempt actually PROVE anything about the file?
 *
 * `MAX_SEND_ATTEMPTS` exists to stop retrying something the host keeps
 * rejecting. It must never be spent on the link being down, because riding out
 * a dead link is the queue's entire job — and eight attempts on the client's
 * 5 s sweep is under a minute, so a host restart (or a tunnel blip) could burn
 * the budget and fail an image outright while the network was fine either side
 * of it.
 *
 * Only an ANSWER counts. A status — any status, including a 500 — means the
 * host heard this upload and decided; a transport error means nobody decided.
 * `socketOpen` is deliberately not sufficient on its own: a host being
 * restarted kills the POST a moment before its WebSocket close event lands, so
 * the socket still reads "open" for exactly the window in which uploads die.
 * A stall is wasted too — the client aborted it, so there is no verdict.
 */
export function uploadAttemptWasted(o: { responded?: boolean; stalled?: boolean; socketOpen: boolean }): boolean {
  return !!o.stalled || !o.responded || !o.socketOpen;
}
