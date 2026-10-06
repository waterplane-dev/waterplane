/**
 * The sessions a work item runs in — one per item, and what closes them again.
 *
 * There used to be ONE `backlog · <repo>` session per repo, recognised by its
 * exact title, and every item that repo ever queued was typed into it. Nothing
 * ever closed one. `sessioncost.ts` is why that had to end: every turn re-sends
 * the whole conversation, so a window at 5× its own baseline stops paying for
 * itself after about three turns, and a shared session of unrelated items
 * reaches 5× within a handful of them — each item reads its own files in and
 * none of that helps the next. The desktop-wide measurement in `CLAUDE.md` is
 * the same shape: 124 conversations out of 8,968 were 76% of every token spent.
 *
 * So: a session per item, and three rules about ending them, all of which fail
 * SILENTLY and none of which an e2e watching a screen would catch —
 *
 *  1. **the mark is a PREFIX, never a title.** `backlog · myapp · fix the flaky
 *     test` and the older `backlog · myapp` are both automatic sessions; a count
 *     that only recognised one of them would let the cap be exceeded by exactly
 *     the sessions a previous version opened.
 *  2. **nothing is ever closed out from under somebody.** Attached, holding a
 *     row that is `starting`/`running`, or active in the last minute — three
 *     exemptions, and a reap that ignored any of them would kill a live agent.
 *  3. **`remove()`, never `kill()`.** Remove lands the conversation under
 *     *Recently closed*, where it reopens with `--continue`; kill is a teardown
 *     with no closed-row on the other side of it, which for work that just RAN
 *     is the one outcome nobody wants.
 *
 * A fake `SessionManager` and a fake store: the decisions are the thing under
 * test, and every fact they read is a method on something injected.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Both knobs are read at module load, so they are set before the import. The
// reap floor is a minute in production and this file would otherwise have to
// wait one out, several times over.
process.env.WATERPLANE_BACKLOG_REAP_IDLE_MS = "1000";
process.env.WATERPLANE_BACKLOG_LINGER_MS = "5000";
const { BacklogManager, backlogTitle, isBacklogTitle } = await import("../dist/backlog.js");

const REPO = "/tmp/waterplane-bls-repo";
const OTHER = "/tmp/waterplane-bls-other";

/** A backlog over fake everything. `now` is the clock the idles are measured
 *  against, so a test states ages rather than sleeping through them. */
function makeBacklog() {
  const root = mkdtempSync(join(tmpdir(), "waterplane-bls-"));
  const state = {
    /** Live sessions: {id, cwd, title, createdAt, idle}. */
    sessions: [],
    /** Store rows, for the "a row is running in it" exemption. */
    rows: [],
    /** Ids somebody has open on their phone. */
    attached: new Set(),
    /** Ids `remove()` was called with, in order — and `kill()` separately, so a
     *  test can prove which verb was used. */
    removed: [],
    killed: [],
    /** Every `create()` call, with the options it was given. */
    created: [],
    kicks: 0,
    broadcasts: 0,
    nextId: 1,
    /** Every `intents.edit` the backlog made, with its patch. */
    edits: [],
    /** Every draft that reached `intents.post`. */
    posted: [],
  };
  const sessions = {
    list: () => state.sessions.map((s) => ({ ...s, running: s.running !== false })),
    get: (id) => {
      const s = state.sessions.find((x) => x.id === id);
      return s ? { ...s, running: s.running !== false } : undefined;
    },
    create: (cwd, opts) => {
      const id = `s${state.nextId++}`;
      state.created.push({ cwd, ...opts });
      state.sessions.push({ id, cwd, title: opts?.title ?? id, createdAt: Date.now(), idle: 0 });
      return { id };
    },
    remove: (id, _onShells, by) => {
      state.removed.push(id);
      (state.removedBy ??= []).push({ id, by });
      state.sessions = state.sessions.filter((x) => x.id !== id);
      return true;
    },
    kill: (id) => { state.killed.push(id); },
    idleMs: (id) => state.sessions.find((x) => x.id === id)?.idle ?? null,
    /**
     * `sessions.autoFireBlocker`, in its real ladder and order — the question
     * `reapable()` now asks instead of reading PTY silence itself.
     *
     * Faithful on purpose: gone, limit, box, then the CLI's own `turnActive` for
     * a hooked session and the silence guess for an un-hooked one. A fake that
     * only answered "idle enough" could not tell the two halves of this rule
     * apart, which is the whole point of the rule.
     */
    autoFireBlocker: (id, quietMs) => {
      const s = state.sessions.find((x) => x.id === id);
      if (!s || s.running === false) return "its session has ended";
      if (s.limitBlocked) return "the session is blocked on a usage limit";
      if (s.awaitingInput || s.prompt) return "the session is waiting for an answer";
      if (s.hooksActive) return s.turnActive ? "the session is working" : null;
      if (s.idle == null) return "the session hasn't printed anything yet";
      return s.idle >= quietMs ? null : "the session looks busy (no hook signal — going by silence)";
    },
    diedAtLimit: () => false,
    runningSessionFor: (cwd) => state.sessions.filter((s) => s.cwd === cwd).at(-1)?.id ?? null,
  };
  const intents = {
    list: () => state.rows,
    kick: () => { state.kicks++; },
    emitChanged: () => { state.broadcasts++; },
    get: (id) => state.rows.find((r) => r.id === id),
    /** Every `edit` patch, in order — a drag has to be visible as a PATCH. */
    edit: (id, patch) => { state.edits.push({ id, ...patch }); return { ok: true }; },
    /** Every draft `add()` minted, so provenance can be asserted on the way in. */
    post: (draft) => {
      const row = { ...draft, state: "queued", createdAt: draft.order ?? 0 };
      state.posted.push(row);
      state.rows.push(row);
      return { ok: true, intent: row };
    },
  };
  const reviews = { get: () => undefined, drop: () => {} };
  const backlog = new BacklogManager(root, sessions, intents, reviews);
  // The global *close automatic sessions when done*. ON in this harness, so
  // every test above section 5 is about HOW a session closes once closing is
  // allowed; section 5 switches it off, which is the shipped default.
  state.closeDefault = true;
  backlog.setCloseWhenDoneDefault(() => state.closeDefault);
  const isAttached = (id) => state.attached.has(id);
  return { backlog, state, isAttached, root };
}

/** Put a session in the fake by hand — the shapes a real host would have. */
const live = (state, id, { cwd = REPO, title = `${backlogTitle(cwd)} · an item`, createdAt = 0, idle = 99_000, shellList } = {}) => {
  const s = { id, cwd, title, createdAt, idle };
  if (shellList) s.shellList = shellList;
  state.sessions.push(s);
  return id;
};

const NOW = Date.now();
/** A background shell reading `working` under `shellBucket` — CPU moved a
 *  second ago. */
const workingShell = (over = {}) => ({
  pid: 4242, startedAt: NOW - 60_000, command: "npm run dev", cpuMs: 1000, workers: 1, cpuMovedAt: NOW - 1_000, ...over,
});

// ── 1. what a fired item's session is called ────────────────────────────────

test("an item's session is titled after the ITEM, under the prefix everything else recognises", () => {
  const { backlog, state, root } = makeBacklog();
  const id = backlog.openItemSession({
    id: "i1", cwd: REPO, label: "fix the flaky test",
    payload: { kind: "prompt", steps: ["fix it"] },
  });
  const made = state.created[0];
  assert.equal(made.cwd, REPO);
  assert.equal(made.title, "backlog · waterplane-bls-repo · fix the flaky test");
  assert.equal(isBacklogTitle(made.title), true, "the prefix is what marks it, so the cap and the sweeps see it");
  assert.equal(made.resume, undefined, "clean by default — the cheap side of sessioncost.ts");
  assert.equal(typeof id, "string");
  assert.equal(state.kicks > 0, true, "a slot was just spent and a session just appeared — every waiting row is re-asked now");
  rmSync(root, { recursive: true, force: true });
});

test("no label falls back to the words, clipped, and `resume` is passed through", () => {
  const { backlog, state, root } = makeBacklog();
  backlog.openItemSession({
    id: "i2", cwd: REPO, resume: true,
    payload: { kind: "prompt", steps: ["work out why the settle sweep re-reads the conversation log every poll\nand write it down"] },
  });
  const made = state.created[0];
  assert.equal(made.title.startsWith("backlog · waterplane-bls-repo · "), true);
  assert.equal(made.title.includes("\n"), false, "a title is one row on a phone");
  assert.equal(made.title.length <= "backlog · waterplane-bls-repo · ".length + 40, true);
  assert.equal(made.resume, true, "`--continue`, because this row asked for it");
  rmSync(root, { recursive: true, force: true });
});

test("an item with its own budget opens its session WITH that budget; one without opens one without", () => {
  const { backlog, state, root } = makeBacklog();
  const budget = { unit: "usd", max: 2, interrupt: true };
  backlog.openItemSession({ id: "ib", cwd: REPO, budget, payload: { kind: "prompt", steps: ["fix it"] } });
  backlog.openItemSession({ id: "in", cwd: REPO, payload: { kind: "prompt", steps: ["fix it"] } });
  assert.deepEqual(state.created[0].budget, budget, "the session is born with the item's cap (Intent.budget)");
  assert.equal("budget" in state.created[1], false, "no budget is not a zero budget — the key is absent");
  rmSync(root, { recursive: true, force: true });
});

test("add() puts the budget on the row it posts, and never on a row aimed at a live session", () => {
  const { backlog, state, root } = makeBacklog();
  const budget = { unit: "tok", max: 500_000, interrupt: false };
  backlog.add("do it", REPO, undefined, undefined, true, { budget });
  backlog.add("do it there", REPO, undefined, "s-live", true, { budget });
  assert.deepEqual(state.posted[0].budget, budget);
  assert.equal(state.posted[1].budget, undefined, "a session-target row opens nothing, so it carries no birth budget");
  rmSync(root, { recursive: true, force: true });
});

// ── 2. the cap counts PROCESSES ─────────────────────────────────────────────

test("the count is by prefix, so an older shared session and a hand-driven one are told apart", () => {
  const { backlog, state, root } = makeBacklog();
  live(state, "s-item", { title: "backlog · waterplane-bls-repo · one thing" });
  live(state, "s-shared", { title: backlogTitle(REPO) });   // the pre-per-item shape
  live(state, "s-hand", { title: "waterplane-bls-repo" });        // opened by a person
  assert.equal(backlog.autoSessionCount(), 2,
    "both automatic shapes count against the cap; the one a person opened does not");
  rmSync(root, { recursive: true, force: true });
});

// ── 3. what may be closed to make room ──────────────────────────────────────

test("the reap takes the OLDEST idle automatic session, and uses remove() not kill()", () => {
  const { backlog, state, isAttached, root } = makeBacklog();
  live(state, "s-new", { createdAt: 2_000 });
  live(state, "s-old", { createdAt: 1_000 });
  const reaped = backlog.reapAutoSession(isAttached);
  assert.equal(reaped, "s-old", "oldest first — the one whose output somebody is least likely to still be reading");
  assert.deepEqual(state.removed, ["s-old"]);
  assert.deepEqual(state.killed, [], "kill() suppresses the closed-row; this one has to be reopenable");
  rmSync(root, { recursive: true, force: true });
});

test("a session somebody is attached to is never reaped, whatever else is true of it", () => {
  const { backlog, state, isAttached, root } = makeBacklog();
  live(state, "s-watched", { createdAt: 1_000 });
  state.attached.add("s-watched");
  assert.equal(backlog.reapAutoSession(isAttached), null);
  assert.deepEqual(state.removed, []);
  rmSync(root, { recursive: true, force: true });
});

test("a session with a row still starting or running in it is never reaped", () => {
  const { backlog, state, isAttached, root } = makeBacklog();
  live(state, "s-busy", { createdAt: 1_000 });
  // `starting` is the whole window in which a delivery is being proved, which is
  // exactly the window in which the session looks idle and is not.
  state.rows.push({ id: "r1", state: "starting", sessionId: "s-busy" });
  assert.equal(backlog.reapAutoSession(isAttached), null);
  state.rows[0].state = "done";
  assert.equal(backlog.reapAutoSession(isAttached), "s-busy", "…and it is reapable the moment the row settles");
  rmSync(root, { recursive: true, force: true });
});

test("a session that printed something a moment ago is never reaped", () => {
  const { backlog, state, isAttached, root } = makeBacklog();
  live(state, "s-fresh", { createdAt: 1_000, idle: 100 });   // under the 1 s floor set above
  assert.equal(backlog.reapAutoSession(isAttached), null);
  rmSync(root, { recursive: true, force: true });
});

test("a hand-driven session is never reaped, however idle — the prefix is the whole gate", () => {
  const { backlog, state, isAttached, root } = makeBacklog();
  live(state, "s-hand", { title: "waterplane-bls-repo", createdAt: 1, idle: 10 * 60_000 });
  assert.equal(backlog.reapAutoSession(isAttached), null);
  assert.deepEqual(state.removed, []);
  rmSync(root, { recursive: true, force: true });
});

// ── 3b. a background shell holds the session open, on its own — closing one
//        is a person's tap, never an automatic verdict (CLAUDE.md) ─────────

test("a session with a WORKING background shell is never auto-reaped, even though the CLI itself says idle", () => {
  const { backlog, state, isAttached, root } = makeBacklog();
  live(state, "s-shell", { createdAt: 1_000, shellList: [workingShell()] });
  assert.equal(backlog.reapAutoSession(isAttached), null);
  assert.deepEqual(state.removed, []);
  rmSync(root, { recursive: true, force: true });
});

test("a session with a SERVER-LIKE background shell is never auto-reaped, however long it has been quiet", () => {
  const { backlog, state, isAttached, root } = makeBacklog();
  // Quiet for hours — `working` would already be false — but `serverLike`
  // stands on its own: quiet is the point for a dev server, not a concern.
  live(state, "s-server", { createdAt: 1_000, shellList: [workingShell({ cpuMovedAt: NOW - 3 * 60 * 60_000, serverLike: true })] });
  assert.equal(backlog.reapAutoSession(isAttached), null);
  rmSync(root, { recursive: true, force: true });
});

test("a session whose only shell is QUIET (not working, not server-like) is reapable as normal", () => {
  const { backlog, state, isAttached, root } = makeBacklog();
  live(state, "s-quiet-shell", {
    createdAt: 1_000,
    shellList: [workingShell({ cpuMovedAt: NOW - 60 * 60_000, workers: 2 })], // long past the quiet window, real workers ⇒ "quiet"
  });
  assert.equal(backlog.reapAutoSession(isAttached), "s-quiet-shell");
  rmSync(root, { recursive: true, force: true });
});

test("a FOREGROUND shell never blocks a reap — it is the running turn's own command, not a background shell", () => {
  const { backlog, state, isAttached, root } = makeBacklog();
  live(state, "s-fg", { createdAt: 1_000, shellList: [workingShell({ foreground: true })] });
  assert.equal(backlog.reapAutoSession(isAttached), "s-fg");
  rmSync(root, { recursive: true, force: true });
});

test("the linger sweep leaves a session with a working background shell alone too", () => {
  const { backlog, state, isAttached, root } = makeBacklog();
  live(state, "s-linger-shell", { createdAt: 1, idle: 9_000, shellList: [workingShell()] }); // past the 5s linger window
  const closed = backlog.lingerSweep(isAttached);
  assert.deepEqual(closed, []);
  assert.equal(state.sessions.length, 1);
  rmSync(root, { recursive: true, force: true });
});

test("a session with a BACKGROUND AGENT still running is never reaped — the orchestrator is waiting on it", () => {
  // Measured: an item's orchestrator handed work package 1 to a background
  // subagent and ended its turn to wait. Hooked, turn over, nobody attached —
  // the sweep closed it inside two minutes and the subagent died mid-typecheck.
  const { backlog, state, isAttached, root } = makeBacklog();
  live(state, "s-agent", { createdAt: 1, idle: 9_000 });
  Object.assign(state.sessions.at(-1), {
    hooksActive: true, turnActive: false, idleSince: NOW - 60 * 60_000,
    agents: [{ id: "a1", what: "WP1 kit extraction", startedAt: NOW - 60_000, lastWriteAt: NOW - 1_000 }],
  });
  assert.equal(backlog.reapAutoSession(isAttached), null);
  assert.deepEqual(backlog.lingerSweep(isAttached), []);
  state.sessions.at(-1).agents = [];
  assert.deepEqual(backlog.lingerSweep(isAttached), ["s-agent"], "…and once it has finished, the session is closed as normal");
  rmSync(root, { recursive: true, force: true });
});

test("a HOOKED session is lingered from when its turn ended, not closed at the next sweep", () => {
  // The hook answers "free now" and never consulted the linger, so a ten-minute
  // linger was however long the sweep interval happened to be.
  const { backlog, state, isAttached, root } = makeBacklog();
  live(state, "s-fresh", { createdAt: 1, idle: 9_000 });
  Object.assign(state.sessions.at(-1), { hooksActive: true, turnActive: false, idleSince: Date.now() - 2_000 });
  live(state, "s-old", { createdAt: 2, idle: 9_000 });
  Object.assign(state.sessions.at(-1), { hooksActive: true, turnActive: false, idleSince: Date.now() - 6_000 });
  assert.deepEqual(backlog.lingerSweep(isAttached), ["s-old"]);
  rmSync(root, { recursive: true, force: true });
});

// ── 4. the linger ───────────────────────────────────────────────────────────

test("the linger sweep archives every automatic session past the window, and leaves the rest", () => {
  const { backlog, state, isAttached, root } = makeBacklog();
  live(state, "s-done-a", { createdAt: 1, idle: 9_000 });               // past 5 s
  live(state, "s-done-b", { cwd: OTHER, createdAt: 2, idle: 6_000 });   // past 5 s
  live(state, "s-recent", { createdAt: 3, idle: 2_000 });               // inside it
  live(state, "s-hand", { title: "waterplane-bls-repo", createdAt: 4, idle: 9_000 });
  const closed = backlog.lingerSweep(isAttached);
  assert.deepEqual(closed.sort(), ["s-done-a", "s-done-b"]);
  assert.deepEqual(state.killed, [], "archived, not killed — each one reopens with --continue");
  assert.equal(state.sessions.length, 2, "the recent one and the hand-driven one are still there");
  rmSync(root, { recursive: true, force: true });
});

test("the linger sweep honours the same exemptions the reap does", () => {
  const { backlog, state, isAttached, root } = makeBacklog();
  live(state, "s-watched", { createdAt: 1, idle: 9_000 });
  live(state, "s-working", { createdAt: 2, idle: 9_000 });
  state.attached.add("s-watched");
  state.rows.push({ id: "r1", state: "running", sessionId: "s-working" });
  assert.deepEqual(backlog.lingerSweep(isAttached), []);
  rmSync(root, { recursive: true, force: true });
});

test("a session the CLI says is MID-TURN is not reaped, even with no row in it", () => {
  // `PLAN.md` §2.2: "Never a session a person is looking at, never one mid-turn."
  // The implementation's proxy for mid-turn was "an intent `starting`/`running`
  // in it", which is a different fact — and the gap is now common by
  // construction: a chain row whose step 2 failed ends `failed` while step 1's
  // turn is still running in a session with no row in it, a first-step
  // `unconfirmed` does the same, and `ensureRepoSession` is a hand-driven session
  // wearing the mark with nothing ever running in it.
  //
  // What "mid-turn and silent" IS in practice is a session waiting on a PERSON —
  // a permission box or an `AskUserQuestion` — because the working spinner
  // repaints every second, so a live tool call is never silent. Reaping it drops
  // the pending tool call and SIGHUPs an agent mid-edit.
  const { backlog, state, isAttached, root } = makeBacklog();
  live(state, "s-turn", { createdAt: 1, idle: 9_000 });
  Object.assign(state.sessions.at(-1), { hooksActive: true, turnActive: true });
  assert.equal(backlog.reapAutoSession(isAttached), null, "a live turn is not a free slot");
  assert.deepEqual(backlog.lingerSweep(isAttached), [], "…and the linger sweep says the same");
  assert.deepEqual(state.removed, []);

  // The moment the CLI says the turn ended, it is reapable — no silence timer
  // between the two, because the hook is positive evidence and silence is a guess.
  state.sessions.at(-1).turnActive = false;
  assert.equal(backlog.reapAutoSession(isAttached), "s-turn");
  rmSync(root, { recursive: true, force: true });
});

test("a session parked on a QUESTION is not reaped either — that is a person being waited for", () => {
  const { backlog, state, isAttached, root } = makeBacklog();
  live(state, "s-box", { createdAt: 1, idle: 9_000 });
  Object.assign(state.sessions.at(-1), { prompt: { kind: "trust" } });
  live(state, "s-unreadable", { cwd: OTHER, createdAt: 2, idle: 9_000 });
  Object.assign(state.sessions.at(-1), { awaitingInput: true });
  live(state, "s-limit", { cwd: OTHER, createdAt: 3, idle: 9_000 });
  Object.assign(state.sessions.at(-1), { limitBlocked: true });
  assert.equal(backlog.reapAutoSession(isAttached), null);
  assert.deepEqual(backlog.lingerSweep(isAttached), []);
  rmSync(root, { recursive: true, force: true });
});

test("…but a lost Stop cannot hold a slot for ever — the ceiling overrules the CLI's word", () => {
  // The cost of trusting `turnActive`, stated and then bounded: a `Stop` that
  // never arrives (a killed curl, a broken hook pipe) leaves the flag set for the
  // life of the process, and the session would hold one of the desktop's
  // automatic slots until a restart. `REAP_CEILING_MS` is 6× the linger of PTY
  // silence — far past any real tool call or permission box.
  const CEILING = 6 * 5_000; // WATERPLANE_BACKLOG_LINGER_MS is 5 s in this file
  const { backlog, state, isAttached, root } = makeBacklog();
  live(state, "s-stuck", { createdAt: 1, idle: CEILING - 1 });
  Object.assign(state.sessions.at(-1), { hooksActive: true, turnActive: true });
  assert.equal(backlog.reapAutoSession(isAttached), null, "just inside the ceiling, the CLI is still believed");
  state.sessions.at(-1).idle = CEILING + 1;
  assert.equal(backlog.reapAutoSession(isAttached), "s-stuck", "past it, silence wins");
  rmSync(root, { recursive: true, force: true });
});

// ── a drag is the one explicit act in this sheet, and it is recorded ─────────

test("reorder and swap stamp handOrdered — nothing else in the host does", () => {
  // Without this, a row somebody dragged to the top is indistinguishable five
  // minutes later from a row that simply arrived last (`add()` puts a new one
  // on top with `min(orders) - 1`). The moment anything automatic sorts this
  // list — the smart pick does — it cannot tell them apart and will quietly
  // undo the one deliberate thing in the sheet.
  const { backlog, state, root } = makeBacklog();
  state.rows.push({ id: "a", cwd: REPO, order: 0, createdAt: 10 });
  state.rows.push({ id: "b", cwd: REPO, order: 1, createdAt: 20 });
  state.rows.push({ id: "c", cwd: REPO, order: 2, createdAt: 30 });

  backlog.reorder(["c", "a", "b"]);
  assert.deepEqual(state.edits, [
    { id: "c", order: 0, handOrdered: true },
    { id: "a", order: 1, handOrdered: true },
    { id: "b", order: 2, handOrdered: true },
  ], "EVERY id in the drag is placed — the client sends the whole display order, and the rows a drag moved past are where they are because of it");

  state.edits.length = 0;
  backlog.swap("a", "b");
  assert.deepEqual(state.edits.map((e) => e.handOrdered), [true, true], "the one-step move is a placement too");
  assert.deepEqual(state.edits.map((e) => e.order), [1, 0], "…and it still swaps the slots");

  // The negative half, and the one that actually protects anything: adding a
  // row is machinery putting it somewhere, not a person placing it.
  state.edits.length = 0;
  backlog.archive("a", true);
  assert.deepEqual(state.edits, [{ id: "a", archived: true }], "setting one aside says nothing about who placed it");
  rmSync(root, { recursive: true, force: true });
});

// ── 5. the smart pick's tick, and what it costs to ask about it ─────────────

test("the tick is per repo, survives a restart, and shares the auto switch's file", async () => {
  // One file, one writer. A second file for one boolean per repo is a second
  // thing to write and migrate; a second WRITER of this one is how "the tick
  // turned itself off when I toggled auto-fire" happens.
  const { backlog, root } = makeBacklog();
  assert.deepEqual(backlog.smartPickList(), [], "off for every repo by default");
  assert.equal(backlog.smartPickEnabled(REPO), false);

  backlog.setAuto(true);
  backlog.setSmartPick(REPO, true);
  assert.deepEqual(backlog.smartPickList(), [REPO]);

  const cfg = JSON.parse(readFileSync(join(root, ".waterplane", "backlog-config.json"), "utf8"));
  assert.equal(cfg.auto, true, "the switch is still there beside it");
  assert.equal(typeof cfg.smartPick[REPO].setAt, "number", "and when it was ticked, which nothing else records");

  const again = new BacklogManager(root, { list: () => [] }, { list: () => [], kick: () => {}, emitChanged: () => {} }, { get: () => undefined });
  await again.init();
  assert.equal(again.smartPickEnabled(REPO), true, "a restart re-derives nothing");
  assert.equal(again.getAuto(), true);

  again.setSmartPick(REPO, false);
  const off = JSON.parse(readFileSync(join(root, ".waterplane", "backlog-config.json"), "utf8"));
  assert.equal(off.auto, true, "turning the tick off leaves the switch alone");
  assert.equal(off.smartPick, undefined);
  rmSync(root, { recursive: true, force: true });
});

test("flipping the tick re-asks every waiting row at once", () => {
  // Turning it ON changes what the next tick does with this repo's ready rows;
  // turning it OFF must free anything a pass is holding right now, rather than
  // making a blocked row wait out a look nobody wants any more.
  const { backlog, state, root } = makeBacklog();
  const before = state.kicks;
  backlog.setSmartPick(REPO, true);
  assert.equal(state.kicks, before + 1);
  backlog.setSmartPick(REPO, true);
  assert.equal(state.kicks, before + 1, "setting it to what it already is writes nothing and kicks nothing");
  backlog.setSmartPick(REPO, false);
  assert.equal(state.kicks, before + 2);
  rmSync(root, { recursive: true, force: true });
});

test("a merge's two chips ride on the row, from the sidecar and not from the intent", () => {
  // `review.ts`'s arrangement exactly: a fact that outlives the run it describes
  // is not lifecycle, so it lives beside the store and is merged in where the
  // wire DTO is built. A host with no smart pick renders the list it always did.
  const { root } = makeBacklog();
  const rows = [
    { id: "mg1", cwd: REPO, order: 0, createdAt: 1, state: "queued", payload: { kind: "prompt", steps: ["merged words"] }, target: { kind: "repo", fresh: true }, trigger: { kind: "idle" }, origin: "smartpick:p1" },
    { id: "a", cwd: REPO, order: 1, createdAt: 2, state: "queued", archived: true, payload: { kind: "prompt", steps: ["do a"] }, target: { kind: "repo", fresh: true }, trigger: { kind: "idle" }, handOrdered: true },
  ];
  const intents = { list: () => rows, kick: () => {}, emitChanged: () => {}, get: (id) => rows.find((r) => r.id === id), edit: () => ({ ok: true }) };
  const facts = { mg1: { mergedFrom: ["a"] }, a: { mergedInto: "mg1" } };
  const b = new BacklogManager(root, { list: () => [] }, intents, { get: () => undefined }, { rowFacts: (id) => facts[id], undo: () => ({ ok: true }) });

  const list = b.list();
  assert.deepEqual(list.find((i) => i.id === "mg1").mergedFrom, ["a"]);
  assert.equal(list.find((i) => i.id === "a").mergedInto, "mg1");
  assert.equal(list.find((i) => i.id === "a").handOrdered, true, "“you placed this” — a rule the user cannot see is one they cannot trust");
  assert.equal(list.find((i) => i.id === "mg1").origin, "smartpick:p1");

  // …and the undo's refusal is a SENTENCE the caller says out loud.
  const bare = new BacklogManager(root, { list: () => [] }, intents, { get: () => undefined });
  assert.equal(bare.unmerge("mg1").ok, false);
  assert.ok(bare.unmerge("mg1").reason, "never a silent no-op");
  assert.equal(bare.list().find((i) => i.id === "mg1").mergedFrom, undefined, "a host without one renders exactly the list it always did");
  rmSync(root, { recursive: true, force: true });
});

test("an item posted with an origin keeps it — the link from a rule to every row it wrote", () => {
  // `backlog.add` is the ONE place a work item is minted, so it is the one place
  // the provenance can be attached. The schedule's executor is today's only
  // caller that passes one.
  const { backlog, state, root } = makeBacklog();
  const item = backlog.add("do the nightly thing", REPO, "nightly", undefined, true, { origin: "schedule:r1" });
  assert.equal(state.posted.at(-1).origin, "schedule:r1", "it reached the store");
  assert.equal(item.origin, "schedule:r1", "…and it is on the wire DTO the sheet reads");

  // An ordinary item carries none, and a chip that is not drawn is the honest
  // answer for every row written before this link existed.
  backlog.add("something somebody typed", REPO, "typed");
  assert.equal(state.posted.at(-1).origin, undefined);
  rmSync(root, { recursive: true, force: true });
});

// ── 5. closing is an OPTION: off by default, per item on top ────────────────

test("a backlog nobody wired closes NOTHING — the default is a person closes them", () => {
  const root = mkdtempSync(join(tmpdir(), "waterplane-bls-"));
  const sessions = [{ id: "s1", cwd: REPO, title: `${backlogTitle(REPO)} · x`, createdAt: 1, idle: 99_000, running: true }];
  const removed = [];
  const fake = {
    list: () => sessions, get: (id) => sessions.find((s) => s.id === id),
    remove: (id) => { removed.push(id); return true; },
    idleMs: () => 99_000, autoFireBlocker: () => null,
  };
  const b = new BacklogManager(root, fake, { list: () => [], kick: () => {} }, { get: () => undefined });
  assert.deepEqual(b.lingerSweep(() => false), []);
  assert.equal(b.reapAutoSession(() => false), null);
  assert.deepEqual(removed, []);
  rmSync(root, { recursive: true, force: true });
});

test("global OFF: neither the linger sweep nor the slot reap closes an idle automatic session", () => {
  const { backlog, state, isAttached, root } = makeBacklog();
  state.closeDefault = false;
  live(state, "s-a", { createdAt: 1, idle: 9_000 });
  live(state, "s-b", { createdAt: 2, idle: 9_000 });
  assert.deepEqual(backlog.lingerSweep(isAttached), []);
  assert.equal(backlog.reapAutoSession(isAttached), null, "the queued row waits — a person closes one");
  assert.deepEqual(state.removed, []);
  rmSync(root, { recursive: true, force: true });
});

test("global OFF, the item said close-when-done: only THAT session closes", () => {
  const { backlog, state, isAttached, root } = makeBacklog();
  state.closeDefault = false;
  live(state, "s-close", { createdAt: 1, idle: 9_000 });
  live(state, "s-keep", { createdAt: 2, idle: 9_000 });
  state.rows.push({ id: "r1", state: "done", sessionId: "s-close", createdAt: 1, closeWhenDone: true });
  state.rows.push({ id: "r2", state: "done", sessionId: "s-keep", createdAt: 2 });
  assert.deepEqual(backlog.lingerSweep(isAttached), ["s-close"]);
  assert.deepEqual(state.removed, ["s-close"]);
  rmSync(root, { recursive: true, force: true });
});

test("the repo's own session (the sheet's \"open a session here\") never closes, even with the global switch ON", () => {
  const { backlog, state, isAttached, root } = makeBacklog();
  state.closeDefault = true;
  live(state, "s-own", { title: backlogTitle(REPO), createdAt: 1, idle: 9_000 });
  live(state, "s-item", { createdAt: 2, idle: 9_000 });
  assert.equal(backlog.closesWhenDone("s-own"), false);
  assert.deepEqual(backlog.lingerSweep(isAttached), ["s-item"]);
  assert.equal(backlog.reapAutoSession(isAttached), null);
  rmSync(root, { recursive: true, force: true });
});

test("global ON, the item said keep it open: the sweep and the reap both leave it", () => {
  const { backlog, state, isAttached, root } = makeBacklog();
  live(state, "s-keep", { createdAt: 1, idle: 9_000 });
  live(state, "s-close", { createdAt: 2, idle: 9_000 });
  state.rows.push({ id: "r1", state: "done", sessionId: "s-keep", createdAt: 1, closeWhenDone: false });
  assert.equal(backlog.reapAutoSession(isAttached), "s-close", "the oldest is passed over — it was asked to stay");
  assert.deepEqual(backlog.lingerSweep(isAttached), []);
  assert.equal(state.sessions.some((s) => s.id === "s-keep"), true);
  rmSync(root, { recursive: true, force: true });
});

test("the item that OPENED the session decides, found by the mark openItemSession leaves", () => {
  const { backlog, state, isAttached, root } = makeBacklog();
  const row = { id: "i-keep", cwd: REPO, closeWhenDone: false, state: "done", createdAt: 5, payload: { kind: "prompt", steps: ["go"] } };
  state.rows.push(row); // NO sessionId on it: the mark alone has to find it
  const sid = backlog.openItemSession(row);
  state.sessions.find((s) => s.id === sid).idle = 9_000;
  assert.equal(backlog.closesWhenDone(sid), false);
  assert.deepEqual(backlog.lingerSweep(isAttached), []);
  // A person flips it on the row while the session is open — the next sweep obeys.
  row.closeWhenDone = true;
  assert.deepEqual(backlog.lingerSweep(isAttached), [sid]);
  rmSync(root, { recursive: true, force: true });
});

test("with no mark (a restart), the EARLIEST row naming the session is the opener", () => {
  const { backlog, state, root } = makeBacklog();
  state.closeDefault = false;
  live(state, "s-x", { createdAt: 1, idle: 9_000 });
  state.rows.push({ id: "later", state: "done", sessionId: "s-x", createdAt: 9, startedAt: 9 });
  state.rows.push({ id: "opener", state: "done", sessionId: "s-x", createdAt: 1, startedAt: 2, closeWhenDone: true });
  assert.equal(backlog.closesWhenDone("s-x"), true);
  assert.equal(backlog.closesWhenDone("s-nobody"), false, "no row at all is the global answer");
  rmSync(root, { recursive: true, force: true });
});

test("autoSlotFacts: the ceiling and every open automatic session, oldest first, with its answer — a fact", () => {
  const { backlog, state, root } = makeBacklog();
  state.closeDefault = false;
  live(state, "s-new", { createdAt: 2 });
  live(state, "s-old", { createdAt: 1 });
  live(state, "s-hand", { title: "waterplane-bls-repo", createdAt: 0 });
  state.rows.push({ id: "r", state: "done", sessionId: "s-new", createdAt: 2, closeWhenDone: true });
  const f = backlog.autoSlotFacts();
  assert.equal(typeof f.max, "number");
  assert.deepEqual(f.open, [{ id: "s-old", closeWhenDone: false }, { id: "s-new", closeWhenDone: true }]);
  assert.deepEqual(state.removed, [], "reading the facts closes nothing");
  rmSync(root, { recursive: true, force: true });
});

test("backlog.update's closeWhenDone goes through edit() — any state, never a requeue — and null clears it", () => {
  const { backlog, state, root } = makeBacklog();
  state.rows.push({ id: "run", state: "running", cwd: REPO, createdAt: 1, payload: { kind: "prompt", steps: ["x"] }, target: { kind: "repo", fresh: true }, trigger: { kind: "idle" } });
  backlog.update("run", { closeWhenDone: true });
  backlog.update("run", { closeWhenDone: null });
  backlog.update("run", { closeWhenDone: false });
  assert.deepEqual(state.edits.map((e) => e.closeWhenDone), [true, null, false]);
  rmSync(root, { recursive: true, force: true });
});

// ── 6. what the closed row will SAY about these sessions ────────────────────
//
// The reason and the origin are written by the CALLER of `remove()`/`create()`
// — the exit path only reads them back (`roster.ts`'s `closedRowOf`). A sweep
// that forgot to name itself would land under *Recently closed* as a person's
// close, which is exactly the row the phone must mark differently.

test("the linger sweep closes as auto-done, the slot reap as auto-slot", () => {
  const { backlog, state, isAttached, root } = makeBacklog();
  live(state, "s-linger", { createdAt: 1, idle: 9_000 });
  backlog.lingerSweep(isAttached);
  live(state, "s-reap", { createdAt: 2, idle: 9_000 });
  backlog.reapAutoSession(isAttached);
  assert.deepEqual(state.removedBy, [{ id: "s-linger", by: "auto-done" }, { id: "s-reap", by: "auto-slot" }]);
  rmSync(root, { recursive: true, force: true });
});

test("an item's session is opened carrying the item: kind, id and its label", () => {
  const { backlog, state, root } = makeBacklog();
  backlog.openItemSession({ id: "i9", cwd: REPO, label: "fix the flaky test", trigger: { kind: "now" }, payload: { kind: "prompt", steps: ["fix it"] } });
  assert.deepEqual(state.created[0].origin, { kind: "backlog", itemId: "i9", itemLabel: "fix the flaky test" });
  backlog.openItemSession({ id: "a1", cwd: REPO, origin: "agent", trigger: { kind: "now" }, payload: { kind: "prompt", steps: ["look at the logs"] } });
  assert.deepEqual(state.created[1].origin, { kind: "agent", itemId: "a1", itemLabel: "look at the logs" });
  rmSync(root, { recursive: true, force: true });
});
