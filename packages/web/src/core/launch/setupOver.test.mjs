/**
 * A repo's set-up page over a started session: the start is exactly the start it was.
 *
 *     node --test packages/web/src/core/launch/setupOver.test.mjs
 *
 * `useLaunch` is rendered through `react-dom/server`, so its refs and state are React's own; the queue is
 * a recorder. Effects do not run there, which is the point: nothing the page does may be part of the start.
 */
import "../../../../../scripts/lib-tsload.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToString } from "react-dom/server";

const store = new Map();
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => { store.set(k, String(v)); },
  removeItem: (k) => store.delete(k), key: (i) => [...store.keys()][i] ?? null, get length() { return store.size; },
};
const noop = () => {};
globalThis.window = { addEventListener: noop, removeEventListener: noop, setTimeout: () => 0, clearTimeout: noop, setInterval: () => 0, matchMedia: () => ({ matches: false, addEventListener: noop }), location: { search: "", hash: "", pathname: "/", href: "http://x/" } };
globalThis.document = { addEventListener: noop, documentElement: { style: {}, classList: { add: noop, remove: noop } }, visibilityState: "visible" };

const { useLaunch } = await import("./useLaunch.ts");
const { AFTER_START_MS, afterStartStep } = await import("./afterStart.ts");
const { mayOffer } = await import("../../features/repoSetup/logic.ts");

const REPO = { id: "r1", repoName: "fresh", branch: "main", worktreePath: "/root/fresh", isPrimary: true };

/** Everything the start did, in order, with the one random thing (the create's ack) named by its order. */
function starts(act) {
  const did = [];
  const acks = new Map();
  const ackName = (a) => { if (!acks.has(a)) acks.set(a, `ack${acks.size + 1}`); return acks.get(a); };
  let launch;
  function Probe() {
    launch = useLaunch({
      backends: null, setOverlay: (o) => did.push(["overlay", o]), geomRef: { current: { cols: 80, rows: 24 } },
      queue: {
        queueOp: (op, lane, text, opts) => { did.push(["queueOp", JSON.stringify(op), lane, text, { ...opts, ackId: ackName(opts.ackId) }]); return false; },
        enterPending: (a) => did.push(["enterPending", ackName(a)]), enterOldestPending: (c) => did.push(["oldest", c]),
        queueSessionPrompt: (...a) => did.push(["prompt", ...a]), submitInput: (...a) => did.push(["input", ...a]),
      },
      setRepos: noop, setReposAt: noop, setReposFailAt: noop, root: "/root", repos: [REPO], active: null, activeId: null, overlay: null,
      openingCwds: () => new Map(), repoForCwd: () => null,
    });
    return null;
  }
  renderToString(createElement(Probe));
  act(launch);
  return did;
}
/** The new-project sheet's own `onOpen`, off the overlay table it is drawn from. */
const openMade = (offer) => (l) => l.sheets.new().props.onOpen("/root/fresh", "fresh", offer);

test("R-onboarding-034: New session queues the same ops in the same order with and without setupUnseen", () => {
  const plain = starts((l) => l.openRepo(REPO));
  assert.deepEqual(plain.map((x) => x[0]), ["queueOp", "enterPending"]);
  assert.deepEqual(starts((l) => l.openRepo({ ...REPO, setupUnseen: true })), plain);
  assert.deepEqual(starts((l) => l.openRepo({ ...REPO, setupUnseen: true }, false)), plain);
});

test("R-onboarding-034: a create or clone queues the same ops in the same order with and without the page", () => {
  const plain = starts((l) => l.openCwd("/root/fresh", "fresh"));
  assert.deepEqual(plain.map((x) => x[0]), ["queueOp", "enterPending"]);
  assert.deepEqual(starts(openMade(true)), plain);
  assert.deepEqual(starts(openMade(false)), plain);
});

test("R-onboarding-034: the page waits on the pending screen and opens only over the bare screen of the session it became", () => {
  const want = { screen: "pending:a1", at: 1000 };
  const step = (o) => afterStartStep(want, { activeId: "pending:a1", overlay: null, session: null, now: 2000, ...o });
  assert.equal(step({}), "wait", "the desktop has not answered: it may still refuse");
  assert.equal(step({ activeId: "s9", session: "s9" }), "open");
  assert.equal(step({ activeId: "s9", session: "s9", overlay: "files" }), "drop", "a sheet over it");
  assert.equal(step({ overlay: "launchask" }), "drop");
  assert.equal(step({ activeId: "s3", session: "s9" }), "drop", "another session");
  assert.equal(step({ activeId: null }), "drop", "Home");
  assert.equal(step({ activeId: "s9", session: "s9", now: 1000 + AFTER_START_MS + 1 }), "drop", "the answer came minutes later");
});

test("R-onboarding-034: never by itself in the demo, on a child's device, offline, or twice in one page load", () => {
  const ok = { demo: false, passive: false, online: true, opened: false };
  assert.equal(mayOffer(ok), true);
  for (const no of [{ demo: true }, { passive: true }, { online: false }, { opened: true }]) assert.equal(mayOffer({ ...ok, ...no }), false, JSON.stringify(no));
});
