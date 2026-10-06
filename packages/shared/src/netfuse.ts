/**
 * The fuse on an HTTP request that never answers.
 *
 * A dead Tailscale path does not refuse a connection, it SWALLOWS it: the
 * socket stays open, no bytes come back, and `fetch` waits for as long as the
 * platform allows — minutes on Android, indefinitely in some WebViews. That
 * failure mode is indistinguishable from a slow request, and everything the
 * client does about being offline hangs off the fetch REJECTING: the reader's
 * cached transcript, the slash cache, the gallery's stale rows. With no fuse
 * those fallbacks are unreachable code exactly when they are the whole point —
 * the observed symptom was a reader parked on "loading transcript…" for as
 * long as anyone cared to watch, with a perfectly good cached document one
 * IndexedDB read away.
 *
 * Deliberately a wall-clock cap rather than `pull.ts`'s stall detector: these
 * are small JSON responses that arrive in one chunk, so "no answer within N
 * seconds" is the entire signal. Streaming transfers (auto-download, the speed
 * test) keep their own progress-based rules, and uploads run on XHR.
 *
 * Lives in `shared` for the same reason `queue.ts` and `promptid.ts` do: node
 * has `fetch`, so the rules can be PINNED by an e2e script against a real
 * server that hangs, instead of trusted to a comment.
 */

/** Generic budget for a JSON call. Long enough that a bad-but-alive link still
 *  completes, short enough that a dead one is reported while someone is still
 *  looking at the screen. */
export const FETCH_TIMEOUT_MS = 20000;
/** The reader polls, so its fuse is shorter than the generic one: a poll still
 *  pending when the next is due has already failed. */
export const TRANSCRIPT_TIMEOUT_MS = 12000;
/** Endpoints that run a real command against a repo (push over a slow uplink,
 *  checkout in a big tree) legitimately take minutes. The fuse exists to stop a
 *  DEAD link hanging forever, not to cap honest work — cutting a push at 20 s
 *  would report failure for something the host then completes, which is worse
 *  than the hang it replaced. */
export const SLOW_OP_TIMEOUT_MS = 180000;

export class TimeoutError extends Error {
  readonly url: string;
  readonly ms: number;
  constructor(url: string, ms: number) {
    super(`timed out after ${Math.round(ms / 1000)}s`);
    this.name = "TimeoutError";
    this.url = url;
    this.ms = ms;
  }
}

/**
 * True for the failures that mean "the host never answered", as opposed to a
 * status code. Callers use it to say "offline" where they would otherwise print
 * a stack trace at someone whose tunnel is down — the difference between
 * "TimeoutError: timed out after 12s" and "can't reach the host".
 * A 404/500 is NOT offline: the host answered, and the answer was no.
 */
export function isOffline(e: unknown): boolean {
  if (e instanceof TimeoutError) return true;
  if (e instanceof TypeError) return true;                 // fetch's transport failure
  const s = String(e);
  return s.includes("Failed to fetch") || s.includes("NetworkError") || s.includes("fetch failed");
}

/**
 * `fetch` that rejects with a `TimeoutError` if the host has not answered in
 * `ms`. Composes with a caller-supplied `signal` (uploads, cancel buttons):
 * an abort THEY caused stays their own error, so a cancel is never mislabelled
 * as a dead link. The timer is always cleared, so a phone holding a screen open
 * for an hour isn't holding a thousand live timers.
 *
 * The budget covers the RESPONSE HEADERS, which is what `fetch` resolves on —
 * a slow body that is actually streaming is not this function's problem.
 */
export async function timedFetch(
  url: string,
  init?: RequestInit,
  ms: number = FETCH_TIMEOUT_MS,
  doFetch: typeof fetch = fetch,
): Promise<Response> {
  const ac = new AbortController();
  const outer = init?.signal;
  const onOuterAbort = () => ac.abort();
  if (outer) {
    if (outer.aborted) ac.abort();
    else outer.addEventListener("abort", onOuterAbort, { once: true });
  }
  const timer = setTimeout(() => ac.abort(), ms);
  try {
    return await doFetch(url, { ...init, signal: ac.signal });
  } catch (e) {
    if (ac.signal.aborted && !outer?.aborted) throw new TimeoutError(url, ms);
    throw e;
  } finally {
    clearTimeout(timer);
    outer?.removeEventListener("abort", onOuterAbort);
  }
}
