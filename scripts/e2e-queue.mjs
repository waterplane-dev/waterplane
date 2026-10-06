// Offline command queuing rests on ONE host-side guarantee: a delivery receipt
// is idempotent. The phone keeps unsent text in localStorage and re-sends it
// with the SAME ackId when the socket comes back — so a re-send that already
// landed must be re-ACKed, never typed a second time. (Same at-most-once rule
// deliver.ts enforces for the backlog; this is its client-retry counterpart.)
//
// Asserted against a real PTY: the stub is a shell, which echoes what it is
// typed, so "how many times did this text reach the terminal" is countable.
import "./lib-tmuxiso.mjs"; // tmux in a socket dir of its own, killed on exit
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocket } from "ws";
import { SERIAL_STARTUP_MS, adoptReferencedUploads, answerInsertAt, applyRelease, bindPendingSession, busySerialGroups, canRetarget, danglingUploadRefs, laneBusy, moveInLane, queueIdleReason, retargetEntry, selectSendable, sendEligible, serialGroup, uploadAttemptWasted } from "../packages/shared/dist/queue.js";
import { bootWait } from "./lib-e2e.mjs";
import { E, SLUG, rootEnv } from "./lib-brand.mjs";

const PORT = 8797;
const ROOT = mkdtempSync(join(tmpdir(), `${SLUG}-queue-`));
const env = { ...process.env, [E.PREFLIGHT]: "0", [E.PORT]: String(PORT), [E.HOST]: "127.0.0.1", ...rootEnv(ROOT), [E.CLAUDE_BIN]: process.cwd() + "/scripts/claude-stub.sh" };
const host = spawn("node", ["packages/host/dist/main.js"], { env, stdio: ["ignore", "pipe", "pipe"] });
host.stderr.on("data", (d) => process.stderr.write("[host] " + d));

let failed = false;
const check = (cond, label) => { console.log(`${cond ? "PASS" : "FAIL"}: ${label}`); if (!cond) failed = true; };

// ── Scheduling rules (pure, no host) ────────────────────────────────
// The lane rule is the whole reason offline queuing is safe with MORE THAN ONE
// message: writing two of them to the same session back-to-back concatenates
// them in the PTY composer and the following Returns submit the mush.
{
  const q = (ackId, sessionId, extra = {}) => ({ ackId, sessionId, ts: 1000, status: "queued", ...extra });
  const blockedReasonTextGate = "queued — auto-send is off, tap Send now";
  // No `ttlMs`. There is no clock in this scheduler any more — see the block
  // marked "nothing expires for waiting" below, which is this suite's copy of
  // the complaint that started the rework.
  const opts = { now: 1000, maxAttempts: 8 };

  let plan = selectSendable([q("a1", "s1"), q("a2", "s1"), q("b1", "s2")], opts);
  check(plan.send.map((e) => e.ackId).join(",") === "a1,b1",
    `one send per session, other sessions still go (${plan.send.map((e) => e.ackId).join(",") || "none"})`);

  plan = selectSendable([{ ...q("a1", "s1"), status: "pending" }, q("a2", "s1")], opts);
  check(plan.send.length === 0, "a session with a delivery in flight sends nothing more");

  plan = selectSendable([q("a1", "s1"), q("a2", "s1")], { ...opts, inflight: ["a1"] });
  check(plan.send.length === 0, "an entry already on the wire holds its lane (inflight)");

  // Order within a lane is queue order — a message typed second must not overtake.
  plan = selectSendable([q("a2", "s1", { ts: 900 }), q("a1", "s1")], opts);
  check(plan.send[0].ackId === "a2", "the head of the lane goes first, not the oldest ts");

  // ── NOTHING EXPIRES FOR WAITING ──────────────────────────────────
  // The complaint this rework answers, as a rule: "queued too long" is gone.
  // A message written ten hours ago on a train is still the head of its lane
  // and still sendable. Age was never evidence of anything — the failures it
  // fired on were a session that had exited, a repo that was busy, a tunnel
  // that was down — and it destroyed work somebody had spent an evening on.
  plan = selectSendable([q("old", "s1", { ts: -10 * 60 * 60_000 }), q("new", "s2")], opts);
  check(plan.expire.length === 0, "age expires nothing, however old");
  check(plan.send.map((e) => e.ackId).join(",") === "old,new", "…and the old one is still first in its lane");
  plan = selectSendable([q("week", "s1", { ts: -7 * 24 * 60 * 60_000 })], opts);
  check(plan.expire.length === 0 && plan.send[0]?.ackId === "week",
    "a week down a dead tunnel is still a message this device is holding, not a message it threw away");

  // The one bound left. It counts a host that ANSWERED and said no — an attempt
  // made with no socket open is rolled back by the caller, so riding out an
  // outage of any length still costs nothing.
  plan = selectSendable([q("ans", "s1", { ts: -100_000, attempts: 8 })], opts);
  check(plan.expire[0]?.reason === "delivery kept failing" && plan.send.length === 0,
    "the attempts cap is the only thing that gives up on an entry");

  // Where a tapped ANSWER goes in the queue. Both halves are load-bearing and
  // both fail silently: too late and the prose ahead of it is typed INTO the
  // open dialog (it neither runs nor answers), too early and a checkbox box's
  // toggles are delivered in reverse and Submit ticks the wrong set.
  {
    const q2 = (ackId, sessionId, extra = {}) => ({ ackId, sessionId, ts: 1000, status: "queued", ...extra });
    const ans = (ackId, sessionId) => q2(ackId, sessionId, { answer: { fingerprint: "f" } });

    check(answerInsertAt([q2("t1", "s1"), q2("t2", "s1")], "s1") === 0,
      "an answer is queued AHEAD of the prose waiting for that session");
    check(answerInsertAt([ans("a1", "s1"), q2("t1", "s1")], "s1") === 1,
      "…but BEHIND an answer already queued, so a checkbox box's taps keep their order");
    check(answerInsertAt([ans("a1", "s1"), ans("a2", "s1")], "s1") === 2,
      "a lane of nothing but answers appends — toggle, toggle, Submit stay in sequence");
    check(answerInsertAt([q2("t1", "s2")], "s1") === 1,
      "another session's queued text is not overtaken");
    check(answerInsertAt([{ ...q2("p1", "s1"), status: "pending" }], "s1") === 1,
      "an entry already on the wire is never overtaken — it may be on a live PTY");
    check(answerInsertAt([], "s1") === 0, "an empty queue appends");
  }

  plan = selectSendable([q("burnt", "s1", { attempts: 8 }), q("next", "s1")], opts);
  check(plan.expire[0]?.reason === "delivery kept failing" && plan.send[0]?.ackId === "next",
    "an entry out of attempts is given up on and the lane moves on");

  // Who is allowed to go: the two "hold the queue" switches, and the two things
  // that override them. The stall this guards against is silent — a message the
  // user tapped Send on sitting behind a parked one, with the compose box
  // already cleared — so the rule is pinned rather than left to a comment.
  check(sendEligible({}, { autoSend: true, hold: false }) === true, "auto-send on, nothing held: a fresh entry goes");
  check(sendEligible({}, { autoSend: false, hold: false }) === false, "auto-send off holds a fresh entry");
  check(sendEligible({}, { autoSend: true, hold: true }) === false, "a pending reconnect confirmation holds a fresh entry");
  check(sendEligible({ armed: true }, { autoSend: false, hold: true }) === true, "an explicitly released entry ignores both switches");
  check(sendEligible({ attempts: 1 }, { autoSend: false, hold: true }) === true, "a retry of an entry already attempted is not re-decided");

  // ── WHY nothing went out ──────────────────────────────────────────
  // A flush that sends zero was reported to the user as "still offline —
  // staying queued", on a screen whose header simultaneously read `open ·
  // 100.64.0.5`. Every branch below leaves a queued entry parked with the
  // socket wide open, so the reason has to come from the ladder that parked it
  // — the same rule backlog `waiting()` and `pulls.whyIdle()` follow.
  const reasonOf = (entries, o = opts) => {
    const p = selectSendable(entries, o);
    return { plan: p, first: p.blocked[0]?.reason ?? null };
  };
  check(reasonOf([q("a1", "s1"), q("a2", "s1")]).first === "lane",
    "a second message for one session is blocked as `lane`, not as offline");
  check(reasonOf([q("a1", "s1", { pendingCreate: true })]).first === "pendingCreate",
    "a prompt chained behind a queued session.create says it is waiting for its session");
  check(reasonOf([q("a1", "s1", { holdUntilIdle: true })], { ...opts, busyLanes: ["s1"] }).first === "held",
    "a held entry whose agent is mid-turn says it is held, not offline");
  check(reasonOf([q("a1", "s1", { retryAt: 5000 })]).first === "backoff",
    "an entry inside its retry backoff says so");
  check(reasonOf([q("a1", "s1")], { ...opts, inflight: ["a1"] }).first === "inflight",
    "an entry already on the wire is reported as in flight");
  // Every parked entry is accounted for: a blocked list that silently omits one
  // is how "0 sent" became unexplainable in the first place.
  {
    const p = selectSendable([q("a1", "s1"), q("a2", "s1"), q("b1", "s2", { pendingCreate: true })], opts).blocked;
    check(p.length === 2 && p.every((b) => b.ackId && b.sessionId),
      `every unsent queued entry is explained, with its lane (${p.length})`);
  }
  // A sent entry is not blocked — the explanation must not fire when the queue
  // is actually moving.
  check(selectSendable([q("a1", "s1")], opts).blocked.length === 0, "an entry that goes out is not reported as blocked");

  // The sentence. Offline still says offline; online never does.
  check(queueIdleReason([], { online: false, queued: 1 }) === "still offline — staying queued",
    "a genuinely dead link still says offline");
  const onlineReason = (blocked) => queueIdleReason(blocked, { online: true, queued: blocked.length || 1 });
  check(!/offline/.test(onlineReason([{ ackId: "a1", sessionId: "s1", reason: "held" }]) ?? ""),
    "with the socket open the reason never claims the link is down");
  check(queueIdleReason([], { online: true, queued: 0 }) === null,
    "an empty queue explains nothing rather than inventing a problem");
  // Precedence is by what a tap can fix: the switch outranks facts about a session.
  check(onlineReason([
    { ackId: "a1", sessionId: "s1", reason: "lane" },
    { ackId: "a2", sessionId: "s2", reason: "gate" },
  ]) === blockedReasonTextGate,
    "the user's own hold outranks a busy lane — it is the one a tap fixes");

  // Reorder stays inside the lane: another session's queue can't be reshuffled.
  const list = [q("a1", "s1"), q("b1", "s2"), q("a2", "s1")];
  check(moveInLane(list, "a2", -1).map((e) => e.ackId).join(",") === "a2,b1,a1",
    "moveInLane swaps with the previous entry OF THE SAME session");
  check(moveInLane(list, "a1", -1).map((e) => e.ackId).join(",") === "a1,b1,a2",
    "moving the first of a lane earlier is a no-op");

  // ── "send it when the agent is done" (holdUntilIdle) ──
  // A parked entry is NOT a failed delivery: it is supposed to wait, possibly
  // for hours, and that is fine: nothing here is on a clock. The entry keeps
  // its place in the lane rather than letting later messages jump it.
  const held = (ackId, sessionId, extra = {}) => q(ackId, sessionId, { holdUntilIdle: true, ...extra });

  plan = selectSendable([held("h1", "s1")], { ...opts, busyLanes: ["s1"] });
  check(plan.send.length === 0 && plan.expire.length === 0, "a held entry waits while its session is mid-turn");

  plan = selectSendable([held("h1", "s1")], { ...opts, busyLanes: ["s2"] });
  check(plan.send.map((e) => e.ackId).join(",") === "h1", "the same entry goes the moment its session is idle");

  plan = selectSendable([held("h1", "s1", { ts: -100_000 })], { ...opts, busyLanes: ["s1"] });
  check(plan.expire.length === 0 && plan.send.length === 0,
    "a held entry waits however long the park lasts — a deliberate wait is not a failure");

  plan = selectSendable([held("h1", "s1", { armed: true })], { ...opts, busyLanes: ["s1"] });
  check(plan.send.length === 0, "armed does NOT override the busy check (it releases the queue, not the turn)");

  plan = selectSendable([held("h1", "s1"), q("a2", "s1"), q("b1", "s2")], { ...opts, busyLanes: ["s1"] });
  check(plan.send.map((e) => e.ackId).join(",") === "b1",
    `a held entry holds its lane — nothing behind it overtakes (${plan.send.map((e) => e.ackId).join(",") || "none"})`);

  plan = selectSendable([q("a1", "s1"), held("h1", "s1")], { ...opts, busyLanes: ["s1"] });
  check(plan.send.map((e) => e.ackId).join(",") === "a1",
    "an ordinary entry still sends into a busy session — only held ones wait");

  // WHICH sessions are busy is the other half of the same rule, and it is not
  // just "a turn is in flight". A session parked on a question is quiet and
  // cannot take a prompt: prose typed at an open dialog goes INTO the dialog,
  // where it neither runs nor answers. On a hooked session the turn stays active
  // while the box is up, so the hold already held — but `turnActive` on a
  // NON-hooked session is the silence guess, and a session waiting for an answer
  // is perfectly silent, which is exactly how a parked prompt got typed into a
  // Yes/No box. Same three facts the host gates backlog auto-fire on
  // (`sessions.autoFireBlocker`), so the two halves of "wait until it can run"
  // cannot drift apart.
  check(laneBusy({ turnActive: true }) === true, "a session mid-turn is busy");
  check(laneBusy({}) === false, "an idle session is not");
  check(laneBusy({ promptKind: "select" }) === true, "a session parked on a question is busy even though it is quiet");
  check(laneBusy({ promptKind: "trust" }) === false, "…but a trust prompt is not a question — delivery auto-accepts it");
  check(laneBusy({ awaitingInput: true }) === true, "an unparsable dialog counts too — same trap, minus the options");
  check(laneBusy({ limitBlocked: true }) === true, "a usage-limited session is busy — a prompt would be typed at the wait menu");

  plan = selectSendable([held("h1", "s1")], {
    ...opts,
    busyLanes: [{ id: "s1", promptKind: "select" }].filter((s) => laneBusy(s)).map((s) => s.id),
  });
  check(plan.send.length === 0, "…so a held entry waits out a question box, not just a turn");

  // …and the RELEASE moment. This used to be where a park was punished for
  // being a park: the exemption held only WHILE the lane was busy, so a "run
  // the tests" parked against a 35-minute turn was already older than the TTL
  // the instant it became deliverable, and got expired ("queued too long") on
  // the exact pass that was meant to send it. There is no clock to be older
  // than now, and the release exists only to take the flag off.
  plan = selectSendable([held("h1", "s1", { ts: -100_000 })], { ...opts, busyLanes: ["s2"] });
  check(plan.expire.length === 0 && plan.send.map((e) => e.ackId).join(",") === "h1",
    `a held entry whose lane goes quiet after hours is DELIVERED (${JSON.stringify(plan.expire)})`);
  check(plan.release.map((e) => e.ackId).join(",") === "h1",
    "…and is reported as released, so the caller can drop the park flag");

  const released = applyRelease([held("h1", "s1", { ts: -100_000 }), q("b1", "s2")], [{ ackId: "h1" }]);
  check(released[0].ts === -100_000 && !released[0].holdUntilIdle,
    `applyRelease drops the park flag and leaves the clock alone (${JSON.stringify(released[0])})`);
  check(JSON.stringify(released[1]) === JSON.stringify(q("b1", "s2")), "every other entry comes back untouched");
  plan = selectSendable(released, { ...opts, busyLanes: ["s1"] });
  check(plan.send.map((e) => e.ackId).join(",") === "h1,b1",
    "a released entry is an ordinary one again — a NEW turn does not re-park it");

  // ── "one session at a time in this repo" (serial) ──────────────
  // The lane rule stops two messages being TYPED into one composer at once. It
  // says nothing about the work they start: a `session.create` is acked as soon
  // as the host has spawned the CLI and typed the first prompt, so a queue of
  // five opens for one repo drains in seconds and leaves five agents spending
  // one account's usage limit in parallel, finishing none of it, and editing the
  // same working tree.
  {
    const g = serialGroup("/repo/a");
    const op = (ackId, extra = {}) => q(ackId, "create:/repo/a", { mode: "op", serial: g, ...extra });

    plan = selectSendable([op("c1"), op("c2")], opts);
    check(plan.send.map((e) => e.ackId).join(",") === "c1",
      `only one member of a serial group leaves per pass (${plan.send.map((e) => e.ackId).join(",") || "none"})`);
    check(plan.blocked.find((b) => b.ackId === "c2")?.reason === "serial",
      "…and the one that waits SAYS it is waiting its turn, not that the link is down");

    plan = selectSendable([op("c1")], { ...opts, busySerial: [g] });
    check(plan.send.length === 0 && plan.expire.length === 0,
      "a serialized open waits while the session before it is still working");

    plan = selectSendable([op("c1")], { ...opts, busySerial: [serialGroup("/repo/b")] });
    check(plan.send.map((e) => e.ackId).join(",") === "c1",
      "another repo being busy is none of its business — the group is the directory");

    // A worktree is its own directory, which is what makes running work in
    // parallel safe in the first place. Two opens in two worktrees are not each
    // other's business either.
    check(serialGroup("/repo/a") !== serialGroup("/repo/a-wt"), "a worktree is a group of its own");

    // Waiting is what it was TOLD to do, and it can easily outlast an hour: ten
    // queued opens at ten minutes of work each. It used to need its clock
    // stamped forward every pass to survive the TTL — a whole apparatus
    // (`hold`/`applyHold`, reported only once the clock was half spent so the
    // persist did not become a busy-loop) whose entire job was to stop the
    // queue punishing an entry for obeying the rule it was given. With no clock
    // there is nothing to outrun: it waits, attempted or not, and says so.
    plan = selectSendable([op("c1", { ts: -100_000 })], { ...opts, busySerial: [g] });
    check(plan.expire.length === 0 && plan.blocked[0]?.reason === "serial",
      `a serialized open waits however long the repo stays busy (${JSON.stringify(plan.expire)})`);
    plan = selectSendable([op("c1", { ts: -100_000, attempts: 1 })], { ...opts, busySerial: [g] });
    check(plan.expire.length === 0 && plan.blocked[0]?.reason === "serial",
      "…and one that has already been on the wire waits the same way");

    // The window between "written to the socket" and "the session reports a
    // turn" is where this used to leak: the create is gone from the live-session
    // view and the repo reads idle.
    plan = selectSendable([{ ...op("c1"), status: "pending" }, op("c2")], opts);
    check(plan.send.length === 0 && plan.blocked.find((b) => b.ackId === "c2")?.reason === "serial",
      "an open still on the wire holds its group, not just its lane");

    // It holds its LANE too — an upload or prompt queued behind it must not
    // overtake the open it belongs to.
    plan = selectSendable([op("c1"), q("u1", "create:/repo/a"), q("b1", "s2")], { ...opts, busySerial: [g] });
    check(plan.send.map((e) => e.ackId).join(",") === "b1",
      `a serialized open holds its lane while it waits (${plan.send.map((e) => e.ackId).join(",") || "none"})`);

    check(queueIdleReason(plan.blocked, { online: true, queued: 2 }) === "one at a time in this repo — waiting for the session before it",
      "…and the one-line answer to “why did nothing go out?” says so");
  }

  // Which repos are busy — the other half of the rule. Same three facts as
  // `laneBusy`, folded up to the directory, plus the startup grace for a session
  // that exists but has not run anything yet.
  {
    const A = "/repo/a", B = "/repo/b";
    const sess = (id, cwd, extra = {}) => ({ id, cwd, running: true, ...extra });
    const now = 1_000_000;

    let g = busySerialGroups([sess("s1", A, { turnActive: true, turnStartedAt: 1 }), sess("s2", B)], [], now);
    check(g.busy.has(serialGroup(A)) && !g.busy.has(serialGroup(B)),
      "a repo with a session mid-turn is busy; a repo with an idle one is not");

    g = busySerialGroups([sess("s1", A, { promptKind: "select", turnStartedAt: 1 })], [], now);
    check(g.busy.has(serialGroup(A)),
      "a session parked on a question counts — it is quiet and cannot take work, exactly like laneBusy says");

    g = busySerialGroups([sess("s1", A, { limitBlocked: true, turnStartedAt: 1 })], [], now);
    check(g.busy.has(serialGroup(A)), "so does one blocked on a usage limit — which is the whole point of not starting a second");

    g = busySerialGroups([sess("s1", A, { running: false, turnActive: true })], [], now);
    check(!g.busy.has(serialGroup(A)), "a dead session holds nothing — otherwise the queue would never drain again");

    // The gap: acked, named, but the CLI is still coming up, so it has run no
    // turn and the repo looks idle. Without the watch the next open starts a
    // second later and the whole rule is decorative.
    const watch = [{ group: serialGroup(A), sessionId: "s1", at: now }];
    g = busySerialGroups([sess("s1", A)], watch, now + 1000);
    check(g.busy.has(serialGroup(A)) && g.watches.length === 1,
      "a just-created session holds its repo through the startup grace, before it reports anything");

    g = busySerialGroups([sess("s1", A, { turnStartedAt: now + 500 })], watch, now + 1000);
    check(!g.busy.has(serialGroup(A)) && g.watches.length === 0,
      "once it HAS run a turn the watch is dropped — the live session list owns the answer from there");

    g = busySerialGroups([sess("s1", A)], watch, now + SERIAL_STARTUP_MS);
    check(!g.busy.has(serialGroup(A)) && g.watches.length === 0,
      "a session that never came up stops holding the queue when the grace runs out");

    g = busySerialGroups([], watch, now + 1000);
    check(g.busy.has(serialGroup(A)),
      "…and a session the host has not listed yet still holds it — absent is not idle");
  }

  // ── Retarget: "that session moved on, send it somewhere else" ──
  // The minted ackId is the whole point: the old one may already carry a host
  // ledger verdict for the OLD target, which would have the host re-ack a stale
  // outcome and never deliver anywhere.
  {
    const base = [
      { ackId: "r1", sessionId: "s1", cwd: "/repo/a", text: "fix the flaky test", ts: 1000, status: "queued", attempts: 3, mode: "input" },
      { ackId: "r2", sessionId: "s2", cwd: "/repo/b", text: "other lane", ts: 1000, status: "queued", attempts: 0, mode: "input" },
      { ackId: "p1", sessionId: "s1", cwd: "/repo/a", text: "already on the wire", ts: 1000, status: "pending", mode: "input" },
      { ackId: "o1", sessionId: "s3", cwd: "/repo/c", text: "fan out", ts: 1000, status: "queued", mode: "op" },
    ];
    const out = retargetEntry(base, "r1", { sessionId: "s9", cwd: "/repo/z", ackId: "NEW1" });
    const moved = out[0];
    check(moved.ackId === "NEW1" && moved.sessionId === "s9" && moved.cwd === "/repo/z" && moved.attempts === 0,
      `the targeted entry moves lane + mints a new ackId, attempts reset (${JSON.stringify({ ackId: moved.ackId, lane: moved.sessionId, attempts: moved.attempts })})`);
    check(moved.text === base[0].text && moved.ts === base[0].ts, "the text and the instant it was written are untouched");
    check(JSON.stringify(out.slice(1)) === JSON.stringify(base.slice(1)), "every other entry comes back byte-identical");

    const toBacklog = retargetEntry(base, "r1", { sessionId: "/repo/z", cwd: "/repo/z", ackId: "NEW2", mode: "backlog" })[0];
    check(toBacklog.mode === "backlog" && toBacklog.label === "fix the flaky test", `→backlog labels the item from its text (${toBacklog.label})`);
    const backItem = { ackId: "r3", sessionId: "/repo/b", cwd: "/repo/b", text: "queued work", ts: 1000, status: "queued", mode: "backlog", label: "queued work", fire: true, autoFire: true, targetSessionId: "s2" };
    const toInput = retargetEntry([backItem], "r3", { sessionId: "s9", cwd: "/repo/z", ackId: "NEW3", mode: "input" })[0];
    check(toInput.mode === "input" && toInput.label === undefined && toInput.fire === undefined && toInput.autoFire === undefined && toInput.targetSessionId === undefined,
      `→input drops the backlog-only fields (${JSON.stringify(toInput)})`);

    check(JSON.stringify(retargetEntry(base, "p1", { sessionId: "s9", cwd: "/repo/z", ackId: "NEW4" })) === JSON.stringify(base),
      "a pending entry is refused — it may already be on a live PTY");
    check(JSON.stringify(retargetEntry(base, "o1", { sessionId: "s9", cwd: "/repo/z", ackId: "NEW5" })) === JSON.stringify(base),
      "an op entry is refused — its payload names its own subject");
    check(canRetarget(base[0]) && !canRetarget(base[2]) && !canRetarget(base[3]), "canRetarget answers the same question for the UI");
    // An answer is the strongest refusal of the set: its payload is a keystroke
    // that means something only in ONE question box in ONE session (it carries
    // that box's fingerprint, and the host refuses it anywhere else). Aiming it
    // elsewhere could only ever produce a stray digit.
    check(!canRetarget({ status: "queued", mode: "input", answer: { fingerprint: "f" } }),
      "a queued ANSWER can never be re-aimed at another session");
    const up = { ackId: "u1", sessionId: "s1", cwd: "/repo/a", text: "image · shot.jpg", ts: 1000, status: "queued", mode: "upload" };
    check(!canRetarget(up), "an upload is refused too — it names a repo inbox, not a session");
    check(JSON.stringify(retargetEntry([up], "u1", { sessionId: "s9", cwd: "/repo/z", ackId: "NEW6" })) === JSON.stringify([up]),
      "…and retargetEntry leaves it untouched");
  }

  // ── Prompts queued for a session that does not exist yet ─────────────
  // Queuing "open a CLI here" on its own is close to pointless: the work meant
  // to run in it is the reason to queue anything, and offline there is no
  // session id a `session.input` could name. The first prompt therefore rides
  // inside the `session.create` op and the rest wait in its lane, unsendable
  // until `op.ack` names the session.
  {
    const lane = "create:/repo/a";
    const create = { ackId: "c1", sessionId: lane, cwd: "/repo/a", text: "open a · main", ts: 1000, status: "queued", mode: "op", op: { t: "session.create", ackId: "c1", cwd: "/repo/a", prompt: "read the failing test" } };
    const p2 = { ackId: "n2", sessionId: lane, cwd: "/repo/a", text: "now fix it", ts: 1000, status: "queued", mode: "input", pendingCreate: true, holdUntilIdle: true };
    const p3 = { ackId: "n3", sessionId: lane, cwd: "/repo/a", text: "then commit", ts: 1000, status: "queued", mode: "input", pendingCreate: true, holdUntilIdle: true };

    let plan = selectSendable([create, p2, p3], opts);
    check(plan.send.map((e) => e.ackId).join(",") === "c1",
      `only the create goes out — the prompts behind it have no session yet (${plan.send.map((e) => e.ackId).join(",") || "none"})`);

    // Without the create in front of them they are STILL unsendable: their lane
    // key is a placeholder, not a session id, so writing one to the socket would
    // address a session the host has never heard of.
    plan = selectSendable([p2, p3], opts);
    check(plan.send.length === 0, "a pending-create prompt is never picked, even at the head of its lane");
    plan = selectSendable([p2, p3, { ackId: "b1", sessionId: "s2", ts: 1000, status: "queued", mode: "input" }], opts);
    check(plan.send.map((e) => e.ackId).join(",") === "b1", "…and it holds only its OWN lane");

    // It waits for the session to exist, which is exactly what the queue is
    // riding out. Its fate follows the create (App fails these alongside it).
    plan = selectSendable([{ ...p2, ts: -100_000 }], opts);
    check(plan.expire.length === 0 && plan.send.length === 0, "a pending-create prompt is not expired while it waits for its session");
    check(plan.release.length === 0, "…and is not reported as released — its hold flag must survive until it is bound");

    // op.ack names the session → bind. Ids are KEPT (the lane rule proves these
    // were never sent, so no host verdict can exist for them) and order stands.
    const bound = bindPendingSession([create, p2, p3, { ackId: "z1", sessionId: "create:/repo/OTHER", ts: 1000, status: "queued", mode: "input", pendingCreate: true }], lane, "sess-9", 5000);
    check(bound[1].sessionId === "sess-9" && bound[2].sessionId === "sess-9", "both prompts move to the new session's lane");
    check(bound[1].ackId === "n2" && bound[2].ackId === "n3", "their ackIds are kept — they were provably never sent");
    check(!bound[1].pendingCreate && bound[1].holdUntilIdle === true, "the wait flag is dropped, the turn-hold is not");
    check(bound[1].ts === 5000, "their clock is restamped to the moment they became deliverable");
    check(bound[3].sessionId === "create:/repo/OTHER", "another repo's queued open is untouched");
    check(bound[0].ackId === "c1" && bound[0].mode === "op", "the create itself is left alone (its own ack removes it)");

    // Bound, they behave like any other chain: one at a time, and each waits for
    // the previous turn to end rather than landing mid-answer.
    plan = selectSendable(bound.slice(1, 3), { ...opts, now: 5000, busyLanes: ["sess-9"] });
    check(plan.send.length === 0, "the first bound prompt waits while the session is mid-turn");
    plan = selectSendable(bound.slice(1, 3), { ...opts, now: 5000 });
    check(plan.send.map((e) => e.ackId).join(",") === "n2", "…and goes alone when it is idle — the next one waits its turn");
  }

  // ── Images share the lane with the prompt that names them ────────────
  // An offline attach queues the picture AND a prompt saying "look at
  // .claude/inbox/x.jpg". Delivered out of order, the agent is pointed at a file
  // that isn't there yet — so the upload takes the lane first and the prompt
  // waits behind it exactly like two prompts would.
  {
    const img = { ackId: "u1", sessionId: "s1", cwd: "/repo/a", text: "image · x.jpg", ts: 1000, status: "queued", mode: "upload" };
    const prompt = { ackId: "t1", sessionId: "s1", cwd: "/repo/a", text: "look at .claude/inbox/x.jpg", ts: 1001, status: "queued", mode: "input" };
    let plan = selectSendable([img, prompt], opts);
    check(plan.send.length === 1 && plan.send[0].ackId === "u1", `the image goes first (${JSON.stringify(plan.send.map((e) => e.ackId))})`);
    // While it is uploading it holds the lane through `inflight` — an upload has
    // no socket receipt, so this is the only thing keeping the prompt back.
    plan = selectSendable([{ ...img, status: "pending" }, prompt], { ...opts, inflight: ["u1"] });
    check(plan.send.length === 0, `the prompt waits while the image is still going up (${JSON.stringify(plan.send.map((e) => e.ackId))})`);
    plan = selectSendable([prompt], opts);
    check(plan.send.length === 1 && plan.send[0].ackId === "t1", "…and goes the moment the upload is out of the queue");
  }

  // ── The REFERENCE decides the lane, not the tap that attached the file ──
  // The lane above only holds when both were queued for the same session. An
  // attach made for the repo (backlog/gallery flows, a pick with no session
  // open) parked the picture under a different key, and two lanes drain
  // concurrently — so the prompt beat its own image up the wire and the agent
  // read an inbox path that did not exist yet, with the link UP.
  {
    const rel = ".claude/inbox/shot-mte1.jpg";
    const img = { ackId: "u9", sessionId: "/repo/a", ts: 1000, status: "queued", mode: "upload", upload: { relPath: rel } };
    const other = { ackId: "u8", sessionId: "/repo/a", ts: 1000, status: "queued", mode: "upload", upload: { relPath: ".claude/inbox/unrelated.jpg" } };
    const prompt = { ackId: "t9", sessionId: "s1", ts: 1001, status: "queued", mode: "input", text: `look at ${rel}` };

    let plan = selectSendable([img, prompt], opts);
    check(plan.send.length === 2, "before adoption the prompt and its image race (two lanes, both go)");

    const moved = adoptReferencedUploads([img, other, prompt], prompt.text, "s1");
    check(moved[0].sessionId === "s1" && moved[0].ackId === "u9", "the referenced upload is pulled into the prompt's lane");
    check(moved[0].ackId === img.ackId, "its ackId is kept — the ackId is the key its bytes are stored under");
    check(moved[1].sessionId === "/repo/a", "an upload the text does not name is left where it is");
    plan = selectSendable(moved, opts);
    check(plan.send.map((e) => e.ackId).join(",") === "u9,u8", "…so now the image goes and the prompt waits behind it");

    // A dead upload must never be adopted: it would park the lane behind bytes
    // that are never coming, and the message naming it is wrong either way.
    const dead = { ...img, status: "failed" };
    check(adoptReferencedUploads([dead, prompt], prompt.text, "s1")[0].sessionId === "/repo/a",
      "a FAILED upload is not adopted");
    check(danglingUploadRefs([dead, prompt], prompt.text).join(",") === rel,
      "…it is reported as a dangling reference instead, so the send can be refused");
    check(danglingUploadRefs([img, prompt], prompt.text).length === 0, "a live upload is not a dangling reference");
  }

  // ── A failed upload attempt only counts when the host ANSWERED ────────
  // Otherwise the give-up budget is spent on the link, which is the one
  // condition the queue exists to ride out: eight attempts on the 5 s sweep is
  // under a minute, so a host restart could fail an image for good.
  {
    check(uploadAttemptWasted({ responded: true, socketOpen: true }) === false,
      "a host that answered (even with an error status) spends an attempt");
    check(uploadAttemptWasted({ socketOpen: true }) === true,
      "a transport error with the socket still reading open is NOT counted — a restart kills the POST before the close event lands");
    check(uploadAttemptWasted({ responded: true, socketOpen: false }) === true,
      "an answer that arrived with no socket is not trusted either");
    check(uploadAttemptWasted({ responded: true, stalled: true, socketOpen: true }) === true,
      "a stall we aborted ourselves is never a verdict");
  }
}
const done = () => { host.kill(); setTimeout(() => process.exit(failed ? 1 : 0), 100); };
const bail = (m) => { console.log("FAIL:", m); failed = true; done(); };

const RETRIED = "RETRIED_PROMPT_MARKER";
const FRESH = "FRESH_PROMPT_MARKER";

bootWait(PORT, 900, async () => {
  const repo = await fetch(`http://127.0.0.1:${PORT}/api/repo`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "queue" }),
  }).then((r) => r.json());
  if (!repo.path) return bail("could not create repo");
  const repos = await fetch(`http://127.0.0.1:${PORT}/api/repos`).then((r) => r.json());

  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
  let sid = null;
  let screen = "";
  const acks = [];
  const count = (needle) => screen.split(needle).length - 1;

  ws.on("open", () => ws.send(JSON.stringify({ t: "hello", protocol: 1 })));
  ws.on("message", async (raw) => {
    const m = JSON.parse(raw.toString());
    if (m.t === "welcome") {
      ws.send(JSON.stringify({ t: "session.create", cwd: repos.targets[0].worktreePath, cols: 120, rows: 40 }));
      return;
    }
    if (m.t === "session.created" && !sid) {
      sid = m.session.id;
      ws.send(JSON.stringify({ t: "session.attach", id: sid }));
      setTimeout(runSteps, 500);
      return;
    }
    if (m.t === "pty" && m.id === sid) screen += Buffer.from(m.dataB64, "base64").toString("utf8");
    if (m.t === "input.ack") acks.push(m);
  });
  ws.on("error", (e) => bail("ws error " + e.message));

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const input = (data, ackId) => ws.send(JSON.stringify({ t: "session.input", id: sid, data, ackId }));

  async function runSteps() {
    // 1. First delivery of a queued message.
    input(RETRIED, "retry-ack-1");
    await sleep(400);
    check(count(RETRIED) === 1, `first delivery types the text once (saw ${count(RETRIED)})`);
    check(acks.filter((a) => a.ackId === "retry-ack-1").length === 1 && acks[0].ok === true, "first delivery is acked ok");

    // 2. The phone never saw that receipt (socket died) and re-sends the same
    //    entry. The host must NOT type it again.
    input(RETRIED, "retry-ack-1");
    await sleep(400);
    check(count(RETRIED) === 1, `re-send of a known ackId is NOT retyped (still ${count(RETRIED)})`);
    const repeats = acks.filter((a) => a.ackId === "retry-ack-1");
    check(repeats.length === 2 && repeats[1].ok === true, "re-send is acked again (so the client can stop retrying)");

    // 3. Dedupe is keyed on the ackId, not the text: the same words sent as a
    //    genuinely new message must go through.
    input(RETRIED, "retry-ack-2");
    await sleep(400);
    check(count(RETRIED) === 2, `same text under a NEW ackId is delivered (saw ${count(RETRIED)})`);

    // 4. A receipt for a session that is gone stays not-ok on repeat too — the
    //    client must keep the text rather than believe a retry fixed it.
    ws.send(JSON.stringify({ t: "session.input", id: "nosuchsession", data: FRESH, ackId: "dead-ack-1" }));
    await sleep(200);
    ws.send(JSON.stringify({ t: "session.input", id: "nosuchsession", data: FRESH, ackId: "dead-ack-1" }));
    await sleep(300);
    const dead = acks.filter((a) => a.ackId === "dead-ack-1");
    check(dead.length === 2 && dead.every((a) => a.ok === false), "a gone session stays ok:false on retry");
    check(count(FRESH) === 0, "nothing leaked into the live session");

    // 5. The submitting Return is a separate, un-acked write (the client only
    //    sends it once the text is confirmed) — it must still reach the PTY.
    const before = screen.length;
    ws.send(JSON.stringify({ t: "session.input", id: sid, data: "\r" }));
    await sleep(400);
    check(screen.length > before, "a bare Return still writes through (no ackId needed)");

    // 6. The full client sequence, end to end: the phone goes offline mid-use,
    //    the user sends anyway, the socket comes back, and the message must be
    //    delivered AND submitted without anyone tapping anything. The client
    //    presses Return only once the receipt confirms the text landed (the old
    //    code fired it 50 ms after the write and hoped), so this also checks
    //    that ack-gated Return actually submits.
    ws.close();
    await sleep(300);
    const ws2 = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
    const queued = { ackId: "offline-1", text: "echo QUEUED_RAN" };
    let submitted = false;
    await new Promise((resolve) => {
      ws2.on("open", () => ws2.send(JSON.stringify({ t: "hello", protocol: 1 })));
      ws2.on("message", (raw) => {
        const m = JSON.parse(raw.toString());
        if (m.t === "welcome") {
          // Reconnect flush: everything queued goes out now.
          ws2.send(JSON.stringify({ t: "session.attach", id: sid }));
          ws2.send(JSON.stringify({ t: "session.input", id: sid, data: queued.text, ackId: queued.ackId }));
        } else if (m.t === "pty" && m.id === sid) {
          screen += Buffer.from(m.dataB64, "base64").toString("utf8");
        } else if (m.t === "input.ack" && m.ackId === queued.ackId && m.ok && !submitted) {
          submitted = true;
          setTimeout(() => ws2.send(JSON.stringify({ t: "session.input", id: sid, data: "\r" })), 50);
          setTimeout(resolve, 900);
        }
      });
      ws2.on("error", () => resolve());
      setTimeout(resolve, 6000);
    });
    check(submitted, "queued message delivered after the socket came back");
    // 7. The OTHER durable queue path: "queue for this session" adds a work item
    //    rather than typing into the PTY, and it must survive the tunnel being
    //    down the same way — which means the same at-most-once contract. A
    //    re-send with a known ackId is re-acked, never added twice.
    const backlogAcks = [];
    let items = null;
    await new Promise((resolve) => {
      ws2.on("message", (raw) => {
        const m = JSON.parse(raw.toString());
        if (m.t === "backlog.ack") backlogAcks.push(m);
        if (m.t === "backlog.list") items = m.items;
      });
      const add = () => ws2.send(JSON.stringify({
        t: "backlog.add", text: "QUEUED_ITEM", repoDir: repos.targets[0].worktreePath,
        label: "QUEUED_ITEM", ackId: "bk-ack-1",
      }));
      add();
      setTimeout(add, 250);                                            // the offline re-send
      setTimeout(() => ws2.send(JSON.stringify({ t: "backlog.list" })), 600);
      setTimeout(resolve, 1100);
    });
    check(backlogAcks.length === 2 && backlogAcks.every((a) => a.ok), "a queued work item is acked, and the re-send is acked again");
    check(backlogAcks[0]?.itemId && backlogAcks[0].itemId === backlogAcks[1]?.itemId, "both receipts name the SAME item");
    const mine = (items ?? []).filter((i) => i.text === "QUEUED_ITEM");
    check(mine.length === 1, `a re-sent work item is added exactly once (saw ${mine.length})`);
    // The stub is a shell: the command having RUN (not just echoed) is the proof
    // the Return took. Its output appears without the `echo ` prefix.
    check(/^QUEUED_RAN/m.test(screen.replace(/\r/g, "\n")), "ack-gated Return actually submitted it (command output seen)");
    try { ws2.close(); } catch { /* already closing */ }

    done();
  }
});

setTimeout(() => bail("timeout"), 20000);
