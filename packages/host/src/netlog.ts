/**
 * Did the last turn end because the CLI gave up on a TRANSIENT API error —
 * asked of the CLI's own log, never of the screen.
 *
 * The CLI retries a failed request itself ("attempt 1/10"), but during a DNS or
 * Wi-Fi outage that budget runs out in seconds to minutes and the TURN ENDS. The
 * give-up is written to the conversation jsonl as a DATED synthetic assistant row:
 *
 *   {"type":"assistant","timestamp":"…","isApiErrorMessage":true,"error":"server_error",
 *    "message":{"model":"<synthetic>","content":[{"type":"text","text":"API Error: …"}]}}
 *
 * Two facts together make a row transient here, and both are needed:
 *  - `error === "server_error"` — a stub's `400` carries `unknown`, and nothing
 *    but the CLI's own classification is trusted for which side failed;
 *  - the TEXT has a known transient shape (`transientApiError`): a network errno,
 *    can't reach, connection lost/dropped/refused, no response, 5xx/529.
 * A spend wall is an API-error row too: `detectSpendText` claims it first, because
 * a wall is `limitlog.ts`/`spendwall.ts`'s and a retry there spends nothing but
 * attempts. A `quotaLimits` rejection is a usage limit — never ours. An unknown
 * shape is no retry: degrade to absent, never guess.
 *
 * The ladder is here too (`netRetryDelay`), pure, like `limitretry.ts`'s.
 */
import { closeSync, openSync, readSync, statSync } from "node:fs";
import { stamp } from "./convlog.js";
import { detectSpendText } from "./limit.js";

/** A give-up is the last row of its turn, so the answer is always near the end. */
const MAX_READ = 256 * 1024;

/**
 * The transient shapes, each a phrase the CLI prints. Kept as a list so a new
 * wording is one line and a test row. Case-insensitive; matched against the
 * text AFTER the `API Error:` prefix.
 */
const TRANSIENT: readonly RegExp[] = [
  /\b(?:ENOTFOUND|EAI_AGAIN|ECONNRESET|ECONNREFUSED|ECONNABORTED|ETIMEDOUT|ENETUNREACH|ENETDOWN|EHOSTUNREACH|EPIPE|UND_ERR_[A-Z_]+)\b/,
  /\bcan(?:'|’)?t reach the API\b|\bcannot reach the API\b|\bunable to (?:connect|reach)\b/i,
  /\bconnection (?:lost|dropped|refused|reset|error|closed|timed out)\b/i,
  /\bno response from (?:the )?API\b/i,
  /\brequest timed out\b|\btimed out waiting\b/i,
  /^(?:5\d\d)\b/,
  /\boverloaded\b|\bservice unavailable\b|\bbad gateway\b|\bgateway time-?out\b|\binternal server error\b/i,
];

/**
 * The short line the phone shows for a transient API error, or null when the
 * text is not one. The `API Error:` prefix is required (it is what marks the
 * CLI's give-up) and dropped from the label; the label is the first sentence,
 * capped at 100 chars.
 */
export function transientApiError(text: string): string | null {
  const m = /^\s*API Error:\s*([\s\S]*)$/.exec(text);
  if (!m) return null;
  const body = m[1].trim();
  if (!body || detectSpendText(text).spend) return null;
  if (!TRANSIENT.some((re) => re.test(body))) return null;
  const first = body.split("\n")[0];
  // First sentence, but keep a trailing errno in parentheses: "… DNS (ENOTFOUND)".
  const cut = /^(.*?\.)(?:\s|$)/.exec(first);
  const label = (cut && cut[1].length >= 12 ? cut[1] : first).trim();
  return label.length > 100 ? label.slice(0, 99) + "…" : label;
}

export interface NetLogVerdict {
  /**
   * `transient`: the NEWEST assistant row is a transient give-up.
   * `clear`: the newest assistant row is anything else (a served reply, a wall, a stub error).
   * `unknown`: no log, or no assistant row in the tail — nothing to say.
   */
  state: "transient" | "clear" | "unknown";
  /** When the transient row was written (epoch ms); null unless `transient`. */
  at: number | null;
  /** The phone's short line; null unless `transient`. */
  error: string | null;
}

const UNKNOWN: NetLogVerdict = { state: "unknown", at: null, error: null };
const CLEAR: NetLogVerdict = { state: "clear", at: null, error: null };

/** The verdict of one parsed row, or null when the row is not an assistant row. */
export function netRowVerdict(row: Record<string, unknown>): NetLogVerdict | null {
  if (row.type !== "assistant") return null;
  const msg = row.message as { model?: unknown; content?: unknown } | undefined;
  if (msg?.model !== "<synthetic>" || row.isApiErrorMessage !== true) return CLEAR;
  if (row.error !== "server_error" || row.quotaLimits) return CLEAR;
  const error = transientApiError(rowText(row));
  const at = stamp(row as { timestamp?: unknown });
  // Undated is not a give-up we can place against our own attempts: absent.
  if (!error || at == null) return CLEAR;
  return { state: "transient", at, error };
}

/** What the conversation log says about the NEWEST assistant row. */
export function readNetLog(path: string): NetLogVerdict {
  let st;
  try { st = statSync(path); } catch { return UNKNOWN; }
  const start = Math.max(0, st.size - MAX_READ);
  const len = st.size - start;
  if (len <= 0) return UNKNOWN;
  const buf = Buffer.allocUnsafe(len);
  let fd: number;
  try { fd = openSync(path, "r"); } catch { return UNKNOWN; }
  try { readSync(fd, buf, 0, len, start); } catch { return UNKNOWN; } finally { closeSync(fd); }
  const lines = buf.toString("utf8").split("\n");
  if (start > 0) lines.shift(); // a tail read starts mid-record
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (!line || line.charCodeAt(0) !== 123 /* { */ || !line.includes('"assistant"')) continue;
    let row: Record<string, unknown>;
    try { row = JSON.parse(line); } catch { continue; }
    const v = netRowVerdict(row);
    if (v) return v;
  }
  return UNKNOWN;
}

function rowText(row: Record<string, unknown>): string {
  const c = (row.message as { content?: unknown } | undefined)?.content;
  if (typeof c === "string") return c;
  if (!Array.isArray(c)) return "";
  return c.map((b) => (b && typeof (b as { text?: unknown }).text === "string" ? (b as { text: string }).text : "")).filter(Boolean).join("\n");
}

// ── The ladder ──────────────────────────────────────────────────────

/** Default wait before retry n (0-based): quick first, then widening. */
export const NET_LADDER_MS: readonly number[] = [20_000, 60_000, 120_000, 300_000, 600_000, 900_000];
/** Default number of retries before giving up and saying so. */
export const NET_MAX_ATTEMPTS = 8;

/**
 * The wait before retry `attempt` (0-based count of retries ALREADY sent), or
 * null once `max` retries have been sent — the cap. Past the ladder's end the
 * last rung repeats.
 */
export function netRetryDelay(attempt: number, max = NET_MAX_ATTEMPTS, ladder: readonly number[] = NET_LADDER_MS): number | null {
  if (!(attempt >= 0) || attempt >= max) return null;
  const rungs = ladder.length ? ladder : NET_LADDER_MS;
  return rungs[Math.min(attempt, rungs.length - 1)];
}

/**
 * Is this transient row a NEW give-up, i.e. one the turn that just ended wrote?
 * It must be stamped at/after that turn started (minus a little clock slack) —
 * else it is an old error still newest in a log whose turn ended for some other
 * reason (an Esc, a hook), and typing `continue` there would be a prompt nobody sent.
 */
export function freshGiveUp(v: NetLogVerdict, turnStartedAt: number | undefined, slackMs = 2000): boolean {
  return v.state === "transient" && v.at != null && turnStartedAt != null && turnStartedAt > 0 && v.at >= turnStartedAt - slackMs;
}
