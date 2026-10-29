// The net retry's STALL (R-connection-024, `sessions/apiretry.ts`): past the
// ladder's cap the work waiting on the session is stalled, and the host keeps
// probing on a slow cadence (`WATERPLANE_NET_RETRY_STALL_MS`), uncapped, while
// the switch is on. Dismissing the session's line only hides it — the stall
// stands. Driven on the slice with a fake core: no PTY, no log.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = mkdtempSync(join(tmpdir(), "wp-netstall-"));
process.env.WATERPLANE_ROOT = root;
process.env.WATERPLANE_NET_RETRY_STALL_MS = "150"; // read at import (`sessions/knobs.ts`)
const { NetRetrySlice } = await import("../dist/sessions/apiretry.js");
const { netRetryStalls, netStalledText } = await import("@waterplane/shared");

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
/** Poll, never a fixed sleep: a timing claim must survive a loaded machine. */
async function until(pred, what, ms = 5000) {
  const end = Date.now() + ms;
  while (!pred()) { if (Date.now() > end) throw new Error(`timed out waiting for ${what}`); await wait(10); }
}

function rig() {
  const writes = [];
  const sessions = new Map();
  const core = {
    sessions,
    emit() {}, loadLive: () => null, persistLive() {},
    write: (_id, data) => { writes.push(data); },
    recordPrompt() {},
  };
  const s = {
    info: { id: "s1", title: "backlog · r · x", running: true, cwd: root, netRetry: null },
    turnActive: false, lastDataAt: 0, stopCount: 0, netTimer: null, netRecheck: null,
  };
  sessions.set("s1", s);
  return { slice: new NetRetrySlice(core), s, writes };
}
const gaveUp = () => ({ state: "gaveup", attempt: 8, max: 8, nextAt: null, error: "Can't reach the API server (ENOTFOUND)", at: 1, why: "after 8 tries" });

test("past the cap a stall PROBES on its cadence, uncapped, flagged `probe` so the work stays stalled", async (t) => {
  const { slice, s, writes } = rig();
  t.after(() => slice.clear(s));
  s.info.netRetry = gaveUp();
  slice.switched(true); // a stall with no probe armed gets one
  const armed = s.info.netRetry;
  assert.equal(armed.state, "gaveup");
  assert.ok(armed.nextAt != null && armed.nextAt > Date.now(), "the next probe rides as nextAt");
  assert.match(netStalledText(armed, armed.nextAt - 23 * 60_000), /· next try in 23m$/);
  await until(() => writes.length >= 1, "the probe"); // `continue` typed through `fire()`
  assert.equal(writes[0], "continue");
  assert.equal(s.info.netRetry.state, "sent");
  assert.equal(s.info.netRetry.probe, true);
  assert.ok(netRetryStalls(s.info.netRetry), "a probe under way is still a stall");
  assert.match(netStalledText(s.info.netRetry), /· trying again now$/);
  await until(() => writes.length >= 2, "the Return");
  assert.deepEqual(writes, ["continue", "\r"]);
  // The probe's turn gave up again: back to the stall, next probe armed, no cap.
  const end = slice["schedule"](s, Date.now(), "Can't reach the API server (ENOTFOUND)");
  assert.equal(end.net, "gaveup");
  assert.equal(s.info.netRetry.state, "gaveup");
  assert.equal(s.info.netRetry.attempt, 9, "past the ladder's 8: no cap while stalled");
  assert.ok(s.info.netRetry.nextAt != null);
  assert.equal(s.info.netRetry.probe, undefined);
  await until(() => writes.filter((w) => w === "continue").length === 2, "the next probe");
});

test("dismissing the gave-up line only HIDES it — the stall stands, and the probe keeps it hidden", async (t) => {
  const { slice, s, writes } = rig();
  t.after(() => slice.clear(s));
  s.info.netRetry = gaveUp();
  slice.cancelById("s1");
  assert.equal(s.info.netRetry.state, "gaveup", "not cleared");
  assert.equal(s.info.netRetry.dismissed, true);
  assert.ok(netRetryStalls(s.info.netRetry), "a dismissed gave-up is still a stall");
  slice.switched(true);
  await until(() => writes.length >= 1, "the probe");
  assert.equal(s.info.netRetry.dismissed, true, "the probe keeps the line hidden");
  await until(() => writes.length >= 2, "the Return");
  slice["schedule"](s, Date.now(), "x");
  assert.equal(s.info.netRetry.dismissed, true, "…and so does its give-up");
  // A person typing ends it (the next real turn end completes the work).
  slice.typed(s);
  assert.equal(s.info.netRetry, null);
});

test("the switch off stops the probing and KEEPS the stall; a cancelled probe does the same", async (t) => {
  const { slice, s, writes } = rig();
  t.after(() => slice.clear(s));
  s.info.netRetry = gaveUp();
  slice.switched(true);
  assert.ok(s.info.netRetry.nextAt != null);
  slice.switched(false);
  assert.equal(s.info.netRetry.state, "gaveup");
  assert.equal(s.info.netRetry.nextAt, null, "no probe while off");
  await wait(250);
  assert.deepEqual(writes, [], "nothing typed");
  // A probe parked on a box, cancelled from the phone: back to the stall.
  slice.switched(true);
  s.info.prompt = { kind: "choice" };
  await until(() => s.info.netRetry.state === "waiting", "the parked probe");
  assert.equal(s.info.netRetry.probe, true);
  assert.ok(netRetryStalls(s.info.netRetry), "a parked probe is still a stall");
  slice.cancelById("s1");
  assert.equal(s.info.netRetry.state, "gaveup");
  assert.equal(s.info.netRetry.nextAt, null);
  assert.deepEqual(writes, []);
});

test.after(() => rmSync(root, { recursive: true, force: true }));
