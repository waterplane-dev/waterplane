// The ONE mapping from a session's wire record onto `LaneSessionState`.
//
// It was written twice — the phone's `laneStateOf` and an object literal in the host's
// `intentDeps.sessions` — each warning that handing `sessionWall` a raw `SessionInfo`
// "type-checks and quietly answers not busy". Every field is optional there and ABSENT reads as
// free, so a field one side forgot was a prompt typed into a question box (62fbb382 trust,
// 0b84920e auth/net, 181980cb). Both sides now call this; a `LaneSessionState` object literal
// anywhere else is refused by `tools/lanestate.test.mjs`.
//
// What only ONE side knows stays with that side: the host layers its unhooked-session silence
// guess over `turnActive` and its own serial facts (`automatic`, `asking`, `netStalled`, name)
// on top of this result; the phone and the host each decide `autoAcceptsTrust` from their own
// backend knowledge (`BackendInfo.caps` / the descriptor) and say it in `opts`.
import { blockWallOf } from "../block.js";
import type { BlockFacts } from "../block.js";
import type { SessionInfo } from "../wire/session.js";
import type { LaneSessionState } from "./queuelane.js";

/** The `SessionInfo` fields the lane reads — a `SessionInfo`, or anything shaped like its slice. */
export type LaneSource = BlockFacts & Pick<SessionInfo, "turnActive" | "awaitingInput" | "prompt">;

export interface LaneStateOpts {
  /**
   * Does delivery answer this session's backend's folder-trust box itself? `false` makes a trust
   * box a wall; `true` or absent leaves it auto-accepted (today's behaviour — a phone whose
   * backend list has not arrived says nothing). It only ever matters while a trust box is up.
   */
  autoAcceptsTrust?: boolean;
}

export function laneStateOf(s: LaneSource, opts: LaneStateOpts = {}): LaneSessionState {
  return {
    turnActive: s.turnActive, limitBlocked: s.limit?.blocked, promptKind: s.prompt?.kind,
    awaitingInput: s.awaitingInput,
    // Signed out, or the host's net retry holds it — `blockWallOf`, never `blockOf`'s kind: a
    // net give-up with nothing more scheduled and first-launch setup alone are badges, not walls.
    block: blockWallOf(s),
    ...(s.prompt?.kind === "trust" && opts.autoAcceptsTrust === false ? { trustAutoAccepted: false } : {}),
  };
}
