/**
 * A HEADLESS `claude -p` run that failed because the CLI is not signed in.
 *
 * The sibling of `limit.ts`'s `detectHeadlessLimit`: same envelope, different
 * fact. A signed-out run exits non-zero with an envelope whose `is_error` is
 * true and whose `result` is the CLI's own one-liner — the live sessions' log
 * writes the same sentence under `error: "authentication_failed"`
 * ("Login expired · Please run /login"); the other measured wordings are
 * "Not logged in · Please run /login" and "Failed to authenticate: OAuth session
 * expired…" (the latter is the one that once became a tab's name). Reported as
 * a generic failure it reads as a broken install, when the true fact is a
 * sign-in the person does once, from any session.
 *
 * Detection is on a KIND (`error: "authentication_failed"`, an HTTP 401 status
 * on a result) or on the START of an errored result's text — never a loose
 * word match, and never on text that merely mentions logging in. An unknown
 * shape is "not signed out", i.e. the caller's old message.
 *
 * The envelope may be one JSON document (`--output-format json`) or NDJSON
 * (`stream-json`, the assessment's), so each parsed object is asked.
 */

/** The one sentence every headless caller says. Not the CLI's own wording. */
export const SIGNED_OUT_NOTE = "Skipped — the CLI is signed out; sign in from any session.";

/** The start of an errored run's `result`: the CLI's auth one-liners. */
const AUTH_RESULT = /^(?:not logged in|login expired|invalid api key|failed to authenticate)\b/i;

/** The same one-liner as a bare line on stderr / a non-envelope stdout. */
const AUTH_LINE = /^(?:not logged in|login expired|invalid api key)\b[^\n]{0,40}\/login\s*$/i;

function objectsOf(stdout: string): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  const take = (v: unknown): void => { if (v && typeof v === "object" && !Array.isArray(v)) out.push(v as Record<string, unknown>); };
  try { take(JSON.parse(stdout)); return out; } catch { /* maybe NDJSON */ }
  for (const line of stdout.split("\n")) {
    const t = line.trim();
    if (!t.startsWith("{")) continue;
    try { take(JSON.parse(t)); } catch { /* a noise line */ }
  }
  return out;
}

function objectSaysSignedOut(o: Record<string, unknown>): boolean {
  if (o.error === "authentication_failed") return true;
  if (o.type !== "result" || o.is_error !== true) return false;
  if (o.api_error_status === 401) return true;
  return typeof o.result === "string" && AUTH_RESULT.test(o.result.trim());
}

export function detectHeadlessSignedOut(stdout: string, stderr: string): boolean {
  if (stdout && objectsOf(stdout).some(objectSaysSignedOut)) return true;
  // Not an envelope: the one-liner alone on stderr, or alone as all of stdout.
  return [stderr, stdout].some((s) => !!s && s.trim().length < 200 && s.trim().split("\n").some((l) => AUTH_LINE.test(l.trim())) && !s.trim().startsWith("{"));
}
