// The serial-group facts the phone reads off its session list: one flattening
// for `busySerialGroups` and one sentence naming who holds a group. Pure, and
// imports nothing but shared — `activity/activityQueueRow.ts` reads it too, and
// `logic.ts` (which imports the activity barrel) would be a cycle.
import { laneStateOf as sharedLaneStateOf, serialHolders, serialWaitText, waitedSessionName } from "@waterplane/shared";
import type { LaneSessionState, SessionInfo } from "@waterplane/shared";
import { trustAutoAccepted, type BackendList } from "../../backendCaps.ts";

/**
 * The `sessionWall` facts plus the trust one, off a `SessionInfo` — one mapping for
 * every phone caller (`laneBusy`, `holdWall`, `busySerialGroups`). `backends` absent or not
 * yet arrived ⇒ a trust box reads as auto-accepted, today's behaviour.
 */
export function laneStateOf(s: SessionInfo, backends?: BackendList): LaneSessionState {
  // The mapping itself is shared (`shared/queue/queuelanestate.ts`), the host's twin; only the
  // backend knowledge is the phone's own.
  return sharedLaneStateOf(s, { autoAcceptsTrust: trustAutoAccepted(backends ?? null, s.backend) });
}

/**
 * Flatten the session list into what `busySerialGroups` reads.
 *
 * Not optional plumbing: `laneBusy` wants `limitBlocked` and `promptKind`,
 * which live one level down on `SessionInfo` (`limit.blocked`, `prompt.kind`).
 * Handing it a raw SessionInfo type-checks — every field it needs is optional
 * — and quietly answers "not busy" for a session parked on a question or
 * blocked on a usage limit, i.e. exactly the two states this rule exists to
 * wait out.
 */
export const serialStates = (list: readonly SessionInfo[], backends?: BackendList) => list.map((s) => ({
  id: s.id, cwd: s.cwd, running: s.running, turnStartedAt: s.turnStartedAt,
  ...laneStateOf(s, backends),
  name: waitedSessionName(s),
}));

/**
 * The serial sentence for one group, NAMING the live session(s) that hold it
 * ("waiting for 'fix webkit sync' (working)") — `serialHolders` over the same
 * flattened states `busySerialGroups` reads, so the name and the hold are one
 * derivation. A group held only by a startup WATCH (a session this phone just
 * opened, not yet reporting a turn) names nobody here and gets the generic line.
 *
 * Every live session counts HERE, hand-opened ones included — this is the
 * phone's own queue of a person's sequential creates. The desktop's backlog
 * ladder reads the same function in its `automaticOnly` reading
 * (`intentSerialHolders`), where a hand session never holds a serial row.
 */
export function serialTextFor(group: string | undefined, sessions: readonly SessionInfo[], backends?: BackendList): string {
  return serialWaitText(group ? serialHolders(serialStates(sessions, backends), []).get(group) : undefined);
}
