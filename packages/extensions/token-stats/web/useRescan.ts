import { useEffect, useRef } from "react";

/**
 * Re-read a resource QUIETLY when `token` moves (a rescan counter, a new scan's stamp), never on
 * mount. The token used to ride in the read's cache key; a key that moves misses the cache and piles
 * a row per refresh, so the key stays stable and the read is repeated through `reload` instead.
 * The fetcher is held by the hook in a ref and is current by the time this effect runs.
 */
export function useRescan(token: unknown, reload: (o?: { quiet?: boolean }) => void): void {
  const seen = useRef(token);
  useEffect(() => {
    if (Object.is(seen.current, token)) return;
    seen.current = token;
    reload({ quiet: true });
  }, [token, reload]);
}
