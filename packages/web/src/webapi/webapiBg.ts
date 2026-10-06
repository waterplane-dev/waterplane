import { timedFetch } from "@waterplane/shared";

/**
 * A request that must NOT blink the activity bar — a background poll, a
 * telemetry flush, a bundle check nobody asked for.
 *
 * The distinction api.ts draws is between the SPINNER and the FUSE, and only
 * the first is optional. A raw `fetch` opts out of both, and opting out of the
 * fuse is the bug: a host that accepts the connection and then never answers
 * leaves the caller pending for ever, which is exactly the state every offline
 * fallback in this client exists to replace — and exactly what a half-open
 * Tailscale path produces. So background callers come here rather than to the
 * global, and `tools/eslint/rules.js` keeps them here.
 */
export function bgFetch(url: string, init?: RequestInit, ms?: number): Promise<Response> {
  return timedFetch(url, init, ms);
}

/** JSON over `bgFetch`, returning null on any failure. Telemetry and update
 *  checks all wanted this shape and each had written its own. */
export async function bgJson<T>(url: string, init?: RequestInit, ms?: number): Promise<T | null> {
  try {
    const r = await bgFetch(url, init, ms);
    if (!r.ok) return null;
    return (await r.json()) as T;
  } catch { return null; }
}
