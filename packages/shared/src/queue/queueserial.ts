// Cut from queue.ts (move only): serial groups
// The one door stays `./queue.js`; this slice imports its siblings directly, never the barrel.

import { laneBusy, sessionWall, type LaneSessionState, type SessionWall } from "./queuelane.js";

/**
 * The serialization group for a working directory.
 *
 * The REPO DIRECTORY, not the repo: a worktree is a separate checkout, and
 * making one per task is exactly how this app already runs work in parallel
 * safely (`parallel` backlog mode). Two sessions in two worktrees cannot write
 * over each other, so they are not each other's business — the only thing they
 * share is the usage limit, and that is a knob, not a rule.
 */
export function serialGroup(cwd: string): string {
  return `repo:${cwd}`;
}

/** How long a just-created session may go without reporting a turn before the
 *  group stops waiting for it. Covers spawn + `deliverPrompt`'s echo window; past
 *  it, something went wrong and holding the rest of the queue forever is worse
 *  than starting the next one. */
export const SERIAL_STARTUP_MS = 60_000;

/** The session facts `busySerialGroups` reads. Primitives again — no SessionInfo
 *  import, so this stays node-runnable and testable without a host. */
export interface SerialSessionState extends LaneSessionState {
  id: string;
  cwd: string;
  running?: boolean;
  /** Epoch ms the session's current/most recent turn started. Absent ⇒ it has
   *  never run one, i.e. it is still coming up. */
  turnStartedAt?: number;
  /** The CLI conversation this session is driving (`claudeSessionId`), so a
   *  clock row aimed at a gone session id can find its conversation open
   *  under another one (`liveConvSession`). Absent = not known. */
  convId?: string;
  /** What a person calls this session — the desktop's derived tab name, else
   *  its title. Only the serial SENTENCE reads it (`serialWaitText`); absent
   *  means the sentence says "another session" rather than inventing one. */
  name?: string;
  /** Opened by MACHINERY for queued work (a backlog item, a schedule, an
   *  agent's posted prompt, a fan-out target, or the reopen of one of those
   *  at a limit reset) — never a session a person opened by hand. Only the
   *  INTENT ladder's serial rung reads it (`intentSerialHolders`): a hand
   *  session never holds a serial backlog row. Absent = a person's. */
  automatic?: boolean;
  /** The turn ended on a question asked in PROSE (`SessionInfo.asking`). Not
   *  a wall for a lane — the answer IS the next prompt — but an automatic
   *  predecessor that asked one holds the serial row behind it. */
  asking?: boolean;
  /** Work in this session is STALLED on the API (shared `netRetryStalls`: the
   *  host's net retry gave up, or a stall probe is under way). Only the serial
   *  SENTENCE reads it: a row held behind such a session is told why the repo
   *  is taken, never held any longer or shorter for it. Absent = not stalled. */
  netStalled?: boolean;
}

/**
 * One serialized send that has already gone out, and the session it produced.
 *
 * Needed for one narrow window: between `op.ack` naming the new session and
 * that session reporting a turn, the repo looks IDLE — the CLI is starting, the
 * prompt has not been typed yet, and nothing about the live session list says
 * "wait". Releasing there would start the next open a second later and undo the
 * whole point.
 */
export interface SerialWatch {
  group: string;
  sessionId: string;
  /** Epoch ms the ack landed — the start of the startup grace. */
  at: number;
}

/**
 * Which serialization groups are still busy, and which watches are still worth
 * keeping.
 *
 * Two sources, deliberately:
 *   • any LIVE session in that directory that `laneBusy()` calls busy — mid-turn,
 *     parked on a question, or blocked on a usage limit. That includes sessions
 *     nobody queued (one opened by hand), which is the point: "don't edit this
 *     repo from two agents at once" is not a statement about who started them.
 *   • a watch inside its startup grace whose session has not reported a turn
 *     yet — the gap described on `SerialWatch`.
 *
 * A watch is dropped once its session HAS run a turn (the first rule takes over
 * from there) or once the grace has run out.
 */
export function busySerialGroups(
  sessions: readonly SerialSessionState[],
  watches: readonly SerialWatch[],
  now: number,
): { busy: Set<string>; watches: SerialWatch[] } {
  const busy = new Set<string>();
  for (const s of sessions) {
    if (s.running === false) continue;
    if (laneBusy(s)) busy.add(serialGroup(s.cwd));
  }
  const kept: SerialWatch[] = [];
  for (const w of watches) {
    const s = sessions.find((x) => x.id === w.sessionId);
    if (s && s.turnStartedAt) continue;             // it is live and has run — the rule above owns it now
    if (now - w.at >= SERIAL_STARTUP_MS) continue;  // never came up; stop holding the queue for it
    busy.add(w.group);
    kept.push(w);
  }
  return { busy, watches: kept };
}

/**
 * May this entry go out right now, given the user's two "hold the queue"
 * switches? Separate from `selectSendable` (which answers "would it corrupt the
 * session?") because this one answers "did the user mean to send it?".
 *
 *   • attempts > 0 — already went out once; a retry is the SAME message, not a
 *     new decision the switches get a say over.
 *   • armed — released explicitly (tapped Send with the link up, "Send now",
 *     "Send all"). Persisted with the entry, so intent survives a reload.
 *   • otherwise only when auto-send is on and no reconnect confirmation is
 *     pending.
 */
export function sendEligible(
  entry: { attempts?: number; armed?: boolean },
  opts: { autoSend: boolean; hold: boolean },
): boolean {
  if ((entry.attempts ?? 0) > 0) return true;
  if (entry.armed) return true;
  return opts.autoSend && !opts.hold;
}

// ── WHO holds a serial group ────────────────────────────────────────────────

/**
 * One thing holding a serialization group, as a sentence needs it.
 *
 * `wall` is `sessionWall`'s answer for a live session — the SAME derivation
 * `laneBusy` (and so `busySerialGroups`/`busyIntentGroups`) asks, never a
 * second reading of the four fields — or `starting` for work the caller knows
 * is starting or running there whose session is not (yet) behind a wall: the
 * delivery window, or a session still coming up.
 */
export interface SerialHolder {
  sessionId?: string;
  name?: string;
  /** `netStalled`: the holder is work STALLED on the API (a relabel of the
   *  `starting`/`sessionBusy` claim it makes — never a hold of its own). */
  wall: SessionWall | "starting" | "netStalled";
}

/**
 * Which sessions hold each busy group, keyed by `serialGroup(cwd)`.
 *
 * The keys are exactly the groups `busyIntentGroups` answers for the same two
 * inputs (it is built from this), so the sentence can never name a holder for
 * a group the ladder thinks is free, nor stay silent about one it holds.
 * `occupied` is the caller's own "work is starting or running here" list; an
 * entry whose session already holds the group as a live wall adds nothing.
 *
 * `automaticOnly` is the INTENT ladder's reading (`intentSerialHolders`): only
 * a session opened for queued work (`automatic`) can hold the group as a
 * wall, and such a session that ended its turn on a prose question
 * (`asking`) holds it as `awaitingAnswer` too. A hand session never does —
 * a person running five sessions in one repo all day would otherwise hold
 * every serial row for as long as any one of them was mid-turn. Without it
 * (the phone's send queue) every live session counts, exactly as before.
 */
export function serialHolders(
  sessions: readonly SerialSessionState[],
  occupied: Iterable<{ cwd: string; sessionId?: string; name?: string }>,
  opts: { automaticOnly?: boolean } = {},
): Map<string, SerialHolder[]> {
  const out = new Map<string, SerialHolder[]>();
  const add = (g: string, h: SerialHolder) => {
    const list = out.get(g);
    if (!list) { out.set(g, [h]); return; }
    if (h.sessionId && list.some((x) => x.sessionId === h.sessionId)) return;
    list.push(h);
  };
  for (const s of sessions) {
    if (s.running === false) continue;
    if (opts.automaticOnly && !s.automatic) continue;
    const wall = sessionWall(s) ?? (opts.automaticOnly && s.asking ? "awaitingAnswer" : null);
    if (wall) add(serialGroup(s.cwd), { sessionId: s.id, wall: wall === "sessionBusy" && s.netStalled ? "netStalled" : wall, ...(s.name ? { name: s.name } : {}) });
  }
  for (const o of occupied) {
    const s = o.sessionId ? sessions.find((x) => x.id === o.sessionId) : undefined;
    const name = s?.name || o.name;
    add(serialGroup(o.cwd), { ...(o.sessionId ? { sessionId: o.sessionId } : {}), wall: s?.netStalled ? "netStalled" : "starting", ...(name ? { name } : {}) });
  }
  return out;
}

/** The serial sentence when nobody said who holds the group. */
export const SERIAL_WAIT_TEXT = "one at a time in this repo — waiting for the session before it";

const SERIAL_WALL_WORDS: Record<Exclude<SerialHolder["wall"], "awaitingAnswer" | "netStalled">, string> = {
  sessionBusy: "working",
  limit: "on a usage limit",
  starting: "starting a queued job",
};

/** How long a quoted session name may run in the sentence. */
const SERIAL_NAME_MAX = 48;

/** Lead order: an open question first (it is the one a PERSON can clear, and
 *  the reason the owner asked for this hold), then any other session wall,
 *  then a `starting` claim. Stable within a rank. */
const SERIAL_RANK: Record<SerialHolder["wall"], number> = { awaitingAnswer: 0, netStalled: 0, limit: 1, sessionBusy: 1, starting: 2 };

/**
 * The holder a serial sentence NAMES, and the one a row offers to open — one
 * ordering for both, so the words and the button point at the same session.
 */
export function serialLead(holders: readonly SerialHolder[] | undefined): SerialHolder | undefined {
  if (!holders || !holders.length) return undefined;
  return [...holders].sort((a, b) => SERIAL_RANK[a.wall] - SERIAL_RANK[b.wall])[0];
}

/**
 * The serial sentence, NAMING what holds the repo:
 * "one at a time in this repo — waiting for 'fix webkit sync' (working)", or
 * "one at a time in this repo — waiting for your answer in 'fix webkit sync'"
 * when the predecessor is parked on a question (a box, an unparsable dialog,
 * or — for an automatic session — a turn that ended asking in prose), or
 * "one at a time in this repo — waiting behind a stalled item: API unreachable ('x')" when the work holding
 * the repo is stalled on the API (`netStalled`).
 *
 * `serialLead` picks the one named; the rest are "+N more". A claim with
 * no session and no name is "an automatic job is starting here". No holders
 * ⇒ the generic sentence — absent facts never become an invented name.
 */
export function serialWaitText(holders: readonly SerialHolder[] | undefined): string {
  const first = serialLead(holders);
  if (!holders || !first) return SERIAL_WAIT_TEXT;
  const more = holders.length > 1 ? ` +${holders.length - 1} more` : "";
  if (first.wall === "starting" && !first.name && !first.sessionId) {
    return `one at a time in this repo — an automatic job is starting here${more}`;
  }
  const raw = (first.name ?? "").trim();
  const name = raw.length > SERIAL_NAME_MAX ? `${raw.slice(0, SERIAL_NAME_MAX - 1)}…` : raw;
  if (first.wall === "netStalled") {
    // The predecessor is not working and not coming back by itself soon: its
    // turn could not reach the API. Say so, or the row reads as a queue that
    // never moves (R-connection-024).
    return `one at a time in this repo — waiting behind a stalled item: API unreachable${name ? ` ('${name}')` : ""}${more}`;
  }
  if (first.wall === "awaitingAnswer") {
    return `one at a time in this repo — waiting for your answer in ${name ? `'${name}'` : "the session before it"}${more}`;
  }
  const who = name ? `'${name}'` : "another session";
  return `one at a time in this repo — waiting for ${who} (${SERIAL_WALL_WORDS[first.wall]})${more}`;
}
