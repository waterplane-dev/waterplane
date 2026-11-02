/**
 * The sign-in episode (`recover/authgate.ts`, Phase D of the blocked sessions):
 * sessions a sign-out stopped are ONE episode per account; `claude auth status`
 * is read only while somebody waits and the account is not yet confirmed; a
 * confirmation ASKS (one push, a wire stamp) and types nothing; the person's
 * continue goes through the wave — first alone — and a first still signed out
 * puts the episode back to "signed out" without typing into the rest.
 * Plus the slice (`sessions/signinwait.ts`) over a fake core: who has an
 * account, who joins, who leaves.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

const { AuthEpisode } = await import("../dist/recover/authgate.js");
const { SignInSlice } = await import("../dist/sessions/signinwait.js");
const { signInWords } = await import("../dist/recover/blockpush.js");
const { detectLimitText, detectSpendText } = await import("../dist/limit.js");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (pred, ms = 2000) => { const t0 = Date.now(); while (!pred()) { if (Date.now() - t0 > ms) throw new Error("timed out"); await sleep(5); } };

/** An episode over fake deps: `auth` is what `claude auth status` says; `alive` the live ids. */
function rig(over = {}) {
  const r = {
    auth: "out", reads: 0, sent: [], wire: new Map(), said: [], verdictFor: new Map(),
    alive: new Set(["a", "b", "c"]),
  };
  r.ep = new AuthEpisode({
    read: async () => { r.reads++; return r.auth; },
    dispatch: (id) => { r.sent.push(id); },
    alive: (id) => r.alive.has(id),
    publish: (id, w) => { if (w) r.wire.set(id, w); else r.wire.delete(id); },
    announce: (t, n) => { r.said.push(`${t}:${n}`); },
    settle: (id) => r.verdictFor.get(id) ?? "wait",
    pollMs: 20, announceDelayMs: 15, settleMs: 10_000, gapMs: 10,
    ...over,
  });
  return r;
}

test("episode: members join on a sign-out; one push for sessions failing together", async (t) => {
  const r = rig(); t.after(() => r.ep.dispose());
  r.ep.signedOut("a"); r.ep.signedOut("b"); r.ep.signedOut("a");
  assert.equal(r.ep.size, 2);
  assert.deepEqual(r.wire.get("a").signedInAt, undefined);
  await until(() => r.said.length);
  await sleep(40);
  assert.deepEqual(r.said, ["signedOut:2"], "one signed-out push, counting both");
});

test("episode: polls only while somebody waits and not yet confirmed; stops on confirm and on empty", async (t) => {
  const r = rig(); t.after(() => r.ep.dispose());
  assert.equal(r.ep.polling(), false, "no member, no read");
  assert.equal(r.reads, 0);
  r.ep.signedOut("a");
  await until(() => r.reads >= 2);
  assert.equal(r.ep.confirmedAt(), null, "still out");
  r.auth = "in";
  await until(() => r.ep.confirmedAt() != null);
  const reads = r.reads;
  await sleep(80);
  assert.equal(r.reads, reads, "confirmed: the poll stopped");
  assert.equal(r.ep.polling(), false);
  assert.equal(r.said.filter((x) => x.startsWith("signedIn")).length, 1, "one signed-in push");
  assert.ok(r.wire.get("a").signedInAt > 0, "the member's wire says signed in again");
  assert.equal(r.sent.length, 0, "confirmation types NOTHING — it asks");
  r.ep.leave("a");
  assert.equal(r.ep.size, 0);
  assert.ok(r.said.includes("ended:0"));
  assert.equal(r.wire.has("a"), false);
});

test("episode: a stale local 'in' is not a sign-in — needs an 'out' first, or evidence", async (t) => {
  const r = rig(); t.after(() => r.ep.dispose());
  r.auth = "in";
  r.ep.signedOut("a");
  await until(() => r.reads >= 3);
  assert.equal(r.ep.confirmedAt(), null, "the API refused this credential; 'in' alone proves nothing");
  r.ep.evidence(); // e.g. another session's turn was served
  await until(() => r.ep.confirmedAt() != null);
});

test("episode: continue goes first ALONE; resumed frees the rest; members leave as they get through", async (t) => {
  const r = rig(); t.after(() => r.ep.dispose());
  for (const id of ["a", "b", "c"]) r.ep.signedOut(id);
  r.auth = "in"; r.ep.evidence();
  await until(() => r.ep.confirmedAt() != null);
  const res = r.ep.continueIds(["a", "b", "c", "zz"]);
  assert.deepEqual(res.taken, ["a", "b", "c"]);
  assert.deepEqual(res.ignored, ["zz"]);
  assert.deepEqual(r.sent, ["a"], "the first goes alone");
  assert.equal(r.wire.get("a").continuing, true);
  assert.equal(r.wire.get("b").queued, true);
  await sleep(50);
  assert.deepEqual(r.sent, ["a"], "the rest wait for its verdict");
  r.ep.verdict("a", "resumed");
  assert.equal(r.ep.isMember("a"), false, "got through: out of the episode");
  await until(() => r.sent.length === 3);
  assert.deepEqual(r.sent, ["a", "b", "c"]);
  r.ep.verdict("b", "resumed"); r.ep.verdict("c", "resumed");
  assert.equal(r.ep.size, 0);
  assert.equal(r.said.at(-1), "ended:0");
});

test("episode: the first still signed out ⇒ back to 'signed out', the rest NOT typed, no new push, poll resumes", async (t) => {
  const r = rig(); t.after(() => r.ep.dispose());
  for (const id of ["a", "b"]) r.ep.signedOut(id);
  r.auth = "in"; r.ep.evidence();
  await until(() => r.ep.confirmedAt() != null);
  r.ep.continueIds(["a", "b"]);
  assert.deepEqual(r.sent, ["a"]);
  const pushes = r.said.length;
  r.auth = "out";
  r.ep.signedOut("a"); // its continue's turn ended authentication_failed
  assert.equal(r.ep.confirmedAt(), null);
  assert.equal(r.ep.isMember("a"), true, "still waiting");
  assert.equal(r.wire.get("a").signedInAt, undefined);
  assert.equal(r.wire.get("b").queued, undefined, "the queued one left the line");
  await sleep(60);
  assert.deepEqual(r.sent, ["a"], "nothing more typed");
  assert.deepEqual(r.said.slice(pushes), ["stillOut:2"], "ONE push under the same key takes back 'signed in again'");
  assert.equal(r.ep.polling() || r.reads > 0, true, "polling again");
  // A fresh sign-in ASKS again; a new tap is needed.
  r.auth = "in";
  await until(() => r.ep.confirmedAt() != null);
  assert.deepEqual(r.sent, ["a"]);
  assert.equal(r.said.filter((x) => x.startsWith("signedIn")).length, 2);
});

test("episode: a tap before the confirmation is taken (the person may know better)", async (t) => {
  const r = rig(); t.after(() => r.ep.dispose());
  r.ep.signedOut("a");
  assert.deepEqual(r.ep.continueIds(["a"]).taken, ["a"]);
  assert.deepEqual(r.sent, ["a"]);
});

test("episode: a tap refused BEFORE any confirmation pushes nothing new (no 'signed in again' to take back)", async (t) => {
  const r = rig(); t.after(() => r.ep.dispose());
  r.ep.signedOut("a");
  await until(() => r.said.length);
  r.ep.continueIds(["a"]);
  r.ep.signedOut("a"); // refused
  await sleep(30);
  assert.deepEqual(r.said, ["signedOut:1"]);
});

test("episode: a stale 'in' forever — the poll backs off (capped) and the members read `unsure`; an 'out' clears it", async (t) => {
  const r = rig({ pollMs: 10, maxPollMs: 40 }); t.after(() => r.ep.dispose());
  r.auth = "in";
  r.ep.signedOut("a");
  await until(() => r.wire.get("a")?.unsure === true);
  assert.equal(r.ep.isUnsure(), true);
  assert.ok(r.reads >= 2, "after two unproving reads");
  assert.equal(r.ep.confirmedAt(), null, "never confirmed off a stale 'in'");
  assert.equal(r.sent.length, 0, "unsure types nothing");
  const before = r.reads;
  await sleep(300);
  assert.ok(r.reads - before <= 9, `backed off to the cap (${r.reads - before} reads in 300 ms; 10 ms would be ~30)`);
  assert.ok(r.reads - before >= 4, "still polling at the cap");
  r.auth = "out";
  await until(() => r.wire.get("a")?.unsure !== true);
  r.auth = "in";
  await until(() => r.ep.confirmedAt() != null);
  assert.equal(r.wire.get("a").unsure, undefined, "a confirmation outranks it");
});

test("episode: an 'out' ever read ⇒ never `unsure` (the reader CAN tell); still backed off", async (t) => {
  const r = rig({ pollMs: 10, maxPollMs: 40 }); t.after(() => r.ep.dispose());
  r.ep.signedOut("a");
  await until(() => r.reads >= 1);
  r.ep.signedOut("b");
  r.ep.continueIds(["a"]);
  r.ep.signedOut("a"); // refused: back to signed out — `sawOut` resets, `everOut` does not
  r.auth = "in";
  await sleep(120);
  assert.equal(r.wire.get("a").unsure, undefined);
});

test("episode: weak evidence (a link left the screen) buys a read; only an 'in' after an 'out' confirms", async (t) => {
  const r = rig({ pollMs: 5000 }); t.after(() => r.ep.dispose());
  r.auth = "in";
  r.ep.signedOut("a");
  await until(() => r.reads >= 1);
  r.ep.evidence(false); // Esc out of /login, a scroll, a resize
  await until(() => r.reads >= 2);
  assert.equal(r.ep.confirmedAt(), null, "weak evidence and a stale 'in' prove nothing");
  r.auth = "out"; r.ep.evidence(false);
  await until(() => r.reads >= 3);
  r.auth = "in"; r.ep.evidence(false);
  await until(() => r.ep.confirmedAt() != null);
});

test("episode: restore after a restart — a member again, silently, polling; a tap is not restored", async (t) => {
  const r = rig(); t.after(() => r.ep.dispose());
  r.ep.restore("a", 1234);
  assert.equal(r.ep.isMember("a"), true);
  assert.equal(r.wire.get("a").since, 1234);
  assert.equal(r.wire.get("a").queued, undefined);
  await until(() => r.reads >= 1);
  await sleep(40);
  assert.deepEqual(r.said, [], "a restart is not a transition: no push");
  assert.deepEqual(r.sent, []);
});

test("episode: a busy or timed-out continue leaves the member waiting for a tap", async (t) => {
  const r = rig(); t.after(() => r.ep.dispose());
  r.ep.signedOut("a");
  r.ep.continueIds(["a"]);
  r.ep.verdict("a", "gone");
  assert.equal(r.ep.isMember("a"), true);
  assert.equal(r.wire.get("a").continuing, undefined);
});

test("push words: once per transition, opening nothing unasked, never a limit phrase", () => {
  const out = signInWords("signedOut", 4).push;
  assert.match(out.title, /^Signed out — 4 sessions stopped/);
  assert.match(out.body, /Sign in once from any of them/);
  const back = signInWords("signedIn", 4).push;
  assert.match(back.title, /^Signed in again — continue the 4 sessions that stopped\?/);
  assert.match(signInWords("signedIn", 1).push.title, /continue the session that stopped\?/);
  assert.equal(signInWords("ended", 0).push, null);
  const still = signInWords("stillOut", 2).push;
  assert.match(still.title, /^Still signed out — sign in again/);
  assert.equal(still.key, back.key, "under the same key: it REPLACES 'signed in again'");
  for (const w of [out, back, still]) {
    for (const text of [w.title, w.body]) {
      assert.equal(detectLimitText(text).blocked, false, text);
      assert.equal(detectSpendText(text).spend, false, text);
    }
  }
});

/** A fake core: sessions by id, the emitted events, what was typed where. */
function slice(read = async () => "out", parkMs) {
  const sessions = new Map();
  const events = [];
  const typed = [];
  const core = { sessions, emit: (...a) => { events.push(a); return true; }, write: (id, d) => { typed.push([id, d]); return true; }, recordPrompt: () => {} };
  const mk = (id, backend = "claude") => {
    const s = { info: { id, title: id, cwd: "/tmp", running: true }, backend: { id: backend, bin: () => "claude" }, turnActive: false, lastDataAt: 0 };
    sessions.set(id, s);
    return s;
  };
  return { sl: new SignInSlice(core, read, parkMs), sessions, events, mk, typed };
}

test("slice: only the claude backend has the account; another backend never joins", (t) => {
  const { sl, mk } = slice();
  const a = mk("a"), loc = mk("l", "claude-local"), ep = mk("e", "claude-endpoint");
  sl.signedOut(a); sl.signedOut(loc); sl.signedOut(ep);
  t.after(() => sl.episodeOf(a)?.dispose());
  assert.equal(sl.episodeOf(a).size, 1);
  assert.equal(sl.episodeOf(loc), undefined);
  assert.equal(loc.info.signInWait, undefined);
  assert.ok(a.info.signInWait?.since > 0);
  assert.deepEqual(sl.continueIds(["a", "l", "nope"]).ignored, ["l", "nope"]);
});

test("slice: a person's turn takes a member out; raw keystrokes (the /login) do not", (t) => {
  const { sl, mk } = slice();
  const a = mk("a"), b = mk("b");
  sl.signedOut(a); sl.signedOut(b);
  const ep = sl.episodeOf(a);
  t.after(() => ep.dispose());
  sl.turnStarted(a); // a person submitted a prompt there
  assert.equal(ep.isMember("a"), false);
  assert.equal(a.info.signInWait, undefined);
  sl.clear(b);
  assert.equal(ep.size, 0);
});

test("slice: a served turn elsewhere is evidence — the account is read at once", async (t) => {
  let reads = 0;
  const { sl, mk } = slice(async () => { reads++; return "in"; });
  const a = mk("a"), other = mk("o");
  sl.signedOut(a);
  const ep = sl.episodeOf(a);
  t.after(() => ep.dispose());
  await until(() => reads >= 1);
  assert.equal(ep.confirmedAt(), null, "a bare 'in' right after the refusal proves nothing");
  sl.served(other);
  await until(() => ep.confirmedAt() != null);
  assert.ok(a.info.signInWait.signedInAt > 0);
});

test("slice: a sign-in link leaving the screen is weak evidence; the CLI's post-login row makes it strong", async (t) => {
  let reads = 0;
  const { sl, mk } = slice(async () => { reads++; return "in"; });
  const a = mk("a");
  sl.signedOut(a);
  const ep = sl.episodeOf(a);
  t.after(() => ep.dispose());
  await until(() => reads >= 1);
  sl.loginRetired(a, false);
  await until(() => reads >= 2);
  assert.equal(ep.confirmedAt(), null, "an Esc out of /login is not a sign-in");
  sl.loginRetired(a, true);
  await until(() => ep.confirmedAt() != null);
});

test("finding 1: a parked member's re-ask is dropped once the episode went back to signed out — no continue without a new tap", async (t) => {
  const { sl, mk, typed } = slice(async () => "in", 60);
  const a = mk("a"), b = mk("b"), o = mk("o");
  sl.signedOut(a); sl.signedOut(b);
  const ep = sl.episodeOf(a);
  t.after(() => ep.dispose());
  sl.served(o); // evidence: confirmed
  await until(() => ep.confirmedAt() != null);
  b.lastDataAt = Date.now() + 1e9; // b's screen keeps moving: its continue parks
  sl.continueIds(["a", "b"]);
  await until(() => typed.some(([id, d]) => id === "a" && d === "\r"));
  sl.turnStarted(a); sl.served(a); // a got through; b goes next — and parks
  await until(() => b.info.signInWait && !b.info.signInWait.continuing && !b.info.signInWait.queued, 4000);
  sl.signedOut(a); // a's next turn is refused: still signed out after all
  assert.equal(ep.confirmedAt(), null);
  b.lastDataAt = 0; // b is quiet now: an unguarded re-ask would type here
  await sleep(250);
  assert.deepEqual(typed.filter(([id]) => id === "b"), [], "b is never typed into on the tap the episode took back");
});

test("slice: a parked member is re-asked on the same tap while the episode still holds it", async (t) => {
  const { sl, mk, typed } = slice(async () => "out", 40);
  const b = mk("b");
  sl.signedOut(b);
  const ep = sl.episodeOf(b);
  t.after(() => ep.dispose());
  b.lastDataAt = Date.now() + 1e9;
  sl.continueIds(["b"]);
  await sleep(30);
  assert.deepEqual(typed, []);
  b.lastDataAt = 0;
  await until(() => typed.some(([id, d]) => id === "b" && d === "\r"));
});
