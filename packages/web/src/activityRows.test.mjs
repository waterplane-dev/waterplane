/**
 * The Activity row model, pinned without a browser.
 *
 * `activityRows.ts` lives in `packages/web/src` because it is the phone's
 * selector — but it has no DOM in it and no clock of its own, so it can be run
 * the way `packages/shared/test/*.test.mjs` runs: `node --test`, straight over
 * the TypeScript, using node's own type stripping. There is no test runner in
 * `packages/web` and adding one for one file would be a worse trade than this
 * comment; the command is written out at the bottom of this header so nobody
 * has to guess it.
 *
 * Why it is worth pinning at all: every rule in that file is a rule stated in
 * prose somewhere else in the app, and the way each of them breaks is silent.
 * A block reason mapped onto the wrong shared word puts a row in the wrong
 * chip. A `null` where `unknown` belongs turns "nobody knows whether it ran"
 * into a row that looks fine. An action disabled with no reason is a grey
 * button on the one screen a person opens after something already went wrong.
 * None of those throws, and none of them shows up in a type-check.
 *
 *     node --test packages/web/src/activityRows.test.mjs
 *
 * `npm run test:unit` now discovers it too: its glob was widened to
 * `packages/shared/test/*.test.mjs` plus `packages/web/src/*.test.mjs`, so the
 * phone's own pure rules are pinned by the same command as the shared ones.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { describeRule } from "@waterplane/shared";
import {
  ACTIVITY_FILTERS,
  activityCounts,
  activityHeadline,
  activityRows,
  activityTextKey,
  bulkLines,
  compareActivity,
  dismissBlocker,
  groupActivity,
  intentTitle,
  isActivityDebris,
  matchesFilter,
  partitionBulk,
  refireBlocker,
  sortActivity,
} from "./activityRows.ts";

const NOW = 1_700_000_000_000;

/** The injected half. Deliberately dumb: what is under test is the mapping, not
 *  the predicates, which are pinned where they live. */
const deps = {
  isEditableEntry: (e) => e.status === "queued" && e.mode !== "upload" && !e.answer,
  isCreateOp: (e) => e.mode === "op" && e.op?.t === "session.create",
  laneLabel: (e) => e.sessionId,
  repoName: (cwd) => cwd.split("/").pop(),
};

const input = (over = {}) => ({ now: NOW, online: true, hostSeenAt: NOW - 1000, deps, ...over });

/**
 * A durable row as the HOST holds it.
 *
 * These fixtures used to be five different DTO shapes — `LaunchIntent`,
 * `BacklogItem`, `ScheduleEntry`, `FanoutRun`, `BuildRun` — because the phone
 * received five projections of one store and rebuilt a lifecycle out of each.
 * They are one shape now, and the tests below are shorter for the same reason
 * the selector is: `state`, `blockReason` and `blockDetail` are GIVEN. What is
 * still worth pinning is everything the phone genuinely decides — which bucket
 * a state falls in, what a person may do about the row, and whether a disabled
 * verb says why.
 */
const intent = (over = {}) => ({
  id: "i1", cwd: "/dev/myapp",
  payload: { kind: "prompt", steps: ["add the export button"] },
  target: { kind: "repo" }, trigger: { kind: "idle" },
  state: "queued", createdAt: NOW, ...over,
});

/** A parked `session.create`: the only thing that waits on files. */
const launch = (over = {}) => intent({
  id: "L1", trigger: { kind: "files", needs: ["a.jpg"], deadlineAt: NOW + 3600e3 },
  payload: { kind: "prompt", steps: ["use shot.jpg"] },
  missing: ["a.jpg"], state: "blocked", blockReason: "filesMissing",
  blockDetail: "waiting for a.jpg", createdAt: NOW - 1000, ...over,
});

/** A standing rule on the wall clock. */
const schedule = (over = {}) => intent({
  id: "s1", label: "weekly sweep",
  trigger: { kind: "at", rule: { kind: "weekly" }, graceMin: 30 },
  target: { kind: "repos", dirs: ["/a", "/b"] },
  payload: { kind: "prompt", steps: ["audit"] },
  nextAt: NOW + 7200e3, state: "blocked", blockReason: "notYet", ...over,
});

/** A shell command, no agent. */
const buildRun = (over = {}) => intent({
  id: "r1", target: { kind: "shell" }, trigger: { kind: "now" },
  payload: { kind: "build", buildId: "b", name: "Release APK", cmd: "gradle", cwd: "/dev/myapp" },
  state: "done", settledAt: NOW,
  result: { at: NOW, ok: true, detail: "finished", exitCode: 0, artifacts: [] }, ...over,
});

/** A verified capture: a shell run with a picture at the end. Like `buildRun`,
 *  it carries no prose at all — the target's snapshotted `name` is the only
 *  string on the row that can tell two of them in one repo apart. */
const captureRun = (over = {}) => intent({
  id: "cr1", target: { kind: "shell" }, trigger: { kind: "now" },
  payload: { kind: "capture", targetId: "t_home", name: "droplet · home", backend: "web" },
  state: "done", settledAt: NOW,
  result: { at: NOW, ok: true, detail: "verified:anchor · score 91 · 390x844 dark · console: clean · net: clean", exitCode: 0, artifacts: [] },
  ...over,
});

/** A sweep: the parent, plus one child per repo sharing its `groupId`. */
const sweep = (targets, over = {}) => [
  intent({ id: "f1", groupId: "f1", origin: "fanout:run", target: { kind: "repos", dirs: targets.map((t) => t.cwd) },
    payload: { kind: "prompt", steps: ["bump deps"] }, createdAt: NOW - 60_000, ...over }),
  ...targets.map((t, n) => intent({
    id: `f1-${n}`, groupId: "f1", origin: "fanout", cwd: t.cwd, title: t.title,
    payload: { kind: "prompt", steps: ["bump deps"] }, target: { kind: "repo", fresh: true },
    createdAt: NOW - 60_000 + n, order: n,
    state: t.state, sessionId: t.sessionId,
    result: t.error ? { at: NOW, ok: false, detail: t.error } : undefined,
    settledAt: t.state === "done" || t.state === "failed" ? NOW : undefined,
  })),
];
const entry = (over = {}) => ({ ackId: "a1", sessionId: "s1", cwd: "/dev/myapp", text: "fix the failing test", ts: NOW - 60_000, status: "queued", ...over });
const only = (rows) => { assert.equal(rows.length, 1); return rows[0]; };

// ── The queue ───────────────────────────────────────────────────────────────

test("a queued send with no socket is `offline`, and the sentence says nothing expires", () => {
  const r = only(activityRows(input({ online: false, outbox: [entry()] })));
  assert.equal(r.state, "blocked");
  assert.equal(r.blockReason, "offline");
  assert.equal(r.bucket, "waiting");
  assert.match(r.verdict, /nothing expires/);
});

test("offline outranks every lane reason — the row has not reached the host at all", () => {
  const r = only(activityRows(input({
    online: false,
    outbox: [entry()],
    queueBlocked: new Map([["a1", "held"]]),
  })));
  assert.equal(r.blockReason, "offline");
});

test("the four lane-shaped queue reasons map to sessionBusy and keep their own sentence", () => {
  for (const [reason, phrase] of [
    ["held", /finishes this turn/],
    ["lane", /going out first/],
    ["inflight", /already in flight/],
    ["pendingCreate", /session to open/],
  ]) {
    const r = only(activityRows(input({ outbox: [entry()], queueBlocked: new Map([["a1", reason]]) })));
    assert.equal(r.blockReason, "sessionBusy", reason);
    assert.match(r.verdict, phrase, reason);
  }
});

test("backoff maps to no shared reason at all — it is this client's clock, not one of the ten", () => {
  const r = only(activityRows(input({
    outbox: [entry({ retryAt: NOW + 12_000 })],
    queueBlocked: new Map([["a1", "backoff"]]),
  })));
  assert.equal(r.blockReason, null);
  assert.equal(r.state, "blocked");
  assert.match(r.verdict, /trying again in 12s/);
});

test("a gone lane needs a person, and lands in `needs you` rather than `waiting`", () => {
  const r = only(activityRows(input({ outbox: [entry()], goneLanes: new Set(["s1"]) })));
  assert.equal(r.blockReason, "sessionGone");
  assert.equal(r.bucket, "needsYou");
});

test("only `input` entries are stranded by a gone lane — an upload is an HTTP POST", () => {
  const r = only(activityRows(input({
    outbox: [entry({ mode: "upload", upload: { repoId: "r", name: "a.jpg", relPath: ".claude/inbox/a.jpg", size: 10, type: "image/jpeg" } })],
    goneLanes: new Set(["s1"]),
  })));
  assert.notEqual(r.blockReason, "sessionGone");
});

test("a failed send carries the delivery truth on its own axis, and `stale` is a REFUSAL", () => {
  const r = only(activityRows(input({ outbox: [entry({ status: "failed", failState: "stale", reason: "the question had changed", failedAt: NOW })] })));
  assert.equal(r.state, "failed");
  assert.equal(r.bucket, "failed");
  assert.equal(r.delivery, "refused");
  assert.equal(r.verdict, "the question had changed");
});

test("an op the desktop answered `ok:false` is a REFUSAL — the host recorded what became of it", () => {
  const r = only(activityRows(input({ outbox: [entry({
    mode: "op", op: { t: "schedule.run", id: "s1" }, status: "failed", failState: "refused",
    reason: "it is already failed", failedAt: NOW,
  })] })));
  assert.equal(r.delivery, "refused");
  assert.equal(r.verdict, "it is already failed");
});

test("a failure nobody recorded is `unknown` — never quietly the kinder of the two", () => {
  const r = only(activityRows(input({ outbox: [entry({ status: "failed", failedAt: NOW })] })));
  assert.equal(r.delivery, "unknown");
});

test("a `pending` send is `starting`, not `running` — the bytes are on the wire, the turn is not", () => {
  const r = only(activityRows(input({ outbox: [entry({ status: "pending", sentAt: NOW })] })));
  assert.equal(r.state, "starting");
  assert.equal(r.bucket, "running");
});

test("a failed row may be revived with the link down; everything else is disabled WITH A REASON", () => {
  const rows = activityRows(input({ online: false, outbox: [entry({ status: "failed", failedAt: NOW })] }));
  const send = rows[0].actions.find((a) => a.id === "sendNow");
  assert.equal(send.disabledReason, undefined);
  const offlineQueued = activityRows(input({ online: false, outbox: [entry()] }))[0];
  assert.match(offlineQueued.actions.find((a) => a.id === "sendNow").disabledReason, /no connection/);
});

// The bug this pins, measured on a phone: "try again" on a row whose verdict
// the desktop REMEMBERED hid itself for the frame the entry spent `pending`,
// came back red, and said nothing. A retry is the same ackId, and the host's
// ledger answers a known ackId with the recorded verdict and types nothing —
// so the only outcome that button ever had was the same refusal, replayed.
// `unconfirmed` is dated OLD on purpose: a FRESH one is a row the desktop is
// still asking about (`sendConfirm.ts`), which has its own sentence and its own
// test below. These four are the settled verdicts — the ledger remembers them,
// so "try again" can only ever replay the same refusal.
for (const [failState, want, age] of [
  ["unconfirmed", /may have run/, 10 * 60_000],
  ["unsubmitted", /composer/, 0],
  ["stale", /same no/, 0],
  ["refused", /refused again/, 0],
]) {
  test(`"try again" is refused WITH A REASON on a ${failState} row, and the rewrite leads instead`, () => {
    const r = only(activityRows(input({ outbox: [entry({ status: "failed", failState, failedAt: NOW - age })] })));
    const send = r.actions.find((a) => a.id === "sendNow");
    assert.match(send.disabledReason, want);
    // The way out has to be pressable, and has to be the thing the row leads
    // with — a rewrite retires this row and queues a fresh ackId, which is a
    // message the ledger has never seen.
    const edit = r.actions.find((a) => a.id === "edit");
    assert.equal(edit.disabledReason, undefined);
    assert.equal(edit.primary, true);
    // …and the bulk button reads the same rule off the same row, so the count
    // on it can never disagree with the sentences under it.
    assert.match(refireBlocker(r), want);
  });
}

test("a send the desktop is STILL confirming is not a failure to deal with", () => {
  // Seven seconds after Send the host has only just written the row down: it
  // goes on to re-ask the CLI's own log on a doubling sweep and to retype a
  // provably-absent prompt up to four times. The row read `failed` here, in the
  // failure count, offering the one action that can run a prompt twice.
  const r = only(activityRows(input({ outbox: [entry({ status: "failed", failState: "unconfirmed", failedAt: NOW - 7_000 })] })));
  assert.equal(r.state, "running", "something IS happening to it");
  assert.notEqual(r.bucket, "failed");
  assert.match(r.verdict, /confirming whether it ran/);
  assert.match(r.actions.find((a) => a.id === "sendNow").disabledReason, /still confirming/);
  // Once the host answers, the row is a failure like any other — the verdict
  // above is about a question, not a colour.
  const settled = only(activityRows(input({ outbox: [entry({ status: "failed", failState: "unconfirmed", failedAt: NOW - 7_000, hostSettled: true })] })));
  assert.equal(settled.state, "failed");
  assert.match(settled.actions.find((a) => a.id === "sendNow").disabledReason, /may have run/);
});

test("save as done is offered only where the desktop's own detector shrugged", () => {
  // `unconfirmed` — typed in, screen unreadable back — is the one verdict a
  // person at the terminal can actually settle themselves. The others already
  // know what happened, and the button would contradict the row's own words.
  const unconfirmed = only(activityRows(input({ outbox: [entry({ status: "failed", failState: "unconfirmed", failedAt: NOW - 5000 })] })));
  assert.ok(unconfirmed.actions.some((a) => a.id === "confirmDone"));
  const refused = only(activityRows(input({ outbox: [entry({ status: "failed", failState: "refused", failedAt: NOW - 5000 })] })));
  assert.ok(!refused.actions.some((a) => a.id === "confirmDone"));
  const unsubmitted = only(activityRows(input({ outbox: [entry({ status: "failed", failState: "unsubmitted", failedAt: NOW - 5000 })] })));
  assert.ok(!unsubmitted.actions.some((a) => a.id === "confirmDone"));
});

test("marking a row done is a person's call, not the desktop's — the row says so", () => {
  const key = "queue:a1";
  const r = only(activityRows(input({
    outbox: [entry({ status: "failed", failState: "unconfirmed", failedAt: NOW - 5000 })],
    confirmedDone: new Map([[key, NOW - 1000]]),
  })));
  assert.equal(r.bucket, "done");
  assert.equal(r.state, "done");
  assert.equal(r.confirmedDoneAt, NOW - 1000);
  assert.match(r.verdict, /you marked this done/);
  // `delivery` is a fact about what the DESKTOP established, and a person's
  // tap does not get to rewrite it.
  assert.equal(r.delivery, "unconfirmed");
});

test("a failure nobody recorded is still retryable — the guard is the ledger, not the redness", () => {
  const r = only(activityRows(input({ outbox: [entry({ status: "failed", failState: "other", failedAt: NOW })] })));
  assert.equal(r.actions.find((a) => a.id === "sendNow").disabledReason, undefined);
  assert.ok(!r.actions.find((a) => a.id === "edit").primary);
  assert.equal(refireBlocker(r), null);
});

test("every disabled action carries a reason — structurally, across every source", () => {
  const rows = activityRows(input({
    outbox: [entry({ mode: "upload" }), entry({ ackId: "a2", answer: { fingerprint: "f", question: "q?", label: "yes" } })],
    intents: [launch(), intent({ id: "b1", state: "done", settledAt: NOW }), buildRun()],
  }));
  for (const row of rows) {
    for (const a of row.actions) {
      if (a.disabledReason !== undefined) {
        assert.equal(typeof a.disabledReason, "string", `${row.key}/${a.id}`);
        assert.ok(a.disabledReason.length > 0, `${row.key}/${a.id} has an empty reason`);
      }
    }
  }
});

test("the words are never clipped away — a long prompt keeps its full text", () => {
  const long = "x".repeat(900);
  const r = only(activityRows(input({ outbox: [entry({ text: long })] })));
  assert.equal(r.clipped, true);
  assert.ok(r.title.length < long.length);
  assert.equal(r.fullText, long);
});

// ── The host's launch gate ──────────────────────────────────────────────────

test("a launch waiting on files is `filesMissing`, says which, and counts them", () => {
  const r = only(activityRows(input({
    intents: [launch({
      trigger: { kind: "files", needs: ["a.jpg", "b.jpg"], deadlineAt: NOW + 3600e3 },
      missing: ["b.jpg"], blockDetail: "waiting for b.jpg",
    })],
  })));
  // Taken from the row, not inferred from a projection of it.
  assert.equal(r.blockReason, "filesMissing");
  assert.match(r.verdict, /b\.jpg/);
  assert.deepEqual(r.progress, { done: 1, total: 2, label: "files" });
  assert.equal(r.cwd, "/dev/myapp");
});

test("a create that is BOTH in the send queue and parked host-side is ONE row, the host's", () => {
  const rows = activityRows(input({
    outbox: [entry({ ackId: "L1", mode: "op", op: { t: "session.create", ackId: "L1" }, text: "open a session" })],
    intents: [launch({ id: "L1" })],
  }));
  assert.equal(rows.length, 1);
  assert.equal(rows[0].source, "launch");
});

// ── The backlog ─────────────────────────────────────────────────────────────

test("the backlog's waiting sentence is the HOST's, displayed verbatim and never re-derived", () => {
  // Any sentence would do — the point is that it is not re-derived here — but
  // it is a LIVE one on purpose: this fixture used to quote "no backlog session
  // open for this repo", a refusal that named a shared conversation the app no
  // longer has, and a retired string in a test reads as a rule still in force.
  // It said "this repo's work items" for the same reason and just as wrongly —
  // *work item* is the retired name for a row in that same shared conversation,
  // and the ladder says *backlog* now (`shared/intent.ts`'s `GONE_SESSION`).
  const host = "that session is gone — aim it at another session, or at this repo's backlog";
  const r = only(activityRows(input({
    intents: [intent({ id: "b1", state: "blocked", blockReason: "sessionGone", blockDetail: host })],
  })));
  assert.equal(r.verdict, host);
  assert.equal(r.state, "blocked");
  // It IS published — `blockReason` rides on the row beside the sentence the
  // same ladder wrote. This used to assert `null`, because the projection the
  // phone received had dropped it and guessing would have made the list sort
  // on a fact nobody decided. Reading the store is what turned the honest
  // `null` into the real answer, and the bucket now follows it.
  assert.equal(r.blockReason, "sessionGone");
  assert.equal(r.bucket, "needsYou");
});

// ── "Was this really lost, or is it already done?" ──────────────────────────
//
// The question a row that failed a month ago is actually read with, and the one
// this screen had no answer for: the only thing it offered was sending the
// words again, which is the expensive move and the one that assumes the answer.
// `backlog.check` already existed and was reachable from exactly one place.

const DAY = 86_400_000;
const item = (over = {}) => intent({ id: "b1", ...over });
/** A work item that ran and did not finish. */
const failedItem = (over = {}) => item({ state: "failed", settledAt: NOW,
  result: { at: over.settledAt ?? NOW, ok: false, detail: "never delivered" }, ...over });

test("a work item can be asked whether it is already implemented", () => {
  const r = only(activityRows(input({ intents: [failedItem()] })));
  const check = r.actions.find((a) => a.id === "check");
  assert.ok(check, "a backlog row offers the check");
  assert.equal(check.disabledReason, undefined);
});

test("a failed work item leads with the check, not with running it again", () => {
  const r = only(activityRows(input({ intents: [failedItem({ settledAt: NOW - 28 * DAY })] })));
  // Re-firing assumes the work is undone, and that assumption is exactly what
  // is worth testing before a month-old prompt spends a session on it.
  assert.equal(r.actions.find((a) => a.primary).id, "check");
});

test("a check in flight is refused by the HOST, so the phone does not carry a second copy of the guard", () => {
  // `review.ts` returns early on `checkStatus === "checking"` for the same id.
  // The phone used to repeat that rule as a disabled reason, which cost a
  // `checkStatus` field in a DTO whose only reader was this button — a guard
  // duplicated across the wire to grey out a control the host already refuses.
  // The tap is live; the desktop is where the answer to "is one running?" is.
  const r = only(activityRows(input({ intents: [failedItem()] })));
  assert.equal(r.actions.find((a) => a.id === "check").disabledReason, undefined);
});

test("a check starts an agent on the desktop, so it is refused with the link down", () => {
  const r = only(activityRows(input({ online: false, intents: [failedItem()] })));
  assert.match(r.actions.find((a) => a.id === "check").disabledReason, /no connection/);
});

test("only rows the desktop holds an intent for offer a check — the rest have nothing to ask about", () => {
  const rows = activityRows(input({
    outbox: [entry({ status: "failed", failedAt: NOW, reason: "gave up" })],
    intents: [
      launch(),
      failedItem(),
      schedule(),
      ...sweep([{ cwd: "/a", title: "a", state: "done", sessionId: "sa" }]),
      buildRun(),
    ],
    pulls: [{ item: { id: "p1", repoId: "myapp", repoDir: "/dev/myapp", repoName: "myapp", name: "app.apk", relPath: "out/app.apk", size: 1000, mtime: NOW, ts: NOW - 1000, source: "build" }, state: "done", received: 1000, attempts: 1, updatedAt: NOW }],
  }));
  // A check is aimed by intent id and its verdict is stored against one. The
  // other six sources have no id the host holds, so the honest answer is that
  // the action does not exist there — not a permanently grey button on it.
  const withCheck = rows.filter((r) => r.actions.some((a) => a.id === "check")).map((r) => r.source);
  assert.deepEqual(withCheck, ["backlog"]);
});

test("an archived item is the backlog's own “I have seen this” — the one row that does leave", () => {
  const rows = activityRows(input({
    intents: [item({ state: "done", settledAt: NOW, archived: true })],
  }));
  assert.equal(rows.length, 0);
});

// ── Schedules ───────────────────────────────────────────────────────────────

test("a disabled schedule needs a person (`gate`); an armed one is `notYet` and scheduled", () => {
  // Both verdicts are the HOST's now — it disarms a rule by clearing `nextAt`
  // and says which of the ten that is. The phone used to infer "gate" from an
  // `enabled` flag the projection had derived from this very field.
  const off = only(activityRows(input({ intents: [schedule({ nextAt: null, blockReason: "gate", blockDetail: "switched off — it will not fire until you turn it back on" })] })));
  assert.equal(off.blockReason, "gate");
  assert.equal(off.bucket, "needsYou");

  const on = only(activityRows(input({ intents: [schedule()] })));
  assert.equal(on.blockReason, "notYet");
  assert.equal(on.bucket, "scheduled");
  assert.equal(on.dueAt, NOW + 7200e3);
  assert.equal(on.where, "2 repos");
});

test("a spent one-off SWEEP is not a switched-off schedule, and no tap pretends otherwise", () => {
  // A sweep, deliberately: a one-off aimed at ONE place is a WORK row now
  // (`isTimedWorkRow` — recurrence, not trigger kind, decides which list a row
  // lives in), and it wears work verbs rather than a schedule's switch. A
  // `repos` sweep has no single backlog to live in, so it is the one-off that
  // stays a schedule card — which is what every assertion below is about.
  const base = {
    id: "s1", label: "tonight's sweep",
    trigger: { kind: "at", rule: { kind: "once", at: NOW - 3600e3 }, graceMin: 0 },
    target: { kind: "repos", dirs: ["/a", "/b"] }, payload: { kind: "prompt", steps: ["check the thing"] },
    createdAt: NOW - 7200e3, nextAt: null,
  };
  // It ran, and it failed: the host's own sentence stands as the verdict.
  const failed = only(activityRows(input({ intents: [intent({ ...base, state: "failed", settledAt: NOW - 3500e3,
    result: { at: NOW - 3500e3, ok: false, detail: "that instant has passed and this was a one-off" } })] })));
  assert.equal(failed.state, "failed");
  assert.equal(failed.blockReason, null);
  assert.equal(failed.verdict, "that instant has passed and this was a one-off");
  // The SWITCH is the tap that pretends: re-arming asks `nextFireAt` again,
  // gets the same null, and reports success having moved nothing.
  assert.match(failed.actions.find((a) => a.id === "toggle").disabledReason, /cannot be re-armed/);
  // *Now* is NOT that tap, and this screen used to refuse it while the schedule
  // sheet offered it for the same row. The host revives a spent row in place
  // and fires it, and a schedule missed while the desktop slept is exactly the
  // one you want to fire by hand.
  assert.equal(failed.actions.find((a) => a.id === "runNow").disabledReason, undefined);
  // Deleting and editing are the other two things that still mean something.
  for (const id of ["cancel", "edit"]) {
    assert.equal(failed.actions.find((a) => a.id === id).disabledReason, undefined, id);
  }

  // A one-off in the FUTURE with nothing armed really was switched off, and
  // the switch really can undo it.
  const off = only(activityRows(input({ intents: [intent({ ...base,
    trigger: { kind: "at", rule: { kind: "once", at: NOW + 3600e3 }, graceMin: 0 },
    state: "blocked", blockReason: "gate",
    blockDetail: "switched off — it will not fire until you turn it back on" })] })));
  assert.equal(off.blockReason, "gate");
  assert.match(off.verdict, /switched off/);
  assert.equal(off.actions.find((a) => a.id === "toggle").disabledReason, undefined);
});

test("a one-off aimed at ONE repo is WORK with a clock — work verbs, and the row names the clock", () => {
  /**
   * The other half of the fixture above, and the whole point of the change:
   * `isTimedWorkRow` files a non-recurring `at` aimed at one place as a BACKLOG
   * row. Recurrence, not trigger kind, decides which list a row lives in — so
   * this row wears work verbs (it is re-runnable, checkable, rewritable) and
   * never a schedule's switch, which on a spent one-off is the one tap that
   * pretends: re-arming asks `nextFireAt` again, gets the same null, and
   * reports success having moved nothing.
   *
   * Measured on this desktop when it was written: nine live `at` rows, all
   * one-off, seven of them `failed` — in no backlog, with no work verbs, and
   * invisible to the smart pick, which only ever looks at backlog rows.
   */
  const RULE = { kind: "once", at: NOW - 3600e3 };
  const timed = (over = {}) => intent({
    id: "t1", cwd: "/dev/myapp", label: "tidy the exports",
    trigger: { kind: "at", rule: RULE, graceMin: 0 },
    target: { kind: "repo", fresh: true }, payload: { kind: "prompt", steps: ["tidy the exports"] },
    createdAt: NOW - 7200e3, nextAt: null, ...over,
  });

  const failed = only(activityRows(input({ intents: [timed({ state: "failed", settledAt: NOW - 3500e3,
    result: { at: NOW - 3500e3, ok: false, detail: "the desktop was not running when it was due" } })] })));
  assert.equal(failed.source, "backlog", "it is a backlog row, not a schedule card");
  assert.equal(failed.state, "failed");
  // Work verbs, all of them live. `sendNow` is *run it now*; `check` is the
  // "is this already done?" question this screen exists to ask after something
  // went wrong, and it is the primary on a failed work row.
  assert.equal(failed.actions.find((a) => a.id === "sendNow" || a.id === "runNow").disabledReason, undefined);
  assert.equal(failed.actions.find((a) => a.id === "check").disabledReason, undefined);
  assert.equal(failed.actions.find((a) => a.primary).id, "check");
  assert.equal(failed.actions.find((a) => a.id === "edit").disabledReason, undefined);
  // And NOT a schedule's switch, with or without a refusal on it: there is no
  // rule here to arm, and `toggle` on a work row means the per-item auto-fire
  // switch in the backlog — never "re-arm this one-off".
  const toggle = failed.actions.find((a) => a.id === "toggle");
  if (toggle) assert.doesNotMatch(toggle.disabledReason ?? "", /re-armed/);
  // The row says its clock, in `describeRule`'s own words and nowhere near the
  // title — it is a fact about WHERE the words are going, beside where they go.
  assert.match(failed.where, new RegExp(describeRule(RULE).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.match(failed.where, /^myapp · in a new session · /);

  // Armed and waiting: still `notYet` and still bucketed `scheduled`, sorted by
  // when it is due — the bucket is the REASON, not the kind, and that does not
  // change just because the row moved lists.
  const armed = only(activityRows(input({ intents: [timed({
    trigger: { kind: "at", rule: { kind: "once", at: NOW + 7200e3 }, graceMin: 0 },
    nextAt: NOW + 7200e3, state: "blocked", blockReason: "notYet" })] })));
  assert.equal(armed.bucket, "scheduled");
  assert.equal(armed.dueAt, NOW + 7200e3);
});

test("an untimed work row's `where` is exactly what it always was", () => {
  // Absent clock = old behaviour, in the one place the fragment is appended.
  const r = only(activityRows(input({ intents: [intent({ target: { kind: "repo", fresh: true } })] })));
  assert.equal(r.where, "myapp · in a new session");
});

// ── Sweeps, builds, downloads ───────────────────────────────────────────────

test("a fan-out is one row that counts its repos and stays openable", () => {
  const r = only(activityRows(input({
    intents: sweep([
      { cwd: "/a", title: "a · main", state: "done", sessionId: "sa" },
      { cwd: "/b", title: "b · main", state: "failed", error: "no session" },
    ], { state: "failed", settledAt: NOW }),
  })));
  assert.equal(r.state, "failed");
  assert.deepEqual(r.progress, { done: 1, total: 2, label: "repos" });
  assert.equal(r.targets.length, 2);
  assert.equal(r.actions.find((a) => a.id === "open").disabledReason, undefined);
});

test("a row is titled the way its OWN kind was titled — prose for work, name for a schedule", () => {
  // The five builders each encoded this and it is easy to lose in a merge: a
  // work item IS the sentence somebody typed, and titling it by whatever short
  // label happens to be attached renames it to `file · 1000074690-…jpg`. A
  // schedule and a build are the other way round — the name is the identity and
  // the prompt or command underneath is the detail.
  const work = only(activityRows(input({ intents: [item({
    label: "file · 1000074690-mtmw2965bdb334.jpg",
    payload: { kind: "prompt", steps: ["look at this screenshot and fix the overlap"] },
  })] })));
  assert.match(work.title, /look at this screenshot/);

  const sch = only(activityRows(input({ intents: [schedule({ label: "weekly sweep" })] })));
  assert.equal(sch.title, "weekly sweep");

  // A schedule's `title` is only a NAME when somebody typed one. The host fills
  // it in otherwise, with the prompt's own first line cut at 120
  // (`scheduleToIntent`) — so "titled by its name" meant the row was a 120-char
  // fragment of the very prose printed under it, cut mid-word. `typedName` is
  // the test, and when it fails the prose is the title.
  const steps = [`${"tidy the schedule card and stop it cutting the prompt twice ".repeat(4)}then run the tests`];
  const derived = only(activityRows(input({ intents: [schedule({
    label: undefined, title: steps[0].split("\n")[0].slice(0, 120), payload: { kind: "prompt", steps },
  })] })));
  assert.match(derived.title, /then run the tests/);   // the whole prose, not the host's slice
  const kept = only(activityRows(input({ intents: [schedule({
    label: undefined, title: "weekly usage sweep", payload: { kind: "prompt", steps },
  })] })));
  assert.equal(kept.title, "weekly usage sweep");

  const bld = only(activityRows(input({ intents: [buildRun()] })));
  assert.equal(bld.title, "Release APK");

  // ── …and where a title a MACHINE wrote goes ──────────────────────────────
  //
  // `Intent.headline` is the backlog's derived title on the wire, and it is the
  // one field on a work row that is only ever a TITLE. The row's `title` is a
  // HEAD — `fullText` still carries the words in full underneath it — so five
  // words over the sentence beat the first eighty characters of the sentence.
  const titled = only(activityRows(input({ intents: [item({
    label: undefined, headline: "flaky upload test",
    payload: { kind: "prompt", steps: ["the upload test fails about one run in five on the phone"] },
  })] })));
  assert.equal(titled.title, "flaky upload test");
  assert.match(titled.fullText, /one run in five/, "the head never replaces the words");
  // **It does NOT displace a name somebody typed** — but on an Intent `label`
  // is also what the send queue MINTS for a row carrying an upload, so the
  // prose stays in front of it and a machine title never wins against words the
  // same person wrote. The case above this one is the one that pins that.
  const both = only(activityRows(input({ intents: [item({
    label: "file · 1000074690-mtmw2965bdb334.jpg", headline: "the overlap on the launcher",
    payload: { kind: "prompt", steps: ["look at this screenshot and fix the overlap"] },
  })] })));
  assert.equal(both.title, "the overlap on the launcher", "a real title beats a filename nobody typed");
  // A row nobody has named reads exactly as it always did.
  assert.match(work.title, /look at this screenshot/);

  // A capture is named for a build's reason, and harder: there is no prose
  // ANYWHERE on the row to fall back to — the payload is a target id — so if the
  // name is not used the row is titled `cr1`. The name is snapshotted on the
  // payload at fire time, because `.myapp/capture.json` is edited between runs
  // and a row that renames itself weeks later is a lie about what ran.
  const cap = only(activityRows(input({ intents: [captureRun()] })));
  assert.equal(cap.title, "droplet · home");
});

test("the chain picker titles a row the way the Activity sheet does — one rule, not two", () => {
  // `SendSheet`'s *after another…* picker has to name the row it is about to
  // wait for, and the name it picks is SNAPSHOTTED onto the trigger
  // (`IntentTrigger.after.title`) — so it becomes what the waiting row says
  // about itself for the rest of its life. A second copy of the rule living in
  // the sheet would drift, and the first thing to drift is the case above: a
  // schedule titled by a mid-word slice of its own prompt.
  const rows = [
    item({ label: "file · shot.jpg", payload: { kind: "prompt", steps: ["fix the overlap"] } }),
    schedule({ label: "weekly sweep" }),
    buildRun(),
    captureRun(),
  ];
  for (const i of rows) {
    assert.equal(intentTitle(i), only(activityRows(input({ intents: [i] }))).title);
  }
  // Un-clipped, deliberately: clipping is the ROW's (`TITLE_MAX`), and a stored
  // ellipsis can never be undone.
  const long = item({ payload: { kind: "prompt", steps: ["x".repeat(400)] } });
  assert.equal(intentTitle(long).length, 400);
  assert.ok(only(activityRows(input({ intents: [long] }))).title.length < 400);
});

test("a capture row carries the host's verdict whole, and is never re-worded here", () => {
  // The verdict grammar is the HOST's, written by one function there. The phone
  // prints it; it does not split it on its separator and it does not re-derive
  // any part of it, or there are two wordings of one rule.
  const verdict = "settled:stable · score n/a · 390x844 dark · console: clean · net: n/a";
  const r = only(activityRows(input({
    intents: [captureRun({ result: { at: NOW, ok: true, detail: verdict, exitCode: 0, artifacts: [] } })],
  })));
  assert.equal(r.verdict, verdict);
});

test("a running capture is not described as running in a session — it has none", () => {
  // A capture's target is `shell`: no agent, no session. The generic sentence
  // ("running in the session now") sends a reader looking for one that was never
  // opened, which on the screen you check when something is stuck is a dead end.
  const r = only(activityRows(input({
    intents: [captureRun({ state: "running", settledAt: undefined, result: undefined })],
  })));
  assert.doesNotMatch(r.verdict, /session/);
});

test("a capture offers a build's three verbs, not a work item's six", () => {
  // Filed under `build` on both axes because that is what it IS — a shell run in
  // a repo that finishes with files. The verbs that follow from that are
  // download / stop / run again; `check whether it is already done` and `aim it
  // at another session` are questions about a PROMPT and mean nothing here.
  const r = only(activityRows(input({ intents: [captureRun()] })));
  assert.equal(r.source, "build");
  assert.equal(r.kind, "build");
  // `dismiss` rides along on every row (`activityRows()` stamps it centrally,
  // not per builder) — it is the same "not now, still here" the bulk button
  // already offers regardless of kind, so it is not one of the kind-specific
  // three this test is actually about.
  assert.deepEqual(r.actions.map((a) => a.id).sort(), ["cancel", "dismiss", "download", "runNow"]);
  // …and the download says why it cannot run rather than being a grey button.
  assert.match(r.actions.find((a) => a.id === "download").disabledReason, /no file/);
});

test("a sweep is ONE row — its per-repo children and its follow-ups are folded into it", () => {
  // `fanoutRuns` puts the children in `targets` and the follow-ups in
  // `lastRun`. Letting them through as rows of their own would draw one sweep
  // four times on the screen whose whole purpose is that a piece of work has
  // exactly one row. The parent is the row whose id IS the group id — the same
  // test the aggregation uses to find it.
  const rows = activityRows(input({
    intents: [
      ...sweep([
        { cwd: "/a", title: "a", state: "done", sessionId: "sa" },
        { cwd: "/b", title: "b", state: "done", sessionId: "sb" },
      ], { state: "done", settledAt: NOW }),
      // …and a follow-up into the sessions that sweep opened.
      intent({ id: "f1-fu", groupId: "f1", origin: "fanout:fu:batch1", cwd: "/a",
        payload: { kind: "prompt", steps: ["…and now commit that"] },
        target: { kind: "sessions", sessionIds: ["sa"] }, state: "done", settledAt: NOW }),
    ],
  }));
  assert.equal(rows.length, 1);
  assert.equal(rows[0].source, "fanout");
  assert.equal(rows[0].targets.length, 2);
  assert.match(rows[0].lastRun.detail, /follow-up/);
});

test("a build that rebuilt nothing does not claim to have made the file", () => {
  const r = only(activityRows(input({
    intents: [buildRun({ result: { at: NOW, ok: true, detail: "finished", exitCode: 0,
      artifacts: [{ repoId: "myapp", name: "app.apk", relPath: "out/app.apk", size: 1, stale: true }] } })],
  })));
  assert.match(r.verdict, /nothing was rebuilt/);
});

test("a download record is the phone's own, so it is never labelled last-known", () => {
  const r = only(activityRows(input({
    online: false,
    pulls: [{ item: { id: "p1", repoId: "myapp", repoDir: "/dev/myapp", repoName: "myapp", name: "app.apk", relPath: "out/app.apk", size: 1000, mtime: NOW, ts: NOW - 1000, source: "build" }, state: "downloading", received: 250, attempts: 1, updatedAt: NOW }],
  })));
  assert.equal(r.asOf, null);
  assert.equal(r.bucket, "running");
  assert.deepEqual(r.progress, { done: 250, total: 1000, label: "bytes" });
});

test("host-sourced rows say how old they are the moment the link is down", () => {
  const rows = activityRows(input({
    online: false,
    hostSeenAt: NOW - 300_000,
    intents: [item()],
  }));
  assert.equal(rows[0].asOf, NOW - 300_000);
});

// ── Failed sends: the rows the give-ups ledger used to hold ─────────────────
//
// There is no second ledger any more. A send that gave up KEEPS its queue row —
// nothing retires it, nothing clips it, nothing moves its words to a pad that
// another device can overwrite — so the three jobs that ledger did (show me
// what never ran, the button that re-sends it to the right repo, and the mark
// that says I dealt with it) are all this one row.

test("a failed send keeps its words in full, and the repo they were written for", () => {
  const long = "x".repeat(400);
  const r = only(activityRows(input({
    outbox: [entry({ status: "failed", failedAt: NOW, reason: "session not available", text: long })],
  })));
  assert.equal(r.source, "queue");
  assert.equal(r.bucket, "failed");
  // The ledger kept 200 characters. This keeps all of them.
  assert.equal(r.fullText, long);
  assert.equal(r.clipped, true);
  assert.equal(r.cwd, "/dev/myapp");
  assert.equal(refireBlocker(r), null);
});

test("a failed send may be tried again with the link DOWN — reviving it writes nothing", () => {
  const r = only(activityRows(input({
    online: false,
    outbox: [entry({ status: "failed", failedAt: NOW, reason: "gave up" })],
  })));
  assert.equal(r.actions.find((a) => a.id === "sendNow").disabledReason, undefined);
});

// ── A reason is advice for an hour and a record for ever ────────────────────
//
// The host writes the failure reason as an errand ("open the session, clear
// whatever is blocking it, and re-fire") because at that instant it was one.
// The row keeps the sentence for ever — it is the only record of what the
// desktop said and nothing here may edit it — but a row that failed twenty-
// eight days ago was still sending a person to open a session that had not
// existed for weeks.

const ADVICE = "Session never became ready for input. Open the session, clear whatever is blocking it, and re-fire.";

test("a fresh failure's reason is its own words — it is still an errand somebody can run", () => {
  const r = only(activityRows(input({
    intents: [item({ payload: { kind: "prompt", steps: ["ship it"] }, state: "failed",
      createdAt: NOW - 90_000, settledAt: NOW - 60_000,
      result: { at: NOW - 60_000, ok: false, detail: ADVICE } })],
  })));
  assert.equal(r.verdict, ADVICE);
});

test("an old failure's reason is framed as a record, and stops instructing", () => {
  const r = only(activityRows(input({
    intents: [item({ payload: { kind: "prompt", steps: ["ship it"] }, state: "failed",
      createdAt: NOW - 29 * DAY, settledAt: NOW - 28 * DAY,
      result: { at: NOW - 28 * DAY, ok: false, detail: ADVICE } })],
  })));
  assert.match(r.verdict, /recorded when this failed/);
  assert.match(r.verdict, /not something to act on now/);
  // Framed, never rewritten: the stored sentence is the historical fact, and a
  // row that trimmed it would be this screen deciding after the event what the
  // desktop had said.
  assert.ok(r.verdict.includes(ADVICE), "the recorded words survive whole");
});

test("a failed send's reason ages the same way — the queue's rows say it too", () => {
  const fresh = only(activityRows(input({ outbox: [entry({ status: "failed", failedAt: NOW - 60_000, reason: ADVICE })] })));
  assert.equal(fresh.verdict, ADVICE);
  const old = only(activityRows(input({ outbox: [entry({ status: "failed", failedAt: NOW - 3 * DAY, reason: ADVICE })] })));
  assert.match(old.verdict, /not something to act on now/);
  assert.ok(old.verdict.includes(ADVICE));
});

test("a failure nobody gave a reason for is not dressed up as a record of one", () => {
  const r = only(activityRows(input({ outbox: [entry({ status: "failed", failedAt: NOW - 3 * DAY })] })));
  assert.doesNotMatch(r.verdict, /recorded when this failed/);
  assert.match(r.verdict, /nothing here says why/);
});

test("an upload that died is never offered a re-send as words", () => {
  const r = only(activityRows(input({
    outbox: [entry({ mode: "upload", status: "failed", failedAt: NOW, text: "file · shot.jpg", reason: "upload failed" })],
  })));
  assert.equal(r.kind, "upload");
  assert.equal(r.fullText, null);
  assert.match(r.actions.find((a) => a.id === "edit").disabledReason, /no words to rewrite/);
});

// ── The files a row names ───────────────────────────────────────────────────
//
// The complaint that produced these: *"I need to be able to see the images here
// and be able to enlarge them"*, over an Activity list whose file rows read
// `file · 1000074690-mtmw2965bdb334.jpg` — a label, printed as prose, naming no
// path anybody or anything can resolve. `AttachStrip` has drawn exactly this
// since the queue sheet had it; what was missing is which string each source
// hands it, which is the one thing that differs per source and the one thing
// that is silent when it is wrong (an empty strip and a row that still shows no
// picture).

test("an upload row's files come from its UPLOAD, not from its words", () => {
  const r = only(activityRows(input({
    outbox: [entry({
      mode: "upload",
      // What `addOutbox` actually writes for a queued photo: a label, so the
      // queue has something to print. It names no path.
      text: "file · 1000074690-mtmw2965bdb334.jpg",
      upload: { repoId: "r", name: "1000074690-mtmw2965bdb334.jpg", relPath: ".claude/inbox/1000074690-mtmw2965bdb334.jpg", size: 10, type: "image/jpeg" },
    })],
  })));
  assert.equal(r.kind, "upload");
  // The trap: `fullText` and `title` are the label, and passing either would
  // draw nothing for the picture this row IS.
  assert.equal(r.fullText, null);
  assert.match(r.title, /^file · /);
  assert.equal(r.attachText, ".claude/inbox/1000074690-mtmw2965bdb334.jpg");
});

test("a prompt row's files come from its prose, so the paths it mentions resolve", () => {
  const text = "look at .claude/inbox/combined-3-screens-marked-mtmtcrlt93ffb3.png and fix the strip";
  const r = only(activityRows(input({ outbox: [entry({ text })] })));
  assert.equal(r.attachText, text);
  // A create op's prose is its PROMPT, and that is what names the files.
  const c = only(activityRows(input({
    outbox: [entry({ mode: "op", text: "open a session", op: { t: "session.create", prompt: text } })],
  })));
  assert.equal(c.attachText, text);
});

test("an answer, a build and a download name no files at all — and say so", () => {
  const a = only(activityRows(input({
    // Keystrokes, not words: "2\r" is not a text whose file mentions mean
    // anything, and `null` here is what stops an empty strip being rendered.
    outbox: [entry({ text: "2\r", answer: { fingerprint: "f", question: "q?", label: "yes" } })],
  })));
  assert.equal(a.attachText, null);
  const b = only(activityRows(input({
    intents: [buildRun({ id: "b1", payload: { kind: "build", buildId: "b", name: "release", cmd: "./gradlew assembleRelease", cwd: "/dev/myapp" } })],
  })));
  assert.equal(b.attachText, null);
  const d = only(activityRows(input({
    pulls: [{ item: { id: "p1", name: "app.apk", relPath: ".claude/outbox/app.apk", repoDir: "/dev/myapp", size: 100, ts: NOW }, state: "done", received: 100, attempts: 1, updatedAt: NOW }],
  })));
  assert.equal(d.attachText, null);
});

test("the desktop's own rows name their files too — a launch is waiting on them", () => {
  const prompt = "use .claude/inbox/shot.png";
  const l = only(activityRows(input({
    intents: [launch({ id: "l1", payload: { kind: "prompt", steps: [prompt] },
      trigger: { kind: "files", needs: [".claude/inbox/shot.png"], deadlineAt: NOW + 60_000 },
      missing: [".claude/inbox/shot.png"] })],
  })));
  assert.equal(l.attachText, prompt);
  const bl = only(activityRows(input({
    intents: [item({ id: "i1", payload: { kind: "prompt", steps: [prompt] } })],
  })));
  assert.equal(bl.attachText, prompt);
});

// ── Ranking, chips, headline ────────────────────────────────────────────────

test("buckets rank by attention: needs you, failed, running, waiting, scheduled, done", () => {
  const rows = activityRows(input({
    outbox: [
      entry({ ackId: "gone", text: "stranded" }),
      entry({ ackId: "bad", status: "failed", failedAt: NOW, text: "broke" }),
      entry({ ackId: "sending", sessionId: "s2", status: "pending", sentAt: NOW, text: "on the wire" }),
      entry({ ackId: "waiting", sessionId: "s3", text: "next" }),
    ],
    goneLanes: new Set(["s1"]),
    queueBlocked: new Map([["waiting", "held"]]),
    intents: [
      schedule({ id: "sch1", label: "later", target: { kind: "repo" }, nextAt: NOW + 3600e3 }),
      item({ state: "done", settledAt: NOW }),
    ],
  }));
  assert.deepEqual(rows.map((r) => r.bucket), ["needsYou", "failed", "running", "waiting", "scheduled", "done"]);
});

test("the scheduled bucket sorts FORWARDS — the next thing to happen is on top", () => {
  const at1 = (id, at) => schedule({ id, label: id, target: { kind: "repo" },
    trigger: { kind: "at", rule: { kind: "once", at }, graceMin: 0 }, nextAt: at });
  const rows = activityRows(input({ intents: [at1("later", NOW + 7200e3), at1("sooner", NOW + 600e3)] }));
  assert.deepEqual(rows.map((r) => r.id), ["sooner", "later"]);
});

test("compareActivity is a total order the sheet can trust", () => {
  const rows = activityRows(input({ outbox: [entry(), entry({ ackId: "a2", ts: NOW })] }));
  assert.equal(compareActivity(rows[0], rows[0]), 0);
  assert.ok(compareActivity(rows[0], rows[1]) <= 0);
});

test("counts cover every chip, and every chip has a filter that agrees with them", () => {
  const rows = activityRows(input({ outbox: [entry({ status: "failed", failedAt: NOW })] }));
  const counts = activityCounts(rows);
  for (const f of ACTIVITY_FILTERS) {
    assert.equal(counts[f.id], rows.filter((r) => matchesFilter(r, f.id)).length, f.id);
  }
});

test("the headline stays silent rather than inventing reassurance", () => {
  assert.equal(activityHeadline([], true), null);
  const rows = activityRows(input({ online: false, outbox: [entry()] }));
  assert.match(activityHeadline(rows, false), /still on this phone/);
});

// ── `held` names WHICH of laneBusy's three facts it is ──────────────────────

test("a lane held on a question box is `awaitingAnswer` and needs you, not “wait for the turn”", () => {
  const r = only(activityRows(input({
    outbox: [entry({ holdUntilIdle: true })],
    queueBlocked: new Map([["a1", "held"]]),
    sessions: [{ id: "s1", cwd: "/dev/myapp", title: "myapp · main", remoteControl: true, running: true, createdAt: NOW, prompt: { kind: "select", question: "overwrite the branch?", options: [] } }],
  })));
  assert.equal(r.blockReason, "awaitingAnswer");
  assert.equal(r.bucket, "needsYou");
  assert.match(r.verdict, /overwrite the branch/);
  assert.equal(r.actions[0].id, "answer");
  assert.equal(r.actions[0].primary, true);
});

test("a trust prompt is not a question in this sense — delivery auto-accepts it", () => {
  const r = only(activityRows(input({
    outbox: [entry({ holdUntilIdle: true })],
    queueBlocked: new Map([["a1", "held"]]),
    sessions: [{ id: "s1", cwd: "/dev/myapp", title: "t", remoteControl: true, running: true, createdAt: NOW, prompt: { kind: "trust", question: "trust this folder?", options: [] } }],
  })));
  assert.equal(r.blockReason, "sessionBusy");
});

test("a lane held behind a usage limit says so, and is not confused with a busy turn", () => {
  const r = only(activityRows(input({
    outbox: [entry({ holdUntilIdle: true })],
    queueBlocked: new Map([["a1", "held"]]),
    sessions: [{ id: "s1", cwd: "/dev/myapp", title: "t", remoteControl: true, running: true, createdAt: NOW, limit: { blocked: true, blockedSince: NOW, resetAt: null, nextAttemptAt: null, attempts: 0, weekly: false, autoContinue: true, autoContinueOverride: null } }],
  })));
  assert.equal(r.blockReason, "limit");
  assert.match(r.verdict, /usage limit/);
});

// ── Triage: what makes 84 rows a couple of minutes ─────────────────────────
//
// Every rule below is one a bulk button is aimed at, and a bulk button aimed at
// a mis-derived set is the most expensive mistake this app can make. None of
// them throws when it is wrong; each of them quietly acts on the wrong rows.

const dead = (over = {}) => entry({
  ackId: "g1", ts: NOW - 3_600_000, text: "make the settle sweep re-ask the log",
  status: "failed", failedAt: NOW - 3_600_000, reason: "session not available", ...over,
});

test("grouping collapses the same words and says how many", () => {
  const rows = activityRows(input({
    outbox: [
      dead({ ackId: "g1", text: "Continue please" }),
      dead({ ackId: "g2", text: "continue please  " }),
      dead({ ackId: "g3", text: "Continue please." }),
      dead({ ackId: "g4", text: "fix the failing settle test" }),
    ],
  }));
  const groups = groupActivity(rows, rows, { group: true });
  assert.equal(groups.length, 2);
  assert.equal(groups.find((g) => g.rows.length === 3).rows.length, 3);
});

test("case, whitespace and a trailing stop are the ONLY differences that are not differences", () => {
  const same = (a, b) =>
    activityTextKey({ kind: "prompt", fullText: a, title: a, clipped: false })
    === activityTextKey({ kind: "prompt", fullText: b, title: b, clipped: false });
  assert.ok(same("Try again", "try again."));
  assert.ok(same("fix  the   test", "fix the test"));
  // The near-miss that must NOT merge: one word apart is a different request.
  assert.ok(!same("fix the login test", "fix the logout test"));
});

test("a file, a build and a download never group — they are not words", () => {
  for (const kind of ["upload", "build", "download"]) {
    assert.equal(activityTextKey({ kind, fullText: "same", title: "same", clipped: false }), null);
  }
});

test("the fact that decides “already done” is counted against the WHOLE list", () => {
  // The copy that ran is a `done` backlog item — i.e. under a chip somebody
  // triaging failures is not looking at. That is the whole reason `groupActivity`
  // takes the full list beside the filtered one.
  const rows = activityRows(input({
    outbox: [dead({ ackId: "g1", text: "ship the release notes" })],
    intents: [item({ payload: { kind: "prompt", steps: ["ship the release notes"] }, state: "done", createdAt: NOW - 7200_000, settledAt: NOW - 7200_000 })],
  }));
  const failed = rows.filter((r) => matchesFilter(r, "failed"));
  const groups = groupActivity(failed, rows, { group: true });
  assert.equal(groups.length, 1);
  assert.equal(groups[0].elsewhere.done, 1);
  assert.equal(groups[0].rows.length, 1);
});

test("a row in view is never also counted as being somewhere else", () => {
  const rows = activityRows(input({
    outbox: [dead({ ackId: "g1", text: "same words" }), dead({ ackId: "g2", text: "same words" })],
  }));
  const groups = groupActivity(rows, rows, { group: true });
  assert.equal(groups[0].rows.length, 2);
  assert.equal(groups[0].elsewhere.done + groups[0].elsewhere.other, 0);
});

test("with grouping off every row is still a group of one, so the view has one code path", () => {
  const rows = activityRows(input({
    outbox: [dead({ ackId: "g1", text: "same" }), dead({ ackId: "g2", text: "same" })],
  }));
  assert.equal(groupActivity(rows, rows, { group: false }).length, 2);
});

test("a group spans the repos its rows were written for — a bulk send is one work item each", () => {
  const rows = activityRows(input({
    outbox: [
      dead({ ackId: "g1", text: "bump the deps", cwd: "/dev/sampleapp" }),
      dead({ ackId: "g2", text: "bump the deps", cwd: "/dev/newsroom" }),
    ],
  }));
  const g = groupActivity(rows, rows, { group: true })[0];
  assert.deepEqual([...g.cwds].sort(), ["/dev/newsroom", "/dev/sampleapp"]);
});

test("debris is the phrases that name no subject, a bare slash command, and nothing longer", () => {
  const debris = (text, over = {}) =>
    isActivityDebris(activityRows(input({ outbox: [dead({ text, ...over })] }))[0]);
  for (const t of ["Continue please", "done?", "try again", "ok", "??", "/cost", "y"]) {
    assert.ok(debris(t), t);
  }
  // Short is not the rule: a subject is.
  for (const t of ["ship it", "fix the login redirect", "run npm test", "rebase onto main"]) {
    assert.ok(!debris(t), t);
  }
  // A clipped head is not the whole message, so it is never judged as one: a
  // long prompt whose first 260 characters happen to read as debris is not.
  assert.ok(!debris(`ok${" ok".repeat(200)}`));
});

test("oldest-first is a flat age order, and `ranked` leaves the selector's order alone", () => {
  const rows = activityRows(input({
    outbox: [dead({ ackId: "old", ts: NOW - 90_000_000 }), dead({ ackId: "new", ts: NOW - 1000 })],
  }));
  assert.equal(sortActivity(rows, "oldest")[0].id, "old");
  assert.deepEqual(sortActivity(rows, "ranked").map((r) => r.id), rows.map((r) => r.id));
});

// ── Dismissal: a mark, never a delete ──────────────────────────────────────

test("a filed row leaves every chip but its own, and keeps its words and its buttons", () => {
  const rows = activityRows(input({
    outbox: [dead()],
    dismissed: new Map([["queue:g1", NOW - 5000]]),
  }));
  const r = only(rows);
  assert.equal(r.dismissedAt, NOW - 5000);
  assert.equal(r.bucket, "failed");           // still a failure — it was not reclassified
  assert.ok(r.title.length > 0);
  assert.ok(r.actions.length > 0);
  assert.equal(matchesFilter(r, "failed"), false);
  assert.equal(matchesFilter(r, "all"), false);
  assert.equal(matchesFilter(r, "dismissed"), true);
  const counts = activityCounts(rows);
  assert.equal(counts.all, 0);
  assert.equal(counts.failed, 0);
  assert.equal(counts.dismissed, 1);
});

test("counts still agree with the filters once something is filed", () => {
  const rows = activityRows(input({
    outbox: [dead({ ackId: "g1" }), dead({ ackId: "g2" })],
    dismissed: new Map([["queue:g1", NOW]]),
  }));
  const counts = activityCounts(rows);
  for (const f of ACTIVITY_FILTERS) {
    assert.equal(counts[f.id], rows.filter((r) => matchesFilter(r, f.id)).length, f.id);
  }
});

test("the standing sentence stops counting rows the user has dealt with", () => {
  const rows = activityRows(input({ outbox: [dead()], dismissed: new Map([["queue:g1", NOW]]) }));
  assert.equal(activityHeadline(rows, true), null);
});

test("a filed row is not evidence that anything ran", () => {
  const rows = activityRows(input({
    outbox: [dead({ ackId: "g1", text: "same words" })],
    intents: [item({ payload: { kind: "prompt", steps: ["same words"] }, state: "done", settledAt: NOW })],
    dismissed: new Map([["intent:b1", NOW]]),
  }));
  const failed = rows.filter((r) => matchesFilter(r, "failed"));
  assert.equal(groupActivity(failed, rows, { group: true })[0].elsewhere.done, 0);
});

// ── Who a bulk button may act on ───────────────────────────────────────────

test("a bulk re-fire reads the row's OWN verdict rather than deciding a second time", () => {
  // An ANSWER is a keystroke bound to one question box, so `queueRow` already
  // refuses to aim it anywhere else; the bulk path reads that answer rather
  // than reaching its own.
  const bound = only(activityRows(input({
    outbox: [dead({ answer: { fingerprint: "f", question: "which branch?", label: "the existing one" } })],
  })));
  assert.equal(refireBlocker(bound), bound.actions.find((a) => a.id === "sendNow").disabledReason ?? null);
  const live = only(activityRows(input({ outbox: [dead()] })));
  assert.equal(refireBlocker(live), null);
});

test("a row still on its way is refused a bulk re-fire, and says that is why", () => {
  const r = only(activityRows(input({ outbox: [entry()] })));
  assert.match(refireBlocker(r), /has not failed/);
});

test("a failed queue row can go again; a row with no repo cannot, and says so", () => {
  const ok = only(activityRows(input({ outbox: [entry({ status: "failed", failedAt: NOW })] })));
  assert.equal(refireBlocker(ok), null);
  const noRepo = only(activityRows(input({ outbox: [entry({ status: "failed", failedAt: NOW, cwd: "" })] })));
  assert.match(refireBlocker(noRepo), /which repo/);
});

test("host-owned rows are never bulk re-fired from here — they are run where they live", () => {
  const r = only(activityRows(input({
    intents: [schedule({ target: { kind: "repos", dirs: ["/dev/sampleapp"] } })],
  })));
  assert.match(refireBlocker(r), /lives on the desktop/);
});

test("running work may not be filed away — stopping it is a different button", () => {
  const r = only(activityRows(input({ outbox: [entry({ status: "pending", sentAt: NOW })] })));
  assert.match(dismissBlocker(r), /running/);
  const failed = only(activityRows(input({ outbox: [entry({ status: "failed", failedAt: NOW })] })));
  assert.equal(dismissBlocker(failed), null);
});

test("a partition keeps the skipped rows AND the reason each of them gave", () => {
  const rows = activityRows(input({
    outbox: [entry({ ackId: "a1", status: "failed", failedAt: NOW }), entry({ ackId: "a2" })],
  }));
  const { go, skip } = partitionBulk(rows, refireBlocker);
  assert.equal(go.length, 1);
  assert.equal(skip.length, 1);
  assert.ok(skip[0].why.length > 0);
});

// ── The sentence in front of the most dangerous button in the app ──────────

test("a bulk confirmation states the count, the repos and a sample of the real words", () => {
  const rows = activityRows(input({
    outbox: [
      dead({ ackId: "g1", text: "one", cwd: "/dev/sampleapp" }),
      dead({ ackId: "g2", text: "two", cwd: "/dev/sampleapp" }),
      dead({ ackId: "g3", text: "three", cwd: "/dev/newsroom" }),
      dead({ ackId: "g4", text: "four", cwd: "/dev/newsroom" }),
    ],
  }));
  const lines = bulkLines(rows, { verb: "dismiss", repoName: (c) => c.split("/").pop() });
  assert.match(lines[0], /^4 rows/);
  assert.ok(lines.some((l) => /Nothing is deleted/.test(l)), "it says what it does NOT do");
  assert.ok(lines.some((l) => /sampleapp 2/.test(l) && /newsroom 2/.test(l)), "it names the repos and their counts");
  assert.equal(lines.filter((l) => l.startsWith("“")).length, 3, "three samples, not eighty-four");
  assert.ok(lines.some((l) => /and 1 more/.test(l)));
});

test("a re-fire confirmation says where the words go, and never claims nothing is lost", () => {
  const rows = activityRows(input({ outbox: [dead()] }));
  const lines = bulkLines(rows, { verb: "refire", repoName: (c) => c.split("/").pop(), skipped: 2 });
  // The vocabulary, pinned. `work item` named the retired shared `backlog ·
  // <repo>` conversation and is not a word this app uses any more; `backlog
  // item` is the row, and `a new session` is where it runs. A reword here is a
  // decision about the app's vocabulary and edits this test in the same change.
  assert.match(lines[0], /backlog items/);
  assert.ok(!lines.some((l) => /work item/.test(l)), "the retired noun is gone from the confirmation");
  assert.ok(lines.some((l) => /each in a new session/.test(l)), "it says where they run, now that it is not one shared session");
  assert.ok(!lines.some((l) => /Nothing is deleted/.test(l)));
  assert.ok(lines.some((l) => /2 of the selected rows are left alone/.test(l)));
});

test("a row with no repo is counted as such rather than dropped from the confirmation", () => {
  const rows = activityRows(input({ outbox: [dead({ cwd: "" })] }));
  const lines = bulkLines(rows, { verb: "dismiss", repoName: (c) => c });
  assert.ok(lines.some((l) => /no repo recorded 1/.test(l)));
});

// ── Which failed row "Restore" is allowed to put back ───────────────────────
//
// Reported from a phone on a bad link: an image upload died, and the recovery
// bar's Restore then offered to send `file · 1000074239-….jpg` — the NAME of the
// picture that had just failed to arrive, as a prompt. Ops were excluded from
// that pick for exactly this reason and uploads were not, so the label of a
// dead file was treated as text somebody had written.

test("Restore never offers an upload's label as a message", async () => {
  const { restorableFailed, onlyUploadsFailed } = await import("./activityRows.ts");
  const rows = [
    { ackId: "u1", status: "failed", mode: "upload", text: "file · 1000074239-mtepifb76e8d47.jpg" },
    { ackId: "p1", status: "failed", mode: "input", text: "what do you make of this .claude/inbox/1000074239-mtepifb76e8d47.jpg" },
  ];
  assert.equal(restorableFailed(rows).ackId, "p1", "the words, not the filename");
  assert.equal(onlyUploadsFailed(rows), false);
});

test("with only a dead upload, Restore has nothing to put in a box", async () => {
  const { restorableFailed, onlyUploadsFailed } = await import("./activityRows.ts");
  // The prompt got through and the picture did not — so there is no text to
  // restore, and the honest next step is the attachment's own re-attach button.
  const rows = [{ ackId: "u1", status: "failed", mode: "upload", text: "file · x.jpg" }];
  assert.equal(restorableFailed(rows), null);
  assert.equal(onlyUploadsFailed(rows), true);
});

test("ops stay excluded, and an op beside an upload is still nothing to restore", async () => {
  const { restorableFailed, onlyUploadsFailed } = await import("./activityRows.ts");
  const rows = [
    { ackId: "o1", status: "failed", mode: "op", text: "open myapp · main" },
    { ackId: "u1", status: "failed", mode: "upload", text: "file · x.jpg" },
  ];
  assert.equal(restorableFailed(rows), null);
  assert.equal(onlyUploadsFailed(rows), false, "an op is not a file — the message must not claim it is");
});

test("the NEWEST prose row is the one offered", async () => {
  const { restorableFailed } = await import("./activityRows.ts");
  const rows = [
    { ackId: "p1", status: "failed", mode: "input", text: "older" },
    { ackId: "u1", status: "failed", mode: "upload", text: "file · x.jpg" },
    { ackId: "p2", status: "failed", mode: "input", text: "newer" },
    { ackId: "p3", status: "queued", mode: "input", text: "not failed" },
  ];
  assert.equal(restorableFailed(rows).ackId, "p2");
});

// ── WHERE a work row is going ───────────────────────────────────────────────
//
// A repo target rendered as the bare repo name, which was true of three
// different destinations at once — the repo's shared backlog conversation, a
// session opened for this item, a `--continue` of the last one. There is one
// destination now, and the row says WHICH conversation instead of leaving the
// reader to work it out from a name they already know.

test("a repo row says it opens a conversation of its own", () => {
  const r = only(activityRows(input({ intents: [intent({ target: { kind: "repo", fresh: true } })] })));
  assert.equal(r.where, "myapp · in a new session");
});

test("`picking up the last conversation` is said, because it is what it costs", () => {
  const r = only(activityRows(input({ intents: [intent({ target: { kind: "repo", fresh: true }, resume: true })] })));
  assert.equal(r.where, "myapp · picking up the last conversation");
});

test("once it HAS a session, the session's own title wins", () => {
  // The fragments describe a row before it runs, which is most of the life of a
  // queued one. A running row has a real session, and naming it is what makes
  // the row tappable through to a terminal.
  const r = only(activityRows(input({
    intents: [intent({ state: "running", sessionId: "s9", target: { kind: "repo", fresh: true }, resume: true })],
    sessions: [{ id: "s9", title: "backlog · myapp · export button", cwd: "/dev/myapp", running: true }],
  })));
  assert.equal(r.where, "backlog · myapp · export button");
});

test("a row aimed at a live session names the session, not its repo", () => {
  const r = only(activityRows(input({
    intents: [intent({ target: { kind: "session", sessionId: "s2" } })],
    sessions: [{ id: "s2", title: "fix-e2e", cwd: "/dev/myapp", running: true }],
  })));
  assert.equal(r.where, "in fix-e2e");
});

// ── The smart pick: a row held for a look, and a row a look wrote ────────────
//
// The feature applies itself — sort, merge and pick, with no approval step —
// which the user chose with the two CLAUDE.md rules it cuts against in view.
// What the rules still buy is that nothing is destroyed and that every row says
// what happened to it, and this screen is half of the second half: Activity is
// where a person looks when something is taking longer than they expected, and
// the two questions it has to answer are "why is this one not running" and "did
// I write these words".

test("a row held for the look is `picking`, with the shared sentence and nothing to press", () => {
  // The sentence is `@waterplane/shared`'s (`intentReasonText`), not a second copy
  // here: the host writes the same words into the backlog sheet's `waiting`
  // map, and two of them is two chances for one to stop being true.
  const r = only(activityRows(input({
    intents: [intent({ id: "p1", state: "blocked", blockReason: "picking" })],
  })));
  assert.equal(r.blockReason, "picking");
  assert.match(r.verdict, /looking over this repo's waiting items before picking the next one/);
  // A WAIT, not a decision waiting on a person: the look releases the row
  // itself, on its own watchdog, and there is nothing on this screen to press.
  assert.equal(r.bucket, "waiting");
});

test("`picking` sorts below every wait a person could act on, and above none", () => {
  // The shared ladder is ordered by what the user can DO about it, and this is
  // the bottom of it: a row held for a two-second look is the least interesting
  // waiting row on the screen.
  const rows = sortActivity(activityRows(input({
    intents: [
      intent({ id: "p1", state: "blocked", blockReason: "picking" }),
      intent({ id: "p2", state: "blocked", blockReason: "serial" }),
    ],
  })));
  assert.deepEqual(rows.map((r) => r.id), ["p2", "p1"]);
});

test("a row the smart pick wrote says so, beside where it is going", () => {
  // Same place `resume` puts its fragment, and for the same reason: this is a
  // fact about where the WORDS came from. It is deliberately not in the title —
  // the title is the item's own prose, and a machine's sentence with a label
  // stuck on the front reads as a person's.
  const r = only(activityRows(input({
    intents: [intent({ origin: "smartpick:pass7", target: { kind: "repo", fresh: true } })],
  })));
  assert.equal(r.where, "myapp · in a new session · written by the smart pick");
  assert.equal(r.title, "add the export button");
});

test("an ordinary item is not credited to the smart pick, and neither is a fan-out child", () => {
  const plain = only(activityRows(input({ intents: [intent({ target: { kind: "repo", fresh: true } })] })));
  assert.equal(plain.where, "myapp · in a new session");
  // `origin` is a busy field — fan-out, rescue, retry, schedule all write it —
  // so the marker is matched as a PREFIX of its own and never as "has an
  // origin at all".
  const swept = activityRows(input({ intents: sweep([{ cwd: "/dev/other", title: "other", state: "queued" }]) }));
  for (const r of swept) assert.ok(!/written by the smart pick/.test(r.where ?? ""), r.where);
});

// ── *run it now* on a rule that QUEUES a backlog item ────────────────────────
//
// A standing rule whose action is "add a work item" (`origin: schedule:work`)
// is repo-targeted, but running it only adds a row that waits its turn. The
// skip-the-queue sentence and the *start a second?* confirm promised the
// opposite of what the tap does.
test("run it now on a rule that queues a backlog item says so, and never asks", () => {
  const rule = intent({
    id: "r1", origin: "schedule:work", label: "nightly",
    trigger: { kind: "at", rule: { kind: "daily", hour: 3, minute: 0 }, graceMin: 60 },
    target: { kind: "repo", fresh: true }, nextAt: NOW + 3600e3,
  });
  const busy = intent({ id: "b1", state: "running" });
  const rows = activityRows(input({ intents: [rule, busy] }));
  const run = rows.find((r) => r.id.endsWith("r1")).actions.find((a) => a.id === "runNow");
  assert.equal(run.note, "queues an item in its backlog — it runs in turn");
  assert.equal(run.confirm, undefined, "a queued child starts no second agent");
  // A plain repo row into the same busy checkout SAYS it starts a second agent
  // — and still never asks: a fire is the manual override, one tap, always.
  const plain = activityRows(input({ intents: [intent({ id: "p1", state: "failed", settledAt: NOW }), busy] }))
    .find((r) => r.id.endsWith("p1")).actions.find((a) => a.id === "sendNow");
  assert.match(plain.note, /skips the queue/);
  assert.match(plain.note, /another agent is working in this checkout — this starts a second one beside it$/);
  assert.equal(plain.confirm, undefined, "one tap fires — the consequence is text, not a question");
});
