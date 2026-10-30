/**
 * Completion and restart reconciliation — what ends a turn that was started on
 * someone's behalf, and what the rows mid-flight when the process died mean.
 * A slice of `IntentManager` (docs/notes/host-architecture.md, `intents/`);
 * it owns `reconciled` and reaches everything else through `IntentCore`.
 *
 * `reconcileOne` never persists; `reconcile` persists once, if dirty.
 */
import type { Intent, IntentResult, TurnEndNet } from "@waterplane/shared";
import { needsSlot, postsScheduledBuild } from "@waterplane/shared";
import { isRecurring, spanWords, type IntentCore } from "./contract.js";

export class WatchSlice {
  /** Set by the first `reconcile()` once it has run; the facade's `tick` waits on it. */
  reconciled = false;
  /** The first `reconcile()` while it waits on its evidence — a second call joins it. */
  private reconciling: Promise<void> | null = null;

  constructor(private readonly core: IntentCore) {}

  // ── Completion: what ends a turn that was started on someone's behalf ─────

  /**
   * A session reported a finished turn.
   *
   * Positive evidence, and the reason it beats every silence guess: the count
   * is compared against the baseline snapshotted BEFORE anything was typed, so
   * the Stop that made the session ready cannot complete the work it made room
   * for. This is the single copy of a watcher that used to exist twice — the
   * backlog's and the fan-out's — with the two subscriptions that fed them.
   *
   * `net` (`sessions/apiretry.ts`, R-connection-024): the turn ended because the
   * CLI gave up on a transient API error. `retrying`/`checking` ⇒ the turn did
   * not do the work — the row keeps waiting, baseline untouched, for the turn
   * the host's `continue` runs (or a person's, once they type over it).
   * `gaveup` ⇒ STALLED: the row stays `running`, baseline untouched — never
   * failed, never `done`, never requeued (the prompt WAS delivered, the
   * conversation is intact, and at-most-once means it is never typed again).
   * A recurring rule's occurrence stays running the same way: putting the rule
   * back in the queue would let its next occurrence fire into, or beside, a
   * conversation whose turn has not ended, and a reply that lands later would
   * have no row to complete. The stall is DERIVED (`netStalledOf`) from the
   * session's `netRetry`, and the row completes the ordinary way on the next
   * real turn end — "Retry now"'s reply, the person typing, a later reply.
   * `sweepRunning` does not fail it for its silence meanwhile.
   */
  onTurnEnded(sessionId: string, stopCount: number, net?: TurnEndNet): void {
    if (net) return;
    for (const row of [...this.core.rows()]) {
      if (row.sessionId !== sessionId) continue;
      if (row.state !== "running" && row.state !== "starting") continue;
      const base = this.core.stopBase.get(row.id);
      if (base == null || stopCount <= base) continue;
      if (row.state === "starting") {
        // Its turn ended before the delivery finished proving itself. Remember
        // it; `fire()` reads this the moment the executor returns.
        this.core.stopSeen.set(row.id, stopCount);
        continue;
      }
      // `complete()` broadcasts the row itself — a blanket second frame here
      // would put two identical lists on the wire for one transition, and a
      // client acting on the first would then act on the second.
      this.complete(row, this.core.readopted.has(row.id)
        ? "the host restarted after this was delivered; its turn finished afterwards — the conversation log has it"
        : "its turn finished");
    }
  }

  /**
   * A session died. Anything still waiting on it cannot complete — and MUST NOT
   * be marked done: a running row means its turn never ended cleanly, because a
   * clean end would have completed it first.
   */
  onSessionExit(sessionId: string): void {
    for (const row of [...this.core.rows()]) {
      if (row.sessionId !== sessionId) continue;
      if (row.state !== "running") continue;
      this.endWithDeadSession(row, sessionId);
    }
  }

  /**
   * Rows delivered and waiting for a turn to end, re-asked once a tick.
   *
   * The hook path (`onTurnEnded`) is exact and is preferred wherever the pipe is
   * live. This is the fallback for a session with no hooks, plus the one thing
   * an event cannot tell us: that the session is simply gone.
   */
  sweepRunning(now: number): void {
    for (const row of [...this.core.rows()]) {
      if (row.state !== "running" || !row.sessionId) continue;
      const sid = row.sessionId;
      const idle = this.core.deps.sessionIdleMs(sid);
      if (idle == null) {
        if (this.core.deps.sessionAlive(sid)) continue;
        this.endWithDeadSession(row, sid);
        continue;
      }
      // A pending choice box means the turn is BLOCKED on a person, not
      // finished — and the two look identical from the outside.
      if (this.core.deps.sessionHasPrompt(sid)) continue;
      // …and so does a dialog the detector could NOT parse: `awaitingInput` is
      // the session saying a person is being waited on, with no box to show for
      // it. Silence under one is a question, not an ending.
      if (this.sessionAwaitingInput(sid)) continue;
      // STALLED on the API (`onTurnEnded`'s `gaveup`): the session is silent
      // because the CLI gave up and the host stopped retrying — waiting on a
      // person's Retry now or typing, not a lost Stop and not an idle ending.
      // Neither the ceiling below nor the idle guess may settle it.
      if (this.core.deps.sessionNetStalled?.(sid)) continue;
      const hooked = this.core.deps.isHooked(sid);
      // ── The backstop: a Stop that was lost ─────────────────────────────────
      //
      // The hook is a `curl -m 2` with no retry, so a Stop can simply not
      // arrive — and a hooked row then waits for it for the life of the
      // process, holding its session (and an automatic slot: `reapable()`
      // exempts a session with a running row) until a restart. The reaper's own
      // ceiling is the one number this desktop already trusts to overrule the
      // CLI's word, so it is used here too. `fail`, never `done`: nothing says
      // the turn finished, only that nothing has been heard.
      const ceiling = this.core.deps.reapCeilingMs?.();
      if (hooked && ceiling != null && ceiling > 0 && idle >= ceiling) {
        this.giveUp(row, `no turn-end signal arrived and the session has been silent for ${spanWords(ceiling)} — check the conversation before running it again`, now);
        continue;
      }
      // A fan-out target says `running` until something PROVES its turn ended.
      // The sweep's output is a claim about N repos; a silence guess is not one.
      if (this.core.watchMode.get(row.id) === "hook") continue;
      // A hooked session completes on its Stop, exactly. Guessing here as well
      // is what marked work done on a mid-task pause. Unless no turn-shaped
      // hook has reported since this process attached: after a restart the
      // first hook is often a `Notification` about a turn whose Stop fired
      // while the host was down, and waiting for that Stop waits for ever.
      if (hooked && (this.core.deps.turnHookSeen?.(sid) ?? true)) continue;
      if (idle < this.core.deps.idleWindowMs()) continue;
      this.complete(row, this.core.readopted.has(row.id)
        ? "the host restarted after this was delivered; the session has gone quiet since — the conversation log has it"
        : "the session went idle after it", now);
    }
  }

  /** A running row nothing will ever complete: failed (a standing rule:
   *  back to `queued`, `ok:false`, its next occurrence already armed at fire
   *  time). The counterpart of `complete()`, with the same bookkeeping. */
  private giveUp(row: Intent, detail: string, now = Date.now()): void {
    this.core.stopBase.delete(row.id);
    this.core.stopSeen.delete(row.id);
    this.core.watchMode.delete(row.id);
    this.core.readopted.delete(row.id);
    const result: IntentResult = { at: now, ok: false, detail, occurrence: row.lastOccurrence };
    if (isRecurring(row)) {
      row.state = "queued";
      row.result = result;
      row.startedAt = undefined;
      row.blockReason = undefined;
      row.blockDetail = undefined;
      this.core.persist();
      this.core.deps.onChange(row);
      this.core.emit("settled", row, result);
      return;
    }
    this.core.settle(row, "failed", result);
  }

  private sessionAwaitingInput(sessionId: string): boolean {
    return this.core.deps.sessions().find((s) => s.id === sessionId)?.awaitingInput === true;
  }

  /** The work this row started is over, and it worked. */
  complete(row: Intent, detail: string, now = Date.now()): void {
    this.core.stopBase.delete(row.id);
    this.core.stopSeen.delete(row.id);
    this.core.watchMode.delete(row.id);
    this.core.readopted.delete(row.id);
    const result: IntentResult = { at: now, ok: true, detail, occurrence: row.lastOccurrence };
    if (isRecurring(row)) {
      row.state = "queued";
      row.result = result;
      row.startedAt = undefined;
      // A re-adopted row carried a sentence about being watched; a standing
      // rule back in the queue must not keep wearing it.
      row.blockReason = undefined;
      row.blockDetail = undefined;
      this.core.persist();
      this.core.deps.onChange(row);
      this.core.emit("settled", row, result);
      return;
    }
    this.core.settle(row, "done", result);
  }

  /**
   * A row whose session went away while it was working.
   *
   * A usage-limit exit is not a failure: the host reopens that session at the
   * reset, so the work is REQUEUED and follows it. Anything else is a crash or a
   * `/quit`, which is a failure — and neither is ever `done`, because a finished
   * turn would have completed the row before the session could exit.
   */
  private endWithDeadSession(row: Intent, sessionId: string): void {
    const now = Date.now();
    // ── A row in a session of its OWN, at the usage limit ───────────────────
    //
    // Asked BEFORE the baselines are cleared, because this row is not ending: it
    // is following its session to the one that replaces it.
    //
    // Requeueing is what the shared-session model did, and for that model it was
    // right — `resolveRepoSession` followed the resurrection, so the requeued row
    // landed back in the same conversation. For a row whose session was opened
    // FOR IT, requeueing runs the work TWICE: the host `--continue`s that very
    // conversation at the reset (`sessions/resume.ts`'s resurrection) AND the queued row
    // opens a second fresh session to run the same words in. So the row stays
    // `running` and is re-aimed instead, which is the same move the tick already
    // makes for a `session` target — extended here to the row that has no target
    // to re-aim yet because its session was its own.
    // `needsSlot(row) || row.followed` — the second half is the whole of the fix
    // for the two-wall case. `needsSlot` reads the TARGET, and the re-aim below
    // rewrites the target to a `session` one, so from the second wall onwards
    // the shape that earned the exemption is gone while the row that earned it
    // is the same row. See `Intent.followed`: a weekly limit reopens after five
    // seconds and re-hits the same wall by construction, so this is the ordinary
    // path for every weekly wall, not a rarity.
    if (this.core.deps.diedAtLimit(sessionId) && (needsSlot(row) || row.followed)) {
      const revived = this.core.deps.revivedSessionFor(sessionId);
      if (revived && revived !== sessionId) {
        // `...row.target` rather than a fresh object for the re-aim one loop
        // up's reason: whatever conversation this row was told to reopen is
        // still the conversation the reopened session is in.
        row.target = { ...(row.target.kind === "session" ? row.target : {}), kind: "session", sessionId: revived };
        row.sessionId = revived;
        // Written HERE, beside the re-aim that destroys the evidence.
        row.followed = true;
        row.blockReason = undefined;
        row.blockDetail = undefined;
        // A fresh baseline for a fresh process: the old count died with the PTY,
        // and a row watching a number from a session that no longer exists would
        // never complete. `watchMode` is re-stated for the same reason.
        this.core.stopSeen.delete(row.id);
        this.core.stopBase.set(row.id, this.core.deps.stopCount(revived));
        this.core.watchMode.set(row.id, this.core.watchMode.get(row.id) ?? "turn");
        this.core.readopted.delete(row.id);
        this.core.persist();
        this.core.deps.onChange(row);
        return;
      }
      // Not reopened yet. Held `running` — never queued, which is the whole
      // point — with the sentence saying what it is following. `sweepRunning`
      // re-enters here every tick until `revivedSessionFor` answers.
      const detail = "its session stopped at the usage limit — following it to the reopened one";
      if (row.blockDetail !== detail) {
        row.blockDetail = detail;
        this.core.persist();
        this.core.deps.onChange(row);
      }
      return;
    }
    this.core.stopBase.delete(row.id);
    this.core.stopSeen.delete(row.id);
    this.core.watchMode.delete(row.id);
    this.core.readopted.delete(row.id);
    if (this.core.deps.diedAtLimit(sessionId)) {
      row.state = "queued";
      row.sessionId = undefined;
      row.startedAt = undefined;
      row.result = { at: now, ok: false, detail: "its session stopped at the usage limit — it will run again when the session reopens" };
      this.core.persist();
      this.core.deps.onChange(row);
      this.core.emit("requeued", row, row.result);
      return;
    }
    this.core.settle(row, "failed", {
      at: now, ok: false,
      detail: "the session exited before the task finished (a crash, or /quit) — re-run it once a session is open",
      occurrence: row.lastOccurrence,
    });
  }

  // ── Restart reconciliation ────────────────────────────────────────────────

  /**
   * What the rows that were mid-flight when the process died actually mean.
   *
   * Called once, after `sessions.rediscover()` — a tmux session outlives the
   * daemon, so "is that session still there" is only answerable once the map
   * has been rebuilt.
   *
   * `starting` is the crash window and is NEVER blindly requeued: something may
   * have been typed, and re-running what may already be there is how one prompt
   * ended up stacked five times. It is handed to the evidence instead — the
   * CLI's own conversation log, which outlives both the session and this
   * process. A READABLE log that does not contain the words proves nothing ran,
   * and only that proof returns a row to the queue.
   *
   * This replaces `backlog.ts:174`'s blanket `running → queued`, which is a
   * latent double-delivery under tmux: the session and the prompt typed into it
   * both survive the restart.
   *
   * ── `landed` is DELIVERED, not DONE ──────────────────────────────────────
   *
   * It used to settle `done` off the log alone. On 2026-09-24 a restart at
   * 18:51:57 found twelve backlog items mid-turn, each in its own
   * `backlog · <repo> · <label>` session, all alive under tmux; nine were
   * settled `done` while their conversation logs kept growing. The log proves
   * the words arrived, and a turn still running writes exactly the same line.
   * And at this moment nothing CAN say busy or idle: a re-attached session
   * starts unhooked, silent and without turn state. So the decision is
   * deferred, not made — the row goes back to `running` and the two ordinary
   * endings settle it: its `Stop` (`onTurnEnded`) or the silence sweep. The
   * accepted caveat: a person who attaches and types a turn of their own
   * before that sweep fires completes the row on THEIR Stop. A session that
   * did not come back is `failed` saying so (at the limit it is followed, as
   * every dead session is) — never `done`.
   */
  reconcile(): Promise<void> {
    if (this.reconciled) return Promise.resolve();
    return (this.reconciling ??= this.reconcileOnce());
  }

  /**
   * The evidence first, then every decision in one synchronous pass. The
   * evidence can be ASYNC — a backend's own channel (`settle.ts`'s
   * `ranVerdict`) — and `reconciled` stays false while it is asked, so `tick`
   * fires nothing into a store whose mid-flight rows are not decided yet.
   */
  private async reconcileOnce(): Promise<void> {
    // The rows the process died with, named BEFORE the await. The server is
    // already listening while a channel is asked, and "Run now" fires without
    // the `reconciled` gate — a row started in that window is being delivered
    // by THIS process and is not this pass's to decide.
    const midFlight = new Set(this.core.rows().filter((r) => r.state === "starting" || r.state === "running").map((r) => r.id));
    const verdicts = new Map<string, "landed" | "absent" | "unknown">();
    await Promise.all(this.core.rows().filter((r) => midFlight.has(r.id)).map(async (row) => {
      let v: "landed" | "absent" | "unknown" = "unknown";
      try {
        const text = row.payload.kind === "prompt" ? row.payload.steps[0] : "";
        // Only the rows `reconcileOne` would ask: asking spends the turn on the row.
        if (!row.sessionId || !text || row.target.kind === "shell" || postsScheduledBuild(row)) return;
        v = await this.core.deps.logVerdict(row.sessionId, text, row.startedAt ?? row.createdAt, row.id);
      } catch { /* no answer is unknown — and never a reconcile that never ends */ }
      verdicts.set(row.id, v);
    }));
    this.reconciled = true;
    const now = Date.now();
    let dirty = false;
    // Which session ids survived — asked once, of the map `rediscover()` has
    // just rebuilt, and asked of EVERY row rather than only the mid-flight
    // ones. A session id is per-boot for a plain PTY and is not per-boot under
    // tmux, and the difference is not something a loader can know: `load()`
    // runs before the sessions exist. So the rule is a fact rather than an
    // assumption, and it is applied here because here is the first moment the
    // answer exists. A settled fan-out target whose agent is still running
    // keeps its handle — that handle is what "follow up on this sweep" needs,
    // and `fanout.followUp()` can only ever re-drive a session it can name.
    for (const row of this.core.rows()) {
      if (!row.sessionId || this.core.deps.sessionAlive(row.sessionId)) continue;
      if (row.state === "starting" || row.state === "running") continue; // the crash window: `reconcileOne` needs the id to find the evidence
      row.sessionId = undefined;
      dirty = true;
    }
    for (const row of this.core.rows()) {
      if (row.state !== "starting" && row.state !== "running") continue;
      if (!midFlight.has(row.id) || this.core.inflight.has(row.id)) continue;
      dirty = true;
      this.reconcileOne(row, now, verdicts.get(row.id) ?? "unknown");
    }
    if (dirty) { this.core.persist(); this.core.deps.onChange(); }
    this.core.kick();
  }

  private reconcileOne(row: Intent, now: number, verdict: "landed" | "absent" | "unknown"): void {
    const fail = (detail: string): void => {
      // The start may have happened, so the waiver it was for is spent.
      row.pastBudget = undefined;
      row.leftoverOf = undefined;
      const result: IntentResult = { at: now, ok: false, detail, occurrence: row.lastOccurrence };
      if (isRecurring(row)) {
        // Standing policy again: record the occurrence as failed, keep the row.
        // A row back in the queue is aimed at nothing yet, so the session this
        // occurrence ran in goes — dead or alive, it is not the next one's.
        row.state = "queued";
        row.sessionId = undefined;
        row.result = result;
        row.startedAt = undefined;
        row.nextAt = this.core.armFrom(row, row.lastOccurrence ?? now, now);
        return;
      }
      // A failed one-off KEEPS its id, dead or not: it is the record of where
      // the words went, and a fan-out run is rebuilt from its rows — each
      // target still names the session it opened (`e2e-fanout.mjs` pins it,
      // and the activity sheet draws that target's session from it).
      row.state = "failed";
      row.result = result;
      row.settledAt = now;
    };

    // Neither a build nor an assessment can be re-adopted: the child process
    // died with the daemon. Nothing to ask, nothing to resume.
    //
    // Two sentences, because the two cost different things to repeat. A build
    // is cheap and idempotent; an assessment spends an agent reading a whole
    // repo, so it says what it was and leaves the decision to a tap rather than
    // quietly starting it again. It is safe to repeat — the run deletes its own
    // output file first — but safe is not the same as free.
    if (row.payload.kind === "assess") {
      fail("the host restarted while this assessment was running — nothing was applied, run it again if you still want it");
      return;
    }
    // A capture dies with the daemon too, and it gets its own sentence because
    // its evidence half-survives: frames already copied into `.claude/outbox/`
    // are still there, and the sidecar that says what they are is not — so the
    // honest reading is "there is no verdict", not "there is nothing".
    if (row.payload.kind === "capture") {
      fail("the host restarted while this capture was running — any frames it had already written are in .claude/outbox/, but no verdict was, so run it again");
      return;
    }
    // A build RULE runs nothing itself — it posts a run, synchronously — so a
    // restart caught it between `starting` and that post. Whether the run was
    // written is the build list's to say; it is NOT posted again.
    if (postsScheduledBuild(row)) {
      fail("the host restarted while this rule was posting its build — check the build's runs; it was NOT started again");
      return;
    }
    if (row.target.kind === "shell" || row.payload.kind === "build") {
      fail("the host restarted while this build was running — start it again");
      return;
    }

    const sid = row.sessionId;
    const alive = !!sid && this.core.deps.sessionAlive(sid);
    if (!sid) {
      // The crash landed between `starting` and the side effect. There is no
      // session, so there is no log to read and nothing to be sure of. Two
      // sentences rather than one, because the two cases lead somewhere
      // different: a create either opened or it did not, and you can look;
      // a sweep may have got half way through twelve repos, and re-running it
      // is the expensive mistake.
      fail(row.target.kind === "repo"
        // `launch.ts`'s wording, kept verbatim because it is the honest one.
        ? "the host restarted while it was opening — start it again if nothing came up"
        : "the host restarted while this was starting — whether it began is not recorded, so it was NOT started again");
      return;
    }
    // `verdict` was asked by `reconcileOnce` before this pass (it may be async):
    // `unknown` for a row with no session or no words.
    if (verdict === "landed") {
      // The CLI's log proves the words were DELIVERED — and nothing more. It
      // says nothing about the turn having ENDED (`logVerdict` finds the user
      // turn; a turn that is still running writes the same line), so this
      // branch never settles `done` off the log alone.
      if (alive) {
        // The session came back with us (tmux). RE-ADOPTED: `running` again,
        // watched the way any running row is — its Stop past a fresh baseline
        // (`onTurnEnded`), or the silence sweep for a session that is not
        // hooked yet, which after a restart is every session until its first
        // hook event. Deciding busy-or-idle here is impossible: a re-attached
        // session has printed nothing, reports no hooks, and has no turn state.
        // Watched as `"turn"` even for a fan-out target (`"hook"`): until its
        // first hook event the session is unhooked, and a Stop that fired while
        // the host was down is gone — silence is the only ending left to see.
        this.core.stopBase.set(row.id, this.core.deps.stopCount(sid));
        this.core.stopSeen.delete(row.id);
        this.core.watchMode.set(row.id, "turn");
        this.core.readopted.add(row.id);
        row.state = "running";
        row.pastBudget = undefined;
        row.leftoverOf = undefined;
        row.blockReason = undefined;
        row.blockDetail = "the host restarted after this was delivered — its session came back, so it is being watched for the turn to end";
        return;
      }
      // The session is gone. At the usage limit it is being brought back, and
      // `sweepRunning`'s first pass hands the row to `endWithDeadSession`, which
      // follows it or requeues it by the same rule as any dead session — so the
      // row is left as it is, bar a `starting` one being called `running`: the
      // sweep only reads running rows, and nothing else would ever look at it.
      if (this.core.deps.diedAtLimit(sid)) { row.state = "running"; return; }
      // Anything else: the turn may have finished or may have been cut off, and
      // nothing left can say which. Never `done` (that is the claim nobody can
      // make), never requeued (the words ARE in that conversation).
      fail("the host restarted after this was delivered, and that session did not come back with it — how far the turn got is in the conversation log (Recently closed, or the archive); reopen it there rather than running it again");
      return;
    }
    if (verdict === "absent" && isRecurring(row)) {
      // Provably nothing ran — but the occurrence is already spent (it is
      // stamped BEFORE the executor, which is the whole point), and re-arming it
      // would be this file firing a schedule twice by another route. The row
      // says the occurrence was lost and waits for the next one.
      row.state = "queued";
      row.startedAt = undefined;
      // The occurrence the waiver was for is lost; the next one waits.
      row.pastBudget = undefined;
      row.leftoverOf = undefined;
      row.result = { at: now, ok: false, detail: "the host restarted before this occurrence was typed — nothing ran, and the next one is armed", occurrence: row.lastOccurrence };
      return;
    }
    if (verdict === "absent") {
      // A readable log without the words: provably nothing ran, and nothing is
      // holding it. The only proof that authorises a second attempt.
      //
      // And a second attempt needs something to wait FOR. The occurrence was
      // spent before the executor was invoked, so a restart mid-delivery used
      // to write *"nothing ran, so it is queued again"* onto a one-off whose
      // `nextAt` was already null, and the very next tick overwrote that with
      // the *"that instant has passed"* gravestone — the same shape `unspend`
      // was reproduced on, reached by the restart path instead of by `retry`.
      // `absent` is the same proof `retry` is, so it earns the same answer.
      // `pastBudget` is KEPT: nothing ran, so the start it was for is still ahead.
      const occurrence = row.lastOccurrence;
      this.core.unspend(row, occurrence);
      row.state = "queued";
      row.startedAt = undefined;
      row.result = { at: now, ok: false, detail: "the host restarted before this was typed — nothing ran, so it is queued again", occurrence };
      return;
    }
    fail(alive
      ? "the host restarted while this was being delivered, and its session left no readable conversation log — check the session before running it again"
      : "the host restarted while this was being delivered, and that session is gone — check it before running it again");
  }
}
