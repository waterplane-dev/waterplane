/**
 * One host read, told honestly — including when it is not a host read at all.
 *
 * Every sheet that lists something from the daemon had written the same five
 * pieces of state (`loading`, `err`, the rows, the cached copy, when the cached
 * copy was taken) and the same effect around them. Twenty-six sheets, twenty-six
 * slightly different answers to the question this app is actually about: what do
 * you show when the tunnel is down?
 *
 * The rule the codebase states in several places — "cached rows always say how
 * old they are", "with the socket down, status is labelled *last known*" — is
 * exactly the kind that survives being written once and rots when it is written
 * twenty-six times. One sheet forgetting the age label is not a crash; it is a
 * screen quietly claiming to be current, which is worse, and it is invisible in
 * review because the sheet looks finished.
 *
 * So: the cache is seeded FIRST (paint immediately, offline or not), the live
 * read replaces it, and `state` never lets the two be confused.
 *
 *   fresh   — this came from the host just now
 *   cached  — this came from the cache; `age` is how old, and it is not optional
 *   loading — nothing to show yet, and a request is out
 *   error   — the host answered, and said no
 *   offline — the request could not be made or could not be answered
 *
 * `error` and `offline` are deliberately separate: "the host refused this" and
 * "the host was not reachable" lead to different next actions, and collapsing
 * them is how a permissions problem gets read as a bad tunnel for a week.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { isOffline } from "./api";
import { agoText } from "./format";
import { linkOnline } from "./link";

export type ResourceState = "loading" | "fresh" | "cached" | "error" | "offline";

export interface RemoteResource<T> {
  data: T | null;
  state: ResourceState;
  /** How old the CACHED copy is, in ms. Null whenever `state !== "cached"` —
   *  a fresh document has no age worth saying, and saying one anyway is the
   *  bug this hook exists to prevent. */
  age: number | null;
  /** The host's own words when `state === "error"`. */
  error: string | null;
  /**
   * A read is out RIGHT NOW.
   *
   * Deliberately not `state === "loading"`, which is a different fact: that one
   * means "nothing to show yet", so it is set only by the first read and by a
   * NON-quiet `reload`. Every refresh button in this app re-reads quietly (or
   * by moving the key), because blanking a document somebody is looking at to
   * prove a request went out is worse than the wait — and so every one of them
   * was reading a flag that, after the first paint, is never true again. A
   * button that cannot tell whether it is running is the same defect whether it
   * spends that on a spinner or on a `disabled` attribute.
   */
  inflight: boolean;
  /** Re-read from the host. `quiet` keeps whatever is on screen while it runs,
   *  for a background refresh that must not blank the list. */
  reload: (opts?: { quiet?: boolean }) => void;
  /** Replace the data locally — an optimistic edit, or a row removed. Does not
   *  touch `state`: what is on screen is still as fresh as it was. */
  set: (next: T | null) => void;
}

export interface RemoteResourceOpts<T> {
  /** Skip entirely (a sheet whose repo is not chosen yet). Stays `loading`. */
  enabled?: boolean;
  /**
   * Don't even attempt the read.
   *
   * The link signal this app trusts is the SOCKET, not `navigator.onLine` —
   * which stays true while the Tailscale path is dead, i.e. during exactly the
   * failure every offline path here exists for. A caller that already knows the
   * socket is down passes it, and the cache is served without spending a
   * request that can only time out.
   */
  offline?: boolean;
  /** Read the cached copy. Resolve null when there isn't one. */
  fromCache?: () => Promise<{ value: T; savedAt: number } | null>;
  /** Store what the host returned. Failures here are swallowed — a cache that
   *  cannot be written is not a reason to fail a read that succeeded. */
  toCache?: (value: T) => void | Promise<void>;
}

/**
 * @param key   Re-reads whenever this changes; also what a late response is
 *              matched against, so a slow answer for a repo you have navigated
 *              away from is dropped instead of painting over the new one.
 * @param fetcher Performs the read. Should reject on transport failure and
 *              throw on a refusal — the two are told apart by `isOffline`.
 */
export function useRemoteResource<T>(
  key: string,
  fetcher: () => Promise<T>,
  opts: RemoteResourceOpts<T> = {},
): RemoteResource<T> {
  // Default to the store's ONE online fact rather than making every caller
  // re-derive it from a socket handle: `navigator.onLine` stays true while the
  // Tailscale path is dead, and a `readyState` stays OPEN under a tunnel that
  // has already died. This was the fourth independent derivation of "am I
  // online" in this app, which is three too many — a caller may still override.
  const { enabled = true, offline: forcedOffline = !linkOnline(), fromCache, toCache } = opts;
  const [data, setData] = useState<T | null>(null);
  const [state, setState] = useState<ResourceState>("loading");
  const [age, setAge] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Counted, not a boolean: a key change starts the next read before the
  // cancelled one has unwound, and a flag would be cleared by the loser.
  const [busy, setBusy] = useState(0);

  // The key a response must still match to be allowed on screen. A ref rather
  // than state: it is read inside an async continuation that must see the
  // CURRENT value, not the one captured when the request went out.
  const liveKey = useRef(key);
  const [nonce, setNonce] = useState(0);
  // Held in a ref so a caller may pass an inline closure without re-running the
  // read on every render — the key is what decides when to re-read.
  const fetcherRef = useRef(fetcher);
  fetcherRef.current = fetcher;
  const cacheRef = useRef({ fromCache, toCache });
  cacheRef.current = { fromCache, toCache };

  const reload = useCallback((o?: { quiet?: boolean }) => {
    if (!o?.quiet) { setData(null); setAge(null); setError(null); setState("loading"); }
    setNonce((n) => n + 1);
  }, []);

  useEffect(() => {
    liveKey.current = key;
    if (!enabled) return;
    let cancelled = false;
    const mine = key;
    const stillMine = () => !cancelled && liveKey.current === mine;

    setBusy((n) => n + 1);
    void (async () => {
      try {
        // Cache first, always. Painting a stale list labelled stale beats an
        // empty one, and on the link this app is for the live read may never
        // arrive at all.
        const cached = await cacheRef.current.fromCache?.().catch(() => null);
        if (cached && stillMine()) {
          setData(cached.value);
          setAge(Date.now() - cached.savedAt);
          setState("cached");
        }
        if (forcedOffline) {
          if (stillMine() && !cached) setState("offline");
          return;
        }
        try {
          const live = await fetcherRef.current();
          if (!stillMine()) return;
          setData(live);
          setAge(null);
          setError(null);
          setState("fresh");
          try { await cacheRef.current.toCache?.(live); } catch { /* cache write is best-effort */ }
        } catch (e) {
          if (!stillMine()) return;
          const offline = isOffline(e);
          // Keep whatever the cache gave us — it is the only thing on screen, and
          // it is still true about the moment it was taken. Only the LABEL moves.
          setState(cached ? "cached" : offline ? "offline" : "error");
          setError(offline ? null : String((e as Error)?.message || e));
        }
      } finally {
        // Decremented even for a read whose answer is no longer wanted: the
        // request really has finished, and leaving the count up would strand
        // every refresh button on this screen showing a spinner for ever.
        setBusy((n) => n - 1);
      }
    })();

    return () => { cancelled = true; };
  }, [key, enabled, forcedOffline, nonce]);

  return { data, state, age, error, inflight: busy > 0, reload, set: setData };
}

/**
 * The sentence a sheet puts above cached rows.
 *
 * Written here rather than per sheet for the same reason as the hook: the
 * wording is a promise about freshness, and twenty-six wordings are twenty-six
 * chances for one of them to overstate it.
 */
export function stalenessNote(state: ResourceState, age: number | null, noun = "listing"): string | null {
  if (state !== "cached" || age == null) return null;
  return `Cached ${noun} from ${agoText(age)} — the link is down, so anything added since won't be here.`;
}

/** Moved to `format.ts`; re-exported so existing importers keep working. */
export { agoText };
