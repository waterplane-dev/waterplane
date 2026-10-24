/**
 * The waterplane host on THIS machine, read over loopback for the All sessions view — the phone's
 * token screen asks the desktop for the live limit windows, the billing profile and budget, the
 * other backends' ledgers and the past-window grids, and this is where the panel asks the same
 * routes the same questions (`GET /api/usagenow`, `/api/usagelog`, `/api/tokenwindows`,
 * `/api/costwindow`, `/api/tokenstats/<id>`, `/api/localusage`).
 *
 * OFF until turned on (`waterplane.desktopUrl`): the extension's description promises no network
 * call but the Copilot one, and a loopback read is still a socket. Only a loopback URL is accepted
 * (127.0.0.1, ::1, localhost) — never a remote host, whatever the setting says — and the host's own
 * gate trusts loopback, so no token is sent or stored. Every failure is a SENTENCE the card that
 * asked draws; nothing here invents a reading the host did not give.
 */
import { BRAND, FETCH_TIMEOUT_MS, SLOW_OP_TIMEOUT_MS, type UsageNowDoc } from "@waterplane/shared";
import type { LiveState } from "./protocol";

/** What the setting is set to when the panel's link turns it on. */
export const DEFAULT_DESKTOP_URL = "http://127.0.0.1:8770";
/** The phone's fuses: a status read, and the slow-op one a cold fold takes (`netfuse.ts`). */
const TIMEOUT_MS = FETCH_TIMEOUT_MS;
const SLOW_TIMEOUT_MS = SLOW_OP_TIMEOUT_MS;

/** The setting as a loopback origin, or a sentence saying why it is not one. "" = off. */
export function desktopBase(raw: string): { base: string } | { off: string } {
  const s = raw.trim();
  if (!s) return { off: `Limits, budget and other backends come from the ${BRAND.name} desktop, and reading it is off.` };
  let u: URL;
  try { u = new URL(s); } catch { return { off: `${BRAND.slug}.desktopUrl is not a URL: "${s.slice(0, 60)}".` }; }
  if (u.protocol !== "http:" && u.protocol !== "https:") return { off: `${BRAND.slug}.desktopUrl must be an http:// URL on this machine.` };
  const h = u.hostname.replace(/^\[|\]$/g, "");
  if (h !== "127.0.0.1" && h !== "localhost" && h !== "::1") {
    return { off: `${BRAND.slug}.desktopUrl names ${h}; only this machine (127.0.0.1) is read, never another host.` };
  }
  return { base: `${u.protocol}//${u.host}` };
}

/**
 * The phone's token-screen reads, and nothing else: the webview builds each path with the phone's
 * own `webapiStats.ts` (one spelling of every query), and only these routes are forwarded — all
 * GET, all read-only ledgers. Anything else is refused before a socket opens.
 */
const READS = /^\/api\/(usagenow|localusage|usagelog(\/[A-Za-z0-9._%-]+)?|tokenwindows|costwindow|tokenstats\/[a-z][a-z0-9-]*)(\?[^#]*)?$/;
export const forwardable = (p: string): boolean => READS.test(p);

async function getJson<T>(base: string, p: string, ms: number): Promise<T> {
  let res: Response;
  try {
    res = await fetch(base + p, { signal: AbortSignal.timeout(ms), headers: { accept: "application/json" } });
  } catch (e) {
    const timeout = (e as Error)?.name === "TimeoutError";
    throw new Error(timeout
      ? `The ${BRAND.name} desktop at ${base} did not answer within ${Math.round(ms / 1000)} s.`
      : `No ${BRAND.name} desktop answered at ${base} — is it running on this machine?`);
  }
  if (!res.ok) {
    let why = "";
    try { why = String(((await res.json()) as { error?: unknown }).error ?? ""); } catch { /* no body */ }
    throw new Error(res.status === 404
      ? (why || `The ${BRAND.name} desktop at ${base} is older than this panel and has no ${p.split("?")[0]}.`)
      : `The ${BRAND.name} desktop answered ${res.status}${why ? `: ${why}` : ""}.`);
  }
  return await res.json() as T;
}

/** The live account facts, or the sentence why there are none. Never throws. */
export async function readLive(raw: string): Promise<LiveState> {
  const at = Date.now();
  const b = desktopBase(raw);
  if ("off" in b) return { doc: null, host: null, why: b.off, at };
  try {
    const doc = await getJson<UsageNowDoc>(b.base, "/api/usagenow", TIMEOUT_MS);
    if (!doc || typeof doc !== "object" || !Array.isArray(doc.readings) || !Array.isArray(doc.backends)) {
      return { doc: null, host: b.base, why: `The ${BRAND.name} desktop at ${b.base} answered in a shape this panel does not know.`, at };
    }
    return { doc, host: b.base, at };
  } catch (e) {
    return { doc: null, host: b.base, why: (e as Error).message, at };
  }
}

/** One of the phone's ledger reads, for the webview. Rejects with a sentence. */
export async function readPath(raw: string, p: string, ms?: number): Promise<unknown> {
  const b = desktopBase(raw);
  if ("off" in b) throw new Error(b.off);
  if (!forwardable(p)) throw new Error(`The panel does not forward ${p.split("?")[0]} to the desktop.`);
  return getJson(b.base, p, Math.min(Math.max(ms ?? TIMEOUT_MS, 1_000), SLOW_TIMEOUT_MS));
}
