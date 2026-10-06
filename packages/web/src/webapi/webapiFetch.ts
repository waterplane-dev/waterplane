import { timedFetch } from "@waterplane/shared";
import { labelForUrl, netBegin } from "../link";

/**
 * `fetch`, counted as in-flight for its whole duration (see `netstate.ts`).
 *
 * The counting lives HERE rather than at each call site because the complaint it
 * answers is about the calls nobody remembered to give a spinner: on a slow
 * Tailscale path a tap that fires a plain GET leaves the screen completely
 * unchanged for ten seconds, which is indistinguishable from a dead button. Any
 * request that should stay silent (a background poll) must therefore bypass
 * these helpers and call `fetch` directly — a bar that blinks on every 6 s
 * transcript poll is noise that hides the real one.
 */
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

export async function jget<T>(url: string, ms?: number): Promise<T> {
  const r = await nfetch(url, undefined, ms);
  if (!r.ok) throw new Error(`${r.status} ${url}`);
  return r.json() as Promise<T>;
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
  return r.json() as Promise<T>;
}

export async function jpost<T>(url: string, body: unknown, ms?: number): Promise<T> {
  const r = await nfetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  }, ms);
  return r.json() as Promise<T>;
}

export async function jdel(url: string): Promise<void> {
  await nfetch(url, { method: "DELETE" });
}
