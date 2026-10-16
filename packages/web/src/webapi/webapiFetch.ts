import { FETCH_TIMEOUT_MS, TimeoutError, timedFetch } from "@waterplane/shared";
import { labelForUrl, netBegin } from "../link/linkOps";

/**
 * `fetch` for the JSON API, with the two things every call here needs: it is
 * counted as in-flight (see `netstate.ts`) and it has a FUSE — a host that
 * never answers rejects instead of hanging forever, which is what makes every
 * offline fallback in this client reachable (see `shared/netfuse.ts` for the
 * full argument; the rules are pinned by `e2e-netfuse.mjs`).
 *
 * The counting lives HERE rather than at each call site because the complaint it
 * answers is about the calls nobody remembered to give a spinner: on a slow
 * Tailscale path a tap that fires a plain GET leaves the screen completely
 * unchanged for ten seconds, which is indistinguishable from a dead button. Any
 * request that should stay silent (a background poll) must therefore bypass
 * these helpers and call `timedFetch` directly — a bar that blinks on every 6 s
 * transcript poll is noise that hides the real one. It must still take the fuse.
 */
export async function nfetch(url: string, init?: RequestInit, ms?: number): Promise<Response> {
  const end = netBegin(labelForUrl(url, init?.method ?? "GET"));
  try {
    return await timedFetch(url, init, ms);
  } finally {
    end();
  }
}

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

/** The body, under a fuse of its own: `timedFetch`'s ends at the HEADERS, so a
 *  tunnel that stalled after the status line left `r.json()` pending for ever
 *  (Files: "Reading this folder…" while the host answered in 50 ms). A stall
 *  now rejects as a `TimeoutError`, which every caller reads as offline. */
function fusedJson<T>(r: Response, url: string, ms = FETCH_TIMEOUT_MS): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const fuse = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new TimeoutError(url, ms)), ms); });
  return Promise.race([r.json() as Promise<T>, fuse]).finally(() => clearTimeout(timer));
}

/** `signal`: the caller's own abort (a superseded read, `useRemoteResource`). */
export async function jget<T>(url: string, ms?: number, signal?: AbortSignal): Promise<T> {
  const r = await nfetch(url, signal ? { signal } : undefined, ms);
  if (!r.ok) throw new Error(`${r.status} ${url}`);
  return fusedJson<T>(r, url, ms);
}

/** `jpost` that throws on a non-2xx, with the host's `error`/`message` words
 *  when it sent some — for a verb whose refusal must be SAID. */
export async function jpostOk<T>(url: string, body: unknown, ms?: number): Promise<T> {
  const r = await nfetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  }, ms);
  if (!r.ok) {
    let why = `${r.status}`;
    try {
      const j = (await r.json()) as { error?: unknown; message?: unknown };
      const w = typeof j.message === "string" ? j.message : typeof j.error === "string" ? j.error : null;
      if (w) why = `${r.status} ${w}`;
    } catch { /* no body */ }
    throw new Error(why);
  }
  return fusedJson<T>(r, url, ms);
}

export async function jpost<T>(url: string, body: unknown, ms?: number): Promise<T> {
  const r = await nfetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  }, ms);
  return fusedJson<T>(r, url, ms);
}

export async function jdel(url: string): Promise<void> {
  await nfetch(url, { method: "DELETE" });
}
