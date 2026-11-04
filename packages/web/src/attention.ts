/**
 * What a session is doing, as ONE bucket — and which sessions a cross-session
 * chip counts. Pure (node-tested in `attention.test.mjs`); `sessionFacts.tsx`
 * re-exports `sessionStatus` and draws the pills off it.
 *
 * The row badge (`statusPill`), the per-repo roll-up, the status filter, the
 * tab strip, the launcher's global chips and the two sheets those chips open
 * (questions, blocked) all read `sessionStatus` — so a count and the list it
 * opens can never come from two ideas of "waiting" or "blocked". The questions
 * sheet once re-derived its own membership with its own predicates over a
 * different set (every session, where the chip counted the visible ones), and
 * "2 waiting" could open three cards; the limit sheet listed exited sessions
 * its chip did not count. `attentionCut` is now the one call both make.
 */
import { blockOf, sessionWaits, shellsSummary } from "@waterplane/shared";
import type { BlockKind, SessionBlock, SessionInfo } from "@waterplane/shared";
import { isShellBackend, type BackendList } from "./backendCaps.ts";

/**
 * Buckets are mutually exclusive and ordered exited > blocked > waiting > done >
 * coding: a session lands in exactly one, so the header's counts sum to its row
 * count and tapping a count always yields that many rows.
 */
export type SessionStatus = "exited" | "blocked" | "wait" | "done" | "coding";

/**
 * The block a session is behind, AS THE LIST COUNTS IT: `blockOf` (shared, the
 * one derivation of the four kinds) on a running session — plus a session that
 * EXITED at a usage or spend wall while the host still holds it in the resume
 * queue (`queuePos`, or being reopened right now): it comes back with
 * `--continue` at the reset (host `resume.ts`), so it is waiting on the wall,
 * not finished. An exited session nothing will reopen is `exited`.
 */
export function listedBlockOf(s: SessionInfo): SessionBlock | null {
  const b = blockOf(s);
  if (!b) return null;
  if (s.running) return b;
  const inLine = (b.kind === "limit" || b.kind === "spend") && (s.limit?.queuePos != null || s.limit?.resuming === true);
  return inLine ? b : null;
}

export function sessionStatus(s: SessionInfo, backends: BackendList = null): SessionStatus {
  // Signed out, out of credit, a usage window, the host's network retry: all
  // four are walls OUTSIDE the session, and a box on screen behind one of them
  // is not the thing the person is waiting on.
  if (listedBlockOf(s)) return "blocked";
  if (!s.running) return "exited";
  // A dialog we could not parse into options is still blocked on you.
  // …and so is a turn that ENDED on a question: the CLI takes typing, but the
  // work does not move until you answer, and `done` said the opposite.
  // `sessionWaits` (shared) is the ONE test: another desktop's `GET /api/attention`
  // counts with it, so its number and this bucket cannot disagree.
  if (sessionWaits(s)) return "wait";
  // A shell has no turns, so nothing ever marks it idle — and "no idle yet" is
  // what reads as "coding". A turnless session is never working.
  if (isShellBackend(backends, s.backend)) return "done";
  // A quiet MAIN loop is not a quiet session: a background agent outlives the
  // turn that launched it, so a session waiting on two of them is working, and
  // `done` said the work had finished while the terminal counted "2 agents".
  // Background shells are the same fact by another route; only a shell with
  // real workers under it is work — a `waiting` one is a poll loop that only
  // sleeps (`shellsSummary`). An older host (no `shellList`, only the boolean
  // `shells`) keeps reading `coding`, exactly as it always has.
  if (s.idle) {
    if (s.agents?.length) return "coding";
    if (s.shellList) return shellsSummary(s.shellList, Date.now()).working > 0 ? "coding" : "done";
    return s.shells ? "coding" : "done";
  }
  return "coding";
}

/** The ONE place a block kind is worded on a row, a group head or a title. */
export const BLOCK_WORD: Record<BlockKind, string> = {
  auth: "signed out",
  spend: "out of credit",
  limit: "at limit",
  net: "network retry",
};

/** The blocked sheet's group order: the one that needs a person once (and
 *  unblocks everything behind it) first, the usage window — which clears by the
 *  clock and has its own queue — last. */
export const BLOCK_GROUPS: readonly BlockKind[] = ["auth", "net", "spend", "limit"];

/** The group heads, in the sheet's words. */
export const BLOCK_GROUP_HEAD: Record<BlockKind, string> = {
  auth: "Sign-in",
  net: "Network",
  spend: "Spend",
  limit: "Usage limit",
};

/** The two cross-session chips: `wait` (a question, a dialog, a turn ending on
 *  a question) and `blocked` (any of the four outside walls). */
export type AttentionKind = "wait" | "blocked";

/** What a chip counts and its sheet lists, and the whole set it was cut from. */
export interface AttentionCut {
  /** The sessions IN VIEW (not in a hidden repo, inside the repo focus) in the
   *  bucket — the chip's number and the sheet's default rows, one array. */
  shown: SessionInfo[];
  /** Every session in the bucket, in view or not — the sheet's "n of N". */
  all: SessionInfo[];
}

/**
 * The chip's count and its sheet's rows, from ONE call over ONE input: the
 * launcher calls it for the number, the sheet for the list, both with the whole
 * session list and the launcher's visibility rule (`core.world.cwdVisible`).
 */
export function attentionCut(sessions: readonly SessionInfo[], kind: AttentionKind, backends: BackendList,
  inView: (cwd: string) => boolean): AttentionCut {
  const all = sessions.filter((s) => sessionStatus(s, backends) === kind);
  return { shown: all.filter((s) => inView(s.cwd)), all };
}

/** The noun a chip says after its number ("2 waiting", "1 blocked"). Both read
 *  the same in the singular and the plural, which is why they were picked.
 * closed: keyed by this file's own `AttentionKind`, which never crosses the wire */
export const ATTENTION_NOUN: Record<AttentionKind, string> = { wait: "waiting", blocked: "blocked" };

/** The chip's `title`: what the n sessions are, and what a tap does. `repo`
 *  names a per-repo twin (whose tap is the launcher's filter, not the sheet). */
export function attentionTitle(kind: AttentionKind, n: number, o: { repo?: string; replies?: boolean } = {}): string {
  const who = `${n} session${n === 1 ? "" : "s"}${o.repo ? ` in ${o.repo}` : ""}`;
  const what = kind === "wait"
    ? `${n === 1 ? "is" : "are"} waiting for your answer${o.replies ? " — some already have a reply on a clock" : ""}`
    : `${n === 1 ? "is" : "are"} blocked — signed out, out of credit, at a usage limit or on a network retry`;
  const tap = o.repo ? "tap to show only those" : kind === "wait" ? "tap to answer them here" : "tap to see why and steer them";
  return `${who} ${what} — ${tap}`;
}

/** "2 of 5 waiting — 3 are in hidden or unfocused repos": what a sheet opened
 *  from a chip is NOT showing, said above its rows. Null when it hides nothing. */
export function cutWords(kind: AttentionKind, cut: AttentionCut): string | null {
  const n = cut.shown.length;
  const N = cut.all.length;
  if (n >= N) return null;
  const rest = N - n;
  return `${n} of ${N} ${ATTENTION_NOUN[kind]} — ${rest} ${rest === 1 ? "is" : "are"} in hidden or unfocused repos`;
}

/** The blocked sheet's groups, in `BLOCK_GROUPS` order: a PARTITION of the rows
 *  it was handed (each by its `listedBlockOf` kind), so the groups add up to the
 *  chip's number. */
export function blockedGroups(rows: readonly SessionInfo[]): Map<BlockKind, SessionInfo[]> {
  const m = new Map<BlockKind, SessionInfo[]>(BLOCK_GROUPS.map((k) => [k, []]));
  for (const s of rows) {
    const b = listedBlockOf(s);
    if (b) m.get(b.kind)!.push(s);
  }
  return m;
}

/** The questions sheet's three card shapes — a PARTITION of the `wait` rows it
 *  was handed, never a second filter: a parsed box (answerable there), a dialog
 *  the parser could not read (only pointed at), a turn that ended on a question
 *  in prose. */
export function waitShapes(rows: readonly SessionInfo[]): { asked: SessionInfo[]; unreadable: SessionInfo[]; inProse: SessionInfo[] } {
  return {
    asked: rows.filter((s) => s.prompt),
    unreadable: rows.filter((s) => !s.prompt && s.awaitingInput),
    inProse: rows.filter((s) => !s.prompt && !s.awaitingInput),
  };
}
