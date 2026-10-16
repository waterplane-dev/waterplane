// The pure Intent rule (`shared/src/intent.ts`) — the ladder that decides
// whether one durable "do this, there, when that is true" may run yet.
//
// Everything here runs against `shared/dist` with no host, no filesystem and no
// clock: `intentVerdict` takes `now` as a parameter, which is exactly what lets
// the ladder be pinned before there is a manager to run it.
import test from "node:test";
import assert from "node:assert/strict";
import {
  busyIntentGroups,
  intentSerialHolders,
  serialHolders,
  serialLead,
  serialWaitText,
  SERIAL_WAIT_TEXT,
  cleanIntentRow,
  isBacklogRow,
  isScheduleRow,
  isTimedWorkRow,
  needsSlot,
  reopensConversation,
  liveConvSession,
  timedWorkKey,
  ORIGIN_FANOUT_TARGET,
  scheduleIdFromOrigin,
  scheduleItemOrigin,
  INTENT_BLOCK_ORDER,
  REQUEUE_KEEP,
  intentKind,
  intentReasonText,
  intentVerdict,
  serialGroup,
  budgetPassAt,
  budgetPassOf,
  budgetLeftoverOf,
  budgetAfterResetOf,
  cleanBudgetWaiver,
  describeRule,
  budgetWaived,
  budgetWaiverUntil,
  RESET_MATCH_MS,
  MANUAL_HOLD_TEXT,
  isAgentPosted,
  autoSlotsBusy, autoSlotsWaitText,
  closeWhenDoneOf,
  closeWhenDoneSetting,
} from "../dist/index.js";

const NOW = 1_700_000_000_000;
const MIN = 60_000;

const intent = (over = {}) => ({
  id: "i1",
  cwd: "/repo",
  payload: { kind: "prompt", steps: ["do the thing"] },
  target: { kind: "session", sessionId: "s1" },
  trigger: { kind: "now" },
  state: "queued",
  createdAt: NOW - 10 * MIN,
  ...over,
});

const facts = (over = {}) => ({
  present: new Set(),
  sessions: [],
  repoSession: new Map(),
  busyCwds: new Set(),
  busySessions: new Set(),
  budgetBlocked: false,
  autoFire: true,
  knownDirs: new Set(),
  hostBusy: false,
  // One slot free by default: the cap is a rung the tests that are about it
  // reach for, and every other test would otherwise be quietly testing it.
  autoSlotsFree: 1,
  ...over,
});

const session = (over = {}) => ({ id: "s1", cwd: "/repo", running: true, ...over });

// ── 1. The order IS the specification ────────────────────────────────────────

test("a row blocked four ways reports the highest rung, not the nearest one", () => {
  // Simultaneously: gated (auto work, switch off), over the usage budget,
  // serialized behind a busy worktree, and aimed at a session mid-turn.
  //
  // Why the order matters, in the user's terms: three of these four are
  // unknowable until the switch is flipped. Reporting "the session is working"
  // to someone whose auto-fire is off sends them to look at a session that was
  // never going to be typed into — the sentence is true and useless. The ladder
  // is ordered by what a person can DO about it, and by how much of the rest
  // each rung makes moot.
  const i = intent({ auto: true, serial: true });
  const world = {
    autoFire: false,
    budgetBlocked: true,
    busyCwds: new Set([serialGroup("/repo")]),
    sessions: [session({ turnActive: true })],
  };

  assert.equal(intentVerdict(i, facts(world), NOW).reason, "gate");
  // Flip the switch: the ACCOUNT is the next thing that is true of every row at
  // once, so it outranks anything about this one item's position.
  assert.equal(intentVerdict(i, facts({ ...world, autoFire: true }), NOW).reason, "budget");
  // Budget clear: the worktree is taken. Rung 4 sits above the target's own
  // state because a serialized intent is not going to be attempted at all.
  assert.equal(
    intentVerdict(i, facts({ ...world, autoFire: true, budgetBlocked: false }), NOW).reason,
    "serial",
  );
  // And only then the session itself.
  assert.equal(
    intentVerdict(i, facts({ ...world, autoFire: true, budgetBlocked: false, busyCwds: new Set() }), NOW).reason,
    "sessionBusy",
  );
});

test("the trigger rung sits above the target rung", () => {
  // An intent that is not due yet must say so even though its session is also
  // busy: everything below rung 3 describes a run that is not being attempted.
  const i = intent({ trigger: { kind: "at", rule: { kind: "once", at: NOW + MIN }, graceMin: 120 }, nextAt: NOW + MIN });
  const v = intentVerdict(i, facts({ sessions: [session({ turnActive: true })] }), NOW);
  assert.equal(v.kind, "wait");
  assert.equal(v.reason, "notYet");
});

test("a clear ladder ends in go, carrying the resolved session", () => {
  const v = intentVerdict(intent(), facts({ sessions: [session()] }), NOW);
  assert.deepEqual(v, { kind: "go", sessionId: "s1", occurrence: undefined, late: undefined });
});

// ── 2. files: presence before the deadline ───────────────────────────────────

test("a file that lands one second early opens the session, not one second late", () => {
  // The same rule, and the same reason, as `launchVerdict`: presence is checked
  // BEFORE the deadline, so a file arriving on the deadline tick opens the
  // session rather than being expired by the very tick that would have opened it.
  const i = intent({
    target: { kind: "repo", fresh: true },
    trigger: { kind: "files", needs: [".claude/inbox/shot.jpg"], deadlineAt: NOW },
  });
  assert.equal(intentVerdict(i, facts({ present: new Set([".claude/inbox/shot.jpg"]) }), NOW).kind, "go");

  const gone = intentVerdict(i, facts(), NOW);
  assert.equal(gone.kind, "fail");
  assert.deepEqual(gone.missing, [".claude/inbox/shot.jpg"]);
  assert.match(gone.detail, /shot\.jpg never arrived/);
});

test("a files trigger names what is still outstanding, by file name", () => {
  const i = intent({
    trigger: { kind: "files", needs: ["a.png", ".claude/inbox/b.png"], deadlineAt: NOW + 60 * MIN },
  });
  const v = intentVerdict(i, facts({ present: new Set(["a.png"]) }), NOW);
  assert.equal(v.kind, "wait");
  assert.equal(v.reason, "filesMissing");
  assert.deepEqual(v.missing, [".claude/inbox/b.png"]);
  assert.equal(v.detail, "waiting for b.png to finish uploading");
});

// ── 3. at: the grace window, once vs recurring ───────────────────────────────

const weekly = { kind: "weekly", days: [4], hour: 18, minute: 0 };

const at = (nextAt, over = {}) =>
  intent({
    target: { kind: "shell" },
    payload: { kind: "build", buildId: "b1" },
    trigger: { kind: "at", rule: weekly, graceMin: 120, ...over },
    nextAt,
  });

test("an at trigger that has not come round is notYet, and carries NO wall clock", () => {
  const v = intentVerdict(at(NOW + 5 * MIN), facts(), NOW);
  assert.equal(v.kind, "wait");
  assert.equal(v.reason, "notYet");
  // The sentence is written on the host and read on a phone, so a date
  // formatted HERE is formatted in the wrong locale: one card carried
  // "Do., 10. Sept., 21:52" and "9/10/2026, 9:52:00 PM" for one instant. The
  // instant travels as a NUMBER (`nextAt`, `occurrence`) and every surface
  // prints it itself.
  assert.match(v.detail, /^not due yet/);
  assert.doesNotMatch(v.detail, /\d{1,2}[:/.]\d{2}/);
});

test("due now runs, and is not called late", () => {
  const v = intentVerdict(at(NOW), facts(), NOW);
  assert.equal(v.kind, "go");
  assert.equal(v.occurrence, NOW);
  assert.equal(v.late, undefined);
});

test("late but inside the grace window runs, and says it ran late", () => {
  // The host is a desktop that sleeps. An occurrence that passed while the
  // machine was shut is normally still worth running — but the row has to say
  // so, because "it ran" and "it ran two hours after you asked" are different
  // facts. Under a minute is on time as far as anyone reading the row cares.
  const onTime = intentVerdict(at(NOW - 30_000), facts(), NOW);
  assert.equal(onTime.kind, "go");
  assert.equal(onTime.late, undefined);

  const v = intentVerdict(at(NOW - 90 * MIN), facts(), NOW);
  assert.equal(v.kind, "go");
  assert.equal(v.occurrence, NOW - 90 * MIN);
  assert.equal(v.late, true);
});

test("past the grace window a one-off fails, saying it was missed and by how much", () => {
  const once = at(NOW - 200 * MIN, { rule: { kind: "once", at: NOW - 200 * MIN } });
  const v = intentVerdict(once, facts(), NOW);
  assert.equal(v.kind, "fail");
  // The grace is a DURATION somebody configured and reads the same in every
  // locale; the instant it missed does not go in the string (see above).
  assert.equal(v.detail, "missed — more than 120 min past its time, and it could not start in time");
  assert.doesNotMatch(v.detail, /\d{1,2}[:/.]\d{2}/);
  // It does NOT say the desktop was down, which is what it used to say and
  // could not know: a row can spend its whole grace awake and held on `serial`,
  // `hostBusy`, `noSlot` or `budget`, and the old sentence sent the person off
  // to look at a machine that had been running the entire time.
  assert.doesNotMatch(v.detail, /desktop/);
});

test("past the grace window a recurring rule skips the occurrence — never a late go", () => {
  // A laptop opened on Saturday must not fire Thursday's sweep. The row keeps
  // standing (it is standing policy, not a one-shot), the blown occurrence is
  // handed back so the manager can record it as MISSED, and the verdict is
  // never `go`: silently advancing would leave a row that looks like it fired.
  const due = NOW - 200 * MIN;
  const v = intentVerdict(at(due), facts(), NOW);
  assert.equal(v.kind, "wait");
  assert.equal(v.reason, "notYet");
  assert.equal(v.missedOccurrence, due);
  assert.match(v.detail, /^missed — /);
});

test("a switched-off recurring rule is a gate, not a clock problem", () => {
  // `nextAt === null` is the explicit "nothing is armed" — distinct from
  // `undefined`, which only means the manager has not computed one yet.
  const v = intentVerdict(at(null), facts(), NOW);
  assert.equal(v.kind, "wait");
  assert.equal(v.reason, "gate");
  assert.match(v.detail, /switched off/);
});

// ── 3b. the two exemptions the backlog's own flags became ────────────────────

test("a row set aside is a gate above everything, and says so in one sentence", () => {
  // `archived` was the backlog's "hide it, keep it" and it is a GATE, not a
  // deletion and not a session problem: reporting the session it is not waiting
  // for would be noise about a row nobody is waiting on.
  const world = facts({ sessions: [session({ turnActive: true })], budgetBlocked: true });
  const v = intentVerdict(intent({ archived: true, auto: true }), world, NOW);
  assert.equal(v.reason, "gate");
  assert.match(v.detail, /set aside/i);
});

test("a manual row (an agent's backlog add) never passes the ladder, auto on or not, and survives a clean", () => {
  // Auto ON and nothing else in the way: the only thing holding it is `manual`.
  const world = facts({ autoFire: true });
  for (const over of [{ auto: true }, { auto: true, pinned: true }, { auto: false }]) {
    const v = intentVerdict(intent({ manual: true, ...over }), world, NOW);
    assert.equal(v.reason, "gate", JSON.stringify(over));
    assert.equal(v.detail, MANUAL_HOLD_TEXT);
  }
  assert.equal(cleanIntentRow(intent({ manual: true }), NOW).manual, true);
  assert.equal(cleanIntentRow(intent({ manual: "yes" }), NOW).manual, undefined, "strictly === true");
  assert.equal(isAgentPosted({ origin: "agent" }), true);
  assert.equal(isAgentPosted({ origin: "agent:x" }), false, "exact, never a prefix");
});

test("work aimed at one session by hand is exempt from the auto-fire switch, not from the budget", () => {
  // The backlog's per-item `autoFire` flag: "queue this for THAT session" was a
  // tap, so the switch that routes machinery has no say in it — but the switch
  // is about machinery and the budget is about the ACCOUNT, and an account over
  // its ceiling is over it for everyone.
  const off = facts({ autoFire: false, sessions: [session()] });
  assert.equal(intentVerdict(intent({ auto: true }), off, NOW).reason, "gate");
  assert.equal(intentVerdict(intent({ auto: true, pinned: true }), off, NOW).kind, "go");
  const broke = facts({ budgetBlocked: true, sessions: [session()] });
  assert.equal(intentVerdict(intent({ auto: true, pinned: true }), broke, NOW).reason, "budget");
});

test("an interjecting row may enter a session another intent holds — nothing else may", () => {
  // One intent at a time per session is what stops a repo's queued work from
  // stacking two prompts in one composer. A fan-out FOLLOW-UP is the next turn
  // of the same sweep, in a session that very run opened and is still holding:
  // without the exemption it queues behind its own target and, on a session
  // with no hook pipe, waits for ever.
  const world = facts({ sessions: [session()], busySessions: new Set(["s1"]) });
  assert.equal(intentVerdict(intent(), world, NOW).reason, "sessionBusy");
  assert.equal(intentVerdict(intent({ interject: true }), world, NOW).kind, "go");
});

// ── 4. budget holds machinery, never a person ────────────────────────────────

test("the budget holds auto work and never a person's own tap", () => {
  // The ceiling exists to stop UNATTENDED work short of the usage wall. A
  // person spending the remaining budget is exactly what the remaining budget
  // is for — the same exemption `selectSendable` gives an `armed` entry.
  const world = facts({ budgetBlocked: true, sessions: [session()] });
  assert.equal(intentVerdict(intent({ auto: true }), world, NOW).reason, "budget");
  assert.equal(intentVerdict(intent(), world, NOW).kind, "go");
});

test("a hand-posted row is not budget-held even when queued", () => {
  // This is a PIN on a regression that was in the tree, not a new rule. Rung 2
  // was briefly widened from `i.auto` to "budget-blocked and not already failed
  // or canceled", which reads like tidying and is not: the ceiling exists to
  // stop UNATTENDED work short of the usage wall, and a person spending what is
  // left of the budget is the entire purpose of what is left of the budget.
  //
  // The widening was also a no-op for the thing it named — terminal rows never
  // reach the ladder at all, the tick filters them out first — so every row it
  // actually changed was a person's own, held for a reason that was never about
  // them. It broke the test above without anyone running the unit suite.
  //
  // So: a hand-posted row (no `auto`) is exempt in EVERY state the ladder can
  // see, which is what makes "queued" not a synonym for "machinery".
  const world = facts({ budgetBlocked: true, sessions: [session()] });
  for (const state of ["queued", "blocked", "starting", "running"]) {
    assert.equal(intentVerdict(intent({ state }), world, NOW).kind, "go", `${state} is still a person's row`);
  }
  // And the flag is the whole discriminator — same rows, `auto` set, all held.
  for (const state of ["queued", "blocked", "starting", "running"]) {
    assert.equal(intentVerdict(intent({ state, auto: true }), world, NOW).reason, "budget", `auto ${state} is machinery`);
  }
});

test("a budget TRIGGER holds a manual intent too — the wait is the one they picked", () => {
  // Rung 2 exempts a person; rung 3 does not, because choosing "when the window
  // allows" IS the person asking to be held. Falling through here would make
  // the trigger a no-op for exactly the intents that name it.
  const i = intent({ trigger: { kind: "budget" } });
  assert.equal(intentVerdict(i, facts({ budgetBlocked: true, sessions: [session()] }), NOW).reason, "budget");
  assert.equal(intentVerdict(i, facts({ sessions: [session()] }), NOW).kind, "go");
});

// ── 5. serial is per WORKTREE ────────────────────────────────────────────────

test("two worktrees of one repo stay independent", () => {
  // A worktree is a separate checkout, and making one per task is exactly how
  // this app already runs work in parallel safely. Two sessions in two
  // worktrees cannot write over each other, so they are not each other's
  // business — the only thing they share is the usage limit, and that is a
  // knob, not a rule.
  const busy = facts({ busyCwds: new Set([serialGroup("/repo")]), sessions: [session({ id: "s2", cwd: "/repo-wt" })] });
  const here = intent({ serial: true, target: { kind: "session", sessionId: "s2" }, cwd: "/repo" });
  const there = { ...here, cwd: "/repo-wt" };

  assert.equal(intentVerdict(here, busy, NOW).reason, "serial");
  assert.equal(intentVerdict(there, busy, NOW).kind, "go");
});

// ── 4.5 holdForHost is host-wide, and opt-in ─────────────────────────────────

test("holdForHost waits on ANY other work, even in an unrelated repo", () => {
  // The exact shape the ticket was about: a `repo`-with-`fresh` target passes
  // straight through rung 5 (nothing exists yet for it to see as busy), so
  // several such intents due in the SAME tick, each in its own repo, would
  // each read the world as idle and each fire — unless they opted into this.
  const world = facts({ hostBusy: true });
  const gated = intent({ holdForHost: true, target: { kind: "repo", fresh: true }, cwd: "/repo-a" });
  const ungated = { ...gated, holdForHost: false, cwd: "/repo-b" };

  assert.equal(intentVerdict(gated, world, NOW).reason, "hostBusy");
  // No opt-in: the host being busy elsewhere is none of this row's business,
  // same as it always was before this rung existed.
  assert.equal(intentVerdict(ungated, world, NOW).kind, "go");
  assert.equal(intentVerdict(gated, facts({ hostBusy: false }), NOW).kind, "go");
});

test("serial outranks holdForHost — the more specific reason wins", () => {
  // Both true at once: this row's OWN repo is busy, and so is the host in
  // general. The repo-scoped answer is the one that tells the reader
  // something they could not already guess from the host-wide one.
  const i = intent({
    serial: true, holdForHost: true,
    target: { kind: "repo", fresh: true }, cwd: "/repo",
  });
  const world = facts({ busyCwds: new Set([serialGroup("/repo")]), hostBusy: true });
  assert.equal(intentVerdict(i, world, NOW).reason, "serial");
});

// ── 4.6 the slot cap is a rung now ───────────────────────────────────────────

test("the slot cap holds automatic work and nothing else", () => {
  // The cap has always meant one thing — at most N `claude` processes opened by
  // machinery at once — and it used to live inside the host as a refusal string
  // that a row wore as `blockDetail`. Now every backlog item opens its own
  // session, so it is a rung: same meaning, on the ladder, with a sentence.
  //
  // What it bounds is what SPAWNS. A row aimed at a session that already exists
  // opens nothing and is none of the cap's business, or a full desktop would
  // stop work that costs it no process at all.
  const full = facts({ autoSlotsFree: 0, sessions: [session()] });
  const fresh = intent({ auto: true, target: { kind: "repo", fresh: true } });

  const held = intentVerdict(fresh, full, NOW);
  assert.equal(held.reason, "noSlot");
  assert.match(held.detail, /free slot/);
  // A slot opens, the same row goes.
  assert.equal(intentVerdict(fresh, facts({ autoSlotsFree: 1 }), NOW).kind, "go");
  // Aimed at a live session: nothing is opened, so nothing is counted.
  assert.equal(intentVerdict(intent({ auto: true }), full, NOW).kind, "go");
  // A sweep spawns too, and keeps its OWN pool — one bound per kind of spawn.
  assert.equal(
    intentVerdict(intent({ auto: true, target: { kind: "repos", dirs: ["/a"] } }), facts({ autoSlotsFree: 0, knownDirs: new Set(["/a"]) }), NOW).kind,
    "go",
  );
});

test("a person's own fresh session ignores the cap — it was never about their tap", () => {
  // The same exemption shape as the gate and the budget, for the same reason:
  // a cap written for unattended work is not a statement about someone who just
  // pressed send, and refusing that tap with "the desktop is full" would teach
  // them to open the session themselves every time — which spends the slot
  // anyway, with none of the bookkeeping.
  const full = facts({ autoSlotsFree: 0 });
  const byHand = intent({ target: { kind: "repo", fresh: true } });
  assert.equal(intentVerdict(byHand, full, NOW).kind, "go");
  assert.equal(intentVerdict({ ...byHand, auto: true }, full, NOW).reason, "noSlot");
});

test("the three waits above rung 5 report in order: serial, then hostBusy, then noSlot", () => {
  // All three true at once, and the order is the specification. It runs from
  // the most specific reason to the most general: this row's own repo is taken
  // (something the reader can go and look at), then the opt-in host-wide hold
  // they asked for, then the desktop's budget of automatic sessions — which is
  // true of every such row at once and says the least about this one.
  const world = facts({ busyCwds: new Set([serialGroup("/repo")]), hostBusy: true, autoSlotsFree: 0 });
  const all = intent({ auto: true, serial: true, holdForHost: true, target: { kind: "repo", fresh: true } });

  assert.equal(intentVerdict(all, world, NOW).reason, "serial");
  assert.equal(intentVerdict({ ...all, serial: false }, world, NOW).reason, "hostBusy");
  assert.equal(intentVerdict({ ...all, serial: false, holdForHost: false }, world, NOW).reason, "noSlot");
  // And with the cap lifted the row is simply due — a fresh target has no
  // session readiness to wait on, opening one IS the work.
  assert.equal(intentVerdict({ ...all, serial: false, holdForHost: false }, facts({ autoSlotsFree: 2 }), NOW).kind, "go");
});

test("busyIntentGroups counts both sources and keys them the same way", () => {
  const sessions = [
    session({ id: "a", cwd: "/one", turnActive: true, automatic: true }),   // mid-turn
    session({ id: "b", cwd: "/two", automatic: true }),                     // idle
    session({ id: "c", cwd: "/three", running: false, turnActive: true, automatic: true }), // ended — not busy
    session({ id: "d", cwd: "/four", limitBlocked: true, automatic: true }), // quiet, but unable to run
  ];
  const groups = busyIntentGroups(sessions, ["/five"]); // an intent is starting in /five
  assert.deepEqual(
    [...groups].sort(),
    [serialGroup("/five"), serialGroup("/four"), serialGroup("/one")].sort(),
  );
});

// The owner's rule: no parallel CODING by queued work, an idle automatic
// predecessor lets the next one go, one with a question open holds it — and a
// session a PERSON opened is never the queue's business. A row sat five hours
// behind "'myrepo' (working)", a hand session, while its owner worked by hand.
test("a hand session never holds a serial row — only queued work does", () => {
  const i = intent({ serial: true, target: { kind: "repo", fresh: true } });
  const verdictWith = (sessions, occupied = []) => intentVerdict(i, facts({
    sessions,
    busyCwds: busyIntentGroups(sessions, occupied.map((o) => o.cwd)),
    serialHolders: intentSerialHolders(sessions, occupied),
  }), NOW);

  // A hand session mid-turn, parked on a box, or at a limit: the row GOES.
  for (const hand of [
    session({ id: "h", cwd: "/repo", turnActive: true, name: "myrepo" }),
    session({ id: "h", cwd: "/repo", promptKind: "permission" }),
    session({ id: "h", cwd: "/repo", limitBlocked: true }),
    session({ id: "h", cwd: "/repo", asking: true }),
  ]) assert.equal(verdictWith([hand]).kind, "go", JSON.stringify(hand));

  // An automatic session mid-turn: held, named, and its id travels.
  const working = verdictWith([session({ id: "auto1", cwd: "/repo", turnActive: true, automatic: true, name: "ios shell" })]);
  assert.equal(working.reason, "serial");
  assert.equal(working.detail, "one at a time in this repo — waiting for 'ios shell' (working)");
  assert.equal(working.holderSessionId, "auto1");

  // An automatic session that finished and is idle: the next row may go.
  assert.equal(verdictWith([session({ id: "auto1", cwd: "/repo", automatic: true })]).kind, "go");

  // An automatic session with a question open — a box, an unparsable dialog,
  // or a turn that ENDED asking in prose — holds it, and the sentence says
  // whose answer it is waiting for.
  for (const asks of [{ promptKind: "permission" }, { awaitingInput: true }, { asking: true }]) {
    const v = verdictWith([session({ id: "auto2", cwd: "/repo", automatic: true, name: "fix webkit sync", ...asks })]);
    assert.equal(v.reason, "serial", JSON.stringify(asks));
    assert.equal(v.detail, "one at a time in this repo — waiting for your answer in 'fix webkit sync'");
    assert.equal(v.holderSessionId, "auto2");
  }
  // At a usage limit: held, unchanged.
  const limited = verdictWith([session({ id: "auto3", cwd: "/repo", automatic: true, limitBlocked: true, name: "x" })]);
  assert.equal(limited.detail, "one at a time in this repo — waiting for 'x' (on a usage limit)");

  // A ROW starting or running holds it wherever it runs — even in a hand
  // session it was aimed at — because that is queued work coding there.
  const hand = session({ id: "h", cwd: "/repo", name: "myrepo" });
  const occ = verdictWith([hand], [{ cwd: "/repo", sessionId: "h" }]);
  assert.equal(occ.reason, "serial");
  assert.equal(occ.detail, "one at a time in this repo — waiting for 'myrepo' (starting a queued job)");
  assert.equal(occ.holderSessionId, "h");

  // A hand session working beside an automatic one with a question: the
  // question is what gets named, and the hand one is not counted at all.
  const both = verdictWith([
    session({ id: "h", cwd: "/repo", turnActive: true, name: "myrepo" }),
    session({ id: "auto4", cwd: "/repo", automatic: true, asking: true, name: "ios shell" }),
  ]);
  assert.equal(both.detail, "one at a time in this repo — waiting for your answer in 'ios shell'");
  assert.equal(both.holderSessionId, "auto4");
});

test("the phone's queue reading still counts every session — and prose questions are not a lane wall", () => {
  const sessions = [
    session({ id: "h", cwd: "/one", turnActive: true }),
    session({ id: "q", cwd: "/two", asking: true }),
  ];
  assert.deepEqual([...serialHolders(sessions, []).keys()], [serialGroup("/one")]);
  assert.deepEqual([...intentSerialHolders(sessions, []).keys()], []);
});

test("serialHolders names exactly the groups busyIntentGroups holds, with sessionWall's reason", () => {
  const sessions = [
    session({ id: "a", cwd: "/one", turnActive: true, name: "fix webkit sync", automatic: true }),
    session({ id: "b", cwd: "/two", name: "idle one", automatic: true }),
    session({ id: "d", cwd: "/four", limitBlocked: true, turnActive: true, name: "walled", automatic: true }),
    session({ id: "q", cwd: "/one", promptKind: "permission", name: "asks", automatic: true }),
    session({ id: "h", cwd: "/six", turnActive: true, name: "by hand" }), // a person's — not counted
  ];
  const occupied = [{ cwd: "/five" }, { cwd: "/one", sessionId: "a" }];
  const h = intentSerialHolders(sessions, occupied);
  assert.deepEqual([...h.keys()].sort(), [...busyIntentGroups(sessions, ["/five", "/one"])].sort());
  // A row running in a session that is already a wall adds nothing.
  assert.deepEqual(h.get(serialGroup("/one")).map((x) => [x.sessionId, x.wall]), [["a", "sessionBusy"], ["q", "awaitingAnswer"]]);
  assert.equal(h.get(serialGroup("/four"))[0].wall, "limit"); // limit outranks a live turn, as sessionWall says
  assert.deepEqual(h.get(serialGroup("/five")), [{ wall: "starting" }]);
  assert.equal(h.has(serialGroup("/six")), false);
  // The sentence leads with the open question, and so does the offer to open it.
  assert.equal(serialLead(h.get(serialGroup("/one"))).sessionId, "q");
});

test("the serial sentence names who holds the repo, and why", () => {
  const one = (wall, name = "fix webkit sync") => serialWaitText([{ sessionId: "a", name, wall }]);
  assert.equal(one("sessionBusy"), "one at a time in this repo — waiting for 'fix webkit sync' (working)");
  assert.equal(one("awaitingAnswer"), "one at a time in this repo — waiting for your answer in 'fix webkit sync'");
  assert.equal(serialWaitText([{ sessionId: "a", wall: "awaitingAnswer" }]), "one at a time in this repo — waiting for your answer in the session before it");
  assert.equal(one("limit"), "one at a time in this repo — waiting for 'fix webkit sync' (on a usage limit)");
  assert.equal(serialWaitText([{ wall: "starting" }]), "one at a time in this repo — an automatic job is starting here");
  assert.equal(serialWaitText([{ sessionId: "x", wall: "sessionBusy" }]), "one at a time in this repo — waiting for another session (working)");
  // More than one: a session wall leads over a starting claim, the rest are counted.
  assert.equal(
    serialWaitText([{ wall: "starting" }, { sessionId: "a", name: "orchestrator", wall: "sessionBusy" }, { sessionId: "b", wall: "limit" }]),
    "one at a time in this repo — waiting for 'orchestrator' (working) +2 more",
  );
  // …and an open question leads over everything: it is what a person can clear.
  assert.equal(
    serialWaitText([{ sessionId: "a", name: "orchestrator", wall: "sessionBusy" }, { sessionId: "b", name: "asker", wall: "awaitingAnswer" }]),
    "one at a time in this repo — waiting for your answer in 'asker' +1 more",
  );
  // Nobody said ⇒ the old sentence, never an invented name.
  assert.equal(serialWaitText(undefined), SERIAL_WAIT_TEXT);
  assert.equal(serialWaitText([]), SERIAL_WAIT_TEXT);
});

test("the serial rung carries the named sentence when the caller supplied holders", () => {
  const sessions = [session({ id: "orch", cwd: "/repo", turnActive: true, name: "orchestrator", automatic: true })];
  const i = intent({ serial: true, target: { kind: "repo", fresh: true } });
  const named = intentVerdict(i, facts({
    sessions,
    busyCwds: busyIntentGroups(sessions, []),
    serialHolders: intentSerialHolders(sessions, []),
  }), NOW);
  assert.equal(named.reason, "serial");
  assert.equal(named.detail, "one at a time in this repo — waiting for 'orchestrator' (working)");
  assert.equal(named.holderSessionId, "orch");
  // Without the optional fact: the generic sentence, same verdict, no holder.
  const bare = intentVerdict(i, facts({ sessions, busyCwds: busyIntentGroups(sessions, []) }), NOW);
  assert.equal(bare.reason, "serial");
  assert.equal(bare.detail, SERIAL_WAIT_TEXT);
  assert.equal(bare.holderSessionId, undefined);
});

test("a row's holder session id is kept only beside a serial block", () => {
  const base = { ...intent({ serial: true, target: { kind: "repo", fresh: true } }), state: "blocked", blockDetail: "x", blockSessionId: "auto1" };
  assert.equal(cleanIntentRow({ ...base, blockReason: "serial" }, NOW).blockSessionId, "auto1");
  assert.equal(cleanIntentRow({ ...base, blockReason: "hostBusy" }, NOW).blockSessionId, undefined);
  assert.equal(cleanIntentRow({ ...base, state: "queued", blockReason: undefined }, NOW).blockSessionId, undefined);
});

// ── 6. A repo target and the sessions that are not its business ──────────────

test("a fresh-session intent needs no session to be open — opening one is the work", () => {
  const i = intent({ target: { kind: "repo", fresh: true } });
  assert.equal(intentVerdict(i, facts(), NOW).kind, "go");
});

test("a repo already holding a session is still not this row's business", () => {
  // The rung is asked BEFORE `repoSession`, not inside a "no session open"
  // branch, and that order is the rule rather than a tidy-up. A repo whose last
  // item's session is still lingering answers that lookup with a conversation
  // this row has nothing to do with — and the row would then be held on
  // somebody else's turn, or on a person who had started typing in it, for a
  // session it was never going to use. Two items in one repo are kept apart by
  // `serial`; they are not kept apart by each other's windows.
  const i = intent({ target: { kind: "repo", fresh: true }, auto: true });
  const lingering = facts({
    repoSession: new Map([["/repo", "s1"]]),
    sessions: [session({ id: "s1", turnActive: true })],
    busySessions: new Set(["s1"]),
  });
  assert.equal(intentVerdict(i, lingering, NOW).kind, "go");
});

test("a repo target passes rung 5 unconditionally — there is no second reading left", () => {
  // Both refusals that used to live here are gone with the thing they named.
  // `no backlog session open for this repo` described a repo's one shared
  // conversation; `automatic work never types into a session you opened by
  // hand` described adopting one. `cleanTarget` makes every repo target
  // `fresh`, opening the session IS the work, and there is nothing at this rung
  // for the tick to find busy — so even the hand-built legacy shape, with no
  // session anywhere and no `repoSession` map supplied at all, goes.
  const legacy = { ...intent({ auto: true }), target: { kind: "repo" } };
  assert.equal(intentVerdict(legacy, facts(), NOW).kind, "go");
  assert.equal(intentVerdict(intent({ target: { kind: "repo", fresh: true } }), facts(), NOW).kind, "go");
});

test("a named session that is gone gets the third wording — re-aim it", () => {
  const v = intentVerdict(intent(), facts({ sessions: [session({ running: false })] }), NOW);
  assert.equal(v.reason, "sessionGone");
  assert.match(v.detail, /aim it at another session/);
});

/**
 * ── …unless the row knows which CONVERSATION it was aimed at ─────────────────
 *
 * `sessionGone` is a wait nothing in the store has ever resolved: a row aimed
 * at a session that exits waits there for as long as it exists. That was the
 * whole reason a clock could not name a session — the phone re-aimed one at its
 * repo before it could be written, so *reply to that session after the reset*
 * became *open a new, empty session in that repo*.
 *
 * A clock row snapshots the conversation (`IntentTarget.resumeConvId`), and
 * reopening it IS the work — exactly a fresh repo target's position at this
 * rung, down to taking one of the desktop's automatic-session slots.
 */
test("a clock row that remembers its conversation is not held by a session that went", () => {
  const timedSession = (over = {}) => intent({
    trigger: { kind: "at", rule: { kind: "once", at: NOW - MIN }, graceMin: 120 },
    target: { kind: "session", sessionId: "s1", resumeConvId: "conv-1" },
    nextAt: NOW - MIN,
    ...over,
  });
  const gone = facts({ sessions: [session({ running: false })] });
  const v = intentVerdict(timedSession(), gone, NOW);
  assert.equal(v.kind, "go");
  assert.equal(v.sessionId, undefined, "the executor opens one — there is no live session to name");
  // The snapshot alone is not enough: a `now`/`idle` row aimed at a session is
  // about a process that exists as it is written, and reopening a conversation
  // on its behalf would put a second agent in the worktree every time a restart
  // took the sessions with it.
  assert.equal(reopensConversation(timedSession()), true);
  assert.equal(reopensConversation(intent({ target: { kind: "session", sessionId: "s1", resumeConvId: "conv-1" } })), false);
  assert.equal(reopensConversation(timedSession({ target: { kind: "session", sessionId: "s1" } })), false);
  // No snapshot ⇒ exactly the old behaviour, which is the safe one.
  assert.equal(intentVerdict(timedSession({ target: { kind: "session", sessionId: "s1" } }), gone, NOW).reason, "sessionGone");
  // Opening a session is opening a session: it spends a slot like any other.
  assert.equal(needsSlot(timedSession()), true);
  assert.equal(intentVerdict(timedSession({ auto: true }), facts({ ...gone, autoSlotsFree: 0 }), NOW).reason, "noSlot");
  // And while the session is still THERE, nothing is reopened — it is typed
  // into, exactly as before.
  const liveOne = intentVerdict(timedSession(), facts({ sessions: [session()] }), NOW);
  assert.equal(liveOne.kind, "go");
  assert.equal(liveOne.sessionId, "s1");
});

test("a gone session whose conversation is open under another id is typed into, never reopened twice", () => {
  const row = intent({
    trigger: { kind: "at", rule: { kind: "once", at: NOW - MIN }, graceMin: 120 },
    target: { kind: "session", sessionId: "s1", resumeConvId: "conv-1" },
    nextAt: NOW - MIN,
  });
  const reopened = session({ id: "s2", convId: "conv-1" });
  const v = intentVerdict(row, facts({ sessions: [session({ running: false, convId: "conv-1" }), reopened] }), NOW);
  assert.equal(v.kind, "go");
  assert.equal(v.sessionId, "s2");
  assert.equal(liveConvSession(row, [reopened]), "s2");
  // Held by THAT session's readiness, like any session target.
  const busy = intentVerdict(row, facts({ sessions: [{ ...reopened, turnActive: true }] }), NOW);
  assert.equal(busy.kind, "wait");
  // Another conversation in the same repo is not this one.
  assert.equal(intentVerdict(row, facts({ sessions: [session({ id: "s3", convId: "conv-9" })] }), NOW).sessionId, undefined);
  // A non-clock row never goes looking.
  assert.equal(liveConvSession(intent({ target: row.target }), [reopened]), null);
});

test("a conversation snapshot survives cleaning, and is never invented", () => {
  const kept = cleanIntentRow(raw({ target: { kind: "session", sessionId: "s1", resumeConvId: "conv-1" } }), NOW);
  assert.deepEqual(kept.target, { kind: "session", sessionId: "s1", resumeConvId: "conv-1" });
  const bare = cleanIntentRow(raw({ target: { kind: "session", sessionId: "s1" } }), NOW);
  assert.deepEqual(bare.target, { kind: "session", sessionId: "s1" },
    "this end cannot look a conversation up, so a missing one stays missing");
});

// ── The rest of rung 5 ───────────────────────────────────────────────────────

test("the target ladder keeps autoFireBlocker's order", () => {
  // gone → another intent holds it → limit → a question → mid-turn. A limited
  // session outranks a question box because the item would bounce off it; a
  // question box outranks "working" because prose typed at an open dialog goes
  // INTO the dialog — it neither runs nor answers.
  const all = session({ limitBlocked: true, awaitingInput: true, turnActive: true });
  assert.equal(intentVerdict(intent(), facts({ sessions: [all], busySessions: new Set(["s1"]) }), NOW).detail,
    "another item is running in that session");
  assert.equal(intentVerdict(intent(), facts({ sessions: [all] }), NOW).reason, "limit");
  assert.equal(intentVerdict(intent(), facts({ sessions: [session({ awaitingInput: true, turnActive: true })] }), NOW).reason,
    "awaitingAnswer");
  assert.equal(intentVerdict(intent(), facts({ sessions: [session({ promptKind: "select", turnActive: true })] }), NOW).reason,
    "awaitingAnswer");
  // A trust prompt is not a question in this sense — delivery auto-accepts it.
  assert.equal(intentVerdict(intent(), facts({ sessions: [session({ promptKind: "trust" })] }), NOW).kind, "go");
});

test("a sweep fails when none of the repos it names are still there", () => {
  const i = intent({ target: { kind: "repos", dirs: ["/gone", "/also-gone"] } });
  assert.equal(intentVerdict(i, facts(), NOW).kind, "fail");
  assert.equal(intentVerdict(i, facts({ knownDirs: new Set(["/gone"]) }), NOW).kind, "go");
});

test("a follow-up waits for every live session it names, and never types into half of them", () => {
  const i = intent({ target: { kind: "sessions", sessionIds: ["s1", "s2"] } });
  const one = session({ id: "s1" });
  const two = session({ id: "s2", cwd: "/other", turnActive: true });
  assert.equal(intentVerdict(i, facts({ sessions: [one, two] }), NOW).reason, "sessionBusy");
  assert.equal(intentVerdict(i, facts({ sessions: [one, { ...two, turnActive: false }] }), NOW).kind, "go");
  // Every one of them gone: one sentence, and it points somewhere useful.
  const dead = intentVerdict(i, facts({ sessions: [] }), NOW);
  assert.equal(dead.reason, "sessionGone");
  // …and it points somewhere that still exists. "this repo's work items" was
  // the retired name for rows in a shared per-repo conversation there is no
  // longer any such thing as; the sentence a blocked row wears in Activity is
  // the last place a retired word survives, because nothing type-checks prose.
  assert.match(dead.detail, /aim it at this repo's backlog/);
  assert.doesNotMatch(dead.detail, /work item/);
});

test("a shell target asks nobody's permission — no agent, no session", () => {
  const i = intent({ target: { kind: "shell" }, payload: { kind: "build", buildId: "b1" } });
  assert.equal(intentVerdict(i, facts(), NOW).kind, "go");
});

// ── intentReasonText ─────────────────────────────────────────────────────────

test("a stored blockReason is accepted exactly when the order knows it", () => {
  // There were two hand-kept lists of the same thirteen strings in two orders —
  // `INTENT_BLOCK_ORDER` (what the UI reports first) and a private set (what
  // `cleanIntentRow` accepts off disk) — and nothing checked they matched.
  // TypeScript holds each to the union but neither to the OTHER, so a reason
  // added to one and forgotten in the other is invisible: rows come back from
  // disk having silently lost their reason. One list now, read two ways; this
  // is the assertion that keeps it that way if anybody splits it again.
  const row = (blockReason) => cleanIntentRow(raw({ state: "blocked", blockReason }), NOW).blockReason;
  for (const r of INTENT_BLOCK_ORDER) assert.equal(row(r), r, `${r} survives a round trip through the store`);
  assert.equal(row("nonsense"), undefined);
  assert.equal(row(undefined), undefined);
});

test("intentReasonText answers every reason, and a finished sentence survives it", () => {
  for (const r of ["offline", "gate", "budget", "sessionBusy", "sessionGone", "awaitingAnswer", "limit", "filesMissing", "notYet", "serial", "hostBusy", "noSlot", "localModel"]) {
    assert.equal(typeof intentReasonText(r), "string");
    assert.ok(intentReasonText(r).length > 10, `${r} needs a real sentence`);
  }
  // A verdict's `detail` is already finished — feeding it back is a no-op, so a
  // UI holding only (blockReason, blockDetail) can call this again safely.
  const specific = "waiting for shot.jpg to finish uploading";
  assert.equal(intentReasonText("filesMissing", specific), specific);
  // The offline sentence is the phone's, and it must promise the one thing the
  // old queue could not: nothing expires.
  assert.match(intentReasonText("offline"), /nothing expires/);
});


// ── cleanIntentRow ───────────────────────────────────────────────────────────

const raw = (over = {}) => ({
  id: "i1",
  cwd: "/repo",
  payload: { kind: "prompt", steps: ["do the thing"] },
  trigger: { kind: "now" },
  ...over,
});

test("cleanIntentRow refuses a needs path that climbs out of the repo", () => {
  const ok = cleanIntentRow(
    raw({ trigger: { kind: "files", needs: [".claude/inbox/a.png", "../../etc/passwd", "/etc/passwd", "a\\b", 7, ""], deadlineAt: NOW } }),
    NOW,
  );
  assert.deepEqual(ok.trigger.needs, [".claude/inbox/a.png"]);
  // A hand-edited file with hundreds of needs is capped, not trusted.
  const many = cleanIntentRow(
    raw({ trigger: { kind: "files", needs: Array.from({ length: 50 }, (_, i) => `f${i}.png`) } }),
    NOW,
  );
  assert.equal(many.trigger.needs.length, 20);
  assert.equal(many.trigger.deadlineAt > NOW, true); // defaulted, never zero
});

test("cleanIntentRow refuses a trigger it cannot read, rather than guessing now", () => {
  // Every wrong guess in that direction is the same wrong guess: work the
  // sender wanted deferred, run immediately.
  assert.equal(cleanIntentRow(raw({ trigger: { kind: "whenever" } }), NOW), null);
  assert.equal(cleanIntentRow(raw({ trigger: undefined }), NOW), null);
  assert.equal(cleanIntentRow(raw({ trigger: "now" }), NOW), null);
});

test("cleanIntentRow refuses a row it could not act on", () => {
  assert.equal(cleanIntentRow(raw({ cwd: "" }), NOW), null);          // no cwd
  assert.equal(cleanIntentRow(raw({ cwd: undefined }), NOW), null);
  assert.equal(cleanIntentRow(raw({ id: "  " }), NOW), null);         // no id
  assert.equal(cleanIntentRow(raw({ payload: { kind: "prompt", steps: [] } }), NOW), null); // nothing to say
  assert.equal(cleanIntentRow(raw({ payload: { kind: "build" } }), NOW), null);             // no build named
  assert.equal(cleanIntentRow(raw({ target: { kind: "session" } }), NOW), null);            // a session with no id
  assert.equal(cleanIntentRow(raw({ target: { kind: "repos", dirs: [] } }), NOW), null);
  assert.equal(cleanIntentRow(null, NOW), null);
});

test("cleanIntentRow never clips the words", () => {
  // The cap is on the COUNT of steps and on labels. What the user wrote is what
  // is stored — that promise is the reason the store exists.
  const long = "x".repeat(50_000);
  const row = cleanIntentRow(raw({ payload: { kind: "prompt", steps: [long, "  ", "second"] }, label: "y".repeat(500) }), NOW);
  assert.deepEqual(row.payload.steps, [long, "second"]);
  assert.equal(row.label.length, 80);
});

test("cleanIntentRow defaults the harmless things and enforces blocked's iff", () => {
  const row = cleanIntentRow(raw({ state: "nonsense", blockReason: "serial", blockDetail: "stale" }), NOW);
  assert.equal(row.state, "queued");                 // a bad state defaults; a bad trigger does not
  assert.equal(row.blockReason, undefined);          // present iff blocked
  assert.equal(row.blockDetail, undefined);
  assert.deepEqual(row.target, { kind: "repo", fresh: true }); // absent target ⇒ this repo, in its own session
  assert.equal(row.createdAt, NOW);

  const blocked = cleanIntentRow(raw({ state: "blocked", blockReason: "serial" }), NOW);
  assert.equal(blocked.blockReason, "serial");
  assert.equal(blocked.blockDetail, intentReasonText("serial"));
});

test("a blocked row persisted as `picking` loads with no reason, and the ladder re-asks it", () => {
  // `picking` was the smart pick's wait (removed 2026-10-16). A row an older
  // host wrote to disk while one was running must load as a blocked row with
  // no reason — the next tick re-judges it — never as a reason nothing words.
  const row = cleanIntentRow(raw({ state: "blocked", blockReason: "picking" }), NOW);
  assert.equal(row.blockReason, undefined);
  assert.ok(!INTENT_BLOCK_ORDER.includes("picking"));
});

test("cleanIntentRow keeps handOrdered only when it is literally true", () => {
  // This flag is a claim that a PERSON placed the row, and it is the one thing
  // standing between an automatic sort and somebody's explicit drag. A truthy
  // value off the wire or out of a hand-edited file is not that claim: a row
  // wrongly marked hand-placed tells its reader a person put it there.
  assert.equal(cleanIntentRow(raw({ handOrdered: true }), NOW).handOrdered, true);
  for (const v of ["yes", 1, "true", {}, [], "false", 0, null, undefined]) {
    assert.equal(
      cleanIntentRow(raw({ handOrdered: v }), NOW).handOrdered,
      undefined,
      `${JSON.stringify(v)} is not a placement`,
    );
  }
  // Absent, never `false`: "nobody placed this" is the absence of a statement,
  // not a statement that nobody did.
  assert.equal(cleanIntentRow(raw({}), NOW).handOrdered, undefined);
});

test("a repo target is normalised to a fresh session, whoever wrote it", () => {
  // The non-fresh repo target — "the repo's one shared backlog session, every
  // item appended to it" — is retired, and `cleanTarget` is where it goes,
  // because every row enters through this function exactly once: a row loaded
  // from a file written months ago, a draft off the wire, and an APK pinned to
  // a bundle that has never heard of the flag all arrive at the same default
  // instead of at three code paths.
  //
  // The reason is a number this repo already computes. `sessioncost.ts` puts
  // the break-even for staying in a warm conversation at ~8 turns, ~3 at 5×,
  // ~1 at 9×; a session of unrelated items reaches 5× within a handful of them,
  // since each item reads its own files in and none of that helps the next.
  // Appending unattended work to one window for ever is the shape of the 124
  // conversations that were 76% of a fortnight's tokens.
  for (const target of [{ kind: "repo" }, { kind: "repo", fresh: false }, undefined, {}]) {
    const row = cleanIntentRow(raw({ target }), NOW);
    assert.deepEqual(row.target, { kind: "repo", fresh: true }, `${JSON.stringify(target)} normalises`);
  }
  // Already fresh stays fresh, and nothing else is touched: a session target is
  // still the deliberate "join THIS conversation" and a sweep is still a sweep.
  assert.deepEqual(cleanIntentRow(raw({ target: { kind: "repo", fresh: true } }), NOW).target, { kind: "repo", fresh: true });
  assert.deepEqual(cleanIntentRow(raw({ target: { kind: "session", sessionId: "s1" } }), NOW).target, { kind: "session", sessionId: "s1" });
  // And a shape from a version we do not have is still refused rather than
  // guessed at — the normalisation is for a target we can read, not for any.
  assert.equal(cleanIntentRow(raw({ target: { kind: "elsewhere" } }), NOW), null);
});

// ── the re-queue history ────────────────────────────────────────────────────
//
// Putting a settled row back replaces its answer: the next run overwrites
// `result`, so the failure the row was wearing when somebody decided to try it
// again is gone the moment it starts. That failure is the only reason a person
// had to think twice, so it is copied onto the entry — and the entries are
// capped the way everything in this file is capped, by COUNT and never by
// words.

const requeue = (over = {}) => ({ at: NOW - MIN, by: "assess", ...over });

test("cleanIntentRow keeps the re-queue history across the round trip", () => {
  // It is persisted for `followed`'s reason: the decision outlives the process,
  // and a restart that dropped it would leave a row that is queued again with
  // nothing on it saying who queued it or what it failed of last time.
  const row = cleanIntentRow(
    raw({
      requeues: [requeue({ runId: "r1", clockDropped: true, result: { at: NOW - 2 * MIN, ok: false, detail: "the session had gone" } })],
    }),
    NOW,
  );
  assert.equal(row.requeues.length, 1);
  assert.deepEqual(row.requeues[0], {
    at: NOW - MIN,
    by: "assess",
    runId: "r1",
    result: { at: NOW - 2 * MIN, ok: false, detail: "the session had gone" },
    clockDropped: true,
  });
  // Absent on the overwhelming majority of rows, which have never settled
  // twice — and absent, never `[]`: an empty list reads as a history.
  assert.equal(cleanIntentRow(raw({}), NOW).requeues, undefined);
  assert.equal(cleanIntentRow(raw({ requeues: "three times" }), NOW).requeues, undefined);
  assert.equal(cleanIntentRow(raw({ requeues: [] }), NOW).requeues, undefined);
});

test("the re-queue history is capped at the NEWEST entries, never the first ones", () => {
  // The list is oldest-first and the entry that explains why the row is queued
  // right now is the LAST one, so a cap that kept the front would throw away
  // the only entry anything renders.
  const many = Array.from({ length: REQUEUE_KEEP + 4 }, (_, i) => requeue({ at: NOW - (20 - i) * MIN, runId: `r${i}` }));
  const kept = cleanIntentRow(raw({ requeues: many }), NOW).requeues;
  assert.equal(kept.length, REQUEUE_KEEP);
  assert.deepEqual(kept.map((e) => e.runId), many.slice(-REQUEUE_KEEP).map((e) => e.runId));
});

test("the cap is on the COUNT of re-queues and never on the words inside one", () => {
  // The same promise `payload.steps` makes, one step earlier: the entry carries
  // a copy of what a run wrote about somebody's work, and this file does not
  // clip words. Dropping the oldest ENTRY loses a decision there are still four
  // of; clipping a `detail` loses the sentence the decision was taken against.
  const detail = "x".repeat(50_000);
  const error = "y".repeat(50_000);
  const row = cleanIntentRow(
    raw({ requeues: [requeue({ result: { at: NOW - 2 * MIN, ok: false, detail, targets: [{ dir: "/repo", status: "failed", error }] } })] }),
    NOW,
  );
  assert.equal(row.requeues[0].result.detail.length, 50_000);
  assert.equal(row.requeues[0].result.targets[0].error.length, 50_000);
});

test("a re-queue entry that cannot say when or who is dropped, not defaulted", () => {
  // `by` is a claim about who took a decision — `handOrdered`'s rule. Defaulting
  // it invents either a person who tapped nothing or an assessment run that does
  // not exist, and the row would then show that sentence under a chip a reader
  // is meant to trust.
  const bad = [
    requeue({ by: "somebody" }),
    requeue({ by: undefined }),
    requeue({ at: "yesterday" }),
    requeue({ at: 0 }),
    "re-queued",
    null,
  ];
  assert.equal(cleanIntentRow(raw({ requeues: bad }), NOW).requeues, undefined);
  // …and one good entry beside six unreadable ones survives on its own.
  assert.deepEqual(
    cleanIntentRow(raw({ requeues: [...bad, requeue({ by: "hand" })] }), NOW).requeues,
    [{ at: NOW - MIN, by: "hand", runId: undefined, result: undefined, clockDropped: undefined }],
  );
});

test("a re-queue by the run-it-now tap survives cleaning, and an unknown `by` is still dropped", () => {
  // Three taps put a settled row back and they are three different sentences:
  // `assess` (a verdict a person applied), `hand` (the row's own *run it again*,
  // which leaves it WAITING) and `run` (the first half of *run it now*, after
  // which the row is already going). The phone draws the first two as "put back
  // in the queue" and cannot draw that over a row the same tap fired — so `run`
  // is a value here and not a fourth thing `hand` has to cover.
  const row = cleanIntentRow(raw({ requeues: [requeue({ by: "run" })] }), NOW);
  assert.deepEqual(row.requeues, [{ at: NOW - MIN, by: "run", runId: undefined, result: undefined, clockDropped: undefined }]);
  // Widening the set did not soften it: `by` is still a claim about who took a
  // decision, and a value nobody here writes is dropped rather than guessed at.
  assert.equal(cleanIntentRow(raw({ requeues: [requeue({ by: "auto" })] }), NOW).requeues, undefined);
  assert.equal(cleanIntentRow(raw({ requeues: [requeue({ by: "RUN" })] }), NOW).requeues, undefined);
});

test("the re-queue COUNT is uncapped and independent of the capped history", () => {
  // The bug this field deletes: `requeues` is capped at REQUEUE_KEEP, so its
  // length stops rising at five and a row put back for the ninth time said
  // "(5th time)" — for ever, and not looking wrong. The words are capped
  // because an entry carries a whole `result` and this row is rewritten every
  // tick; the number is not, because it is a number, and "how many times has
  // this failed and been put back" is the one reading that must not silently
  // stop rising.
  const many = Array.from({ length: 9 }, (_, i) => requeue({ at: NOW - (20 - i) * MIN, runId: `r${i}` }));
  const row = cleanIntentRow(raw({ requeues: many, requeueCount: 9 }), NOW);
  assert.equal(row.requeues.length, REQUEUE_KEEP, "the WORDS are still capped");
  assert.equal(row.requeueCount, 9, "the NUMBER is not");
  // And the two are cleaned independently, because a row may honestly carry
  // either alone: everything written before the count existed has the history
  // and no count, and the count cannot be reconstructed from a capped length.
  assert.equal(cleanIntentRow(raw({ requeues: many }), NOW).requeueCount, undefined);
  assert.equal(cleanIntentRow(raw({ requeueCount: 3 }), NOW).requeues, undefined);
  assert.equal(cleanIntentRow(raw({ requeueCount: 3 }), NOW).requeueCount, 3);
});

test("a re-queue count that is not a whole positive number is absent, never 0", () => {
  // It is rendered as an ORDINAL on a chip a person reads as a warning, and
  // there is no nearly-right count — so the only accepted shape is a real,
  // whole, positive number, and everything else degrades to absent. Absent
  // means NOBODY COUNTED, which is also how "never put back" is spelled: one
  // fact, one spelling, so no reader has to tell a stored 0 from a missing one.
  for (const bad of [0, -1, 2.5, NaN, Infinity, -Infinity, "9", true, null, undefined, {}, [9]]) {
    assert.equal(
      cleanIntentRow(raw({ requeueCount: bad }), NOW).requeueCount, undefined,
      `${JSON.stringify(bad) ?? String(bad)} is not a count`,
    );
  }
  assert.equal(cleanIntentRow(raw({ requeueCount: 1 }), NOW).requeueCount, 1);
  assert.equal(cleanIntentRow(raw({ requeueCount: 9_999 }), NOW).requeueCount, 9_999);
});

test("cleanIntentRow keeps a null nextAt as null", () => {
  // `null` is the explicit "nothing armed"; collapsing it into `undefined` would
  // re-arm a rule the user switched off.
  const off = cleanIntentRow(raw({ trigger: { kind: "at", rule: { kind: "weekly", days: [4], hour: 18 } }, nextAt: null }), NOW);
  assert.equal(off.nextAt, null);
  assert.equal(off.trigger.graceMin, 120); // DEFAULT_GRACE_MIN
  assert.equal(cleanIntentRow(raw({ trigger: { kind: "now" } }), NOW).nextAt, undefined);
});

// ── 3c. the run window: due is not the same as allowed ──────────────────────
//
// `nextFireAt` places the occurrence and knows nothing about `hours` — an
// anchor is a fact about when the work becomes worth doing, quiet hours are a
// policy over every anchor. So the instant the rule landed on may be one the
// user shut the door on, and the ladder is where that is noticed.

const iso = (s) => Date.parse(s);
const DAY_WINDOW = { from: 7 * 60, to: 22 * 60 };
const nightly = (over = {}) =>
  intent({
    target: { kind: "shell" },
    payload: { kind: "build", buildId: "b1" },
    trigger: {
      kind: "at",
      rule: { kind: "weekly", days: [], hour: 3, minute: 0, tz: "UTC", hours: DAY_WINDOW },
      graceMin: 120,
    },
    nextAt: iso("2026-09-10T03:00:00Z"),
    createdAt: iso("2026-09-09T00:00:00Z"),
    ...over,
  });

test("due but outside its hours waits, and says which hours", () => {
  const v = intentVerdict(nightly(), facts(), iso("2026-09-10T04:00:00Z"));
  assert.equal(v.kind, "wait");
  assert.equal(v.reason, "notYet");
  assert.equal(v.detail, "outside its hours (07:00–22:00 UTC) — runs when they open");
  // The hours DO go in the sentence where a due instant deliberately does not:
  // they are a pair of wall clocks the user typed, in the zone they typed them
  // in, not an instant every surface already prints from a number.
  //
  // …and the ZONE goes in with them, always. `inHours` reads a rule with no
  // `tz` against the daemon's own clock, which is a real reading a person
  // cannot otherwise see: the same 07:00–22:00 rule was open at 05:30Z on a
  // Tokyo host and shut on a UTC one, and this sentence read identically in
  // both. What a zone-less rule says now is whose clock it is on.
  const hostClock = nightly({
    trigger: { kind: "at", rule: { kind: "weekly", days: [], hour: 3, minute: 0, hours: DAY_WINDOW }, graceMin: 120 },
  });
  const tz = process.env.TZ;
  process.env.TZ = "UTC";                  // the reading this row actually gets
  try {
    assert.equal(
      intentVerdict(hostClock, facts(), iso("2026-09-10T04:00:00Z")).detail,
      "outside its hours (07:00–22:00 host clock) — runs when they open",
    );
  } finally {
    if (tz == null) delete process.env.TZ; else process.env.TZ = tz;
  }
});

test("the hours are checked against NOW, not only against the occurrence", () => {
  // The window can close while a row is still inside its grace. An occurrence
  // due at 21:30 with two hours of grace is "on time" at 22:30 by the clock and
  // is still not allowed to speak, because 22:00 is when the user went to bed.
  const late = nightly({ nextAt: iso("2026-09-10T21:30:00Z") });
  const v = intentVerdict(late, facts(), iso("2026-09-10T22:30:00Z"));
  assert.equal(v.reason, "notYet");
  assert.match(v.detail, /^outside its hours/);
});

test("the grace counts from the window OPENING, never from the anchor", () => {
  // The whole reason `hoursOpenFrom` exists. A rule anchored at 03:00 behind a
  // 07:00–22:00 window is due at 03:00 and may not run until 07:00: measured
  // from the anchor it has burned its entire grace asleep and reports itself
  // missed at 05:00 — every day, having never once been allowed to try, which
  // is worse than a schedule that never fires because it fails loudly at the
  // user instead.
  const open = intentVerdict(nightly(), facts(), iso("2026-09-10T08:00:00Z"));
  assert.equal(open.kind, "go");
  assert.equal(open.occurrence, iso("2026-09-10T03:00:00Z")); // the occurrence is still the anchor's
  assert.equal(open.late, true);                              // and the row says it ran late

  // Past the grace measured from the opening, it is missed — the window moves
  // the basis, it does not remove the deadline.
  const blown = intentVerdict(nightly(), facts(), iso("2026-09-10T09:30:00Z"));
  assert.equal(blown.reason, "notYet");
  assert.match(blown.detail, /^missed — /);
  assert.equal(blown.missedOccurrence, iso("2026-09-10T03:00:00Z"));
});

test("a rule with no hours answers exactly as it did before the field existed", () => {
  // The same row, the same instant, the window taken off: five hours past a
  // two-hour grace is missed, which is what this rule has always said.
  const bare = nightly({
    trigger: { kind: "at", rule: { kind: "weekly", days: [], hour: 3, minute: 0, tz: "UTC" }, graceMin: 120 },
  });
  const v = intentVerdict(bare, facts(), iso("2026-09-10T08:00:00Z"));
  assert.equal(v.reason, "notYet");
  assert.match(v.detail, /^missed — /);
  // …and inside the grace it goes, hours or no hours.
  assert.equal(intentVerdict(bare, facts(), iso("2026-09-10T04:00:00Z")).kind, "go");
});

// ── 3d. after: a chain across rows and repos ────────────────────────────────
//
// The two "not yet" triggers that existed both answer to the world — a clock,
// or one session's state. Neither can say "when the migration finishes, review
// it", which people were expressing by guessing a wall clock far enough out: a
// guess that is either wasteful or silently wrong in the direction of reviewing
// a half-finished migration.

const chained = (over = {}) => intent({ trigger: { kind: "after", id: "p1" }, ...over });
const settled = (over = {}) => new Map([["p1", { ok: true, at: NOW - 5 * MIN, ...over }]]);
const live = facts({ sessions: [session()], knownIntents: new Set(["i1", "p1"]) });

test("a chain waits for its predecessor, and names it", () => {
  const v = intentVerdict(chained({ trigger: { kind: "after", id: "p1", title: "run the migration" } }), live, NOW);
  assert.equal(v.kind, "wait");
  assert.equal(v.reason, "notYet");
  assert.equal(v.detail, "waits for “run the migration” to finish");
  // The title is a SNAPSHOT taken when the chain was made, so it degrades to
  // naming no title rather than to naming a wrong one.
  assert.equal(intentVerdict(chained(), live, NOW).detail, "waits for the item before it to finish");
});

test("the chain is a TRIGGER, so it outranks everything about the target", () => {
  // Rung 3 sits above rungs 4 and 5 for the reason the whole ladder is ordered:
  // everything below describes a run that is not being attempted at all.
  const busy = facts({ sessions: [session({ turnActive: true })], busySessions: new Set(["s1"]), knownIntents: new Set(["i1", "p1"]) });
  assert.equal(intentVerdict(chained(), busy, NOW).reason, "notYet");
});

test("settled releases the chain; how it settled only matters if the row asked", () => {
  assert.equal(intentVerdict(chained(), facts({ sessions: [session()], settled: settled() }), NOW).kind, "go");
  // A failed predecessor still releases an unqualified chain — "run the tests,
  // then tell me what happened" wants to run either way.
  const failed = facts({ sessions: [session()], settled: settled({ ok: false }) });
  assert.equal(intentVerdict(chained(), failed, NOW).kind, "go");
  // …and `onlyIfOk` is the difference between "afterwards" and "if it worked".
  const v = intentVerdict(chained({ trigger: { kind: "after", id: "p1", onlyIfOk: true } }), failed, NOW);
  assert.equal(v.kind, "fail");
  assert.match(v.detail, /failed, and this one was set to run only if that one succeeded/);
});

test("a chain gives back NO occurrence — that is the clock's bookkeeping", () => {
  // `lastOccurrence` is what stops one wall-clock instant being spent twice.
  // A chain has no occurrence to spend, and handing one back would write a
  // `lastOccurrence` onto a row with no clock to compare it against.
  const v = intentVerdict(chained(), facts({ sessions: [session()], settled: settled() }), NOW);
  assert.deepEqual(v, { kind: "go", sessionId: "s1", occurrence: undefined, late: undefined });
});

test("a predecessor that is GONE fails the row — it never silently never-fires", () => {
  // The store's one non-negotiable rule: an intent waits, fails loudly, or is
  // cancelled. A chain whose predecessor was cancelled and dismissed would
  // otherwise sit there for ever under a perfectly reasonable sentence.
  const gone = facts({ sessions: [session()], knownIntents: new Set(["i1"]) });
  const v = intentVerdict(chained({ trigger: { kind: "after", id: "p1", title: "run the migration" } }), gone, NOW);
  assert.equal(v.kind, "fail");
  assert.match(v.detail, /is gone \(“run the migration”\)/);
  assert.match(v.detail, /give it a time, or chain it to another/);
});

test("facts the host has not supplied make a chain WAIT, never fail", () => {
  // `knownIntents` absent is "nobody said", not "it is not there". Failing a
  // row because a fact was missing would kill work whose predecessor is alive
  // and running — the one direction that cannot be undone.
  const quiet = facts({ sessions: [session()] });
  const v = intentVerdict(chained(), quiet, NOW);
  assert.equal(v.kind, "wait");
  assert.equal(v.reason, "notYet");
});

test("a chain's grace is opt-in: absent means no deadline at all", () => {
  // The person named an EVENT, not an instant, so a desktop that slept through
  // the event has lost nothing by picking the work up now. The opposite default
  // would quietly bin a chain every time the laptop was shut.
  const old = facts({ sessions: [session()], settled: settled({ at: NOW - 3 * 24 * 60 * MIN }) });
  assert.equal(intentVerdict(chained(), old, NOW).kind, "go");

  const withGrace = chained({ trigger: { kind: "after", id: "p1", graceMin: 60 } });
  const v = intentVerdict(withGrace, facts({ sessions: [session()], settled: settled({ at: NOW - 180 * MIN }) }), NOW);
  assert.equal(v.kind, "fail");
  assert.equal(v.detail, "missed — more than 60 min since the item it waited for finished, and it could not start in time");
  // Not "and the desktop was not running": this rung sees a clock and nothing
  // else. (A chain that this rung has already CLEARED is no longer judged by
  // the grace at all — see the held-occurrence tests below.)
  assert.doesNotMatch(v.detail, /desktop/);
  // Inside it, the same row runs.
  assert.equal(intentVerdict(withGrace, facts({ sessions: [session()], settled: settled({ at: NOW - 30 * MIN }) }), NOW).kind, "go");
});

test("“skip it” means unless it can start about now, not unless the clock is exact", () => {
  // `graceMin: 0` is a chip in the send sheet ("skip it"), and it used to mean
  // NEVER. The manager has no timer at the instant a row becomes due: it ticks
  // every 2 s and asks this ladder, so `now` is always some milliseconds past
  // the anchor and `lateBy > 0` was true on every tick that could ever see the
  // row. A daily rule with the chip wore *missed — …(more than 0 min late)* on
  // every occurrence with the desktop up the whole time; a chain with it failed
  // TERMINALLY 1.5 s after the row it waited for finished.
  const TICK = 2000;

  // ── the `at` arm ────────────────────────────────────────────────────────
  const skip = at(NOW - TICK, { graceMin: 0 });
  assert.equal(intentVerdict(skip, facts(), NOW).kind, "go");
  assert.equal(intentVerdict(at(NOW - 59_000, { graceMin: 0 }), facts(), NOW).kind, "go");
  // Past the floor it does what the chip says.
  const gone = intentVerdict(at(NOW - 90_000, { graceMin: 0 }), facts(), NOW);
  assert.equal(gone.reason, "notYet");
  assert.match(gone.detail, /^missed — more than 0 min past its time/);

  // ── the `after` arm, same constant ──────────────────────────────────────
  const now0 = chained({ trigger: { kind: "after", id: "p1", graceMin: 0 } });
  const justSettled = facts({ sessions: [session()], settled: settled({ at: NOW - 1500 }) });
  assert.equal(intentVerdict(now0, justSettled, NOW).kind, "go");
  const stale = facts({ sessions: [session()], settled: settled({ at: NOW - 90_000 }) });
  assert.equal(intentVerdict(now0, stale, NOW).kind, "fail");

  // ── and the window's opening, which is the third edge of the same bug ────
  // A rule behind quiet hours counts its grace from the moment the window
  // opened; with no floor, a 0-grace rule missed every opening it ever had.
  const window = intent({
    target: { kind: "shell" },
    payload: { kind: "build", buildId: "b1" },
    trigger: {
      kind: "at",
      rule: { kind: "weekly", days: [], hour: 3, minute: 0, tz: "UTC", hours: { from: 7 * 60, to: 22 * 60 } },
      graceMin: 0,
    },
    nextAt: Date.parse("2026-09-10T03:00:00Z"),
    createdAt: Date.parse("2026-09-09T00:00:00Z"),
  });
  assert.equal(intentVerdict(window, facts(), Date.parse("2026-09-10T07:00:01Z")).kind, "go");
  assert.equal(intentVerdict(window, facts(), Date.parse("2026-09-10T07:02:00Z")).reason, "notYet");

  // A configured grace is not shortened by the floor — it is a floor, never a
  // ceiling and never an addition.
  assert.equal(intentVerdict(at(NOW - 100 * MIN, { graceMin: 120 }), facts(), NOW).kind, "go");
});

// ── 3b. an occurrence rung 3 has ALREADY released ────────────────────────────
//
// The real case, audited out of a live `.myapp/intents.json`:
//
//   myapp · "We have setup local ai coding with ollama recently…"
//     rule: once · right after the weekly window resets · waits until free
//     · grace 120 min  →  state: failed
//     "missed — the desktop was not running when it was due (more than 120 min late)"
//
// The desktop had been running the whole time. Rung 3 said "due, within grace";
// rung 4.5 (`holdForHost`, the user's own "wait until it's free") held the row;
// the clock kept moving while it was held; and the next tick's rung 3 — which
// re-runs from scratch and remembers nothing — judged the same occurrence missed
// and binned the work, then blamed the machine. The row was killed for doing
// exactly what it was told to do.

test("a row held BELOW rung 3 does not spend its own grace — the observed lost-work case", () => {
  // The user's rule, as close as a pure test can get: weekly, wait-until-free,
  // grace 120 min, and a desktop that is busy for longer than the grace.
  const rule = { kind: "weekly", days: [4], hour: 18, minute: 0 };
  const due = NOW;
  const row = intent({
    auto: true,
    holdForHost: true,
    target: { kind: "repo", fresh: true },
    trigger: { kind: "at", rule, graceMin: 120 },
    nextAt: due,
  });
  const busy = facts({ hostBusy: true });

  // Tick 1: due, inside the grace, and the desktop is busy. It HOLDS — and the
  // verdict says which occurrence this rung let through, so the row can be
  // stamped with it.
  const first = intentVerdict(row, busy, due);
  assert.equal(first.kind, "wait");
  assert.equal(first.reason, "hostBusy");
  assert.equal(first.clearedOccurrence, due);
  // The sentence while held says HELD, never late and never anything about the
  // desktop being off — it is on, and that is why the row is waiting.
  assert.match(first.detail, /waiting for the desktop to be free/);
  assert.doesNotMatch(first.detail, /missed|late|not running/);

  const stamped = { ...row, clearedOccurrence: first.clearedOccurrence };

  // Tick N, three hours later — an hour past the grace. Before the fix this is
  // where the work was lost. It is still held, still saying so.
  const held = intentVerdict(stamped, busy, due + 180 * MIN);
  assert.equal(held.kind, "wait");
  assert.equal(held.reason, "hostBusy");
  assert.match(held.detail, /waiting for the desktop to be free/);
  assert.doesNotMatch(held.detail, /missed/);

  // And the moment the desktop frees up — long past the grace — it RUNS,
  // because the grace answered "is this still worth starting" hours ago and the
  // answer was yes.
  const freed = intentVerdict(stamped, facts({ hostBusy: false }), due + 180 * MIN);
  assert.equal(freed.kind, "go");
  assert.equal(freed.occurrence, due);
  assert.equal(freed.late, true);

  // Without the stamp — i.e. a row this rung never released — the grace still
  // bites exactly as before. This is the half of the behaviour that must NOT
  // change: a desktop that really was asleep still misses.
  const unstamped = intentVerdict(row, facts({ hostBusy: false }), due + 180 * MIN);
  assert.equal(unstamped.reason, "notYet");
  assert.match(unstamped.detail, /^missed — more than 120 min past its time/);
});

test("every rung below rung 3 stamps the release, and rungs above it never do", () => {
  const rule = { kind: "weekly", days: [4], hour: 18, minute: 0 };
  const due = NOW;
  const base = {
    auto: true,
    target: { kind: "repo", fresh: true },
    trigger: { kind: "at", rule, graceMin: 120 },
    nextAt: due,
  };
  const cleared = (i, f) => intentVerdict(intent(i), facts(f), due).clearedOccurrence;

  // Below: serial (4), holdForHost (4.5), noSlot (4.6), target busy (5).
  assert.equal(cleared({ ...base, serial: true }, { busyCwds: new Set([serialGroup("/repo")]) }), due);
  assert.equal(cleared({ ...base, holdForHost: true }, { hostBusy: true }), due);
  assert.equal(cleared(base, { autoSlotsFree: 0 }), due);
  assert.equal(
    cleared({ ...base, target: { kind: "session", sessionId: "s1" } },
            { sessions: [session({ turnActive: true })] }),
    due,
  );

  // Above: the gate (1) and the budget (2). Neither ever reached rung 3, so
  // neither may exempt the row from it — a row that sat `gate` through its whole
  // grace genuinely did miss, and must still say so.
  assert.equal(cleared(base, { autoFire: false }), undefined);
  assert.equal(cleared(base, { budgetBlocked: true }), undefined);
});

test("a released row still expires, at a ceiling that is honest about what it knows", () => {
  const rule = { kind: "weekly", days: [4], hour: 18, minute: 0 };
  const due = NOW;
  const row = intent({
    auto: true,
    holdForHost: true,
    target: { kind: "repo", fresh: true },
    trigger: { kind: "at", rule, graceMin: 120 },
    nextAt: due,
    clearedOccurrence: due,
  });
  const busy = facts({ hostBusy: true });

  // "Held for ever, silently" is not an improvement on "failed wrongly". At 23 h
  // it is still waiting…
  assert.equal(intentVerdict(row, busy, due + 23 * 60 * MIN).reason, "hostBusy");
  // …and past 24 h a recurring rule records the occurrence missed and stands.
  const out = intentVerdict(row, busy, due + 25 * 60 * MIN);
  assert.equal(out.kind, "wait");
  assert.equal(out.reason, "notYet");
  assert.equal(out.missedOccurrence, due);
  // The sentence is the OTHER miss, and it says so: cleared to start, then never
  // got a free moment. It names the grace so the reader can see that the 120 min
  // they configured is not what binned it — and it claims nothing about the
  // cause, exactly as `missedText` does not.
  assert.match(out.detail, /^missed — it was due and cleared to start, then waited 24 h/);
  assert.match(out.detail, /the grace you set was 120 min/);
  assert.doesNotMatch(out.detail, /desktop|not running/);

  // A ONE-OFF has nothing left to repeat, so it fails — with the same sentence.
  const once = { ...row, trigger: { kind: "at", rule: { kind: "once", at: due }, graceMin: 120 } };
  const failed = intentVerdict(once, busy, due + 25 * 60 * MIN);
  assert.equal(failed.kind, "fail");
  assert.match(failed.detail, /^missed — it was due and cleared to start/);

  // A grace LARGER than the ceiling is never shortened by it: the person typed
  // a duration and is entitled to it.
  const week = { ...row, trigger: { kind: "at", rule, graceMin: 7 * 24 * 60 } };
  assert.equal(intentVerdict(week, busy, due + 3 * 24 * 60 * MIN).reason, "hostBusy");
});

test("the stamp is per-OCCURRENCE: last week's hold does not exempt this week's run", () => {
  // The whole reason this is a number and not a boolean. A weekly rule whose
  // previous occurrence was held and eventually ran must have its NEXT occurrence
  // judged from scratch — otherwise one busy Thursday would exempt the rule from
  // its grace for ever.
  const rule = { kind: "weekly", days: [4], hour: 18, minute: 0 };
  const lastWeek = NOW - 7 * 24 * 60 * MIN;
  const thisWeek = NOW;
  const row = intent({
    auto: true,
    holdForHost: true,
    target: { kind: "repo", fresh: true },
    trigger: { kind: "at", rule, graceMin: 120 },
    nextAt: thisWeek,
    clearedOccurrence: lastWeek,
  });
  const v = intentVerdict(row, facts({ hostBusy: false }), thisWeek + 180 * MIN);
  assert.equal(v.reason, "notYet");
  assert.match(v.detail, /^missed — more than 120 min past its time/);
});

test("a chain cleared by rung 3 is not failed by the waits it was told to perform", () => {
  // The `after` arm had the same defect, and it was written down on the trigger
  // as if it were the design: "a chain with `graceMin: 60` held an hour on
  // `serial` or `noSlot` misses, having been awake and ready the whole time."
  const settledAt = NOW - 180 * MIN;
  const row = chained({ trigger: { kind: "after", id: "p1", graceMin: 60 }, serial: true });
  const busyRepo = facts({
    sessions: [session()],
    settled: settled({ at: settledAt }),
    busyCwds: new Set([serialGroup("/repo")]),
  });

  // Held on `serial` at the moment the predecessor settled: the release is
  // stamped against the predecessor's settlement instant.
  const first = intentVerdict(row, facts({
    sessions: [session()], settled: settled({ at: settledAt }), busyCwds: new Set([serialGroup("/repo")]),
  }), settledAt + 1000);
  assert.equal(first.reason, "serial");
  assert.equal(first.clearedOccurrence, settledAt);

  // Three hours later, two hours past the grace, still held — not failed.
  const stamped = { ...row, clearedOccurrence: settledAt };
  assert.equal(intentVerdict(stamped, busyRepo, NOW).reason, "serial");
  // And it runs the moment the repo frees up.
  assert.equal(intentVerdict(stamped, facts({ sessions: [session()], settled: settled({ at: settledAt }) }), NOW).kind, "go");

  // Unstamped, the grace bites as before.
  assert.equal(intentVerdict(row, facts({ sessions: [session()], settled: settled({ at: settledAt }) }), NOW).kind, "fail");
});

test("cleanIntentRow keeps the release across a restart", () => {
  // It is persisted precisely because the hold outlives the process: dropping it
  // on load would re-arm the bug on the first tick after `npm run restart`.
  const kept = cleanIntentRow(raw({ clearedOccurrence: NOW - 5 * MIN }), NOW);
  assert.equal(kept.clearedOccurrence, NOW - 5 * MIN);
  assert.equal(cleanIntentRow(raw({}), NOW).clearedOccurrence, undefined);
  assert.equal(cleanIntentRow(raw({ clearedOccurrence: "nope" }), NOW).clearedOccurrence, undefined);
});

test("graceMin null and empty are ABSENT, not zero", () => {
  // `Number(null) === 0` and `Number("") === 0`, and 0 is the most destructive
  // value this field has. `null` is JSON's spelling of absent: what a client
  // serialising an unset optional sends, what an `intent.update` carries to
  // CLEAR the field, and what a hand-edited file holds. Read as 0 it turned
  // "no deadline" into "only if it is immediate" — the documented default for a
  // chain, inverted, in silence. `cleanRule` reads `minPctLeft` the same way,
  // two functions away in the file this one imports.
  const after = (graceMin) => cleanIntentRow(raw({ trigger: { kind: "after", id: "p1", graceMin } }), NOW).trigger.graceMin;
  assert.equal(after(null), undefined);
  assert.equal(after(""), undefined);
  assert.equal(after(undefined), undefined);
  assert.equal(after(0), 0, "a 0 somebody actually typed is still a 0");
  assert.equal(after(30), 30);

  const clock = (graceMin) =>
    cleanIntentRow(raw({ trigger: { kind: "at", rule: { kind: "weekly", hour: 9 }, graceMin } }), NOW).trigger.graceMin;
  assert.equal(clock(null), 120, "the documented default, not the destructive one");
  assert.equal(clock(""), 120);
  assert.equal(clock(0), 0);
});

test("a chain that bites its own tail fails with a sentence instead of spinning", () => {
  // Two rows pointing at each other settle nothing, so each reads the other as
  // "not finished yet" for ever — a pair that looks exactly like work which is
  // next in line and is in fact work that will never start.
  const self = chained({ trigger: { kind: "after", id: "i1" } });
  // The self-loop needs no map at all: a row cannot be its own predecessor.
  const v = intentVerdict(self, facts({ sessions: [session()] }), NOW);
  assert.equal(v.kind, "fail");
  assert.match(v.detail, /waiting on each other in a circle/);

  // A longer loop needs the edges, and the host's map is what supplies them.
  const loop = facts({ sessions: [session()], chainWaits: new Map([["i1", "p1"], ["p1", "i1"]]) });
  assert.equal(intentVerdict(chained(), loop, NOW).kind, "fail");

  // A loop the row is not IN still traps it: i1 → p1 → p2 → p1 never settles.
  const downstream = facts({ sessions: [session()], chainWaits: new Map([["i1", "p1"], ["p1", "p2"], ["p2", "p1"]]) });
  assert.equal(intentVerdict(chained(), downstream, NOW).kind, "fail");

  // A chain that terminates is not a loop — it is simply waiting.
  const fine = facts({ sessions: [session()], chainWaits: new Map([["i1", "p1"], ["p1", "p2"]]) });
  assert.equal(intentVerdict(chained(), fine, NOW).reason, "notYet");
});

test("a chain behind a row that never ends FAILS, instead of waiting for ever", () => {
  // `settled` is terminal-only by contract, and a recurring rule never goes
  // terminal — it fires, re-arms and does it again. So every other answer in
  // this rung is "not yet", which is true, reassuring, and permanent: the
  // precise shape of lost work the store exists to make impossible. The picker
  // declines to offer one, but a rule can be edited from *once* to *every day*
  // long after the chain behind it was made, so the filter cannot be the guard.
  const never = facts({
    sessions: [session()],
    knownIntents: new Set(["i1", "p1"]),
    neverSettles: new Set(["p1"]),
  });
  const v = intentVerdict(chained({ trigger: { kind: "after", id: "p1", title: "the nightly sweep" } }), never, NOW);
  assert.equal(v.kind, "fail");
  assert.match(v.detail, /“the nightly sweep” *\) is a repeating rule, so it never finishes/);
  assert.match(v.detail, /chain it to one run of that work/, "…and what to do instead");

  // It outranks "gone": a recurring row IS there, so `knownIntents` would say
  // wait and the reader would be told the truest wrong thing.
  const alsoGone = facts({ sessions: [session()], knownIntents: new Set(["i1"]), neverSettles: new Set(["p1"]) });
  assert.match(intentVerdict(chained(), alsoGone, NOW).detail, /repeating rule/);

  // Absent = nobody said = the old behaviour, which is to wait. A fact that
  // failed rows by being missing would kill work whose predecessor is fine.
  assert.equal(intentVerdict(chained(), facts({ sessions: [session()], knownIntents: new Set(["i1", "p1"]) }), NOW).reason, "notYet");
  // And a predecessor nobody named as endless is unaffected.
  assert.equal(intentVerdict(chained(), facts({ sessions: [session()], neverSettles: new Set(["other"]), settled: settled() }), NOW).kind, "go");
});

test("a predecessor somebody ARCHIVED says so, instead of waiting for ever", () => {
  // Archiving is not terminating. `edit({archived:true})` leaves the row
  // `queued`: it is in `knownIntents`, out of `settled`, and not the kind of
  // thing `neverSettles` names — so every other answer in this rung is *waits
  // for “X” to finish*, for ever, about work nobody is going to start. Somebody
  // archived "run the migration" to tidy the list and "review the migration"
  // sat in Activity waiting for it, with nothing on either row saying what
  // would release it.
  const aside = facts({
    sessions: [session()],
    knownIntents: new Set(["i1", "p1"]),
    setAside: new Set(["p1"]),
  });
  const v = intentVerdict(chained({ trigger: { kind: "after", id: "p1", title: "run the migration" } }), aside, NOW);
  // A WAIT and not a fail: un-archiving genuinely releases it, so failing here
  // would bin the work of somebody who was only tidying a list.
  assert.equal(v.kind, "wait");
  assert.equal(v.reason, "notYet");
  assert.match(v.detail, /“run the migration”\) is archived/);
  assert.match(v.detail, /bring it back to release this, or give this one a time/, "both doors out");
  // Without the title it still reads — the snapshot is optional everywhere.
  assert.match(intentVerdict(chained(), aside, NOW).detail, /^the item this waits for is archived/);

  // Absent = nobody said = the old sentence, unchanged.
  const quiet = facts({ sessions: [session()], knownIntents: new Set(["i1", "p1"]) });
  assert.equal(intentVerdict(chained(), quiet, NOW).detail, "waits for the item before it to finish");
  // And a row that was archived AFTER it finished releases the chain as ever:
  // the fact is only consulted when nothing has settled.
  const settledToo = facts({ sessions: [session()], setAside: new Set(["p1"]), settled: settled() });
  assert.equal(intentVerdict(chained(), settledToo, NOW).kind, "go");
});

test("a predecessor somebody CALLED OFF fails the chain — a cancel is not “afterwards”", () => {
  // `settle(row, "canceled")` records `{ok: false}`, and an unqualified chain
  // does not read `ok` at all, so a cancel released the row exactly like a
  // success: "after the migration, review it and post the diff" reviewed a
  // migration that had been stopped half-way, unattended, and the person who
  // had just pressed cancel was not asked.
  const off = facts({ sessions: [session()], settled: settled({ ok: false, canceled: true }) });
  const v = intentVerdict(chained(), off, NOW);
  assert.equal(v.kind, "fail");
  assert.match(v.detail, /^the item it waited for was called off/);
  assert.match(v.detail, /give it a time, or chain it to another/);
  // It does not depend on `onlyIfOk`, which is the opt-in this row never took —
  // and could not have taken, since the chain was made before the cancel.
  assert.equal(intentVerdict(chained({ trigger: { kind: "after", id: "p1", onlyIfOk: true } }), off, NOW).kind, "fail");
  // A cancel that also SUCCEEDED is not a thing, but the flag outranks `ok`
  // either way: nothing re-runs a cancelled row, so this can never clear.
  assert.equal(intentVerdict(chained(), facts({ sessions: [session()], settled: settled({ canceled: true }) }), NOW).kind, "fail");
  // Absent = the old behaviour: a plain failure still releases an unqualified
  // chain, because "run the tests, then tell me what happened" wants to run.
  assert.equal(intentVerdict(chained(), facts({ sessions: [session()], settled: settled({ ok: false }) }), NOW).kind, "go");
});

test("a SETTLED row is a chain end, not a link — a finished cycle stops trapping live work", () => {
  // `chainWaits` carries every row's `after` edge, terminal rows included, so a
  // row that has already finished still looks like it is waiting on whatever it
  // named when it was posted. A↔B, B run by hand and done: the walk from A
  // reached B, followed B's stale edge back to A and failed A for ever —
  // although B has settled and A is exactly the row B's finish should release.
  const closed = facts({
    sessions: [session()],
    chainWaits: new Map([["i1", "p1"], ["p1", "i1"]]),
    settled: settled(),
  });
  assert.equal(intentVerdict(chained(), closed, NOW).kind, "go");

  // A LIVE cycle still fails — the guard is "stop at a settled row", not "stop
  // looking".
  const open = facts({ sessions: [session()], chainWaits: new Map([["i1", "p1"], ["p1", "i1"]]) });
  assert.equal(intentVerdict(chained(), open, NOW).kind, "fail");
  // …and a settled row further along the chain ends the walk before the loop
  // behind it: i1 → p1 (settled) → p2 → p1.
  const beyond = facts({
    sessions: [session()],
    chainWaits: new Map([["i1", "p1"], ["p1", "p2"], ["p2", "p1"]]),
    settled: settled(),
  });
  assert.equal(intentVerdict(chained(), beyond, NOW).kind, "go");
});

test("a chained prompt is WORK, not a schedule", () => {
  // It has no recurrence, no clock to arm and nothing for the schedule sheet to
  // pause. Filing it there would put it on the one screen that can say nothing
  // true about it, and take it off the list of the repo's waiting work — which
  // is exactly what it is.
  assert.equal(intentKind(cleanIntentRow(raw({ trigger: { kind: "after", id: "p1" } }), NOW)), "work");
  assert.equal(intentKind(cleanIntentRow(raw({ trigger: { kind: "at", rule: { kind: "weekly", hour: 9 } } }), NOW)), "schedule");
});

// ── RECURRENCE decides the list ─────────────────────────────────────────────
//
// The same argument one trigger over. A ONE-OFF `at` aimed at one place is
// waiting work whose WHEN happens to be an instant: spent by its one run, with
// no recurrence left to arm, pause or skip. Measured, on the desktop this was
// written for: 9 live `at` rows, every one one-off, zero recurring — a second
// backlog with clocks on it, which nobody grooming the list ever saw.

/** A row with a clock, aimed at one repo unless told otherwise. */
const timed = (rule, over = {}) => cleanIntentRow(raw({ trigger: { kind: "at", rule, graceMin: 120 }, ...over }), NOW);

test("a one-off with a clock is WORK; a rule that recurs, and a one-off SWEEP, are schedules", () => {
  const once = timed({ kind: "once", at: NOW + 3600e3 });
  assert.equal(isTimedWorkRow(once), true);
  assert.equal(isBacklogRow(once), true, "it is in the repo's backlog, where its verbs are");
  assert.equal(isScheduleRow(once), false);
  assert.equal(intentKind(once), "work");

  // The anchor is not the question — recurrence is. A `weekly` or `window` rule
  // marked `oneShot` fires once and is done, exactly like a `once`.
  const oneShot = timed({ kind: "window", window: "session", edge: "after", offsetMin: 0, oneShot: true });
  assert.equal(isTimedWorkRow(oneShot), true, "`oneShot` is the recurrence question, whatever the anchor");
  assert.equal(intentKind(oneShot), "work");

  // A standing rule is a standing rule wherever it is aimed.
  const rule = timed({ kind: "weekly", hour: 9 });
  assert.equal(isTimedWorkRow(rule), false);
  assert.equal(isBacklogRow(rule), false);
  assert.equal(isScheduleRow(rule), true);

  // A one-off SWEEP is the exception, and the reason is that there is no single
  // backlog for it to live in: it names every repo it touches.
  const sweep = timed({ kind: "once", at: NOW + 3600e3 }, { target: { kind: "repos", dirs: ["/a", "/b"] } });
  assert.equal(isTimedWorkRow(sweep), false);
  assert.equal(isScheduleRow(sweep), true);
  assert.equal(intentKind(sweep), "schedule");

  // A fan-out CHILD is one repo of a sweep and is classified by provenance, so
  // it is never work and never a card, clock or no clock.
  const child = timed({ kind: "once", at: NOW + 3600e3 }, { groupId: "g1", origin: ORIGIN_FANOUT_TARGET });
  assert.equal(isTimedWorkRow(child), false);
  assert.equal(isBacklogRow(child), false, "the fan-out owns what a target's delivery means, clock or no clock");
  // (`intentKind` still says `schedule` for this shape, because its order is
  // unchanged and asks the trigger before the provenance. The claim here is
  // only that the clock never makes one of these a work item — a sweep's
  // targets are `idle` rows in practice, and those read `fanout` as they always
  // did.)
  assert.equal(intentKind(cleanIntentRow(raw({ trigger: { kind: "idle" }, groupId: "g1", origin: ORIGIN_FANOUT_TARGET }), NOW)), "fanout");

  // A build has no words to put in a backlog.
  const build = cleanIntentRow(raw({
    payload: { kind: "build", buildId: "b", name: "APK", cmd: "gradle", cwd: "/repo" },
    target: { kind: "shell" },
    trigger: { kind: "at", rule: { kind: "once", at: NOW + 3600e3 }, graceMin: 120 },
  }), NOW);
  assert.equal(isTimedWorkRow(build), false);
});

test("the classification is DERIVED, so an edit of the rule moves the row with nothing migrated", () => {
  // The alternative — a stored "which list am I in" — is a second fact beside
  // the trigger, free to disagree with it the first time somebody edits a
  // schedule from *tonight* to *every Thursday*.
  const row = timed({ kind: "once", at: NOW + 3600e3 });
  assert.equal(isBacklogRow(row), true);
  const edited = { ...row, trigger: { ...row.trigger, rule: { kind: "weekly", hour: 9 } } };
  assert.equal(isBacklogRow(edited), false);
  assert.equal(isScheduleRow(edited), true);
  // …and back again, off the same row object: nothing on it remembers.
  assert.equal(isBacklogRow({ ...edited, trigger: row.trigger }), true);
});

test("timedWorkKey is equality for `the same clock`, and absent for a row without one", () => {
  // Anything folding two rows into one must do so only when it decides no
  // clock — so "same clock" has to be one expression, not a comparison spelled
  // out at each call site.
  const rule = { kind: "once", at: NOW + 3600e3 };
  const a = timed(rule);
  const b = cleanIntentRow(raw({ id: "i2", trigger: { kind: "at", rule, graceMin: 120 } }), NOW);
  assert.equal(typeof timedWorkKey(a), "string");
  assert.equal(timedWorkKey(a), timedWorkKey(b), "same rule, same grace, same hold");

  assert.notEqual(timedWorkKey(a), timedWorkKey(timed(rule, { holdForHost: true })),
    "*wait until the desktop is free* is part of WHEN, so it is part of the key");
  assert.notEqual(timedWorkKey(a), timedWorkKey(cleanIntentRow(raw({ trigger: { kind: "at", rule, graceMin: 5 } }), NOW)),
    "a different grace is a different answer to how late is too late");
  assert.notEqual(timedWorkKey(a), timedWorkKey(timed({ kind: "once", at: NOW + 7200e3 })));

  // Absent, never a shared empty string: two untimed rows must not compare
  // equal ON THE KEY, and a caller has to ask `isTimedWorkRow` to tell them
  // apart from each other.
  assert.equal(timedWorkKey(cleanIntentRow(raw({ trigger: { kind: "idle" } }), NOW)), undefined);
  assert.equal(timedWorkKey(timed({ kind: "weekly", hour: 9 })), undefined, "a standing rule is not a work item's clock");
});

test("cleanTrigger refuses a chain that names nothing, and clamps the rest", () => {
  // Same call `cleanTarget` makes for a session target with no id: defaulting
  // to `now` runs work whose whole point was to wait, and keeping an empty id
  // stores a row that can never be released and can never say what it waits for.
  assert.equal(cleanIntentRow(raw({ trigger: { kind: "after" } }), NOW), null);
  assert.equal(cleanIntentRow(raw({ trigger: { kind: "after", id: "   " } }), NOW), null);

  const t = cleanIntentRow(raw({ trigger: { kind: "after", id: "p1", onlyIfOk: "yes", graceMin: 99999, title: "z".repeat(500) } }), NOW).trigger;
  assert.equal(t.kind, "after");
  assert.equal(t.onlyIfOk, undefined);       // hostile ⇒ the permissive reading, which is "afterwards"
  assert.equal(t.graceMin, 7 * 24 * 60);     // a week, the ceiling `at` uses
  assert.equal(t.title.length, 200);
  // Absent stays ABSENT rather than becoming DEFAULT_GRACE_MIN — the default
  // for a chain is no deadline.
  assert.equal(cleanIntentRow(raw({ trigger: { kind: "after", id: "p1" } }), NOW).trigger.graceMin, undefined);
  assert.equal(cleanIntentRow(raw({ trigger: { kind: "after", id: "p1", onlyIfOk: true } }), NOW).trigger.onlyIfOk, true);
});

// ── A chain of STEPS is one row, at every rung ──────────────────────────────

test("nothing in the ladder or the sanitiser assumes one step", () => {
  // A scheduled chain is one intent carrying N turns (`payload.steps`), not N
  // intents — `deliverChain` runs them one turn at a time into the session the
  // row opened. So the words all survive the door, and the whole chain gets ONE
  // verdict rather than one per step.
  const steps = ["write the migration", "run it", "tell me what changed"];
  const row = cleanIntentRow(raw({ payload: { kind: "prompt", steps }, trigger: { kind: "at", rule: { kind: "weekly", hour: 9 } }, nextAt: NOW - MIN }), NOW);
  assert.deepEqual(row.payload.steps, steps);
  const v = intentVerdict({ ...row, target: { kind: "session", sessionId: "s1" } }, facts({ sessions: [session()] }), NOW);
  assert.equal(v.kind, "go");
  assert.equal(v.occurrence, NOW - MIN);
  // And a chain rides an `after` trigger just as happily — S4 is a field that
  // was already there, not a new one.
  const after = cleanIntentRow(raw({ payload: { kind: "prompt", steps }, trigger: { kind: "after", id: "p1" } }), NOW);
  assert.deepEqual(after.payload.steps, steps);
});

test("a schedule's item names the rule that wrote it, and the rule's OWN row does not", () => {
  // The link used to be `ScheduleResult.childId` alone — the LAST item a rule
  // wrote — so a nightly rule that had run four times showed "backlog · 1 item"
  // and three rows in the list said where they came from: nowhere.
  assert.equal(scheduleItemOrigin("ab12cd34"), "schedule:ab12cd34");
  assert.equal(scheduleIdFromOrigin("schedule:ab12cd34"), "ab12cd34");
  // `schedule:` already had two RESERVED suffixes, on the rule's own row. A bare
  // `startsWith("schedule:")` on the far side of the wire would have read those
  // as an entry id called "work" and drawn a chip pointing at nothing.
  assert.equal(scheduleIdFromOrigin("schedule:work"), undefined);
  assert.equal(scheduleIdFromOrigin("schedule:sweep"), undefined);
  // And everything else is absent, never guessed.
  assert.equal(scheduleIdFromOrigin("assess:abc"), undefined);
  assert.equal(scheduleIdFromOrigin("schedule:"), undefined);
  assert.equal(scheduleIdFromOrigin(undefined), undefined);
  // It survives the round trip to disk like any other origin.
  assert.equal(cleanIntentRow(raw({ origin: scheduleItemOrigin("ab12cd34") }), NOW).origin, "schedule:ab12cd34");
});


// ── The naming pair, which travels together or not at all ───────────────────
//
// A title that cannot say who wrote it cannot say whether a person may be
// overwritten — `hand` is the one author that makes a title un-replaceable, so
// a title with no author is a title with no defence. Every case below is the
// same rule seen from a different side: the pair is dropped PAIRWISE, and
// nothing is repaired into an author or a kind that nobody wrote.

test("a title with no author is not stored — it could not defend itself against the next run", () => {
  const row = cleanIntentRow(raw({ headline: "Uploader drops big files" }), NOW);
  assert.equal(row.headline, undefined);
  assert.equal(row.headlineBy, undefined);
});

test("an author with nothing to be the author OF is a stamp on a row nobody named", () => {
  const row = cleanIntentRow(raw({ headlineBy: "assess", categoryBy: "name" }), NOW);
  assert.equal(row.headline, undefined);
  assert.equal(row.headlineBy, undefined);
  assert.equal(row.category, undefined);
  assert.equal(row.categoryBy, undefined);
});

test("an author this app does not know is not an author, and takes the title with it", () => {
  // Defaulting it either way would be a claim about who typed something.
  const row = cleanIntentRow(raw({ headline: "Uploader drops big files", headlineBy: "machine" }), NOW);
  assert.equal(row.headline, undefined);
  assert.equal(row.headlineBy, undefined);
});

test("a kind outside the four is dropped rather than rounded, and takes its author with it", () => {
  // Absent means NOBODY SAID. "chore" for every row nobody looked at is a row
  // filed under a heading its author never chose.
  const row = cleanIntentRow(raw({ category: "bugfix", categoryBy: "assess" }), NOW);
  assert.equal(row.category, undefined);
  assert.equal(row.categoryBy, undefined);
});

test("a complete pair survives the round trip to disk, both halves of it", () => {
  const row = cleanIntentRow(raw({
    headline: "Uploader drops big files", headlineBy: "name",
    category: "bug", categoryBy: "assess",
  }), NOW);
  assert.equal(row.headline, "Uploader drops big files");
  assert.equal(row.headlineBy, "name");
  assert.equal(row.category, "bug");
  assert.equal(row.categoryBy, "assess");
  // …and the two halves are independent: a kind with no title is an honest row.
  const half = cleanIntentRow(raw({ category: "chore", categoryBy: "hand" }), NOW);
  assert.equal(half.headline, undefined);
  assert.equal(half.category, "chore");
  assert.equal(half.categoryBy, "hand");
});

test("a 'title' that is only the opening of the row's own prompt never reaches the row", () => {
  // The same string twice on one card, cut once by the slice and again by CSS
  // ellipsis. The words are right underneath it and lose nothing.
  const steps = ["fix the uploader so it stops dropping files over ten megabytes"];
  const row = cleanIntentRow(raw({
    payload: { kind: "prompt", steps },
    headline: "fix the uploader so it stops", headlineBy: "name",
  }), NOW);
  assert.equal(row.headline, undefined);
  assert.equal(row.headlineBy, undefined);
  assert.deepEqual(row.payload.steps, steps);
});

// ── pastBudget: a waiver of rung 2, and of nothing below it ──────────────────
//
// The re-time sheet's bulk release used to send `intent.run` per row, and
// `runNow` skips the whole ladder: four rows in one repo started in parallel in
// one worktree. `pastBudget` lifts the budget and leaves every rung below it
// holding — that is the whole contract, pinned rung by rung.

// The waiver is SCOPED to the budget window it was granted in (`until`, the
// reset): a bare flag lived until the row started, so a one-off for tomorrow
// waived tonight fired tomorrow past a fresh, unrelated block.
const WAIVED = { until: NOW + 3_600_000 };

test("pastBudget lifts the budget rung for an auto row — inside its window", () => {
  const fresh = { auto: true, target: { kind: "repo", fresh: true } };
  assert.equal(intentVerdict(intent(fresh), facts({ budgetBlocked: true }), NOW).reason, "budget");
  assert.equal(intentVerdict(intent({ ...fresh, pastBudget: WAIVED }), facts({ budgetBlocked: true }), NOW).kind, "go");
});

test("an expired waiver is no waiver — the next window's block holds the row", () => {
  const i = intent({ auto: true, target: { kind: "repo", fresh: true }, pastBudget: WAIVED });
  assert.equal(intentVerdict(i, facts({ budgetBlocked: true }), WAIVED.until).reason, "budget", "at the reset it is over");
  assert.equal(intentVerdict(i, facts({ budgetBlocked: true }), WAIVED.until + 86_400_000).reason, "budget");
  assert.equal(budgetWaived(i, WAIVED.until - 1), true);
  assert.equal(budgetWaived(i, WAIVED.until), false);
  assert.equal(budgetWaived(intent({}), NOW), false);
});

test("a waiver lifts every tripped cap at once, where budgetPass lifts only its own window's", () => {
  const i = intent({ auto: true, target: { kind: "repo", fresh: true }, pastBudget: WAIVED });
  const over = [
    { which: "session", pct: 90, max: 75, resetAt: NOW + 1_000 },
    { which: "weekly", pct: 90, max: 75, resetAt: NOW + 2_000 },
  ];
  assert.equal(intentVerdict(i, facts({ budgetBlocked: true, budgetOver: over }), NOW).kind, "go");
});

test("budgetWaiverUntil is the latest known reset among the tripped caps, or null", () => {
  assert.equal(budgetWaiverUntil([
    { which: "session", pct: 90, max: 75, resetAt: NOW + 1_000 },
    { which: "weekly", pct: 90, max: 75, resetAt: NOW + 9_000 },
  ], NOW), NOW + 9_000);
  assert.equal(budgetWaiverUntil([{ which: "session", pct: 90, max: 75, resetAt: null }], NOW), null, "no reset said ⇒ no window to scope it to");
  assert.equal(budgetWaiverUntil([{ which: "session", pct: 90, max: 75, resetAt: NOW - 1 }], NOW), null, "a reset already past is no window");
  assert.equal(budgetWaiverUntil([], NOW), null);
  assert.equal(budgetWaiverUntil(undefined, NOW), null);
});

test("pastBudget leaves serial, hostBusy, noSlot and the gate holding", () => {
  const waived = intent({ auto: true, pastBudget: WAIVED, serial: true, holdForHost: true, target: { kind: "repo", fresh: true } });
  const broke = { budgetBlocked: true };
  assert.equal(intentVerdict(waived, facts({ ...broke, busyCwds: new Set([serialGroup("/repo")]) }), NOW).reason, "serial");
  assert.equal(intentVerdict(waived, facts({ ...broke, hostBusy: true }), NOW).reason, "hostBusy");
  assert.equal(intentVerdict(waived, facts({ ...broke, autoSlotsFree: 0 }), NOW).reason, "noSlot");
  // The gate is ABOVE the budget: a waiver of the account is not a way past
  // the switch that routes all machinery.
  assert.equal(intentVerdict(waived, facts({ ...broke, autoFire: false }), NOW).reason, "gate");
});

test("a budget TRIGGER is waived too — the newer answer to the same question — inside its window", () => {
  const i = intent({ trigger: { kind: "budget" }, pastBudget: WAIVED });
  assert.equal(intentVerdict(i, facts({ budgetBlocked: true, sessions: [session()] }), NOW).kind, "go");
  assert.equal(intentVerdict(i, facts({ budgetBlocked: true, sessions: [session()] }), WAIVED.until).reason, "budget");
});

test("cleanIntentRow keeps pastBudget only as a window, and drops the legacy flag", () => {
  assert.deepEqual(cleanIntentRow(raw({ pastBudget: { until: NOW + 5 } }), NOW).pastBudget, { until: NOW + 5 });
  assert.equal(cleanIntentRow(raw({ pastBudget: true }), NOW).pastBudget, undefined,
    "a waiver that recorded no window cannot be scoped — dropped, so the row just waits for the budget");
  assert.equal(cleanIntentRow(raw({ pastBudget: false }), NOW).pastBudget, undefined);
  assert.equal(cleanIntentRow(raw({ pastBudget: { until: "soon" } }), NOW).pastBudget, undefined);
  assert.equal(cleanIntentRow(raw({ pastBudget: { until: Infinity } }), NOW).pastBudget, undefined);
  assert.equal(cleanIntentRow(raw({}), NOW).pastBudget, undefined);
});

// ── 2b. the before-reset pass ───────────────────────────────────────────────
//
// The incident: twelve auto rows timed *an hour before the weekly window
// resets* never fired, because the weekly budget (75%) was at 97% and rung 2
// held them — the ceiling was saving allowance for later in a window that had
// one hour left. A row timed BEFORE a reset is lifted past that SAME window's
// ceiling between its own time and the reset; everything else still holds.

const R = NOW + 30 * MIN;                       // the weekly reset
const beforeWeekly = (over = {}) => ({ kind: "window", window: "weekly", edge: "before", offsetMin: -60, oneShot: true, ...over });
const passRow = (rule = beforeWeekly(), over = {}) =>
  intent({
    auto: true,
    target: { kind: "repo", fresh: true },
    trigger: { kind: "at", rule, graceMin: 120 },
    nextAt: R - 60 * MIN,
    ...over,
  });
const weeklyCap = (over = {}) => ({ which: "weekly", pct: 97, max: 75, resetAt: R, ...over });
const sessionCap = (over = {}) => ({ which: "session", pct: 95, max: 90, resetAt: NOW + 2 * 60 * MIN, ...over });
const overBudget = (caps) => facts({ budgetBlocked: true, budgetDetail: "the host's sentence", budgetOver: caps });

test("a before-reset row runs past its own window's ceiling between its time and the reset", () => {
  const v = intentVerdict(passRow(), overBudget([weeklyCap()]), R - 30 * MIN);
  assert.equal(v.kind, "go");
});

test("…and is held before its time, told it will be lifted then", () => {
  const v = intentVerdict(passRow(), overBudget([weeklyCap()]), R - 90 * MIN);
  assert.equal(v.reason, "budget");
  assert.match(v.detail, /97% of the weekly window used/);
  assert.match(v.detail, /lifted for this row at its time/);
});

test("past the reset a new window's ceiling holds it plainly", () => {
  const next = weeklyCap({ resetAt: R + 7 * 24 * 60 * MIN });
  const v = intentVerdict(passRow(), overBudget([next]), R + 10 * MIN);
  assert.equal(v.reason, "budget");
  assert.doesNotMatch(v.detail, /exempt|lifted/);
});

test("an after-edge rule and a zero lead time carry no pass", () => {
  const after = passRow(beforeWeekly({ edge: "after", offsetMin: 0 }), { nextAt: R - 60 * MIN });
  assert.equal(intentVerdict(after, overBudget([weeklyCap()]), R - 30 * MIN).reason, "budget");
  const atReset = passRow(beforeWeekly({ offsetMin: 0 }), { nextAt: R });
  assert.equal(intentVerdict(atReset, overBudget([weeklyCap()]), R - 30 * MIN).reason, "budget");
  assert.equal(budgetPassAt(beforeWeekly({ offsetMin: 0 }), R), null);
  assert.equal(budgetPassAt(beforeWeekly({ edge: "after", offsetMin: -60 }), R), null);
  assert.equal(budgetPassAt({ kind: "weekly", days: [4], hour: 18, minute: 0, offsetMin: -60 }, R), null);
  // Absent edge is `before` and absent window is `session`, as `nextFireAt` reads them.
  assert.deepEqual(budgetPassAt({ kind: "window", offsetMin: -60 }, R - 60 * MIN), { window: "session", from: R - 60 * MIN, until: R });
});

test("the OTHER window's cap still holds, and says which exemption it does not cover", () => {
  const S = NOW + 2 * 60 * MIN;
  const beforeSession = passRow(beforeWeekly({ window: "session" }), { nextAt: S - 60 * MIN });
  const v = intentVerdict(beforeSession, overBudget([weeklyCap()]), S - 30 * MIN);
  assert.equal(v.reason, "budget");
  assert.match(v.detail, /weekly window used/);
  assert.match(v.detail, /exempt from the session ceiling, not from this one/);
});

// A session cap saves allowance for later in a week that ends at the reset the
// row is timed ahead of — the same "there is no later" — so a weekly pass
// covers it. The reverse is not true: see the test above.
test("a before-WEEKLY row is lifted past the session ceiling too, inside the same span", () => {
  assert.equal(intentVerdict(passRow(), overBudget([sessionCap(), weeklyCap()]), R - 30 * MIN).kind, "go");
  assert.equal(intentVerdict(passRow(), overBudget([sessionCap()]), R - 30 * MIN).kind, "go",
    "weekly under its ceiling, session over it");
  const early = intentVerdict(passRow(), overBudget([sessionCap()]), R - 90 * MIN);
  assert.equal(early.reason, "budget");
  assert.match(early.detail, /session window used/);
  assert.match(early.detail, /lifted for this row at its time — it is timed before the weekly window resets/);
  // Past the weekly reset the session cap holds plainly — a new week.
  const after = intentVerdict(passRow(), overBudget([sessionCap({ resetAt: R + 60 * MIN })]), R + 10 * MIN);
  assert.equal(after.reason, "budget");
  assert.doesNotMatch(after.detail, /exempt|lifted/);
  // A weekly reset that MOVED is another window: nothing is lifted, the session cap included.
  const moved = weeklyCap({ resetAt: R + RESET_MATCH_MS + MIN });
  assert.equal(intentVerdict(passRow(), overBudget([sessionCap(), moved]), R - 30 * MIN).reason, "budget");
});

test("a reset that MOVED is another window — no pass", () => {
  const moved = weeklyCap({ resetAt: R + RESET_MATCH_MS + MIN });
  assert.equal(intentVerdict(passRow(), overBudget([moved]), R - 30 * MIN).reason, "budget");
  // Inside the tolerance is the same reset, re-read and rounded.
  const nudged = weeklyCap({ resetAt: R + 30_000 });
  assert.equal(intentVerdict(passRow(), overBudget([nudged]), R - 30 * MIN).kind, "go");
});

test("the scrape's minute of jitter never drops the lift, on either side", () => {
  // Measured: consecutive readings of one reset differ by EXACTLY 60 000 ms
  // (a relative *resets in 1h 59m* truncated to the minute). `nextAt` was
  // fixed from one of them; the ceiling carries whichever came last.
  for (const d of [-60_000, 60_000]) {
    const v = intentVerdict(passRow(), overBudget([weeklyCap({ resetAt: R + d })]), R - 30 * MIN);
    assert.equal(v.kind, "go", `reset read ${d / 1000}s off`);
  }
  // …and the lift runs to the LATER of the two readings, not a minute short.
  assert.equal(intentVerdict(passRow(), overBudget([weeklyCap({ resetAt: R + 60_000 })]), R + 30_000).kind, "go");
  // The tolerance edge is inclusive.
  assert.equal(intentVerdict(passRow(), overBudget([weeklyCap({ resetAt: R + RESET_MATCH_MS })]), R - 30 * MIN).kind, "go");
});

test("nobody said which cap ⇒ held as before, in the host's own sentence", () => {
  const v = intentVerdict(passRow(), facts({ budgetBlocked: true, budgetDetail: "the host's sentence" }), R - 30 * MIN);
  assert.equal(v.reason, "budget");
  assert.equal(v.detail, "the host's sentence");
  const empty = intentVerdict(passRow(), overBudget([]), R - 30 * MIN);
  assert.equal(empty.reason, "budget");
});

test("pinned and recurring rows are lifted the same way", () => {
  assert.equal(intentVerdict(passRow(beforeWeekly(), { pinned: true }), overBudget([weeklyCap()]), R - 30 * MIN).kind, "go");
  const recurring = passRow(beforeWeekly({ oneShot: undefined }));
  assert.equal(intentVerdict(recurring, overBudget([weeklyCap()]), R - 30 * MIN).kind, "go");
  assert.equal(intentVerdict(recurring, overBudget([weeklyCap()]), R - 90 * MIN).reason, "budget");
});

test("a budget TRIGGER is never lifted — it asked to wait until under the ceiling", () => {
  const pass = { window: "weekly", from: R - 60 * MIN, until: R };
  const i = intent({ auto: true, trigger: { kind: "budget" }, budgetPass: pass });
  const v = intentVerdict(i, overBudget([weeklyCap()]), R - 30 * MIN);
  assert.equal(v.reason, "budget");
});

test("a recurring rule's child carries the pass as a stamp: lifted inside, held outside", () => {
  const pass = { window: "weekly", from: R - 60 * MIN, until: R };
  const child = intent({ auto: true, target: { kind: "repo", fresh: true }, trigger: { kind: "idle" }, budgetPass: pass });
  assert.deepEqual(budgetPassOf(child), pass);
  assert.equal(intentVerdict(child, overBudget([weeklyCap()]), R - 30 * MIN).kind, "go");
  for (const d of [-60_000, 60_000]) {
    assert.equal(intentVerdict(child, overBudget([weeklyCap({ resetAt: R + d })]), R - 30 * MIN).kind, "go", `stamp vs a reset read ${d / 1000}s off`);
  }
  assert.equal(intentVerdict(child, overBudget([weeklyCap({ resetAt: R + RESET_MATCH_MS + MIN })]), R - 30 * MIN).reason, "budget");
  assert.match(intentVerdict(child, overBudget([weeklyCap()]), R - 90 * MIN).detail, /lifted for this row/);
  assert.equal(intentVerdict(child, overBudget([weeklyCap({ resetAt: R + 7 * 24 * 60 * MIN })]), R + MIN).reason, "budget");
  // A row with no stamp and no clock has no pass.
  assert.equal(budgetPassOf(intent({ trigger: { kind: "idle" } })), null);
});

test("cleanIntentRow keeps a well-formed budgetPass and drops everything else", () => {
  const good = { window: "weekly", from: NOW, until: NOW + 60 * MIN };
  assert.deepEqual(cleanIntentRow(raw({ budgetPass: good }), NOW).budgetPass, good);
  assert.equal(cleanIntentRow(raw({ budgetPass: { ...good, until: NOW } }), NOW).budgetPass, undefined);
  assert.deepEqual(cleanIntentRow(raw({ budgetPass: { ...good, window: "month" } }), NOW).budgetPass, { ...good, window: "month" }, "any period id");
  assert.equal(cleanIntentRow(raw({ budgetPass: { ...good, window: "" } }), NOW).budgetPass, undefined);
  assert.equal(cleanIntentRow(raw({ budgetPass: { ...good, from: "1" } }), NOW).budgetPass, undefined);
  assert.equal(cleanIntentRow(raw({ budgetPass: true }), NOW).budgetPass, undefined);
});

// ── close-when-done, and what the cap says when nothing will free a slot ────

test("closeWhenDoneSetting: only an explicit on is on — absent, empty and junk are OFF", () => {
  assert.equal(closeWhenDoneSetting("1"), true);
  assert.equal(closeWhenDoneSetting("true"), true);
  for (const v of [undefined, null, "", "0", "false", "yes"]) assert.equal(closeWhenDoneSetting(v), false, String(v));
});

test("closeWhenDoneOf: the row's own answer beats the global, either way; absent inherits", () => {
  assert.equal(closeWhenDoneOf({ closeWhenDone: false }, true), false);
  assert.equal(closeWhenDoneOf({ closeWhenDone: true }, false), true);
  assert.equal(closeWhenDoneOf({}, true), true);
  assert.equal(closeWhenDoneOf(undefined, false), false);
});

test("cleanIntentRow keeps closeWhenDone false as false — it is an answer, not absence", () => {
  const base = intent({ closeWhenDone: false });
  assert.equal(cleanIntentRow(base, NOW).closeWhenDone, false);
  assert.equal(cleanIntentRow({ ...base, closeWhenDone: "yes" }, NOW).closeWhenDone, undefined);
});

test("noSlot in words: only WORKING sessions fill the cap, and a slot frees when one goes idle (R-automation-042)", () => {
  const open = (n, busy = true) => Array.from({ length: n }, (_, i) => ({ id: `s${i}`, closeWhenDone: false, busy }));
  assert.equal(autoSlotsWaitText({ max: 3, open: open(2) }), undefined, "a free slot: the cap is not what holds anything");
  assert.equal(autoSlotsWaitText({ max: 3, open: [...open(2), ...open(5, false)] }), undefined,
    "five idle sessions left open hold no slot");
  assert.equal(autoSlotsWaitText({ max: 3, open: open(3) }),
    "waiting for a free slot — this desktop runs 3 automatic sessions at a time and 3 are working; a slot frees when one goes idle");
  assert.equal(autoSlotsWaitText({ max: 1, open: open(1) }),
    "waiting for a free slot — this desktop runs 1 automatic session at a time and 1 is working; a slot frees when one goes idle");
  assert.equal(autoSlotsWaitText({ max: 1, open: [{ id: "old", closeWhenDone: false }] }),
    "waiting for a free slot — this desktop runs 1 automatic session at a time and 1 is working; a slot frees when one goes idle",
    "no `busy` is an older host, which counted every open one");
  assert.deepEqual(autoSlotsBusy({ max: 3, open: [{ id: "a", closeWhenDone: false, busy: false }, { id: "b", closeWhenDone: true, busy: true }] }).map((s) => s.id), ["b"]);
  assert.match(intentReasonText("noSlot"), /every automatic session .* is working/);
});

// ── a session's OWN budget ───────────────────────────────────────────────────

test("a session over its own budget holds rows aimed at it — a repo target passes", () => {
  const world = facts({ sessions: [session(), session({ id: "s2" })], budgetHeldSessions: new Set(["s1"]) });
  const v = intentVerdict(intent(), world, NOW);
  assert.equal(v.kind, "wait");
  assert.equal(v.reason, "sessionBudget");
  assert.match(intentReasonText("sessionBudget"), /own budget/);
  const many = intent({ target: { kind: "sessions", sessionIds: ["s2", "s1"] } });
  assert.equal(intentVerdict(many, world, NOW).reason, "sessionBudget");
  const fresh = intent({ target: { kind: "repo", fresh: true } });
  assert.notEqual(intentVerdict(fresh, world, NOW).reason, "sessionBudget");
});

test("cleanIntentRow round-trips a budget and drops garbage", () => {
  const b = { unit: "usd", max: 2, interrupt: false };
  assert.deepEqual(cleanIntentRow(intent({ budget: b }), NOW).budget, b);
  assert.equal(cleanIntentRow(intent({ budget: { unit: "usd", max: -1 } }), NOW).budget, undefined);
});

// ── Leftovers of a reset week ────────────────────────────────────────────────
//
// A row let past last week's budget — a weekly before-reset pass, or a person's
// weekly waiver — that was still waiting when the week reset. A new week reads
// 0%, so without its own ceiling every leftover started at once and spent the
// new week on work only ever worth the old week's spare.

const leftoverCap = (over = {}) => ({ which: "weekly", pct: 25, max: 20, resetAt: R + 7 * 24 * 60 * MIN, ...over });

test("a weekly before-reset child still waiting past the reset is a leftover; a session one is not", () => {
  const weekly = intent({ auto: true, target: { kind: "repo", fresh: true }, trigger: { kind: "idle" }, budgetPass: { window: "weekly", from: R - 60 * MIN, until: R } });
  const session = intent({ auto: true, target: { kind: "repo", fresh: true }, trigger: { kind: "idle" }, budgetPass: { window: "session", from: R - 60 * MIN, until: R } });
  assert.equal(budgetLeftoverOf(weekly, R - MIN), null, "inside its own lift it is not left over yet");
  assert.equal(budgetLeftoverOf(weekly, R), R);
  assert.equal(budgetLeftoverOf(session, R + MIN), null, "weekly only — a session window refills in hours");
  assert.equal(budgetLeftoverOf(intent({ auto: true }), NOW), null);
  assert.equal(budgetLeftoverOf(intent({ auto: true, leftoverOf: R }), NOW), R, "the expired waiver's stamp");
});

test("the leftover ceiling holds a leftover, and only a leftover, and only an auto one", () => {
  const base = { auto: true, target: { kind: "repo", fresh: true }, trigger: { kind: "idle" } };
  const left = intent({ ...base, leftoverOf: R });
  const v = intentVerdict(left, facts({ leftoverOver: leftoverCap() }), R + MIN);
  assert.equal(v.reason, "budget");
  assert.match(v.detail, /leftover from a week that has reset .* under 20% \(25% used\)/);
  assert.equal(intentVerdict(left, facts({ leftoverOver: null }), R + MIN).kind, "go", "under the ceiling it runs");
  assert.equal(intentVerdict(left, facts({}), R + MIN).kind, "go", "absent = nobody said = no hold");
  assert.equal(intentVerdict(intent(base), facts({ leftoverOver: leftoverCap() }), R + MIN).kind, "go", "ordinary work is not held by it");
  assert.equal(intentVerdict(intent({ ...base, auto: false, leftoverOf: R }), facts({ leftoverOver: leftoverCap() }), R + MIN).kind, "go", "a person's tap never");
});

test("a row timed for right AFTER the weekly reset is held by the leftover ceiling, not before it and not days in", () => {
  const at = (rule) => intent({ auto: true, target: { kind: "repo", fresh: true }, trigger: { kind: "at", rule }, nextAt: R + Math.max(0, (rule.offsetMin ?? 0)) * MIN });
  const after30 = at({ kind: "window", window: "weekly", edge: "after", offsetMin: 30 });
  assert.equal(budgetAfterResetOf(after30, R - MIN), null, "never before the reset");
  assert.equal(budgetLeftoverOf(after30, R + 30 * MIN), R, "the reset it starts right after");
  assert.equal(budgetLeftoverOf(at({ kind: "window", window: "weekly", offsetMin: 0 }), R), R, "at the reset counts");
  assert.equal(budgetLeftoverOf(at({ kind: "window", window: "weekly", edge: "after", offsetMin: 2 * 24 * 60 }), R + 3 * 24 * 60 * MIN), null, "two days in is not right after");
  assert.equal(budgetLeftoverOf(at({ kind: "window", window: "session", edge: "after", offsetMin: 30 }), R + 30 * MIN), null, "weekly only");
  const v = intentVerdict(after30, facts({ leftoverOver: leftoverCap() }), R + 30 * MIN);
  assert.equal(v.reason, "budget");
  assert.match(v.detail, /^timed for right after the weekly reset, so it starts only while the new week is under 20% \(25% used\)/);
  assert.equal(intentVerdict(after30, facts({ leftoverOver: null }), R + 30 * MIN).kind, "go", "under the ceiling it runs");
});

test("a waiver given in the new week lifts a leftover — the newer answer", () => {
  const left = intent({ auto: true, target: { kind: "repo", fresh: true }, trigger: { kind: "idle" }, leftoverOf: R, pastBudget: { until: R + 7 * 24 * 60 * MIN, weekly: true } });
  assert.equal(intentVerdict(left, facts({ leftoverOver: leftoverCap() }), R + MIN).kind, "go");
});

test("cleanIntentRow keeps leftoverOf as one finite instant, and a waiver's weekly mark", () => {
  assert.equal(cleanIntentRow(raw({ leftoverOf: R }), NOW).leftoverOf, R);
  assert.equal(cleanIntentRow(raw({ leftoverOf: "1" }), NOW).leftoverOf, undefined);
  assert.equal(cleanIntentRow(raw({ leftoverOf: Infinity }), NOW).leftoverOf, undefined);
  assert.deepEqual(cleanBudgetWaiver({ until: R, weekly: true }), { until: R, weekly: true });
  assert.deepEqual(cleanBudgetWaiver({ until: R, weekly: "yes" }), { until: R });
});

test("a budgetPass and a waiver keep a configured period id; a wordy window rule names it", () => {
  const row = cleanIntentRow(intent({ budgetPass: { window: "month", from: 1000, until: 2000 }, pastBudget: { until: 5000, periodId: "month" } }), NOW);
  assert.deepEqual(row.budgetPass, { window: "month", from: 1000, until: 2000 });
  assert.deepEqual(row.pastBudget, { until: 5000, periodId: "month" });
  assert.equal(cleanIntentRow(intent({ budgetPass: { window: "", from: 1, until: 2 } }), NOW).budgetPass, undefined);
  assert.deepEqual(cleanBudgetWaiver({ until: 5, weekly: true }), { until: 5, weekly: true }, "an old waiver is unchanged");
  assert.match(describeRule({ kind: "window", window: "session", periodId: "month", edge: "before", offsetMin: -60 }), /month period resets/);
  assert.match(describeRule({ kind: "window", window: "weekly", edge: "before", offsetMin: -60 }), /weekly window resets/);
});
