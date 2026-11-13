// `laneStateOf` — the ONE mapping from a SessionInfo onto LaneSessionState.
//
// It used to be written twice: the phone's `laneStateOf` (web/core/queue/serialStates.ts) and an
// object literal in the host's `intentDeps.sessions`. Both carried the same warning ("a raw
// SessionInfo type-checks and quietly answers not busy"), and a field one side forgot read as
// "free" — a prompt typed into a question box (commits 62fbb382, 0b84920e, 181980cb).
//
// `phoneBefore` and `hostBefore` below are COPIES of those two mappings as they stood before the
// merge (the host's is its literal, minus the host-only facts it layers on top: convId, automatic,
// asking, netStalled, name, and the unhooked-session turnActive heuristic). They are the pinned
// expectation: the shared function must reproduce both on every fixture, and where the two
// disagreed it is listed in DISAGREE.
import test from "node:test";
import assert from "node:assert/strict";
import { blockWallOf, laneStateOf, laneBusy, sessionWall } from "../dist/index.js";

// Copy of packages/web/src/core/queue/serialStates.ts laneStateOf (before). `trust` = what the
// phone's backend list said (`trustAutoAccepted`): false | undefined.
function phoneBefore(s, trust) {
  const t = s.prompt?.kind === "trust" ? trust : undefined;
  return {
    turnActive: s.turnActive, limitBlocked: s.limit?.blocked, promptKind: s.prompt?.kind,
    awaitingInput: s.awaitingInput, block: blockWallOf(s),
    ...(t === false ? { trustAutoAccepted: false } : {}),
  };
}
// Copy of the object literal in packages/host/src/server/intentDeps.ts (before). `autoAccepts` =
// `backendAutoAcceptsTrust(s.backend)`. `turnActive` is passed in: the host ORs in its silence guess.
function hostBefore(s, autoAccepts, turnActive) {
  return {
    turnActive,
    limitBlocked: s.limit?.blocked, promptKind: s.prompt?.kind, awaitingInput: s.awaitingInput,
    block: blockWallOf(s),
    ...(s.prompt?.kind === "trust" && !autoAccepts ? { trustAutoAccepted: false } : {}),
  };
}

const base = { id: "s", cwd: "/r", running: true };
const FIXTURES = {
  idle: { ...base },
  busyHooked: { ...base, turnActive: true },
  limited: { ...base, limit: { blocked: true } },
  choiceBox: { ...base, prompt: { kind: "choice" } },
  trustBox: { ...base, prompt: { kind: "trust" } },
  trustBoxOtherCli: { ...base, backend: "copilot", prompt: { kind: "trust" } },
  unparsedDialog: { ...base, awaitingInput: true },
  signedOut: { ...base, signedOut: true },
  netRetrying: { ...base, netRetry: { phase: "waiting", nextAt: 1 } },
  exited: { ...base, running: false, turnActive: false },
  exitedMidTurn: { ...base, running: false, turnActive: true },
  limitedAndBox: { ...base, limit: { blocked: true }, prompt: { kind: "choice" } },
};

const trimUndef = (o) => JSON.parse(JSON.stringify(o));

test("one mapping reproduces the phone's old mapping on every fixture", () => {
  for (const [name, s] of Object.entries(FIXTURES)) {
    for (const trust of [undefined, false]) {
      const got = laneStateOf(s, { autoAcceptsTrust: trust === false ? false : undefined });
      assert.deepEqual(trimUndef(got), trimUndef(phoneBefore(s, trust)), `${name} trust=${trust}`);
    }
  }
});

test("one mapping reproduces the host's old literal on every fixture", () => {
  for (const [name, s] of Object.entries(FIXTURES)) {
    for (const autoAccepts of [true, false]) {
      const got = laneStateOf(s, { autoAcceptsTrust: autoAccepts });
      assert.deepEqual(trimUndef(got), trimUndef(hostBefore(s, autoAccepts, s.turnActive)), `${name} auto=${autoAccepts}`);
    }
  }
});

// The disagreements that existed. They are in WHAT EACH SIDE KNOWS, not in the field mapping:
// for the same SessionInfo and the same backend the field mapping was identical.
//  1. turnActive: the host ORs in `autoFireBlocker`'s silence guess for an unhooked session; the
//     phone never could. Kept host-side, layered on the shared result (a host-only fact).
//  2. a backend the phone's list does not name (list not yet arrived / unknown id) reads as
//     auto-accepted; the host reads an id it cannot name as NOT auto-accepted (a wall). Both
//     callers keep their own answer for `autoAcceptsTrust`.
test("the trust box is a wall only when the caller says the backend waits for a person", () => {
  const s = FIXTURES.trustBox;
  assert.equal(sessionWall(laneStateOf(s)), null);
  assert.equal(sessionWall(laneStateOf(s, { autoAcceptsTrust: true })), null);
  assert.equal(sessionWall(laneStateOf(s, { autoAcceptsTrust: false })), "awaitingAnswer");
  // a non-trust box ignores the opt
  assert.equal(laneStateOf(FIXTURES.choiceBox, { autoAcceptsTrust: false }).trustAutoAccepted, undefined);
});

test("walls come out right for the fixtures", () => {
  const wall = (n) => sessionWall(laneStateOf(FIXTURES[n]));
  assert.equal(wall("idle"), null);
  assert.equal(wall("busyHooked"), "sessionBusy");
  assert.equal(wall("limited"), "limit");
  assert.equal(wall("limitedAndBox"), "limit");
  assert.equal(wall("choiceBox"), "awaitingAnswer");
  assert.equal(wall("unparsedDialog"), "awaitingAnswer");
  assert.equal(wall("signedOut"), "auth");
  assert.equal(wall("netRetrying"), "net");
  assert.equal(laneBusy(laneStateOf(FIXTURES.exited)), false);
});
