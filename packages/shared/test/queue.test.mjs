// Unit tests for the send-queue scheduler (`shared/src/queue.ts`).
//
// These rules are the reason a prompt typed in a tunnel is delivered exactly
// once, in order, hours later — and every one of them was previously pinned
// only by an e2e script that boots a host and a stub CLI. They are pure
// functions over primitives, so they belong here: milliseconds instead of
// minutes, and edge cases an end-to-end script cannot reach at all.
import test from "node:test";
import assert from "node:assert/strict";
import {
  RETRY_BACKOFF_MAX_MS,
  RETRY_ROUND_MS,
  RETRY_ROUND_MAX_MS,
  MIN_TRY_MS,
  roundDelay,
  SERIAL_STARTUP_MS,
  answerInsertAt,
  applyRelease,
  bindPendingSession,
  ownedPendingCreates,
  busySerialGroups,
  blockedReasonText,
  queueIdleReason,
  canRetarget,
  laneBusy,
  moveInLane,
  retargetEntry,
  retryDelay,
  selectSendable,
  serialGroup,
  uploadAttemptWasted,
} from "../dist/index.js";

const NOW = 1_700_000_000_000;
/** A queued entry with the defaults every test here would otherwise repeat. */
const q = (over = {}) => ({ ackId: "a1", sessionId: "s1", ts: NOW, status: "queued", ...over });
const plan = (entries, over = {}) =>
  selectSendable(entries, { now: NOW, maxAttempts: 8, ...over });
const ids = (list) => list.map((e) => e.ackId);
const why = (p, ackId) => p.blocked.find((b) => b.ackId === ackId)?.reason;

test("retryDelay doubles from the floor and stops at the ceiling", () => {
  assert.equal(retryDelay(1), 2000);
  assert.equal(retryDelay(2), 4000);
  assert.equal(retryDelay(3), 8000);
  assert.equal(retryDelay(99), RETRY_BACKOFF_MAX_MS);
  // A never-attempted entry must not produce a negative or sub-floor delay.
  assert.equal(retryDelay(0), 2000);
  assert.equal(retryDelay(-5), 2000);
});

test("uploadAttemptWasted spends the budget only on an answered attempt", () => {
  // The whole point: riding out a dead link costs nothing.
  assert.equal(uploadAttemptWasted({ responded: true, socketOpen: true }), false);
  assert.equal(uploadAttemptWasted({ responded: false, socketOpen: true }), true);
  assert.equal(uploadAttemptWasted({ responded: true, socketOpen: false }), true);
  // An aborted stall has no verdict even though the host answered the headers.
  assert.equal(uploadAttemptWasted({ responded: true, stalled: true, socketOpen: true }), true);
});

test("laneBusy covers the three quiet-but-unable states, and not a trust box", () => {
  assert.equal(laneBusy({}), false);
  assert.equal(laneBusy({ turnActive: true }), true);
  assert.equal(laneBusy({ limitBlocked: true }), true);
  assert.equal(laneBusy({ awaitingInput: true }), true);
  assert.equal(laneBusy({ promptKind: "select" }), true);
  // Delivery auto-accepts a trust prompt, so it is not a reason to hold.
  assert.equal(laneBusy({ promptKind: "trust" }), false);
  assert.equal(laneBusy({ promptKind: null }), false);
});

test("answerInsertAt puts an answer ahead of queued text, behind other answers", () => {
  const entries = [
    q({ ackId: "other", sessionId: "s2" }),
    q({ ackId: "ans", answer: { index: 1 } }),
    q({ ackId: "text" }),
  ];
  assert.equal(answerInsertAt(entries, "s1"), 2);           // ahead of "text"
  assert.equal(answerInsertAt(entries, "s3"), entries.length); // empty lane ⇒ append
});

test("selectSendable sends one per lane and blocks the rest with a reason", () => {
  const p = plan([
    q({ ackId: "a" }),
    q({ ackId: "b" }),
    q({ ackId: "c", sessionId: "s2" }),
  ]);
  assert.deepEqual(ids(p.send), ["a", "c"]);
  assert.equal(why(p, "b"), "lane");
});

test("an in-flight ackId holds its lane without being re-sent", () => {
  const p = plan([q({ ackId: "a" }), q({ ackId: "b" })], { inflight: ["a"] });
  assert.deepEqual(ids(p.send), []);
  assert.equal(why(p, "a"), "inflight");
  assert.equal(why(p, "b"), "lane");
});

test("age expires nothing — the clock that shredded prompts is gone", () => {
  // The complaint's pin, in the pure rule: a message written ten hours ago on a
  // train is still the head of its lane, still sendable, and still says nothing
  // about "queued too long". Nothing in `expire` is about time any more.
  const old = q({ ackId: "old", ts: NOW - 10 * 60 * 60_000 });
  const p = plan([old, q({ ackId: "fresh", sessionId: "s2" })]);
  assert.deepEqual(p.expire, []);
  assert.deepEqual(ids(p.send), ["old", "fresh"]);
  // A week down the tunnel changes nothing either.
  assert.deepEqual(plan([q({ ackId: "week", ts: NOW - 7 * 24 * 60 * 60_000 })]).expire, []);
});

test("the attempts cap is the ONLY thing that expires an entry", () => {
  const spent = plan([q({ ackId: "ans", ts: NOW - 10 * 60 * 60_000, attempts: 8 })]);
  assert.deepEqual(spent.expire.map((e) => e.reason), ["delivery kept failing"]);
});

test("the attempts cap may not be spent in less than MIN_TRY_MS of trying", () => {
  // The complaint this floor exists for: eight receipt windows dropped by a bad
  // radio in a few seconds are not evidence about the message, and "delivery
  // kept failing" said that fast is a verdict on the link wearing the message's
  // clothes. Under the floor the entry is SENT again, not expired.
  const justStarted = q({ ackId: "new", attempts: 8, firstTryAt: NOW - 5_000 });
  const p = plan([justStarted], { minTryMs: MIN_TRY_MS });
  assert.deepEqual(p.expire, []);
  assert.deepEqual(ids(p.send), ["new"]);

  // Past the floor the cap stands exactly as before.
  const tried = plan([q({ ackId: "old", attempts: 8, firstTryAt: NOW - MIN_TRY_MS - 1 })], { minTryMs: MIN_TRY_MS });
  assert.deepEqual(tried.expire.map((e) => e.reason), ["delivery kept failing"]);

  // Never attempted at all (or written by an older build): there is nothing to
  // measure, so the floor applies to nothing and the cap stands alone.
  const noStamp = plan([q({ ackId: "nostamp", attempts: 8 })], { minTryMs: MIN_TRY_MS });
  assert.deepEqual(noStamp.expire.map((e) => e.ackId), ["nostamp"]);

  // The floor can only KEEP an entry queued — it never expires one early.
  const under = plan([q({ ackId: "few", attempts: 1, firstTryAt: NOW - 10 * MIN_TRY_MS })], { minTryMs: MIN_TRY_MS });
  assert.deepEqual(under.expire, []);
});

test("roundDelay grows the wait between give-up rounds and stops at the cap", () => {
  // Running out of attempts is the end of a ROUND, not of the entry: the caller
  // parks it for this long and tries the whole ladder again, for ever.
  assert.equal(roundDelay(1), RETRY_ROUND_MS);
  assert.equal(roundDelay(2), RETRY_ROUND_MS * 2);
  assert.equal(roundDelay(99), RETRY_ROUND_MAX_MS);
  // A round wait is always longer than the longest in-round backoff, or the
  // round boundary would mean nothing.
  assert.ok(roundDelay(1) > RETRY_BACKOFF_MAX_MS);
  assert.equal(roundDelay(0), RETRY_ROUND_MS);
});

test("a pendingCreate entry never sends and holds everything behind it", () => {
  const p = plan([
    q({ ackId: "chained", sessionId: "create:/repo", pendingCreate: true, ts: NOW - 60 * 60_000 }),
    q({ ackId: "behind", sessionId: "create:/repo" }),
  ]);
  assert.deepEqual(ids(p.send), []);
  assert.equal(why(p, "chained"), "pendingCreate");
  assert.equal(why(p, "behind"), "lane");
  assert.deepEqual(p.expire, []);
});

test("holdUntilIdle parks on a busy lane and releases the instant it goes quiet", () => {
  const held = q({ ackId: "later", holdUntilIdle: true, ts: NOW - 45 * 60_000 });
  const parked = plan([held], { busyLanes: ["s1"] });
  assert.deepEqual(ids(parked.send), []);
  assert.equal(why(parked, "later"), "held");
  assert.deepEqual(parked.expire, []);

  // Quiet now.
  const freed = plan([held]);
  assert.deepEqual(ids(freed.send), ["later"]);
  assert.deepEqual(ids(freed.release), ["later"]);
  assert.deepEqual(freed.expire, []);
});

test("a park is not SPENT by a pass that refused to send the entry", () => {
  // The flag's whole job is "do not type this while a turn is running". A pass
  // that finds the lane quiet, then refuses the entry for something else, must
  // leave the park ON: by the time that other thing clears the lane can be busy
  // again, and an entry that has lost its flag is an ordinary send typed into a
  // running turn — the concatenation the flag exists to prevent.
  const held = q({ ackId: "step2", holdUntilIdle: true });

  // …the account is past its usage ceiling.
  const budget = plan([held], { budgetBlocked: true });
  assert.deepEqual(ids(budget.send), []);
  assert.equal(why(budget, "step2"), "budget");
  assert.deepEqual(ids(budget.release), []);

  // …this repo already has a serialized send working in it.
  const g = serialGroup("/repo");
  const ser = plan([q({ ackId: "step2", holdUntilIdle: true, serial: g })], { busySerial: [g] });
  assert.deepEqual(ids(ser.send), []);
  assert.equal(why(ser, "step2"), "serial");
  assert.deepEqual(ids(ser.release), []);

  // …a lane-mate is already on the wire.
  const lane = plan([
    q({ ackId: "first", status: "pending" }),
    q({ ackId: "step2", holdUntilIdle: true }),
  ]);
  assert.equal(why(lane, "step2"), "lane");
  assert.deepEqual(ids(lane.release), []);

  // …and the pass that actually sends it is the one that spends the park.
  const sent = plan([held]);
  assert.deepEqual(ids(sent.send), ["step2"]);
  assert.deepEqual(ids(sent.release), ["step2"]);
});

test("applyRelease drops the park flag and leaves the clock alone", () => {
  const e = q({ ackId: "x", ts: NOW - 45 * 60_000, holdUntilIdle: true });
  const out = applyRelease([e], [e])[0];
  assert.equal(out.holdUntilIdle, undefined);
  // `ts` is when the words were written. Nothing reads it as a deadline any
  // more, so nothing rewrites it either.
  assert.equal(out.ts, NOW - 45 * 60_000);
  // Untouched entries come back as they were.
  const other = q({ ackId: "y", ts: 1, holdUntilIdle: true });
  assert.equal(applyRelease([other], [])[0].holdUntilIdle, true);
});

test("serial holds a group until the previous member's work is done", () => {
  const g = serialGroup("/repo");
  const p = plan([q({ ackId: "open2", serial: g })], { busySerial: [g] });
  assert.deepEqual(ids(p.send), []);
  assert.equal(why(p, "open2"), "serial");
});

test("one member of a serial group goes out per pass, even across lanes", () => {
  const g = serialGroup("/repo");
  const p = plan([
    q({ ackId: "open1", sessionId: "create:/repo#1", serial: g }),
    q({ ackId: "open2", sessionId: "create:/repo#2", serial: g }),
  ]);
  assert.deepEqual(ids(p.send), ["open1"]);
  assert.equal(why(p, "open2"), "serial");
});

test("a serial entry on the wire holds its group before any ack lands", () => {
  const g = serialGroup("/repo");
  const p = plan([
    q({ ackId: "open1", sessionId: "create:/repo#1", serial: g, status: "pending" }),
    q({ ackId: "open2", sessionId: "create:/repo#2", serial: g }),
  ]);
  assert.deepEqual(ids(p.send), []);
  assert.equal(why(p, "open2"), "serial");
});

test("a serial hold is reported for persistence only past half the TTL", () => {
  const g = serialGroup("/repo");
  // A serial wait can legitimately last hours — ten queued opens at ten minutes
  // of work each. It used to have to be stamped forward to survive the clock;
  // now it simply waits, however long that is, and says `serial` throughout.
  const aging = plan([q({ ackId: "a", serial: g, ts: NOW - 20 * 60 * 60_000 })], { busySerial: [g] });
  assert.equal(why(aging, "a"), "serial");
  assert.deepEqual(aging.expire, []);
  const tried = plan([q({ ackId: "a", serial: g, attempts: 1, ts: NOW - 31 * 60_000 })], { busySerial: [g] });
  assert.equal(why(tried, "a"), "serial");
  assert.deepEqual(tried.expire, []);
});

test("backoff blocks without sending, and never expires", () => {
  const p = plan([q({ ackId: "a", retryAt: NOW + 5000 })]);
  assert.equal(why(p, "a"), "backoff");
  const stale = plan([q({ ackId: "a", retryAt: NOW + 5000, ts: NOW - 31 * 60_000 })]);
  assert.equal(why(stale, "a"), "backoff");
  assert.deepEqual(stale.expire, []);
});

test("busySerialGroups reads live sessions and the startup grace", () => {
  const watch = { group: serialGroup("/repo"), sessionId: "s9", at: NOW };
  // Nothing live yet, watch inside its grace ⇒ the group is held.
  const held = busySerialGroups([], [watch], NOW + 1000);
  assert.equal(held.busy.has(serialGroup("/repo")), true);
  assert.equal(held.watches.length, 1);

  // The session has run a turn ⇒ the live rule takes over and the watch drops.
  const live = busySerialGroups(
    [{ id: "s9", cwd: "/repo", turnStartedAt: NOW + 500, turnActive: true }], [watch], NOW + 1000);
  assert.equal(live.busy.has(serialGroup("/repo")), true);
  assert.deepEqual(live.watches, []);

  // It never came up ⇒ stop holding the whole queue for it.
  const gone = busySerialGroups([], [watch], NOW + SERIAL_STARTUP_MS);
  assert.equal(gone.busy.size, 0);
  assert.deepEqual(gone.watches, []);

  // An ended session is not busy.
  const ended = busySerialGroups([{ id: "s1", cwd: "/repo", running: false, turnActive: true }], [], NOW);
  assert.equal(ended.busy.size, 0);
});

test("bindPendingSession rewrites the lane, keeps the ackId, restarts the clock", () => {
  const entries = [
    q({ ackId: "p1", sessionId: "create:/repo", pendingCreate: true, ts: NOW - 60 * 60_000 }),
    q({ ackId: "p2", sessionId: "create:/repo", pendingCreate: true, ts: NOW - 60 * 60_000 }),
    q({ ackId: "elsewhere", sessionId: "s2" }),
  ];
  const out = bindPendingSession(entries, "create:/repo", "sess-7", NOW);
  assert.deepEqual(ids(out), ["p1", "p2", "elsewhere"]);       // order preserved
  assert.equal(out[0].sessionId, "sess-7");
  assert.equal(out[0].pendingCreate, undefined);
  assert.equal(out[0].ts, NOW);                                 // TTL restarted
  assert.equal(out[0].ackId, "p1");                             // ackId kept: provably un-sent
  assert.equal(out[2].sessionId, "s2");                         // other lanes untouched
});

test("two creates for one repo keep their own chains", () => {
  // The lane is per REPO, so two "open a session here and run these" queued for
  // the same repo share it. Binding on the lane alone handed the second one's
  // prompts to the FIRST session — and one create's failure failed the other's.
  const entries = [
    q({ ackId: "c1", sessionId: "create:/repo", mode: "op" }),
    q({ ackId: "p1", sessionId: "create:/repo", pendingCreate: true, createAck: "c1" }),
    q({ ackId: "c2", sessionId: "create:/repo", mode: "op" }),
    q({ ackId: "p2", sessionId: "create:/repo", pendingCreate: true, createAck: "c2" }),
  ];
  const out = bindPendingSession(entries, "create:/repo", "sess-1", NOW, "c1");
  assert.equal(out[1].sessionId, "sess-1");          // c1's chain bound
  assert.equal(out[1].createAck, undefined);
  assert.equal(out[3].sessionId, "create:/repo");    // c2's chain still waiting
  assert.equal(out[3].pendingCreate, true);

  // …and the ownership question has ONE answer, which the fail/hold paths read.
  assert.deepEqual(ids(ownedPendingCreates(entries, "create:/repo", "c2")), ["p2"]);
  assert.deepEqual(ids(ownedPendingCreates(entries, "create:/repo", "c1")), ["p1"]);

  // An entry written by an older build carries no createAck: there is one
  // create in flight per lane, so binding it on the lane is the right fallback.
  const legacy = [q({ ackId: "old", sessionId: "create:/repo", pendingCreate: true })];
  assert.equal(bindPendingSession(legacy, "create:/repo", "sess-1", NOW, "c1")[0].sessionId, "sess-1");
});

test("the usage budget holds work, but never a person, an answer or bytes", () => {
  const entries = [
    q({ ackId: "prose", sessionId: "s1", mode: "input" }),
    q({ ackId: "armed", sessionId: "s2", mode: "input", armed: true }),
    q({ ackId: "answer", sessionId: "s3", mode: "input", answer: { fingerprint: "f" } }),
    q({ ackId: "bytes", sessionId: "s4", mode: "upload" }),
    q({ ackId: "op", sessionId: "create:/r", mode: "op" }),
  ];
  const held = plan(entries, { budgetBlocked: true });
  // Ordinary work waits — a queued prompt and a queued "open a session".
  assert.deepEqual(ids(held.send), ["armed", "answer", "bytes"]);
  assert.equal(why(held, "prose"), "budget");
  assert.equal(why(held, "op"), "budget");
  // …and it all goes the moment the gate lifts, with no other change.
  assert.deepEqual(ids(plan(entries).send).sort(), ["answer", "armed", "bytes", "op", "prose"]);
});

test("a budget hold waits out a session window instead of expiring the queue", () => {
  // A session window is hours. There is no clock left to outlast it: an entry
  // held here waits, attempted or not, and keeps saying `budget`.
  const old = q({ ackId: "p", ts: NOW - 20 * 60 * 60_000, mode: "input" });
  const p = plan([old], { budgetBlocked: true });
  assert.deepEqual(p.expire, []);
  assert.equal(why(p, "p"), "budget");
  const tried = q({ ackId: "t", ts: NOW - 31 * 60_000, attempts: 1, mode: "input" });
  const t = plan([tried], { budgetBlocked: true });
  assert.deepEqual(t.expire, []);
  assert.equal(why(t, "t"), "budget");
});

test("canRetarget refuses anything that is not purely local text", () => {
  assert.equal(canRetarget({ status: "queued", mode: "input" }), true);
  assert.equal(canRetarget({ status: "queued", mode: "backlog" }), true);
  assert.equal(canRetarget({ status: "pending", mode: "input" }), false);
  assert.equal(canRetarget({ status: "queued", mode: "op" }), false);
  assert.equal(canRetarget({ status: "queued", mode: "upload" }), false);
  assert.equal(canRetarget({ status: "queued", mode: "input", answer: { index: 1 } }), false);
});

test("retargetEntry mints a fresh ackId, resets attempts, keeps the age", () => {
  const entries = [q({ ackId: "old", cwd: "/a", text: "run the tests", attempts: 3, ts: NOW - 1000 })];
  const out = retargetEntry(entries, "old", { sessionId: "s9", cwd: "/b", ackId: "new" });
  assert.equal(out[0].ackId, "new");
  assert.equal(out[0].sessionId, "s9");
  assert.equal(out[0].cwd, "/b");
  assert.equal(out[0].attempts, 0);
  assert.equal(out[0].ts, NOW - 1000); // retargeting does not make the words fresher
});

test("retargeting to backlog fills the backlog fields and drops an inherited target", () => {
  const entries = [q({ ackId: "old", text: "a-very-long-prompt-".repeat(5), targetSessionId: "s-old" })];
  const out = retargetEntry(entries, "old", { sessionId: "repo:/b", cwd: "/b", ackId: "new", mode: "backlog" });
  assert.equal(out[0].mode, "backlog");
  assert.equal(out[0].label.length, 40);
  assert.equal(out[0].targetSessionId, undefined);
});

test("a refused retarget leaves the entry exactly as it was", () => {
  const entries = [q({ ackId: "old", status: "pending" })];
  assert.deepEqual(retargetEntry(entries, "old", { sessionId: "s9", cwd: "/b", ackId: "new" }), entries);
});

// ── A dead session must not take its queue with it ────────────────────────
//
// This used to be a client-side rule (`rescuableEntries` + a 45-second grace on
// the PHONE's clock) that re-aimed stranded prompts at the repo's work items.
// It is the HOST's job now: given a `cwd` it writes them to that repo's work
// items itself and answers `rescued` (`main.ts`'s `deliverInput`). The client's
// copy could only ever run with a foregrounded, connected tab — and worse, the
// block below made the host's version unreachable, so for the queued-offline
// case it was written for, NEITHER ran.
//
// What is left here is the half the host genuinely cannot do.

test("a gone lane still SENDS when the entry names a repo — the host rescues it", () => {
  // The whole point of the change: with a `cwd` there is somewhere for the words
  // to go, and only the host can put them there durably. Blocking here is what
  // kept that from happening.
  const p = plan([q({ ackId: "a", cwd: "/a" })], { goneLanes: ["s1"] });
  assert.deepEqual(ids(p.send), ["a"]);
  assert.equal(why(p, "a"), undefined);
});

test("...but with no repo to name, it is still held", () => {
  // No `cwd` ⇒ no work list to add to, and the host's only answer is
  // "session not available", un-retryable — the five-red-rows case the block was
  // written for, which is unchanged.
  const p = plan([q({ ackId: "a" })], { goneLanes: ["s1"] });
  assert.deepEqual(ids(p.send), []);
  assert.equal(why(p, "a"), "sessionGone");
});

test("moveInLane swaps within a lane and never reshuffles another", () => {
  const entries = [q({ ackId: "a" }), q({ ackId: "x", sessionId: "s2" }), q({ ackId: "b" })];
  assert.deepEqual(ids(moveInLane(entries, "b", -1)), ["b", "x", "a"]);
  assert.deepEqual(ids(moveInLane(entries, "a", -1)), ["a", "x", "b"]); // already first
  assert.deepEqual(ids(moveInLane(entries, "nope", 1)), ["a", "x", "b"]);
});

test("a gone session blocks its input entries instead of failing them one at a time", () => {
  // The bug: the host refuses a message for a dead session un-retryably, so a
  // lane of five was fired over five flushes and buried as five red rows and
  // five toasts — one fact told five times.
  const p = plan([
    q({ ackId: "a" }),
    q({ ackId: "b" }),
    q({ ackId: "c", sessionId: "s2" }),
  ], { goneLanes: ["s1"] });
  assert.deepEqual(ids(p.send), ["c"]);
  assert.equal(why(p, "a"), "sessionGone");
  assert.equal(why(p, "b"), "sessionGone");
  assert.deepEqual(p.expire, []);
});

test("a gone lane waits to be re-aimed; it is never shredded for waiting", () => {
  // This is the shape the complaint took: the session exits, every prompt for
  // it is blocked, and half an hour later the lot is expired as "queued too
  // long" — a sentence about a clock, for a failure about a session, with the
  // repo those words were written for sitting unread in the entry's own `cwd`.
  // The block stands; the shredder does not.
  const p = plan([
    q({ ackId: "old", ts: NOW - 31 * 60_000 }),
    q({ ackId: "ans", ts: NOW - 31 * 60_000, answer: { index: 1 } }),
  ], { goneLanes: ["s1"] });
  assert.deepEqual(p.expire, []);
  assert.equal(why(p, "old"), "sessionGone");
  assert.equal(why(p, "ans"), "sessionGone");
  assert.deepEqual(ids(p.send), []);
});

test("goneLanes is scoped to the lanes named — and empty by default", () => {
  const entries = [q({ ackId: "a" })];
  assert.deepEqual(ids(plan(entries).send), ["a"]);
  assert.deepEqual(ids(plan(entries, { goneLanes: ["s2"] }).send), ["a"]);
});

test("a pendingCreate entry outranks a gone lane it happens to share a key with", () => {
  // Its lane key is `create:<cwd>`, never a session id — but the check must sit
  // behind pendingCreate anyway, so the create ahead of it keeps its own reason.
  const p = plan([q({ ackId: "p", sessionId: "create:/r", pendingCreate: true })],
    { goneLanes: ["create:/r"] });
  assert.equal(why(p, "p"), "pendingCreate");
});

test("a gone lane stops only its input entries — the other modes still go out", () => {
  // A work item is added to the REPO and the host falls back to its default
  // session; an upload is an HTTP POST to the inbox. Holding either would stop
  // something that would have been accepted.
  const p = plan([
    q({ ackId: "prompt" }),
    q({ ackId: "item", mode: "backlog" }),
    q({ ackId: "file", mode: "upload", upload: { relPath: ".claude/inbox/a.jpg" } }),
  ], { goneLanes: ["s1"] });
  assert.equal(why(p, "prompt"), "sessionGone");
  // One per lane still holds: the two survivors share s1, so the first goes and
  // the second waits its turn — the ordinary rule, not the gone one.
  assert.deepEqual(ids(p.send), ["item"]);
  assert.equal(why(p, "file"), "lane");
});

// ── a session's OWN budget ───────────────────────────────────────────────────

test("a lane whose own budget is spent blocks with its reason — armed, answer and upload still go", () => {
  const lanes = { budgetHeldLanes: new Set(["s1", "s3", "s4", "s5"]) };
  const p = plan([q({ ackId: "a" }), q({ ackId: "b", sessionId: "s2" })], lanes);
  assert.equal(why(p, "a"), "sessionBudget");
  assert.deepEqual(ids(p.send), ["b"], "another session's lane is untouched");
  const p2 = plan([
    q({ ackId: "armed", sessionId: "s5", armed: true }),
    q({ ackId: "ans", sessionId: "s3", answer: true }),
    q({ ackId: "up", sessionId: "s4", mode: "upload" }),
  ], lanes);
  assert.equal(why(p2, "armed"), undefined);
  assert.equal(why(p2, "ans"), undefined);
  assert.equal(why(p2, "up"), undefined);
});

test("idle wording ranks the session budget just under the account's", () => {
  const b = (reason) => ({ ackId: reason, reason });
  const own = blockedReasonText("sessionBudget");
  assert.match(own, /own budget/);
  assert.equal(queueIdleReason([b("sessionGone"), b("sessionBudget")], { online: true, queued: 2 }), own);
  assert.equal(queueIdleReason([b("sessionBudget"), b("budget")], { online: true, queued: 2 }), blockedReasonText("budget"));
});
