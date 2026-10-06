/**
 * Routes about ONE session: its lifecycle, what is typed into it, what it
 * remembers, and the usage limit it may be blocked on.
 */
import { cleanSessionBudget, promptStillCurrent, safeRel, slashForkTitle } from "@waterplane/shared";
import type { SessionInfo } from "@waterplane/shared";
import { join } from "node:path";
import { existsSync } from "node:fs";
import { gitCloseCheck } from "../git.js";
import { randomUUID } from "node:crypto";
import { settleDelivery } from "../settle.js";
import { forkConversationFile } from "../convfork.js";
import { backendForksOnServer, forkAtTurnRefusal } from "../backends/index.js";
import { rivalTexts } from "../opendeliveries.js";
import { createToIntent } from "../intents/adapters.js";
import { withoutBacklogMark } from "../backlog.js";
import type { InputVerdict, Route, RouteSpec, RouteTable } from "./types.js";

const onSessionList: Route<"session.list"> = (a) => {
    a.c.send(a.ws, { t: "session.list", sessions: a.c.sessions.list() });
};

const onRecentList: Route<"recent.list"> = (a) => {
    a.c.send(a.ws, { t: "recent.list", recent: a.c.sessions.listRecent() });
};

const onRecentClear: Route<"recent.clear"> = (a) => {
    a.c.sessions.clearRecent();
    a.c.broadcast({ t: "recent.list", recent: a.c.sessions.listRecent() });
};

const onClosedClear: Route<"closed.clear"> = (a) => {
    a.c.sessions.clearClosed(); // emits "closed" → broadcasts empty closed.list
};

/**
 * Open a session — and, when the prompt names files that are not there yet,
 * DON'T, and hand the waiting to the host instead.
 *
 * `durable` because a re-send must not leave two claude processes running in
 * the same worktree; `contain` because a create is a process spawn, and an
 * unchecked cwd is the one input here that turns a trusted-but-buggy client
 * into "start an agent anywhere on this machine".
 */
const onSessionCreate: RouteSpec<"session.create"> = {
  durable: true,
  contain: "cwd",
  refusal: "that folder is outside the configured root — session not opened",
  run: (a) => {
      // create() emits "created" → broadcast happens in the sessions.on("created")
      // handler above. Here we just attach the creating socket so it streams.
      const cwd = a.dir;
      // ── A create off the WIRE is a person's, so it never wears the mark ───
      //
      // `backlog · ` is the ONLY thing that says a session belongs to
      // machinery: it is what the automatic-session cap counts, what
      // `reapAutoSession` may close to make room, and what `lingerSweep`
      // retires after ten minutes. A finished item's session is closed WITH its
      // title, so it sits in *Recently closed* still called `backlog · waterplane ·
      // fix the flaky test` — and the reopen button sends that very title back
      // here. The session a person was then driving counted against the cap and
      // was reapable after sixty seconds of a silent screen (a permission box,
      // a long tool call), with the socket detached because the phone was in a
      // pocket. Stripped here, at the one door a client comes through: the three
      // host-side openers that MINT the mark (`openItemSession`,
      // `ensureRepoSession`, `doResurrect`) never pass through a route.
      const title = withoutBacklogMark(a.msg.title);
      // "Relaunch with different flags" is kill-then-create, and the two
      // halves must be ONE op. Sent separately, the kill is a bare socket
      // write (dropped when the tunnel is down) while the create is durably
      // queued — so an offline relaunch whose tab is then killed replays only
      // the create, against a worktree whose old claude is still running. As
      // part of the same ackId'd op it is atomic (the kill can't be lost) and
      // idempotent (a retry finds the verdict in the ledger and does neither).
      // Absent ⇒ exactly today's behaviour; an already-gone target is not an
      // error, killing it was the intent.
      // ── The handover ────────────────────────────────────────────────
      // A create that NAMES files it cannot run without does not spawn here.
      // It is written down — as an INTENT with a `files` trigger, which is what
      // a parked launch always was — and this host opens it once the last file
      // lands, hours later if the tunnel needs that long. Composed on a phone,
      // the alternative is what shipped before: the ordering lived in the
      // browser's send queue, and a slow upload took the create and every
      // prompt behind it down with it after thirty minutes.
      //
      // Nothing is parked when the files are already there: that is the
      // ordinary case (the upload won the race) and it must stay instant. Nor
      // is a create with no PROMPT — the store keeps words, and a create that
      // has none has nothing that can fail to find its files.
      const needs = (a.msg.needs ?? []).filter((p) => safeRel(p));
      const absent = needs.filter((p) => !existsSync(join(cwd, p)));
      const first = a.msg.prompt?.trim();
      // The session's own budget, refused whole if it is garbage (never a
      // rounded cap nobody typed). It rides a parked create too.
      const budget = cleanSessionBudget(a.msg.budget) ?? undefined;
      if (absent.length && first) {
        const now = Date.now();
        const posted = a.c.intents.post(createToIntent({
          id: a.msg.ackId || randomUUID().slice(0, 8),
          cwd, prompt: first, needs, now,
          cols: a.msg.cols, rows: a.msg.rows, title, launch: a.msg.launch,
          replaceSessionId: a.msg.replaceSessionId, budget,
        }), now);
        if (posted.ok && posted.intent) {
          a.c.send(a.ws, { t: "toast", text: absent.length === 1
            ? `waiting for ${absent[0].split("/").pop()} — the session opens here when it lands`
            : `waiting for ${absent.length} files — the session opens here when they land` });
          // `ok` because the host has TAKEN it, and — the part that is stronger
          // than it used to be — because the row is already on disk when this
          // returns. No sessionId: nothing is open yet, and the client must not
          // read that as "never named". `launchId` and `intentId` are the same
          // string, so a client pinned to the old bundle binds exactly as it did.
          return { ok: true, launchId: posted.intent.id, intentId: posted.intent.id };
        }
        if (!posted.ok) a.c.send(a.ws, { t: "toast", text: `not parked: ${posted.reason}` });
      }
      // ── Fork from a turn ────────────────────────────────────────────
      // "Fork from here" / "reset to here": copy the source conversation's
      // history up to and including one turn into a NEW log, and open that
      // instead. The file operation is `convfork.ts`; what belongs here is the
      // ORDER. It runs BEFORE the kill, because a fork that cannot be written
      // must leave the session it was going to replace exactly where it was —
      // a reset whose file write failed after the kill would have destroyed a
      // running session in exchange for nothing.
      //
      // A refusal is `ok:false` and therefore REMEMBERED by the ack ledger,
      // which is right: every way this fails ("that turn is not in this
      // conversation", a bad id) is a permanent property of the request, and a
      // retry could only fail the same way.
      //
      // ONE GAP, accepted rather than worked around. At-most-once is enforced by
      // the ledger, which is written when this returns — so a crash in the window
      // between `forkConversationFile` and that write leaves the copy on disk
      // with no verdict, and the client's retry writes a SECOND one. What that
      // costs is bounded and visible: an extra `<uuid>.jsonl`, i.e. one more row
      // in `ArchiveSheet`, deletable there like any other conversation. What it
      // cannot cost is the thing durability exists to prevent — two claudes in
      // one worktree — because the spawn is downstream of the ack and the retry
      // is the only create that reaches it. Closing it would mean a second
      // durable record for the file write, which is the intent store's job and a
      // disproportionate amount of machinery for an orphan file; this is
      // `starting`-row semantics exactly (a crash leaves a visible artifact,
      // never double work), so it is stated here and left.
      //
      // Nothing here can collide with the `needs` park above: a fork is composed
      // in the reader, carries no attachments and so never names files, and the
      // park only triggers for a create that has both `needs` and a prompt.
      let resumeSessionId = a.msg.resumeSessionId;
      let serverFork = false;
      if (a.msg.forkAtTurn) {
        if (!resumeSessionId) return { ok: false, reason: "fork needs the conversation to fork from" };
        // …and the backend has to be one whose conversation is a FILE this host
        // may copy. `forkConversationFile` below is claude's jsonl and nothing
        // else; handed an opencode session it would build a path under
        // `~/.claude/projects` that cannot exist and fail on it, which reads as
        // a bug rather than as the refusal it is. Refused in words, before the
        // copy and long before the spawn — the sentence lands on the queue row,
        // and `ok:false` is REMEMBERED, which is right: a retry could only fail
        // the same way (`backends/index.ts`).
        const refusal = forkAtTurnRefusal(a.msg.launch?.backend);
        if (refusal) {
          a.c.send(a.ws, { t: "toast", text: refusal });
          return { ok: false, reason: refusal };
        }
        // A backend whose SERVER forks (`caps.forkVia: "server"`, opencode's
        // `POST /session/{id}/fork`) is handed the turn in the launch instead:
        // nothing is copied here, and the new id comes back from the server.
        if (backendForksOnServer(a.msg.launch?.backend)) serverFork = true;
      }
      if (a.msg.forkAtTurn && resumeSessionId && !serverFork) {
        const forked = forkConversationFile(cwd, resumeSessionId, a.msg.forkAtTurn);
        if ("error" in forked) {
          a.c.send(a.ws, { t: "toast", text: `could not fork this conversation: ${forked.error}` });
          return { ok: false, reason: forked.error };
        }
        // Worth a line: `pruned` means the copy is not a plain prefix of the
        // source (a record naming a uuid the cut left behind was dropped — the
        // compact-boundary case), and `dropped` means a line would not parse.
        // Both are normal and neither is visible on the phone, so this is the
        // only place either is ever stated.
        console.log(`[fork] ${resumeSessionId} @${a.msg.forkAtTurn} → ${forked.newId}: `
          + `${forked.records} records, ${forked.pruned} pruned, ${forked.dropped} unreadable`);
        resumeSessionId = forked.newId;
      }
      // A relaunch onto the same conversation keeps its prompt history and tab
      // name; read BEFORE the kill, which deletes both (`sessions.carryFor`).
      const carry = a.msg.replaceSessionId && !a.msg.forkAtTurn ? a.c.sessions.carryFor(a.msg.replaceSessionId, resumeSessionId) : null;
      if (a.msg.replaceSessionId) a.c.sessions.kill(a.msg.replaceSessionId, undefined, "replaced");
      const info = a.c.sessions.create(cwd, { cols: a.msg.cols, rows: a.msg.rows, title, resume: a.msg.resume, carry,
        origin: { kind: a.msg.forkAtTurn ? "fork" : "hand" },
        // A forked file is already its own conversation, so it is resumed
        // PLAINLY — `--fork-session` on top would fork the copy again and open a
        // third id. `"fork"` on the wire names the user's verb, not the flag.
        resumeMode: serverFork ? "fork" : a.msg.forkAtTurn ? "continue" : a.msg.resumeMode,
        resumeSessionId, ...(serverFork ? { forkAtTurn: a.msg.forkAtTurn } : {}), launch: a.msg.launch, budget });
      a.att.add(info.id);
      a.c.recomputeWatched();
      // "Open a session here AND run this" — one op, because the phone cannot
      // address a session that doesn't exist yet: a prompt written while the
      // tunnel was down has no id to be queued against, and minting a
      // `session.input` after the create lands would be a second, undeduped
      // send. Delivery is the same at-most-once path the fan-out uses, and it
      // is fire-and-forget: `ok` on an op means ACCEPTED, not finished.
      if (first) void a.c.startPrompt(info.id, first);
      return { ok: true, sessionId: info.id };
  },
};

const onSessionFork: Route<"session.fork"> = (a) => {
    // Branch the conversation into a fresh parallel session. create() inside
    // fork() emits "created" (broadcast above); focus navigates the requester.
    const info = a.c.sessions.fork(a.msg.id, { cols: a.msg.cols, rows: a.msg.rows });
    if (!info) { a.c.send(a.ws, { t: "toast", text: "session not available to fork" }); return; }
    a.att.add(info.id);
    a.c.recomputeWatched();
    a.c.send(a.ws, { t: "session.focus", id: info.id });
};

const onSessionAttach: Route<"session.attach"> = (a) => {
    a.att.add(a.msg.id);
    a.c.recomputeWatched();
    // Resumable replay: only the delta since `resumeSeq` on a reconnect where
    // the client's terminal survived; a full (flagged) replay otherwise.
    // A resume point from a PREVIOUS boot is meaningless: seq restarts at 0
    // when a session is registered, and a tmux session survives the daemon, so
    // the same id can carry a fresh low seq that an old resume point falls
    // inside — stitching a delta out of a byte stream that no longer exists.
    // Mismatched boot ⇒ ignore it and replay in full.
    const resumeSeq = a.msg.resumeBoot && a.msg.resumeBoot !== a.c.BOOT_ID ? undefined : a.msg.resumeSeq;
    const rep = a.c.sessions.attachReplay(a.msg.id, resumeSeq);
    if (rep && (rep.data || rep.full)) a.c.send(a.ws, { t: "pty", id: a.msg.id, dataB64: Buffer.from(rep.data, "utf8").toString("base64"), seq: rep.seq, full: rep.full });
    a.c.send(a.ws, { t: "session.history", id: a.msg.id, entries: a.c.sessions.getHistory(a.msg.id) });
};

const onSessionDetach: Route<"session.detach"> = (a) => {
    a.att.delete(a.msg.id);
    a.c.recomputeWatched();
};

/** An answer's receipt: remembered against its ackId (a repeat re-acks, never
 *  re-answers) and sent with the dispatcher's sentence when it refused. */
function answerReply(a: Parameters<Route<"session.input">>[0], answered: Promise<{ ok: boolean; reason?: string }>): void {
  const ackId = a.msg.ackId;
  void answered.then(({ ok, reason }) => {
    if (!ackId) return;
    a.c.acks.remember(ackId, { ok, reason });
    a.c.send(a.ws, { t: "input.ack", id: a.msg.id, ackId, ok, reason });
  });
}

/**
 * A bare `/fork [title]` to a claude session is answered HERE and never typed.
 *
 * From CLI 2.1.291 a `/fork` typed into the TUI hands the branch to the CLI's
 * own background daemon, in no tmux this host owns, so the phone that asked for
 * it never sees it (`shared/slash.ts`'s `slashForkTitle`). The fork is opened
 * as an ordinary tab instead, through `sessions.fork()` — the toolbar's *fork*
 * button's own path (`--resume <conversation> --fork-session`, same cwd, same
 * launch flags), so there is no second spawn path — and the asking socket is
 * focused on it, as `session.fork` does.
 *
 * At-most-once by ackId: the fork is synchronous, so its verdict is remembered
 * before this returns and a retried ackId is re-acked by the ledger check in
 * `onSessionInput`, never forked a second time. A refusal is remembered too —
 * each one (the session gone, remote control off, no conversation id yet) is a
 * property of the request — and NEVER falls back to typing `/fork`, which is
 * the invisible fork this exists to prevent.
 *
 * `false` ⇒ not this command, or not a claude session: delivered as before.
 */
function forkFromInput(a: Parameters<Route<"session.input">>[0], ackId: string): boolean {
  const asked = slashForkTitle(a.msg.data);
  if (asked === null) return false;
  const info = a.c.sessions.get(a.msg.id);
  if (info?.backend && info.backend !== "claude") return false; // absent = claude (`SessionInfo.backend`)
  const refusal = !info || !info.running ? "that session is gone, so there is nothing to fork — /fork was not typed"
    : !info.remoteControl ? "remote control is off for this session — not forked"
    : !info.claudeSessionId ? "this session's conversation is not known yet, so it cannot be forked into a new tab — /fork was not typed, because the CLI would open that fork where this phone cannot see it"
    : null;
  let verdict: InputVerdict;
  if (refusal || !info) verdict = { ok: false, reason: refusal ?? "session not available" };
  else {
    let made: SessionInfo | null = null;
    let why = "";
    // A person's fork never wears the machine's mark (`withoutBacklogMark`, as on
    // `session.create`): a forked `backlog · …` tab would count against the
    // automatic-session cap and be reapable under the person driving it.
    const title = withoutBacklogMark(asked) || `${withoutBacklogMark(info.title) || info.title} (fork)`;
    try { made = a.c.sessions.fork(info.id, { title }); } catch (e) { why = String((e as Error)?.message || e); }
    if (!made) verdict = { ok: false, reason: `could not fork this session${why ? `: ${why}` : ""}` };
    else {
      console.log(`[fork] /fork from ${info.id} (${info.claudeSessionId}) → ${made.id}`);
      a.att.add(made.id);
      a.c.recomputeWatched();
      a.c.send(a.ws, { t: "session.focus", id: made.id });
      verdict = { ok: true, state: "forked", reason: `forked into a new session — ${made.title}` };
    }
  }
  a.c.acks.remember(ackId, verdict);
  a.c.send(a.ws, { t: "input.ack", id: a.msg.id, ackId, ...verdict });
  return true;
}

const onSessionInput: Route<"session.input"> = (a) => {
    // Delivery receipts are the client's retry key: a phone whose socket dies
    // mid-send re-sends the SAME ackId when it comes back (offline queue, see
    // web/outbox.ts). Without this ledger the text would be typed a second
    // time — the same at-most-once trap deliver.ts exists for. A repeat of a
    // known ackId is re-ACKed with the original verdict and NOT retyped.
    if (a.msg.ackId) {
      const seen = a.c.acks.get(a.msg.ackId);
      if (seen) {
        // Replay the STORED reason, not a hardcoded one: today there is only
        // one failure mode, but the moment a second exists a hardcoded string
        // makes the replayed receipt disagree with the original.
        a.c.netstats.noteAckReplay();
        // An `ok` carries its reason only when it has one (`forked` says where the words went).
        a.c.send(a.ws, { t: "input.ack", id: a.msg.id, ackId: a.msg.ackId, ok: seen.ok, reason: seen.ok ? seen.reason : (seen.reason ?? "session not available"), state: seen.state, retryable: undefined });
        return;
      }
      // A verified delivery already running for this ackId (the phone's retry
      // normally RACES the first one, because delivery outlasts its receipt
      // deadline). Join it — never start a second.
      const already = a.c.inputsInFlight.get(a.msg.ackId);
      if (already) {
        a.c.netstats.noteAckReplay();
        void already.then((v) => a.c.send(a.ws, { t: "input.ack", id: a.msg.id, ackId: a.msg.ackId!, ok: v.ok, reason: v.reason, state: v.state, retryable: v.retryable }));
        return;
      }
      // The ledger was lost at boot and this ackId was first sent before that:
      // these words may already be in the session, and nothing here can tell.
      // Nothing is typed; never retryable (a retry carries the same stamp), and
      // remembered so a repeat is re-acked with the same sentence (acks.ts).
      const lostRefusal = a.c.acks.preLossRefusal(a.msg);
      if (lostRefusal) {
        a.c.acks.remember(a.msg.ackId, { ok: false, reason: lostRefusal });
        a.c.send(a.ws, { t: "input.ack", id: a.msg.id, ackId: a.msg.ackId, ok: false, reason: lostRefusal, retryable: false });
        return;
      }
    }
    if (a.msg.expectPrompt) {
      // An ANSWER, minted against a specific question box — possibly minutes
      // ago, on a phone with no link (see promptid.ts). The keystroke only
      // means what the user intended while THAT box is still the one on
      // screen: the same "2" lands on a different choice once the agent moves
      // on, or as a stray digit in the composer that the next Return submits.
      // A mismatch is refused rather than guessed at, and is never retryable —
      // waiting longer can only make it staler.
      const live = a.c.sessions.get(a.msg.id);
      if (!promptStillCurrent(live?.prompt, a.msg.expectPrompt)) {
        const verdict = {
          ok: false,
          reason: live?.prompt ? "that question was replaced by a different one" : "that question is no longer open",
          state: "stale" as const,
        };
        if (a.msg.ackId) {
          a.c.acks.remember(a.msg.ackId, verdict);
          a.c.send(a.ws, { t: "input.ack", id: a.msg.id, ackId: a.msg.ackId, ...verdict });
        }
        return;
      }
    }
    if (a.msg.ackId && a.msg.submit) {
      // Verified delivery: type it, confirm the echo, press Return, prove the
      // turn started. The receipt goes out when that settles, not when the
      // bytes leave — which is the whole point (see `deliverInput`).
      const ackId = a.msg.ackId;
      // A bare `/fork` to a claude session opens a tab here instead of being typed.
      if (forkFromInput(a, ackId)) return;
      // `view` is carried for the audit row only — see `DeliverOpts.view`.
      const settled = a.c.deliverInput(a.msg.id, a.msg.data, ackId, a.msg.cwd, a.msg.view);
      a.c.inputsInFlight.set(ackId, settled);
      void settled
        .then((v) => {
          // A retryable verdict is deliberately NOT remembered: the ledger
          // exists to stop a repeat from being DELIVERED twice, and "nothing
          // was typed" is the one case where a repeat must get a real second
          // attempt rather than a replayed "no".
          if (!v.retryable) a.c.acks.remember(ackId, { ok: v.ok, reason: v.reason, state: v.state });
          a.c.send(a.ws, { t: "input.ack", id: a.msg.id, ackId, ok: v.ok, reason: v.reason, state: v.state, retryable: v.retryable });
        })
        .finally(() => a.c.inputsInFlight.delete(ackId));
      return;
    }
    if (a.msg.promptSubmit) {
      // The Submit ROW of a checkbox box, not a keystroke. Return is only a
      // submit once the TUI's cursor is on that row — pressed on option 1 it
      // re-toggles the option and the box stays open, which is what the phone's
      // Submit button did for as long as it sent a bare "\r". Walking the
      // cursor there needs the rendered screen, so it happens here and the
      // receipt waits for it. Bounded (`submitPromptBox`), and it degrades to
      // the same bare Return when the screen shows no Submit row.
      const ackId = a.msg.ackId;
      void a.c.sessions.submitPromptBox(a.msg.id).then(({ ok }) => {
        if (!ackId) return;
        const reason = ok ? undefined : "session not available";
        a.c.acks.remember(ackId, { ok, reason });
        a.c.send(a.ws, { t: "input.ack", id: a.msg.id, ackId, ok, reason });
      });
      return;
    }
    if (a.msg.promptChoice != null) {
      // Option N of a box with NO NUMBERS. opencode draws its permission options
      // on one row, unnumbered, with the armed one marked by a background
      // colour: a digit typed at it is a stray character in the composer, and a
      // bare Return presses whatever was already armed. So the host walks the
      // selection onto the named option against the rendered screen and presses
      // Return only once it has re-read it there — and REFUSES otherwise, in
      // words, rather than falling back to a bare Return the way a checkbox
      // box's Submit can. A Return on the wrong row here approves a command
      // nobody approved, which is the exact failure `caps.promptBoxes: false`
      // was protecting against before the box became readable at all.
      //
      // Not retryable: the refusal is about what is on screen NOW, and a repeat
      // would walk a box that has since moved. The client shows the sentence.
      //
      // Through `answerBox`, the ONE dispatcher: a dialog the CLI posed on its
      // own channel is answered THERE (nothing typed); `walk` keeps every other
      // `promptChoice` on the walk it always was.
      answerReply(a, a.c.sessions.answerBox(a.msg.id, a.msg.promptChoice, { walk: true, byPerson: true }));
      return;
    }
    // A digit tap on a numbered box ("<n>\r", minted against the box above):
    // the same dispatcher, so the CLI's own channel is preferred where it posed
    // the box and the keystrokes are byte-for-byte the tap's everywhere else.
    // A checkbox box's digit (no Return — it toggles) and Esc stay raw keys.
    const digit = a.msg.expectPrompt ? /^(\d{1,2})\r$/.exec(a.msg.data ?? "") : null;
    if (digit && !a.c.sessions.get(a.msg.id)?.prompt?.multi) {
      answerReply(a, a.c.sessions.answerBox(a.msg.id, Number(digit[1]), { byPerson: true }));
      return;
    }
    const ok = a.c.sessions.input(a.msg.id, a.msg.data);
    // Only compose/slash sends ask for a receipt (they set ackId); raw
    // keystrokes don't. ok=false ⇒ session gone/not-running ⇒ client recovers.
    if (a.msg.ackId) {
      // The reason is stored, not re-derived on replay — see above.
      const reason = ok ? undefined : "session not available";
      a.c.acks.remember(a.msg.ackId, { ok, reason });
      a.c.send(a.ws, { t: "input.ack", id: a.msg.id, ackId: a.msg.ackId, ok, reason });
    }
};

    /**
     * Re-decide a delivery the host could not confirm at the time — see
     * settle.ts. Reads a conversation log and a rendered screen; writes
     * nothing, into no PTY, ever. Capped so a confused client cannot turn a
     * socket message into a pile of transcript parses.
     */
const onInputSettle: Route<"input.settle"> = (a) => {
    const items = (a.msg.items ?? []).slice(0, 40);
    void Promise.all(items.map(async (it) => {
      try {
        // Who owns the re-send? The host keeps its own row for every
        // unconfirmable delivery and acts on the ones nobody is watching; a
        // client that ASKS has proved it is watching, and takes it back. The
        // one case it may not have is a row the host has already re-sent —
        // acting on any verdict there would put a second copy behind the one
        // already on its way, so it is told, flatly, that this one is handled.
        if (a.c.openDeliveries.claim(it.ackId) === "mine") {
          return { ackId: it.ackId, verdict: "unknown" as const, alive: a.c.sessions.get(it.id)?.running === true, handled: true };
        }
        // The ackId is the claimer, and it is the same name the host's own row
        // uses (`ackId ?? id`): a delivery must keep its own proof across every
        // re-ask, whoever is asking, and a key that changed between the phone
        // and the sweep would lock a row out of the log turn it already
        // matched. The rivals are the other prompts that could be in that
        // composer — without them a fourteen-character head is all that
        // separates this row from somebody else's echo.
        const r = await settleDelivery(a.c.sessions, it.id, it.text, it.since, {
          claimer: it.ackId,
          others: rivalTexts(it.id, it.ackId),
        });
        return { ackId: it.ackId, verdict: r.verdict, alive: r.alive };
      } catch {
        // A row the host has no opinion about is still answered: a client
        // waiting on a reply must not be left hanging by one bad entry.
        return { ackId: it.ackId, verdict: "unknown" as const, alive: false };
      }
    })).then((results) => a.c.send(a.ws, { t: "input.settled", results }));
};

/**
 * The host's own open questions, and what the settled ones turned out to be.
 *
 * `input.settle` above is the phone asking about rows IT still holds; this is
 * the phone reading the host's copy, which exists whether or not anyone asked.
 * Sent unprompted on hello too — this arm is for a sheet opened later.
 */
const onDeliveryList: Route<"delivery.list"> = (a) => {
    a.c.send(a.ws, a.c.deliverySnapshot());
};

const onSessionResize: Route<"session.resize"> = (a) => {
    a.c.sessions.resize(a.msg.id, a.msg.cols, a.msg.rows);
};

const onSessionKill: Route<"session.kill"> = (a) => {
    a.c.sessions.kill(a.msg.id, undefined, "you");
};

/**
 * Stop one background shell's whole process group (`shells.ts`'s
 * `killShellGroup`, re-validated fresh against pid/startedAt) and republish
 * the session's `shellList` either way — a stop that landed or one that was
 * refused both change what a person should now see. Bare, not durable: see
 * `shell.kill`'s own wire comment for why a late one must never be replayed.
 */
const onShellKill: Route<"shell.kill"> = (a) => {
    const { id, pid, startedAt } = a.msg;
    void a.c.sessions.killShell(id, pid, startedAt).then(({ ok, reason }) => {
      a.c.send(a.ws, { t: "shell.killed", id, pid, ok, reason });
    });
};

/**
 * Forget a session: kill it (and every background shell running under it —
 * `drive.ts`'s `remove()`) and drop it from the list. The list broadcasts
 * right away, same as before this route grew shells; `session.closed`
 * follows once the shells are actually confirmed stopped (SIGTERM, then
 * SIGKILL after 3s for survivors), which is why it is a second message
 * rather than a field tacked onto the first.
 */
const onSessionRemove: Route<"session.remove"> = (a) => {
    const id = a.msg.id;
    const removed = a.c.sessions.remove(id, (counts) => {
      a.c.broadcast({ t: "session.closed", id, shellsStopped: counts.shellsStopped, shellsLeft: counts.shellsLeft });
    }, "you");
    if (removed) a.c.imgSeen.delete(id);
    // Broadcast even when the id was UNKNOWN. The client that asked is holding a
    // row for it — from a snapshot rendered while the link was down, or from a
    // list this daemon published before its last restart — and answering nothing
    // leaves that row on screen for good, with the × that removes it doing
    // literally nothing every time it is pressed. The authoritative list is the
    // answer to both cases.
    a.c.broadcast({ t: "session.list", sessions: a.c.sessions.list() });
};

const onSessionClosecheck: Route<"session.closecheck"> = (a) => {
    const id = a.msg.id;
    const s = a.c.sessions.get(id);
    if (!s) {
      a.c.send(a.ws, { t: "session.closecheck", id, isRepo: false, branch: "", dirty: false, unmerged: 0, isMain: false, mainBranch: "" });
      return;
    }
    void gitCloseCheck(s.cwd).then((c) => a.c.send(a.ws, { t: "session.closecheck", id, ...c, shells: s.shellList }));
};

const onSessionRename: Route<"session.rename"> = (a) => {
    a.c.sessions.rename(a.msg.id, a.msg.title);
    a.c.broadcast({ t: "recent.list", recent: a.c.sessions.listRecent() });
};

/**
 * Name this conversation now (`session.name`).
 *
 * Two cheap toolless calls deep, so the reply comes back whenever it comes
 * back — the phone has said what it is doing and is not waiting on a lane.
 * Answered ALWAYS, with the name or with the sentence saying why there is
 * none: a tap that spends a call and says nothing is the failure this whole
 * path is written around.
 */
const onSessionName: Route<"session.name"> = (a) => {
    void a.c.sessions.nameNow(a.msg.id).then((r) => a.c.send(a.ws, { t: "session.named", id: a.msg.id, ...r }));
};

/**
 * Set or clear a session's own budget (`session.budget.set`). Not durable and
 * never queued — a cap delivered late would hold or release a session on a
 * figure the person has since changed — and idempotent, so a double tap is one
 * change. Garbage is refused in words, never rounded into a cap; `null` clears.
 * Answered by the ordinary `session.updated` (`sessions/budgetwatch.ts`).
 */
const onSessionBudgetSet: Route<"session.budget.set"> = (a) => {
    const cfg = a.msg.budget === null ? null : cleanSessionBudget(a.msg.budget);
    if (a.msg.budget !== null && !cfg) {
      a.c.send(a.ws, { t: "toast", text: "budget not set: it needs a unit and an amount above zero (a percent at most 100)" });
      return;
    }
    if (!a.c.sessions.setSessionBudget(a.msg.id, cfg)) {
      a.c.send(a.ws, { t: "toast", text: "budget not set: that session is not open" });
      return;
    }
    // A budget in window percent is a reason for the usage poll to run; a
    // cleared one may be the last reason.
    a.c.syncUsagePolling();
};

const onSessionRemoteControl: Route<"session.remoteControl"> = (a) => {
    a.c.sessions.setRemoteControl(a.msg.id, a.msg.enabled);
};

const onSessionStar: Route<"session.star"> = (a) => {
    a.c.sessions.setStar(a.msg.id, a.msg.starred);
};

const onSessionAckAsking: Route<"session.ackAsking"> = (a) => {
    a.c.sessions.ackAsking(a.msg.id, a.msg.text);
};

const onSessionPin: Route<"session.pin"> = (a) => {
    a.c.sessions.pin(a.msg.id, a.msg.entryId);
};

const onSessionRecord: Route<"session.record"> = (a) => {
    a.c.sessions.recordPrompt(a.msg.id, a.msg.text, a.msg.kind);
};

const onSessionHistory: Route<"session.history"> = (a) => {
    a.c.send(a.ws, { t: "session.history", id: a.msg.id, entries: a.c.sessions.getHistory(a.msg.id) });
};

const onSessionSearch: Route<"session.search"> = (a) => {
    void a.c.sessions.search(a.msg.query, a.msg.scope, a.msg.id).then((results) =>
      a.c.send(a.ws, { t: "session.searchResults", query: a.msg.query, scope: a.msg.scope, id: a.msg.id, results }));
};

const onLimitSetAuto: Route<"limit.setAuto"> = (a) => {
    a.c.sessions.setAutoContinue(a.msg.enabled);
    a.c.broadcast({ t: "limit.config", enabled: a.c.sessions.getAutoContinue(), ...a.c.sessions.resumeState() });
};

const onLimitSession: Route<"limit.session"> = (a) => {
    a.c.sessions.setSessionLimitOverride(a.msg.id, a.msg.override);
};

const onLimitFirst: Route<"limit.first"> = (a) => {
    a.c.sessions.setResumeFirst(a.msg.id, a.msg.on);
};

const onLimitResume: Route<"limit.resume"> = (a) => {
    a.c.sessions.resumeNow(a.msg.id);
};

const onLimitSetMode: Route<"limit.setMode"> = (a) => {
    a.c.sessions.setResumeMode(a.msg.mode);
    a.c.broadcast({ t: "limit.config", enabled: a.c.sessions.getAutoContinue(), ...a.c.sessions.resumeState() });
};

export const sessionRoutes: RouteTable = {
  "session.list": onSessionList,
  "recent.list": onRecentList,
  "recent.clear": onRecentClear,
  "closed.clear": onClosedClear,
  "session.create": onSessionCreate,
  "session.fork": onSessionFork,
  "session.attach": onSessionAttach,
  "session.detach": onSessionDetach,
  "session.input": onSessionInput,
  "shell.kill": onShellKill,
  "input.settle": onInputSettle,
  "delivery.list": onDeliveryList,
  "session.resize": onSessionResize,
  "session.kill": onSessionKill,
  "session.remove": onSessionRemove,
  "session.closecheck": onSessionClosecheck,
  "session.rename": onSessionRename,
  "session.name": onSessionName,
  "session.budget.set": onSessionBudgetSet,
  "session.remoteControl": onSessionRemoteControl,
  "session.star": onSessionStar,
  "session.ackAsking": onSessionAckAsking,
  "session.pin": onSessionPin,
  "session.record": onSessionRecord,
  "session.history": onSessionHistory,
  "session.search": onSessionSearch,
  "limit.setAuto": onLimitSetAuto,
  "limit.session": onLimitSession,
  "limit.first": onLimitFirst,
  "limit.resume": onLimitResume,
  "limit.setMode": onLimitSetMode,
};
