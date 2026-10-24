/**
 * The sessions fired work runs in — one per item, their cap and linger —
 * and the executor that types an item into one. Split out of `BacklogManager`
 * (move only): the methods are functions over `BacklogCore`.
 */
import type { AutoSlotFacts, Intent } from "@waterplane/shared";
import { closeWhenDoneOf, sessionOriginOfIntent, shellBucket, logTag } from "@waterplane/shared";
import type { ExecutorResult } from "../intents/manager.js";
import { deliverPrompt, type DeliveryResult } from "../deliver.js";
import { BACKLOG_LINGER_MS, BACKLOG_SESSIONS_MAX, REAP_CEILING_MS, REAP_IDLE_MS } from "./backlogknobs.js";
import { backlogTitle, isBacklogTitle, itemTitle } from "./backlogtitles.js";
import { chainDeliveryError, retryableStep } from "./backlogwording.js";
import type { BacklogCore } from "./backlogcore.js";

/** Wire the global close-when-done default (main.ts: the synced setting). */
export function setCloseWhenDoneDefault(c: BacklogCore, read: () => boolean): void {
  c.closeDefault = read;
}

/**
 * The row that OPENED a session: the mark `openItemSession` left, else the
 * earliest row whose `sessionId` names it (the opener, not a later row typed
 * into the same session). The one lookup `closesWhenDone` and the follow-up
 * sweep (`backlogfollowup.ts`) both ask.
 */
export function openerRow(c: BacklogCore, sessionId: string): Intent | undefined {
  const rows = c.intents.list();
  const marked = c.openedBy.get(sessionId);
  let row = marked ? rows.find((r) => r.id === marked) : undefined;
  if (!row) {
    for (const r of rows) {
      if (r.sessionId !== sessionId) continue;
      if (!row || (r.startedAt ?? r.createdAt) < (row.startedAt ?? row.createdAt)) row = r;
    }
  }
  return row;
}

/**
 * Does this automatic session close itself once it is done?
 *
 * The item that opened it decides (`Intent.closeWhenDone`, absent ⇒ the
 * global setting) — `closeWhenDoneOf` is the one rule. Found by the mark
 * `openItemSession` left, else by the row whose `sessionId` names it (the
 * earliest: the opener, not a later row typed into the same session). No row
 * at all — the sheet's own *open a session here*, a row compacted away — is
 * the global answer. A read that throws is OFF: the failure mode of this
 * question must be a session left open, never one closed.
 */
export function closesWhenDone(c: BacklogCore, sessionId: string): boolean {
  try {
    // The repo's OWN session (the bare `backlog · <repo>` title, no item
    // after it) is the sheet's "open a session here": a person opened it,
    // so no setting closes it. Recognised by title, which survives a restart.
    const info = c.sessions.get(sessionId);
    if (info && info.title === backlogTitle(info.cwd)) return false;
    const row = openerRow(c, sessionId);
    return closeWhenDoneOf(row, c.closeDefault());
  } catch {
    return false;
  }
}

/**
 * The cap as facts (`AutoSlotFacts`) — the `noSlot` sentence's numbers and
 * what the phone offers "close one to make room" from. Never an action.
 */
export function autoSlotFacts(c: BacklogCore): AutoSlotFacts {
  const open = c.sessions.list()
    .filter((s) => s.running && isBacklogTitle(s.title))
    .sort((a, b) => a.createdAt - b.createdAt)
    .map((s) => ({ id: s.id, closeWhenDone: closesWhenDone(c, s.id), busy: slotBusy(c, s.id) }));
  return { max: BACKLOG_SESSIONS_MAX, open };
}

/**
 * Open a session FOR ONE ITEM — what a fired fresh row runs in.
 *
 * The title carries the item's own label after the prefix (`backlog · myrepo ·
 * fix the flaky test`) so the launcher row says which piece of work it is,
 * while `BACKLOG_PREFIX` stays the only recognition mark: `isBacklogTitle` is
 * a prefix test, so the cap, the reap and the linger sweep all keep working on
 * the older `backlog · <repo>` sessions too.
 *
 * `resume` is the one deliberate continuation — `claude --continue`, the "a new
 * session, picking up the repo's last conversation" chip. Nothing infers it;
 * absent starts clean, which is the cheap side of `sessioncost.ts`.
 *
 * **And the ONE named continuation is `resumeConvId`**: a clock row aimed at
 * a session whose process has since gone reopens THE CONVERSATION it was
 * aimed at (`--resume <id>`), not the repo's last one and not an empty
 * window. `--continue` would be the guess this repo already paid for once
 * (`revivedSessionFor`): the gap between writing the row and its instant is
 * days, and whatever conversation happens to be newest in that worktree by
 * then is not the one the words were about. `manager.execute()` routes here
 * only when the session is actually gone, so a live target is still typed
 * into and nothing is reopened behind it.
 *
 * It does NOT go through `repoSessions`: there is no per-repo session to track
 * any more, and caching one would be the shared-session model growing back.
 */
export async function openItemSession(c: BacklogCore, i: Intent): Promise<string> {
  const label = i.label || (i.payload.kind === "prompt" ? i.payload.steps[0] : "") || i.id;
  // `?.` and not `.`: a hand-built row (a caller inside this host, a test)
  // may carry no target at all, and refusing to OPEN A SESSION over a missing
  // optional field would be a crash in place of a session.
  const convId = i.target?.kind === "session" && !c.sessions.get(i.target.sessionId)?.running
    ? i.target.resumeConvId
    : undefined;
  const id = (await c.sessions.create(i.cwd, {
    title: itemTitle(i.cwd, label),
    resume: i.resume,
    ...(convId ? { resumeMode: "continue" as const, resumeSessionId: convId } : {}),
    origin: sessionOriginOfIntent(i),
    // The item's own budget, the session is born with it (`Intent.budget`).
    ...(i.budget ? { budget: i.budget } : {}),
    // …and the model/effort/backend a person picked for it (`Intent.launch`,
    // the send sheet's *model* row). Absent = the desktop's new-session
    // defaults, which is what a backlog item has always opened on.
    ...(i.launch ? { launch: i.launch } : {}),
  })).id;
  // Which item opened it — the shortcut `closesWhenDone` asks first.
  c.openedBy.set(id, i.id);
  // A slot has just been spent and a session has just appeared: every row
  // waiting on either fact is re-asked now rather than in two seconds.
  c.intents.kick();
  return id;
}

/**
 * Close the automatic sessions that have been sat on long enough to look at.
 *
 * `sessions.remove()`, never `kill()`: remove lets the exit path record the
 * session under *Recently closed*, where it reopens with `--continue` and its
 * conversation stays listed by `archive.ts` for ever. `kill()` is a teardown
 * with no closed-row on the other side of it, which for a piece of work that
 * just RAN is the one thing nobody wants.
 *
 * `isAttached` is the host's own fact (a socket is watching that session), and
 * it is the exemption that matters: nothing here ever closes a session
 * somebody has open on their phone.
 *
 * **Only a session whose item said close-when-done** (`closesWhenDone`, the
 * global setting being OFF by default): the rest stay open until a person
 * closes them — `reapable()`'s first gate.
 */
export function lingerSweep(c: BacklogCore, isAttached: (id: string) => boolean): string[] {
  const gone: string[] = [];
  for (const s of c.sessions.list()) {
    if (!reapable(c, s.id, isAttached, BACKLOG_LINGER_MS)) continue;
    if (c.sessions.remove(s.id, undefined, "auto-done")) gone.push(s.id);
  }
  if (gone.length) c.intents.kick();
  return gone;
}

/**
 * May this session be closed on the host's own initiative?
 *
 * There is deliberately no "somebody looked at it once" exemption — a session
 * nobody has open, with no work in it, that the CLI says is free is a session
 * whose only remaining value is its conversation, and that survives being
 * closed (`remove()`, so it lands in *Recently closed* and `--continue`
 * reopens it).
 *
 * ── Why the idle test is the CLI's word and not PTY silence ───────────────
 *
 * It used to be `idleMs(id) >= idleFor` — "the screen has not moved for a
 * minute" — with "an intent `starting`/`running` in it" standing in for
 * mid-turn. Those are different facts, and `PLAN.md` §2.2 promised the other
 * one: *"Never a session a person is looking at, never one mid-turn."*
 *
 * The gap is not theoretical and it is now common by construction. A chain row
 * whose step 2 failed ends `failed` while step 1's turn is still running in a
 * `backlog · …` session with no row in it; a first-step `unconfirmed` does the
 * same (the words DID land, the row says failed); and `ensureRepoSession` is a
 * hand-driven session wearing the mark with nothing ever `running` in it. What
 * "mid-turn and silent for 60 s" IS in practice is a session waiting on a
 * PERSON — a permission box, or an `AskUserQuestion` — because the working
 * spinner repaints every second, so a live TOOL CALL is never silent. Closing
 * it drops the pending tool call, SIGHUPs an agent mid-`Edit`, and "makes room"
 * by closing the one session that was doing something.
 *
 * `sessions.autoFireBlocker(id, idleFor)` is that question, already written
 * and already the one implementation: hook-aware (`turnActive`), box-aware
 * (`sessionWall` — limit, prompt, `awaitingInput`), and for a session with no
 * hook pipe it IS the silence rule at `idleFor`. No fourth ladder, no second
 * reading of `turnActive`, and `"hasn't printed anything yet"` matches the old
 * `idleMs() === null`.
 *
 * The cost, stated: a hooked session whose `Stop` was lost keeps `turnActive`
 * for ever and would never be reaped — a slot held until restart. That is what
 * `REAP_CEILING_MS` is for, and it is the only thing that may overrule the
 * CLI's own word.
 *
 * ── And never on a background shell still doing something ─────────────────
 *
 * "Nothing here auto-closes a session" used to mean the CLI's own turn flag;
 * it never meant a `run_in_background` Bash or a Monitor a person cannot see
 * from the phone unless they open the shells sheet. `autoFireBlocker` has no
 * opinion about those — they outlive the turn that launched them BY DESIGN —
 * so an automatic reap that only asked it would SIGHUP an emulator or a dev
 * server nobody was told was at risk. A `foreground` shell is not this
 * check's business (closing the session IS what ends it, same as any other
 * turn); a background one that is `working` or `serverLike` is, and holds
 * the session open the same way a live tool call does.
 */
export function reapable(c: BacklogCore, id: string, isAttached: (sid: string) => boolean, idleFor: number): boolean {
  const info = c.sessions.get(id);
  if (!info?.running || !isBacklogTitle(info.title)) return false;
  // The person's decision before any reading of the session: a session not
  // set to close when done is closed by nobody but a person — not the linger,
  // not the slot reap. Silent on purpose (asked every sweep).
  if (!closesWhenDone(c, id)) return false;
  if (isAttached(id)) return false;
  // Counted off the STORE, not off a map here: a row is `starting` for the
  // whole window in which a delivery is being proved, which is exactly the
  // window in which this session looks idle and is not.
  if (c.intents.list().some((r) => (r.state === "starting" || r.state === "running") && r.sessionId === id)) return false;
  const now = Date.now();
  const busyShell = info.shellList?.find(
    (sh) => !sh.foreground && (sh.serverLike || shellBucket(sh, now) === "working"),
  );
  if (busyShell) {
    const label = busyShell.description || busyShell.command.slice(0, 60);
    console.log(`${logTag} backlog: keeping ${id} open — a background shell is still ${busyShell.serverLike ? "running (long-running by design)" : "working"}: ${label}`);
    return false;
  }
  // A background AGENT is the same fact as a background shell, one tool
  // over: an orchestrator that hands a work package to a subagent and ends
  // its turn to wait for the notification is at the prompt, hooked, and
  // `autoFireBlocker` calls it free. Closing it there killed the subagent
  // mid-typecheck and left half a work package in the tree with nobody to
  // finish it. `info.agents` retires itself (a notification, or agents.ts's
  // STALE_MS), so this is not overruled by the ceiling either.
  const agent = info.agents?.[0];
  if (agent) {
    console.log(`${logTag} backlog: keeping ${id} open — ${info.agents!.length} background agent${info.agents!.length === 1 ? " is" : "s are"} still running: ${agent.what}`);
    return false;
  }
  if (c.sessions.autoFireBlocker(id, idleFor) === null) {
    // The CLI's word says "free NOW"; it says nothing about "for how long",
    // and a hooked session never consults `idleFor` — so the ten-minute
    // linger was a one-minute one (the sweep's own interval). `idleSince` is
    // stamped when the turn ended; absent means nobody stamped it, which is
    // the old answer.
    const since = info.idleSince;
    return since == null || Date.now() - since >= idleFor;
  }
  // …and the backstop, over the CLI's word and nothing else.
  const idle = c.sessions.idleMs(id);
  return idle != null && idle >= REAP_CEILING_MS;
}

/**
 * Open the repo's own auto-titled session — the sheet's explicit "open a
 * session here" button, and the one thing `queue here` can then aim at.
 *
 * It is no longer where fired work goes (every item opens its own), so this is
 * now only what it always looked like: a session, in this repo, named so that
 * the cap and the sweeps above still count it. Reused if alive, (re)created if
 * absent or dead.
 */
export async function ensureRepoSession(c: BacklogCore, repoDir: string): Promise<string> {
  const id = c.repoSessions.get(repoDir);
  if (id && c.sessions.get(id)?.running) return id;
  // A session this host opened for this very purpose, before it was restarted.
  // The map is memory-only and the sessions are not: under the TMUX knob at 1 the
  // `claude` processes outlive the daemon and `rediscover()` re-adopts them by
  // the same id — but nothing re-adopted them as BACKLOG sessions, so after
  // every restart a repo's own session looked exactly like one opened by hand
  // and its queued work went back to saying it had nowhere to go. That is the
  // other half of the forty stranded rows; the title is the mark.
  const known = adoptBacklogSession(c, repoDir);
  if (known) return known;
  const fresh = (await c.sessions.create(repoDir, { title: backlogTitle(repoDir), origin: { kind: "backlog" } })).id;
  c.repoSessions.set(repoDir, fresh);
  // A repo that had nothing to fire into a moment ago now has somewhere: every
  // row blocked on `sessionGone` is free, and none of them is watching a timer.
  c.intents.kick();
  return fresh;
}

/**
 * An already-open running session for this repo's work, or null — NEVER
 * spawns one.
 *
 * The one implementation of the question `IntentDeps.repoSession` asks, which
 * is why it is injected rather than guessed at a second time. It always
 * prefers the backlog's OWN tracked session. `adopt` controls the fallback to
 * a session the user opened by hand:
 *  - a hand fire (adopt = true) may take one — the user asked for it, now;
 *  - AUTOMATIC work (adopt = false) must not: silently injecting queued
 *    prompts into the session you are actively driving is the last thing
 *    anyone wants. An adopted session is used once and never cached as the
 *    repo's backlog session (that used to permanently rebind it).
 */
export function resolveRepoSession(c: BacklogCore, repoDir: string, adopt = false): string | null {
  const tracked = c.repoSessions.get(repoDir) ?? adoptBacklogSession(c, repoDir) ?? undefined;
  if (tracked && c.sessions.get(tracked)?.running) return tracked;
  // The tracked session died at the usage limit; the host resurrects it as a
  // NEW session in the same repo. Re-adopt that revival even for automatic
  // work, so the backlog follows its own session across the limit bounce.
  if (tracked && c.sessions.diedAtLimit(tracked)) {
    const revived = c.sessions.runningSessionFor(repoDir);
    if (revived) { c.repoSessions.set(repoDir, revived); return revived; }
    return null; // not resurrected yet — wait for it
  }
  if (!adopt) return null;
  return c.sessions.runningSessionFor(repoDir);
}

/**
 * An automatic session in this repo that somebody could still be given, found
 * by the PREFIX its title carries.
 *
 * Recognition rather than bookkeeping: a persisted map would need writing,
 * migrating and keeping in step with sessions that die on their own, while the
 * title is already on the row, already survives `rediscover()`, and is already
 * what the user sees.
 *
 * Prefix rather than the exact `backlog · <repo>` string, because a session is
 * now named after the ITEM it was opened for — and NEWEST-IDLE-FIRST rather
 * than simply newest, because handing back one that is mid-turn is handing
 * back a session the caller then has to wait out. Two callers only:
 * `resolveRepoSession(cwd, adopt = true)` (a hand fire on a row old enough to
 * predate `fresh`) and the reap. Automatic work never adopts anything.
 */
export function adoptBacklogSession(c: BacklogCore, repoDir: string): string | null {
  let best: { id: string; createdAt: number; idle: number } | null = null;
  for (const s of c.sessions.list()) {
    if (!s.running || s.cwd !== repoDir || !isBacklogTitle(s.title)) continue;
    const idle = c.sessions.idleMs(s.id);
    if (idle == null) continue;
    const cand = { id: s.id, createdAt: s.createdAt, idle };
    if (!best || cand.idle > best.idle || (cand.idle === best.idle && cand.createdAt > best.createdAt)) best = cand;
  }
  if (!best) return null;
  c.repoSessions.set(repoDir, best.id);
  return best.id;
}

/**
 * How many sessions MACHINERY has alive on this host right now — the number
 * `BACKLOG_SESSIONS_MAX` is a ceiling on, and the one `IntentFacts.
 * autoSlotsFree` is subtracted from.
 *
 * Counted off the SESSIONS and never off a map, for the reason the cap exists:
 * it is about how many `claude` processes are running, so a restart (which
 * empties every map and nothing else) must not make a host with a dozen agents
 * on it read as zero. A session the sheet's own button opened counts too — the
 * cap is about processes, not about who asked for them.
 */
export function autoSessionCount(c: BacklogCore): number {
  return c.sessions.list().filter((s) => s.running && isBacklogTitle(s.title) && slotBusy(c, s.id)).length;
}

/**
 * Does this automatic session hold a slot — is it WORKING? (R-automation-042)
 *
 * The cap bounds how many agents run at once, so an idle session left open
 * (close-when-done is off by default) holds none: it is a conversation waiting
 * to be read. Before this, every open `backlog · …` session counted, nothing
 * closed them, and a desktop with three finished items open fired nothing —
 * timed rows included, an hour before a reset they were timed for.
 *
 * Working is every fact `reapable()` refuses a close on, in the same order: a
 * row `starting`/`running` in it (a delivery being proved looks idle and is
 * not), a background shell `working` or `serverLike`, a background agent, and
 * the CLI's own word (`autoFireBlocker` — a turn, a box, a limit wall). Who is
 * attached is NOT a fact here: a person reading a finished session is not an
 * agent running. `REAP_CEILING_MS` of PTY silence overrules the CLI's word and
 * nothing else, for the reason it does there — a lost `Stop` leaves
 * `turnActive` set for the life of the process, which would hold a slot until
 * restart.
 */
export function slotBusy(c: BacklogCore, id: string): boolean {
  const info = c.sessions.get(id);
  if (!info?.running) return false;
  if (c.intents.list().some((r) => (r.state === "starting" || r.state === "running") && r.sessionId === id)) return true;
  const now = Date.now();
  if (info.shellList?.some((sh) => !sh.foreground && (sh.serverLike || shellBucket(sh, now) === "working"))) return true;
  if (info.agents?.length) return true;
  if (c.sessions.autoFireBlocker(id, REAP_IDLE_MS) === null) return false;
  const idle = c.sessions.idleMs(id);
  return !(idle != null && idle >= REAP_CEILING_MS);
}

/**
 * Type an intent's words into a session that already exists, and say what
 * became of it.
 *
 * The whole of what the backlog still DOES. `deliverPrompt` is the one
 * implementation of "type into a live session like a human, and confirm" —
 * the fan-out and `session.create`'s first prompt use it too, and two copies
 * of that logic would drift. Only `retry` (provably nothing typed) may be
 * re-attempted, and that decision is the store's, stated once for every
 * executor.
 */
export async function deliver(c: BacklogCore, i: Intent, sessionId: string): Promise<ExecutorResult> {
  const steps = i.payload.kind === "prompt" ? i.payload.steps : [];
  if (!steps.length) return { ok: false, detail: "nothing to type" };
  let last: DeliveryResult = "ok";
  let step = 0;
  for (; step < steps.length; step++) {
    last = await deliverPrompt(c.sessions, sessionId, steps[step], steps[step].trimStart().startsWith("/") ? "command" : "prompt",
      { audit: { source: "backlog", actor: "auto", detail: "a work item fired" } });
    if (last !== "ok") break;
  }
  if (last === "ok") return { ok: true, detail: "delivered", sessionId, watch: "turn" };
  // `step` travels for the store's Stop shortcut: a Stop seen while a later
  // step was being delivered is evidence about step 1, never about this one.
  return { ok: false, step, detail: chainDeliveryError(last, step, steps.length), sessionId, retry: retryableStep(last, step) };
}

