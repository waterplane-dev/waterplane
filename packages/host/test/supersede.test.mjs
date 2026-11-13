/**
 * A relaunch (`replaceSessionId`) or a limit resurrect moves a conversation to a NEW session id.
 * The old session used to stay in the list as `exited` right beside its replacement — the same
 * conversation twice in the phone's open tabs (2026-11-13). `drive.supersede` drops it once the
 * replacement exists: its companion shells follow the new id, the old row leaves the map, and
 * `superseded` is emitted so the server re-broadcasts the whole list.
 *
 * Stubbed: no PTY, no tmux. `drive.supersede` over a core proxy.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

const { supersede } = await import("../dist/sessions/drive.js");

const sid = () => `sup-${Math.random().toString(36).slice(2, 10)}`;

function harness() {
  const events = [];
  const sessions = new Map();
  const base = {
    sessions,
    emit: (ev, ...args) => { events.push([ev, ...args]); return true; },
  };
  const core = new Proxy(base, { get: (t, k) => (k in t ? t[k] : () => undefined) });
  const add = (id, extra = {}) => {
    const s = { info: { id, cwd: "/nowhere", running: false, ...extra.info }, history: [], proc: { kill() {} }, ...extra };
    delete s.info.info;
    sessions.set(id, s);
    return s;
  };
  return { core, sessions, events, add };
}

test("the replaced session leaves the list; its replacement and the event stay", () => {
  const h = harness();
  const [from, to] = [sid(), sid()];
  h.add(from);
  h.add(to, { info: { running: true } });
  assert.equal(supersede(h.core, from, to, "replaced"), true);
  assert.equal(h.sessions.has(from), false, "the old row is gone");
  assert.equal(h.sessions.has(to), true, "the replacement stays");
  assert.deepEqual(h.events.find((e) => e[0] === "superseded"), ["superseded", from, to]);
});

test("a companion shell follows the replacement instead of being closed with the old row", () => {
  const h = harness();
  const [from, to, comp] = [sid(), sid(), sid()];
  h.add(from);
  h.add(to, { info: { running: true } });
  const c = h.add(comp, { origin: { kind: "hand", companionOf: from }, info: { running: true, companionOf: from } });
  supersede(h.core, from, to);
  assert.equal(h.sessions.has(comp), true, "companion kept");
  assert.equal(c.origin.companionOf, to);
  assert.equal(c.info.companionOf, to);
});

test("nothing happens for an unknown id, a missing replacement, or the same id", () => {
  const h = harness();
  const a = sid();
  h.add(a);
  assert.equal(supersede(h.core, sid(), a), false);
  assert.equal(supersede(h.core, a, sid()), false, "never drop a row before its replacement exists");
  assert.equal(supersede(h.core, a, a), false);
  assert.equal(h.sessions.has(a), true);
  assert.equal(h.events.length, 0);
});
