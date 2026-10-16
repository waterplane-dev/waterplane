// Client → host: a session — create, attach, input, rename, history, search, the recent/closed stacks. Member list of `ClientMessage` in `../messages.ts`. 

import type { SessionBudget } from "../../sessionbudget.js";
import type { SendStamp } from "../../sendstamp.js";
import type { ClientRole } from "../notifylink.js";
import type { LaunchOpts, PermissionMode, SendView, SessionSearchScope } from "../session.js";

export type ClientSessionMsg =
  // `role` (optional): "notify" marks the APK's background link
  // (`wire/notifylink.ts`), which is then sent only the frames it acts on.
  // Additive — an old host ignores it — so `PROTOCOL_VERSION` stays.
  | { t: "hello"; protocol: number; role?: ClientRole }
  | { t: "ping" } // heartbeat — host replies { t: "pong" } so the client can detect a dead (zombie) socket
  | { t: "session.list" }
  // `resumeSessionId`: resume that EXACT claude conversation (`--resume <uuid>`)
  // instead of the directory's most recent (`--continue`) — what makes several
  // conversations per repo individually restorable.
  // `ackId` (optional): durable-op receipt — see `op.ack`. The phone can queue a
  // "start a session here" while the tunnel is down and safely re-send it.
  // `replaceSessionId` (optional): kill THAT session first, then create. This is
  // "relaunch with different flags" as ONE op, and it has to be one: sent as a
  // separate `session.kill` the kill is a bare socket write the ws layer drops
  // while the tunnel is down, while the create is durably queued — so an offline
  // relaunch replays only the create and leaves two claude processes in the same
  // worktree. Inside the ackId'd op the pair is atomic and at-most-once; a target
  // that is already gone is not an error. Omitted ⇒ a plain create.
  // `prompt` (optional): type this into the session once it is up, through the
  // same at-most-once `deliverPrompt()` the backlog and fan-out use. It rides in
  // the create ON PURPOSE: "open a session here and run this" queued while the
  // tunnel is down is ONE durable op, so the host's ledger de-dupes the pair
  // together. A separate `session.input` could not be queued at all — the phone
  // has no session id to address until the create lands.
  // `needs` (optional): repo-relative paths this create's `prompt` REFERS to
  // and must not run without — normally `.claude/inbox/<file>` for a photo the
  // phone is still uploading. Present ⇒ the host does not spawn on receipt: it
  // parks the whole create as a durable LAUNCH INTENT (`launch.ts`) and opens
  // the session itself once the last file lands, hours later if need be. That
  // is the point — the plan stops depending on the tab that composed it, which
  // is on a phone with a tunnel that may not come back inside the send queue's
  // half-hour. `op.ack` then answers with `launchId` and no `sessionId`, because
  // there is no session yet.
  // `forkAtTurn` (optional): fork `resumeSessionId`'s conversation AT that turn
  // — the uuid of the turn's prompt record, i.e. `TranscriptTurn.id` — and open
  // the copy instead of the original. The host writes a new `<uuid>.jsonl`
  // holding the history up to and including that whole turn (`convfork.ts`) and
  // resumes THAT. Additive, and `PROTOCOL_VERSION` did not move for it: an older host simply
  // ignores the field and resumes the source conversation whole, which is the
  // pre-existing behaviour rather than a wrong one.
  // The source is never modified, so both verbs built on this are non-destructive
  // in this codebase's sense — the discarded turns stay on disk under the old id
  // and stay listed in the archive, and `deleteArchived` remains the only way to
  // lose a conversation. Paired with `replaceSessionId` it is "reset to here":
  // the old PTY is killed and the fork opens in its place, one atomic op.
  | ({ t: "session.create"; cwd: string; cols?: number; rows?: number; title?: string; resume?: boolean; resumeMode?: "continue" | "pick" | "fork"; resumeSessionId?: string; forkAtTurn?: string; launch?: LaunchOpts; ackId?: string; replaceSessionId?: string; prompt?: string; needs?: string[]; budget?: SessionBudget; companionOf?: string } & SendStamp)
  /** The launches this host is holding. Answered with `launch.list`. */
  | { t: "launch.list" }
  /** Call one off. Not durable and deliberately so: like `session.kill`, a
   *  cancel delivered an hour late is wrong rather than merely duplicated. */
  | { t: "launch.cancel"; id: string }
  /** Open it NOW, without its files. The escape hatch for "the picture is not
   *  coming, run the prompt anyway" — the host records that it went without
   *  them so the row never claims the files were there. */
  | { t: "launch.run"; id: string }
  // Fork the session's conversation into a NEW parallel session (same cwd, same
  // launch flags) via `claude --continue --fork-session`; the original session
  // keeps running untouched. The requester is navigated via session.focus.
  | { t: "session.fork"; id: string; cols?: number; rows?: number }
  // `resumeSeq` (optional): the client already holds this session's output up to
  // this byte offset (from a prior attach that's still rendered — i.e. a mobile
  // wake/reconnect where the xterm survived). The host replays only the delta
  // after it, so a reconnect doesn't re-stream the whole scrollback. Omitted on a
  // fresh attach / session switch (the terminal is empty ⇒ full replay).
  // `resumeBoot` (optional): the `welcome.bootId` that was live when `resumeSeq`
  //   was recorded. Seq counts bytes since a session was REGISTERED, and a tmux
  //   session outlives the daemon — so after a host restart the same session id
  //   carries a seq that restarted at 0, and a persisted resume point from the
  //   previous boot can land numerically inside the new buffer window and stitch
  //   a delta out of a different byte stream. The host answers a full replay
  //   whenever this doesn't match its own boot id.
  | { t: "session.attach"; id: string; resumeSeq?: number; resumeBoot?: string }
  | { t: "session.detach"; id: string }
  // `ackId` (optional): the client wants delivery confirmed. The host replies
  // { t: "input.ack", ackId, ok } once it has (or hasn't) written to a live PTY.
  // Compose/slash sends set it so a stale/zombie socket can't silently eat text;

  // raw xterm keystrokes omit it (no ack spam).
  //
  // `submit` (optional, implies ackId): deliver it the way the backlog and the
  // fan-out do — `deliver.ts`'s `deliverPrompt()`, which types the text, CHECKS
  // it echoed on the rendered screen, presses Return and (on a hooked session)
  // re-presses until the turn provably started. The receipt then means "the
  // prompt is running", not "bytes reached a file descriptor".
  //
  // Without it the host writes the bytes raw and the CLIENT owns the submitting
  // Return — which is where compose sends used to disappear: the Return was a
  // bare, unacked socket write fired AFTER the outbox entry had been dropped, so
  // a socket that died in between left the prompt sitting in the composer with
  // nothing left to retry. `submit` moves that keystroke to the side of the
  // tunnel that can actually see whether it worked. The host also records the
  // prompt itself, so a submitting client must NOT send `session.record`.
  //
  // `expectPrompt` (optional, implies ackId): this input is an ANSWER to the
  // question box whose `promptFingerprint()` is given, and must not be written
  // unless that exact box is still the one on screen. It is what makes
  // answering offline safe — see promptid.ts. The host refuses a mismatch with
  // `input.ack` state "stale" instead of typing a digit at whatever is up now,
  // and it is deliberately NOT combined with `submit`: a dialog takes raw
  // keystrokes, not the type-echo-Return composer path.
  //
  // `promptSubmit` (optional, with `expectPrompt`): this input is the **Submit
  // action of a checkbox box**, not a keystroke to be written where the cursor
  // happens to be. A multi-select `AskUserQuestion` is answered by toggling rows
  // and pressing Return on an unnumbered Submit row; a bare Return sent while
  // the cursor still sits on option 1 TOGGLES that option instead — the box
  // stays open and the user's own pick is undone. So the host walks the cursor
  // onto the Submit row against the rendered screen first (`submitPromptBox`).
  // The client cannot do this: it has no cursor position, and the two arrow
  // keys it would need are the undurable raw-keystroke path.
  //
  // `promptChoice` (optional, with `expectPrompt`): the answer is **option N of
  // a box that has no numbers**, so there is no keystroke to send. opencode's
  // permission dialog draws its options on one row, unnumbered, with the armed
  // one marked by a background colour; a digit typed at it lands in the composer
  // as a stray character, and a bare Return presses whatever was already armed —
  // which on a fresh dialog is "Allow once". So the client names the option it
  // means and the host walks the selection there against the rendered screen,
  // re-reading after every move and REFUSING rather than pressing Return if the
  // armed label never comes back as the one asked for
  // (`sessions.choosePromptBox()`). Same posture as `promptSubmit`: goes with
  // `expectPrompt`, never with `submit`, and the client knows to use it because
  // the published box said `nav: true`, not because it knows which binary drew
  // it. `data` is ignored when this is present and is sent as "" — the field is
  // not optional on the message, and inventing a keystroke to fill it would put
  // one on the wire that must never be typed.
  /**
   * `cwd` is the repo the prompt was composed for, and it exists for ONE case:
   * the session is gone by the time the text arrives.
   *
   * Without it the host can only answer "session not available", and the phone
   * has to notice, run its own grace timer and re-aim the words at that repo's
   * work items — a rescue measured by the PHONE's clock, while a tab is
   * foregrounded, which is exactly when the phone is least likely to be awake.
   * With it the host parks the prompt as a work item itself, on disk, with
   * nobody connected (`input.ack.state === "rescued"`).
   *
   * Optional because it is a hint, not a target: a delivery into a LIVE session
   * never reads it, and a client that does not send it gets the old refusal.
   */
  | ({ t: "session.input"; id: string; data: string; ackId?: string; submit?: boolean; expectPrompt?: string; promptSubmit?: boolean; promptChoice?: number; cwd?: string; view?: SendView } & SendStamp)
  /**
   * "What actually became of these deliveries?" — asked about sends the host
   * already answered `unconfirmed` or `unsubmitted`.
   *
   * Those two verdicts are honest about a 4-second echo window and useless
   * afterwards: the client may not retry them (retrying what may already be
   * there is what stacked five copies of one prompt), so the row sits in the
   * queue for ever. Later the answer is knowable — the CLI's conversation log
   * says whether the prompt ran — so the client asks again instead of keeping a
   * gravestone.
   *
   * READ-ONLY: the host types nothing here, whatever it finds. It carries the
   * text and the queue time because the host deliberately keeps no copy of an
   * un-acked prompt anywhere it could be resurrected from. Batched: a phone
   * settles its whole failed queue at once, and those rows are usually all in
   * the same session (one transcript parse).
   */
  | { t: "input.settle"; items: { ackId: string; id: string; text: string; since: number }[] }
  /**
   * "Which deliveries is the host still unsure about, and what did the ones it
   * has worked out turn out to be?"
   *
   * The reconciliation half of `delivery.list`/`delivery.settled`. A client that
   * was asleep for an hour missed every push, and the rows it is holding are
   * precisely the ones it must not act on from stale information — so it asks
   * for the whole set rather than replaying pushes it cannot know it missed.
   * Also sent unprompted on hello, so the ordinary reconnect needs no request
   * at all; this is for a sheet opening later.
   */
  | { t: "delivery.list" }
  | { t: "session.resize"; id: string; cols: number; rows: number }
  | { t: "session.kill"; id: string }
  /**
   * Stop one background shell — its whole process group, not just the wrapper
   * (`shells.ts`'s `killShellGroup`): SIGTERM, then SIGKILL after 3s for
   * whatever in the group is still alive. `pid`/`startedAt` name the exact row
   * the tap was showing (`SessionShell.pid`/`startedAt`), so a shell that has
   * since ended, or whose pid was reused by something else entirely, is
   * refused in words rather than acted on blind.
   *
   * Deliberately NOT durable and never queued offline — CLAUDE.md's rule that
   * kills are not durable/queued: a kill delivered an hour late hits whatever
   * now holds that pid, not the shell the person tapped stop on.
   */
  | { t: "shell.kill"; id: string; pid: number; startedAt: number }
  /** Forget a session entirely (kills it if still running) — drops it from the list. */
  | { t: "session.remove"; id: string }
  // Close-keep-alive: drop the phone's view but leave claude running in tmux
  // (survives, re-attachable).
  | { t: "session.background"; id: string }
  // Reopen a backgrounded/closed session: re-attach the live tmux session by id
  // if it still exists, else spawn a fresh `--continue` in its cwd.
  // NOTE: no host handler and no client sender — every reopen path goes through
  // `session.create` with `resumeSessionId` (which resumes THAT conversation,
  // not merely the directory's most recent one; see e2e-restore.mjs). Do NOT
  // give this an `ackId`: the queue would park an op nobody handles, and it
  // would never be acked, so the entry retries until it ages out.
  | { t: "session.reopen"; id: string; cwd: string; title: string; launch?: LaunchOpts }
  | { t: "session.closecheck"; id: string }
  | { t: "session.rename"; id: string; title: string }
  /**
   * "Name this conversation now" — re-derive the ≤4-word name the tab and the
   * session header wear (`SessionInfo.tabTitle`), off the session's FIRST
   * PROMPT plus its last few prompts (`record.ts` `recentPromptsOf`) — the
   * automatic pass sees only the first, but a person taps this because that
   * name went stale.
   *
   * The automatic pass (`sessions/record.ts` `nameTab`) fires ONCE per session
   * ever, deliberately: a tab that renames itself is a tab whose position
   * cannot be learned. This is the other half of that rule rather than a hole
   * in it — a tab is renamed because a PERSON asked, at a moment they chose.
   * With no prompt sent yet the answer says so.
   *
   * It SPENDS: one call on the cheap toolless path. One tap, one call, so it
   * is never queued, never retried and never automatic.
   *
   * Not durable and never queued offline, for `intent.cancel`'s reason: a name
   * delivered an hour late is a name for a screen nobody is looking at.
   */
  | { t: "session.name"; id: string }
  /**
   * Switch a live claude session's permission mode the way a person at the
   * desktop would: the host presses shift+tab and re-reads the footer until it
   * shows `mode`, or until the cycle comes back round (the mode is not in this
   * session's cycle — `bypassPermissions` only exists when launched with it).
   * Answered by `session.moded`, always.
   *
   * Not durable and never queued offline, for `intent.cancel`'s reason: a mode
   * switch delivered an hour late changes what a session nobody is watching
   * may do unasked. Re-sending is safe (the target is a state, not a step).
   */
  | { t: "session.mode"; id: string; mode: PermissionMode }
  /** Set (or, with `null`, clear) a session's own budget (`sessionbudget.ts`).
   *  Additive, idempotent, not durable and never queued: re-sending the same
   *  budget is a no-op, and one delivered late would hold or release a session
   *  on a cap the person has since changed. Answered by `session.updated`. */
  | { t: "session.budget.set"; id: string; budget: SessionBudget | null }
  | { t: "session.remoteControl"; id: string; enabled: boolean }
  /** Toggle the manual "prima interest" star (durable — survives restart). */
  | { t: "session.star"; id: string; starred: boolean }
  /**
   * Set or clear the follow-up flag (R-sessions-041). `id` is a live session
   * id OR a conversation id (a *Recently closed* row's `claudeSessionId`), so a
   * flagged session can be marked read after it closed. `on:true` sets it as
   * `by:"hand"`; `on:false` clears it whoever set it — the only way it clears.
   * Fire-and-forget like `session.star`: answered by `session.updated` (live)
   * or a fresh closed list.
   */
  | { t: "session.followup"; id: string; on: boolean }
  /** Pin a history entry as the session's "last" overview label (null = clear). */
  | { t: "session.pin"; id: string; entryId: string | null }
  /**
   * "I have dealt with that question" — retire `SessionInfo.asking` without
   * typing anything into the session.
   *
   * The prose-question badge is recomputed from the rendered tail on every
   * re-idle, so it only retires when a turn STARTS or something is typed. That
   * is the right rule for a question answered in the session and the wrong one
   * for a question answered OUTSIDE it: commit the change yourself at the desk
   * and the badge, the waiting count and the push all keep standing for a
   * decision that is already made, with nothing to type that would clear them.
   *
   * `text` names the question being acknowledged, for `expectPrompt`'s reason:
   * a tap on a badge read a minute ago must not silence a DIFFERENT question
   * that has replaced it since. A mismatch is ignored and the badge stays up.
   * Absent acknowledges whatever is standing (an older client cannot say).
   *
   * Not durable and never queued offline, like `intent.cancel`: an
   * acknowledgement delivered an hour late speaks for a screen nobody is
   * looking at any more. It types NOTHING — the session is untouched, and a
   * new question from the next turn raises the badge again.
   */
  | { t: "session.ackAsking"; id: string; text?: string }
  /** Record a prompt the client just submitted, so it lands in the session history. */
  | { t: "session.record"; id: string; text: string; kind: "prompt" | "command" }
  /** Request the full history for a session. */
  | { t: "session.history"; id: string }
  /** Search terminal text. `id` set = one session (in-CLI find); absent = all
   *  sessions (main-screen search). scope: "recent" = current rendered output,
   *  "history" = full persisted prompt+output history, "prompts" = the persisted
   *  prompts alone (`SessionSearchScope`). */
  | { t: "session.search"; query: string; scope: SessionSearchScope; id?: string }
  | { t: "recent.list" }
  | { t: "recent.clear" }
  /** Drop all entries from the "recently closed" reopen stack (in-memory). */
  | { t: "closed.clear" };
