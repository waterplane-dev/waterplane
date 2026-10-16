/**
 * **"Queue this one here."** — an item already written down, aimed at the
 * session a person is actually looking at.
 *
 * The compose bar could always do this for words being typed NOW
 * (`composeQueueHere` → `backlog.add` with `autoFire`). What it could not do was
 * the far more common shape: a backlog with fifteen things in it, a session open
 * on screen, and the wish to run four of them here in the order you tap them.
 * `backlog.update` carries `autoFire` for exactly that, and it lands on the
 * store as three facts at once.
 *
 * All three are pinned here because each fails SILENTLY and in a way no e2e can
 * see — the row sits there looking perfectly queued while doing the wrong thing:
 *
 *  1. **`pinned` exempts it from the global auto-fire switch.** That switch
 *     routes machinery; a tap that names one session is not machinery. If the
 *     flag is dropped anywhere between the wire and `cleanIntentRow`, the item
 *     waits for a switch the user never touched and looks like the feature does
 *     not work.
 *  2. **A patch that says nothing about `pinned` must not clear it.** The patch
 *     is spread over the row, so a bare `pinned: undefined` from an ordinary
 *     label edit would silently un-queue everything a person had just queued.
 *  3. **It goes to the BOTTOM.** The taps ARE the order. A row keeping its
 *     month-old `order` jumps the queue it was just added to, which is the one
 *     thing "build up a queue" must not do.
 *
 * Fake deps and a temp root, as `intentsched.test.mjs`: the store is the thing
 * under test and every fact it reads is a function it was handed.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { IntentManager } = await import("../dist/intents/manager.js");

const REPO = "/tmp/waterplane-queuehere-repo";
const settle = () => new Promise((r) => setTimeout(r, 30));

/** A store whose GLOBAL auto-fire switch is off — the state this feature is
 *  about. Anything that runs here ran because someone aimed it. */
function makeStore(over = {}) {
  const root = mkdtempSync(join(tmpdir(), "waterplane-queuehere-"));
  const state = { sessions: [], ran: [] };
  const exec = (name) => async (i) => { state.ran.push({ name, id: i.id }); return { ok: true, detail: "delivered" }; };
  const store = new IntentManager({
    root,
    sessions: () => state.sessions,
    sessionAlive: (id) => state.sessions.some((s) => s.id === id && s.running !== false),
    repoSession: () => null,
    repoAnySession: (cwd) => state.sessions.some((s) => s.running !== false && s.cwd === cwd),
    // The cap on automatic sessions, as the ladder reads it. Generous here —
    // this file is about where a PINNED row goes, and a pinned row is aimed at a
    // session that already exists, so it never asks for a slot at all.
    autoSlotsFree: () => 3,
    revivedSessionFor: () => null,
    diedAtLimit: () => false,
    stopCount: () => 0,
    isHooked: () => false,
    sessionIdleMs: () => 99_000,
    sessionHasPrompt: () => false,
    idleWindowMs: () => 1000,
    groupConcurrency: () => 6,
    knownDirs: async () => new Set([REPO]),
    budgetBlocked: () => false,
    autoFire: () => false,
    logVerdict: () => "unknown",
    executors: {
      freshSession: exec("freshSession"), sweep: exec("sweep"), deliver: exec("deliver"),
      workItem: exec("workItem"), build: exec("build"), assess: exec("assess"),
    },
    onChange: () => {},
    ...over,
  });
  return { store, state, root };
}

const item = (id, order) => ({
  id, cwd: REPO,
  payload: { kind: "prompt", steps: [`do ${id}`] },
  target: { kind: "repo" },
  trigger: { kind: "idle" },
  auto: true,
  order,
});

/** What the phone sends for one tap of *queue here*, as it reaches the store. */
const queueHere = (store, id, sessionId, order) =>
  store.update(id, { target: { kind: "session", sessionId }, pinned: true, order });

test("a pinned item runs with the global auto-fire switch OFF; its sibling waits", async () => {
  const { store, state, root } = makeStore();
  state.sessions.push({ id: "s-here", cwd: REPO, running: true });
  await store.reconcile();
  store.post(item("a", 1));
  store.post(item("b", 2));

  // Nothing may move while the switch is off and nobody has aimed anything.
  store.kick();
  await settle();
  assert.equal(state.ran.length, 0, "the global switch still gates un-aimed work");
  assert.equal(store.get("a").blockReason, "gate");

  assert.deepEqual(queueHere(store, "a", "s-here", 3), { ok: true });
  store.kick();
  await settle();
  assert.deepEqual(state.ran.map((r) => r.id), ["a"], "the aimed one ran, alone");
  assert.equal(store.get("a").sessionId, "s-here");
  assert.equal(store.get("b").blockReason, "gate", "its sibling is untouched and still gated");

  store.stop();
  rmSync(root, { recursive: true, force: true });
});

test("the tap moves the row to the BOTTOM — the taps are the order", async () => {
  const { store, root } = makeStore();
  await store.reconcile();
  store.post(item("old", 1));
  store.post(item("newer", 2));
  // `old` is tapped second, so it must run second: the order it had before the
  // tap describes a queue it was not in.
  queueHere(store, "newer", "s-here", 3);
  queueHere(store, "old", "s-here", 4);
  assert.ok(store.get("old").order > store.get("newer").order, "tap order, not age");
  store.stop();
  rmSync(root, { recursive: true, force: true });
});

test("an ordinary edit does not silently un-queue what was queued", async () => {
  const { store, root } = makeStore();
  await store.reconcile();
  store.post(item("a", 1));
  queueHere(store, "a", "s-here", 2);
  assert.equal(store.get("a").pinned, true);
  // A label edit says nothing about the flag, so it must say nothing about it.
  store.update("a", { label: "renamed" });
  assert.equal(store.get("a").pinned, true, "the flag survived an unrelated edit");
  assert.equal(store.get("a").label, "renamed");
  store.stop();
  rmSync(root, { recursive: true, force: true });
});

test("taking it back off clears the flag AND the target", async () => {
  const { store, root } = makeStore();
  await store.reconcile();
  store.post(item("a", 1));
  queueHere(store, "a", "s-here", 2);
  // What `onQueueHere(id, "")` becomes: back to a session of the item's OWN
  // (`cleanTarget` normalises a bare repo target to `fresh`), and back under the
  // global switch. It used to mean the repo's one shared backlog conversation.
  store.update("a", { target: { kind: "repo" }, pinned: undefined });
  assert.equal(store.get("a").pinned, undefined);
  assert.deepEqual(store.get("a").target, { kind: "repo", fresh: true });
  store.stop();
  rmSync(root, { recursive: true, force: true });
});
