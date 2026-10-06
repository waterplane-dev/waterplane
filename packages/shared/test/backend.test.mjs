// The wire subset of a backend descriptor (`shared/src/wire/backend.ts`) and
// the two additive fields that name one (`LaunchOpts.backend`,
// `SessionInfo.backend`, `shared/src/wire/session.ts`). No runtime logic
// computes any of this yet — it is pure DTO shape — so what is worth pinning
// is the JSON-codec contract every consumer on both ends must honor:
// `contextWindowTokens` absent must never turn into 0, and a `SessionInfo`
// with no `backend` key must stay that way rather than being coerced into
// some other value, because CLAUDE.md's rule is that absence there IS the
// value "claude".
import test from "node:test";
import assert from "node:assert/strict";
import { decode, encode } from "../dist/index.js";

const fullCaps = {
  contextMeter: true,
  usageLimits: true,
  transcript: true,
  slash: true,
  promptBoxes: true,
  hooks: true,
  effort: true,
  remoteControl: true,
  permissionModes: ["default", "plan", "acceptEdits", "auto", "dontAsk", "bypassPermissions"],
};

const bareCaps = {
  contextMeter: false,
  usageLimits: false,
  transcript: false,
  slash: false,
  promptBoxes: false,
  hooks: false,
  effort: false,
  remoteControl: false,
  permissionModes: [],
};

test("the backends message round-trips through the JSON codec", () => {
  const list = [
    { id: "claude", label: "Claude Code", caps: fullCaps, models: { aliases: ["opus", "sonnet"], ids: ["claude-opus-5"] }, contextWindowTokens: 200_000 },
    { id: "othercli", label: "othercli", caps: bareCaps, models: { aliases: [], ids: [] } },
  ];
  const wire = encode({ t: "backends", list });
  const back = decode(wire);
  assert.deepEqual(back, { t: "backends", list });
});

test("contextWindowTokens absent stays absent — never coerced to 0", () => {
  const info = { id: "othercli", label: "othercli", caps: bareCaps, models: { aliases: [], ids: [] } };
  const wire = encode({ t: "backends", list: [info] });
  // Not merely `undefined` on the decoded object — the key must not even be
  // present on the wire, so a naive `JSON.parse` on the other end sees no
  // trace of it either (the failure mode this guards is `?? 0` upstream).
  assert.equal(wire.includes("contextWindowTokens"), false);
  const back = decode(wire);
  assert.equal("contextWindowTokens" in back.list[0], false);
  assert.equal(back.list[0].contextWindowTokens, undefined);
});

test("an absent backend on a SessionInfo means claude — the key stays absent, never defaulted on the wire", () => {
  const session = {
    id: "s1",
    cwd: "/repo",
    title: "repo · main",
    remoteControl: true,
    running: true,
    // no `backend` field — this is the pre-multi-backend shape verbatim.
  };
  const wire = encode({ t: "session.list", sessions: [session] });
  assert.equal(wire.includes("\"backend\""), false);
  const back = decode(wire);
  assert.equal("backend" in back.sessions[0], false);
  assert.equal(back.sessions[0].backend, undefined);
});

test("a session that DOES name a backend keeps it through the round trip", () => {
  const session = {
    id: "s2",
    cwd: "/repo",
    title: "repo · main",
    remoteControl: true,
    running: true,
    backend: "othercli",
  };
  const back = decode(encode({ t: "session.list", sessions: [session] }));
  assert.equal(back.sessions[0].backend, "othercli");
});

test("LaunchOpts.backend is additive: an opts object with none named is unchanged by the round trip", () => {
  const opts = { model: "opus", effort: "high" };
  const wire = JSON.stringify(opts);
  assert.equal(wire.includes("backend"), false);
  assert.equal(JSON.parse(wire).backend, undefined);
});
