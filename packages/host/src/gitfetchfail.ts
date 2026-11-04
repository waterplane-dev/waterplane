/**
 * Why a `git fetch` failed, read off the error `execFile` threw — and whether the cause is the
 * NETWORK (it passes by itself) or something a person has to fix (a key, a deleted repo).
 *
 * The case that made this (2026-11-03): three SSH pulls from one "pull all" failed within 23 ms
 * of each other and each became a "needs you" item reading only "the fetch failed". What was kept
 * was `Command failed: git fetch --no-tags` and no stderr — and a timeout, a silent exit and an
 * outside SIGTERM all leave exactly that text, so the cause could not be read back afterwards.
 * So the three are told apart HERE, off the error's own fields (`killed`, `signal`, `code`),
 * and a failure with no stderr still names which of them it was.
 *
 * Network is a CLOSED list of transport phrases from ssh, curl and git. Anything else — auth,
 * "Repository not found", an unknown line — is `network: false`, which keeps the old
 * behaviour (a needs-you item): a wrong guess there costs an extra alert, the other way would
 * hide a broken key.
 */

const NETWORK = [
  /could not resolve host(name)?/i,
  /temporary failure in name resolution/i,
  /nodename nor servname provided/i,
  /connection timed out/i,
  /operation timed out/i,
  /connection refused/i,
  /network is unreachable/i,
  /no route to host/i,
  /connection reset/i,
  /connection closed by .* port \d+/i,
  /kex_exchange_identification/i,
  /failed to connect to/i,
  /recv failure/i,
  /the requested url returned error: 5\d\d/i,
  /unexpected disconnect while reading sideband packet/i,
  /early eof/i,
];

export interface FetchFailure {
  /** The one-line reason, for the first line of the error (the line a notification shows). */
  reason: string;
  /** The cause passes by itself: a timeout or a transport error. */
  network: boolean;
}

/** `err` is what `execFile` rejected with; `timeoutMs` is the limit the fetch ran under. */
export function fetchFailure(err: unknown, timeoutMs: number): FetchFailure {
  const e = err as { killed?: boolean; signal?: string | null; code?: number | string | null; stderr?: unknown } | null;
  const stderr = String(e?.stderr ?? "").trim();
  // `killed` is node's own kill: the timeout, unless the output overflowed maxBuffer (no network fault).
  if (e?.killed && e.code !== "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") {
    const min = Math.round(timeoutMs / 60_000);
    return { reason: `no answer from the remote within ${min >= 1 ? `${min} min` : `${Math.round(timeoutMs / 1000)} s`}`, network: true };
  }
  const lines = stderr.split("\n").map((l) => l.trim()).filter(Boolean);
  const hit = lines.find((l) => NETWORK.some((re) => re.test(l)));
  if (hit) return { reason: clean(hit), network: true };
  // Not the network: name git's own first meaningful line (skip git's generic tail).
  const own = lines.find((l) => !/^fatal: could not read from remote repository\.?$/i.test(l) && !/^please make sure you have the correct access rights/i.test(l) && !/^and the repository exists\.?$/i.test(l));
  if (own) return { reason: clean(own), network: false };
  // Silent. Someone else's signal (a host restart stops its children) is no network fault either.
  if (e?.signal) return { reason: `git was stopped by ${e.signal}`, network: false };
  return { reason: e?.code != null ? `git exited with ${e.code} and gave no reason` : "git gave no reason", network: false };
}

/** Drop git's and ssh's prefixes and cap it — it is one line of a notification. */
function clean(line: string): string {
  const s = line.replace(/^(fatal|error|ssh):\s*/i, "").replace(/\.$/, "");
  return s.length > 140 ? `${s.slice(0, 139)}…` : s;
}
