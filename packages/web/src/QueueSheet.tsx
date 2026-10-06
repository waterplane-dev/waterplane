import { useState } from "react";
import { AlertTriangle, ArrowDown, ArrowUp, CheckCheck, ChevronLeft, CircleCheck, CloudOff, CornerDownLeft, Ellipsis, FilePenLine, Hourglass, Image as ImageIcon, ListOrdered, Loader, MessageCircleQuestion, Pencil, Play, Plus, SendHorizontal, RotateCw, Shuffle, Trash2, X } from "lucide-react";
import { describeLaunch, type LaunchIntent, type RepoTarget, type SessionInfo } from "@waterplane/shared";
import { AttachStrip } from "./AttachStrip";
import { PromptComposer } from "./PromptComposer";
import { RepoPicker } from "./RepoPicker";
import { isCreateOp, isEditableEntry, isSerializable, type OutboxEntry } from "./outbox";
import { track } from "./usage";
import { SheetHead } from "./Sheet";
import { Empty } from "./Empty";
import { SessionName } from "./SessionName";
import { useLink } from "./link";

interface Props {
  /** The whole send queue, in send order (queued + in-flight + failed). */
  entries: OutboxEntry[];
  /** Lane id → human label (session title / repo name), for the group heads. */
  laneLabel: (entry: OutboxEntry) => string;
  /** Live sessions + repos — the destinations a queued message can be re-aimed at. */
  sessions: SessionInfo[];
  repos: RepoTarget[];
  /**
   * Lane keys whose session is GONE — nothing in them will ever be delivered.
   *
   * Computed by App (`goneLanes`) rather than re-derived here from `sessions`,
   * so the sentence this sheet prints and the decision `selectSendable` makes
   * are the same fact. Recomputing it would also print it a moment too early:
   * App waits for a session list that landed on the CURRENT connection, and a
   * sheet open across a reconnect has no way to know that.
   */
  goneLanes: string[];
  onEdit: (ackId: string, text: string) => void;
  onRemove: (ackId: string) => void;
  onMove: (ackId: string, dir: -1 | 1) => void;
  /** Point one queued message at a different session (`input`) or repo (`backlog`). */
  onRetarget: (ackId: string, to: { sessionId: string; cwd: string; mode?: "input" | "backlog" }) => void;
  /** Park / un-park one entry until its session's turn ends. */
  onToggleHold: (ackId: string) => void;
  /**
   * Flip "wait for the other sessions in this repo" on one queued open.
   *
   * Per entry rather than only a global switch, because the two questions are
   * different: the setting says how a queue should drain by default, and this
   * says that THIS one is independent of the rest (or, with the default off,
   * that it should wait after all).
   */
  onToggleSerial: (ackId: string) => void;
  /** Whether new queued opens are serialized per repo, and the switch for it. */
  serialSessions: boolean;
  onToggleSerialAll: () => void;
  /** Release one entry now (arms it and flushes). */
  onSendNow: (ackId: string) => void;
  /** Release everything queued. */
  onSendAll: () => void;
  /**
   * Put every given-up row that is provably un-sent back in the queue.
   *
   * The one answer to a sheet full of red. An outage longer than the queue's
   * own TTL expires the whole backlog on the first flush that reaches the
   * host, so the sheet a person opens after a bad tunnel is a list of failures
   * with a per-row retry each — twenty taps, in a list that scrolls. Rows whose
   * fate is genuinely unknown (`unconfirmed`, `unsubmitted`: written into a
   * live composer, never seen to submit) are deliberately NOT included: those
   * may only be revived one at a time, by someone who has decided about that
   * one message.
   */
  onRetryFailed: () => void;
  /** Pull one entry's text back into the compose box and drop it. */
  onRestore: (ackId: string) => void;
  /**
   * Open one entry in the resend editor: rewrite it, check that the files it
   * names will actually be there, then send it as a new message.
   *
   * The counterpart to "try again" for a row that gave up. A retry re-sends
   * exactly what failed — right when the words have gone stale and the photo
   * behind them may have been dropped from the queue underneath.
   */
  onResend: (e: OutboxEntry) => void;
  /** Which repo an entry's file paths belong to, for looking them up. */
  repoIdOf: (e: OutboxEntry) => string | null;
  /**
   * Append one more prompt to the chain behind a queued `session.create`.
   *
   * A queued open on its own delivers an empty terminal — the prompts that
   * should run once it is up are the reason to queue it at all, and offline
   * they cannot be addressed to the session directly (it has no id yet). They
   * ride in the create's own lane and are delivered one turn at a time.
   */
  onAddPrompt: (ackId: string, text: string) => void;
  onClose: () => void;
  /** false = no socket; the sheet says so instead of pretending Send does something. */
  online: boolean;
  /**
   * Sessions the HOST is holding until the files their prompt names arrive.
   *
   * They are not in `entries` and must not be: they left this device. That is
   * the whole point of them — the desktop took the intent, so the plan no
   * longer dies with a tab or a tunnel. But they are still "things you asked
   * for that have not happened", which is what this sheet is for, so they are
   * listed here with what they are waiting on and the two decisions only a
   * person can make: call it off, or run it without the file.
   */
  launches: LaunchIntent[];
  onCancelLaunch: (id: string) => void;
  onRunLaunch: (id: string) => void;
}

const STATUS: Record<string, { icon: typeof CloudOff; label: string }> = {
  queued: { icon: CloudOff, label: "waiting" },
  pending: { icon: Loader, label: "sending" },
  failed: { icon: AlertTriangle, label: "not delivered" },
};

/**
 * Manage the offline send queue — the counterpart to being able to keep typing
 * while the tunnel is down. Everything typed offline is listed in the order it
 * will be delivered, GROUPED BY SESSION, because that is the order that
 * actually matters: entries in one group are delivered strictly one at a time
 * (a PTY composer would otherwise concatenate them), so position N+1 does not
 * move until N has been submitted.
 *
 * Editing is the point: prompts written before the link died are often half
 * wrong by the time it comes back ("also fix the test" — which the agent has
 * since done). Rewrite it, reorder it, or drop it, without losing the rest of
 * the queue. A `pending` entry is read-only: it may already be on a live PTY.
 */
export function QueueSheet({ entries, laneLabel, sessions, repos, goneLanes, onEdit, onRemove, onMove, onRetarget, onToggleHold, onToggleSerial, serialSessions, onToggleSerialAll, onSendNow, onSendAll, onRetryFailed, onRestore, onResend, repoIdOf, onAddPrompt, onClose, online, launches, onCancelLaunch, onRunLaunch }: Props) {
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  /** How much this phone is holding that the desktop has not got — the queue
   *  PLUS the settings pushes. Read rather than re-derived: this sheet can see
   *  its own rows and nothing else, and an all-clear inferred from an empty
   *  list would be a claim about a store it has never looked at. */
  const outstanding = useLink((s) => s.outstanding);
  /** Which entry has its "aim it somewhere else" picker open. */
  const [retargeting, setRetargeting] = useState<string | null>(null);
  /** Which queued create has its "…and then do this" box open. */
  const [adding, setAdding] = useState<string | null>(null);
  const [addDraft, setAddDraft] = useState("");
  /**
   * Which row has its secondary actions open.
   *
   * A row carried up to eight icon buttons next to the text it describes — on a
   * phone that is the entire width, so either the buttons went under the
   * fingertip floor or the message was squeezed to a few characters. The two
   * that answer "deal with this now" (send it, drop it) stay; the rest are one
   * tap away. Opening one closes the other, so the list never grows two rows of
   * controls at once.
   */
  const [moreFor, setMoreFor] = useState<string | null>(null);
  const live = sessions.filter((s) => s.running);
  // Only the ones still holding something back. A settled launch is a session
  // that exists (it is in the session list) or a failure the host already
  // notified about — neither belongs in a list of pending work.
  const held = launches.filter((l) => l.state === "waiting" || l.state === "opening");

  // Group by lane, preserving the flat queue order within each group.
  const lanes: { id: string; label: string; items: OutboxEntry[] }[] = [];
  for (const e of entries) {
    let lane = lanes.find((l) => l.id === e.sessionId);
    if (!lane) { lane = { id: e.sessionId, label: laneLabel(e), items: [] }; lanes.push(lane); }
    lane.items.push(e);
  }

  /**
   * A file and the message that names it are ONE thing to the person who sent
   * them, and THREE deliveries to the queue: every upload is its own HTTP POST
   * with its own ack, its own retry budget and its own verdict, and the text
   * may not go out until they have landed. That split is what makes "this one
   * image failed — keep the words, re-attach that file" expressible at all;
   * merged into a single entry, one dead byte range would fail the prompt too.
   *
   * So the rows stay separate and the SHEET draws one card around them.
   */
  const grouped = lanes.map((lane) => {
    const owner = new Map<string, string>(); // upload ackId → ackId of the message naming it
    for (const e of lane.items) {
      if (e.mode === "upload" || !e.text) continue;
      for (const u of lane.items) {
        if (u.mode !== "upload" || !u.upload || owner.has(u.ackId)) continue;
        if (e.text.includes(u.upload.relPath)) owner.set(u.ackId, e.ackId);
      }
    }
    const groups: { key: string; rows: { e: OutboxEntry; i: number }[] }[] = [];
    lane.items.forEach((e, i) => {
      if (e.mode === "upload" && owner.has(e.ackId)) return; // drawn with its message instead
      const rows = lane.items
        .map((u, j) => ({ e: u, i: j }))
        .filter((r) => owner.get(r.e.ackId) === e.ackId);
      rows.push({ e, i });
      groups.push({ key: e.ackId, rows });
    });
    return { ...lane, groups };
  });
  const goneSet = new Set(goneLanes);
  /** Stranded: an `input` message for a session that has gone. Same test as
   *  `selectSendable`'s — the other modes still go out (an upload is an HTTP
   *  POST, a work item falls back to the repo's own session). */
  const isStranded = (e: OutboxEntry) =>
    e.status === "queued" && (e.mode ?? "input") === "input" && goneSet.has(e.sessionId);
  // Queued rows that cannot go anywhere: their session has gone. Counted so the
  // standing sentence can say it once instead of the queue saying it per row,
  // one give-up at a time, which is what it used to do.
  const strandedCount = entries.filter(isStranded).length;
  const queuedCount = entries.filter((e) => e.status === "queued").length;
  // Given-up rows that may be revived in bulk. `unconfirmed`/`unsubmitted` are
  // excluded on purpose — see `onRetryFailed`.
  const retryable = entries.filter((e) => e.status === "failed"
    && e.failState !== "unconfirmed" && e.failState !== "unsubmitted").length;

  function startEdit(e: OutboxEntry) { setEditing(e.ackId); setDraft(e.text); }
  function commitEdit(ackId: string) {
    const text = draft.trim();
    setEditing(null);
    if (!text) { onRemove(ackId); return; } // emptied = deleted, the obvious reading
    onEdit(ackId, text);
  }

  /**
   * `owner` is the message that NAMES this row's file, when the row is one of
   * the uploads drawn inside a bundle. An upload has no words of its own, so
   * every text-shaped action on it is really an action on that message — which
   * is what "rewrite it and fix the files" has to reach to be reachable at all
   * from the row the failure is actually printed on.
   */
  function renderRow(e: OutboxEntry, i: number, arr: OutboxEntry[], owner?: OutboxEntry) {
      const st = STATUS[e.status] ?? STATUS.queued;
      const StIcon = st.icon;
      const locked = e.status === "pending";
      // An OP is an ACTION, not text: "start a session here", "fan out",
      // "run this build". Two consequences in this sheet — its body is
      // only editable when the text IS the payload (a fan-out prompt),
      // and it can never be re-aimed at another session, because the
      // payload already names its own subject.
      const isOp = e.mode === "op";
      // An UPLOAD is file bytes waiting for a link, not a message: its
      // row exists so the queue explains why the prompt behind it hasn't
      // gone yet. Nothing about it is text — no edit, no re-aim, no
      // "put it back in the message box".
      const isUpload = e.mode === "upload";
      // An ANSWER is a one-tap reply to a question box the CLI was
      // showing — a keystroke, not a message. Its `text` is "2\r" or an
      // Esc, which is meaningless to read and dangerous to edit, so the
      // row shows the OPTION that was tapped and the question it belongs
      // to. It cannot be re-aimed either: the fingerprint it carries
      // names one box in one session, and the host refuses it anywhere
      // else (`input.ack` state "stale").
      const isAnswer = !!e.answer;
      const editable = isEditableEntry(e);
      const canAim = !isOp && !isUpload && !isAnswer;
      // Nothing is on the wire for this one — an attempt failed and the
      // next is waiting out its backoff. Worth saying, because the row
      // otherwise reads "waiting" exactly like an entry that has never
      // been tried.
      // Seconds under the minute, minutes over it: a round wait (`roundDelay`)
      // is 5 to 30 minutes and "retrying in 1140s" is a number nobody converts.
      const backoffMs = e.status === "queued" && e.retryAt != null && e.retryAt > Date.now()
        ? e.retryAt - Date.now()
        : null;
      const backoffIn = backoffMs == null ? null
        : backoffMs < 60_000 ? `${Math.max(1, Math.round(backoffMs / 1000))}s` : `${Math.round(backoffMs / 60_000)} min`;
      // Rewriting an upload row means rewriting the message that names it.
      const resendTarget = isUpload ? owner : e;
      // Does "⋯" lead anywhere? A failed upload used to open a strip in which
      // every single control was disabled — the most expensive way an
      // interface can say "nothing". Draw the button only when at least one
      // thing behind it can be pressed.
      const hasMore = (!locked && (i > 0 || i < arr.length - 1))
        || e.status === "queued"
        || (!locked && !isOp && !isUpload && !isAnswer)
        || (!locked && !isAnswer && !!resendTarget);
      if (editing === e.ackId) {
        return (
          <div key={e.ackId} className="queue-edit">
            {/* The one prompt-writing surface (`PromptComposer`), inline: a
                queued message is rewritten INSIDE its row, above the actions
                that send or drop it. */}
            <PromptComposer inline rows={4} autoFocus prompts={[draft]}
              onChange={(next) => setDraft(next[0] ?? "")} placeholder="Rewrite it…" />
            <div className="queue-row-acts">
              <button className="key" onClick={() => setEditing(null)}><X size={16} /> cancel</button>
              <span className="spacer" />
              <button className="send" onClick={() => { track("action:queue.edit"); commitEdit(e.ackId); }}>Save</button>
            </div>
          </div>
        );
      }
      return (
        <div key={e.ackId} className={`queue-row-wrap ${retargeting === e.ackId ? "aiming" : ""}`}>
        <div className={`queue-row ${e.status}`}>
          <button className="queue-text" disabled={!editable} onClick={() => startEdit(e)}
            title={locked ? "already on its way"
              : isCreateOp(e) ? "tap to write what this session should do first"
              : isAnswer ? "an answer to a question — the option you tapped, not text to rewrite"
              : editable ? "tap to edit"
              : "this one is an action, not text — nothing to rewrite"}>
            <span className="queue-text-body">{isOp ? <><Play size={11} /> {e.text}</> : isUpload ? <><ImageIcon size={11} /> {e.text}</> : e.answer ? <><MessageCircleQuestion size={11} /> {e.answer.label} — {e.answer.question}</> : e.text}</span>
            <span className="queue-meta">
              <StIcon size={12} className={e.status === "pending" ? "spin" : undefined} />
              {st.label}
              {e.mode === "backlog" ? " · backlog item" : ""}
              {isOp ? (isCreateOp(e) ? " · opens a session" : " · action") : ""}
              {e.pendingCreate ? " · runs once that session is open" : ""}
              {isUpload ? ` · file${e.upload ? ` · ${Math.max(1, Math.round(e.upload.size / 1024))} kB` : ""} · uploads before the prompt that names it` : ""}
              {isAnswer ? " · answer · only sent while that question is still open" : ""}
              {isStranded(e) ? " · that session is gone — aim it somewhere else, or rewrite it" : ""}
              {e.holdUntilIdle ? " · waiting until the session can take it" : ""}
              {e.serial ? " · runs after this repo's other sessions" : isSerializable(e) ? " · starts even if this repo is busy" : ""}
              {e.reason ? ` · ${e.reason}` : ""}
              {backoffIn != null ? ` · ${e.waitReason ? `${e.waitReason} · ` : ""}retrying in ${backoffIn}` : ""}
              {/* `tries`, not `attempts`: the give-up counter is reset by every
                  retry round (`nextRound`), so it answers "how close is this to
                  the next long wait?" and not "how many times has this been
                  tried?" — which is the question a person reading a row is
                  asking. */}
              {(e.tries ?? e.attempts ?? 0) > 1 ? ` · ${e.tries ?? e.attempts} attempts` : ""}
            </span>
          </button>
          <div className="queue-row-acts">
            {/* Primary: what you came to the row to do. The rest live
                under "⋯" — see `moreFor`. Both groups are RENDERED for
                every row and disabled when they don't apply, rather
                than mounted per status: a delivery attempt flips a row
                queued→pending→queued, and unmounting buttons on each
                flip reshapes the row and shunts the list — the
                Manage-Queue half of the flicker the queue bar had.
                Geometry stays put; only the enabled state moves. */}
            {/* A `failed` row is the one thing here that is worth tapping with
                the link DOWN: reviving it writes nothing to a socket, it puts
                the entry back in the queue with its budget reset so it goes out
                whenever the link returns. Gating it on `online` made the only
                enabled control on a row of red text the DELETE button — the
                sheet in the report, where nothing a person pressed did
                anything. Everything else still needs a socket to mean
                anything, so it stays gated. */}
            <button className="key" data-hint="queue.sendone"
              disabled={e.status === "pending" || (!online && e.status !== "failed")}
              title={e.status === "pending" ? "already on its way"
                : e.status === "failed" ? (online ? "try this one again" : "put it back in the queue — it goes out when the link is back")
                : !online ? "no connection yet"
                : backoffIn != null ? "waiting before the next attempt — tap to try it right now"
                : "send this one now"}
              onClick={() => { track("action:queue.sendone"); onSendNow(e.ackId); }}>
              {e.status === "failed" ? <RotateCw size={16} /> : <SendHorizontal size={16} />}
            </button>
            <button className="key danger" data-hint="queue.remove" title="discard" disabled={locked}
              onClick={() => { track("action:queue.remove"); onRemove(e.ackId); }}><Trash2 size={16} /></button>
            {hasMore && (
              <button className={`key ${moreFor === e.ackId ? "on" : ""}`} data-hint="queue.more"
                title={moreFor === e.ackId ? "hide the other actions" : "reorder, hold, re-aim, rewrite and send again"}
                aria-expanded={moreFor === e.ackId}
                onClick={() => setMoreFor(moreFor === e.ackId ? null : e.ackId)}><Ellipsis size={16} /></button>
            )}
          </div>
        </div>
        {/* The files this message names, as the files they are. A minted inbox
            name ("1000074539-mtjv8u52a489a0.jpg") is unreadable on purpose —
            it is built not to collide, not to be recognised — so a queue of
            them cannot be audited by reading it. The strip also says, per file,
            whether it is actually going to be there: an upload two rows down,
            a file already in the repo, or bytes nobody is sending any more. */}
        {(isUpload ? !!e.upload : !isOp && !isAnswer) && (
          <AttachStrip compact text={isUpload ? e.upload!.relPath : e.text} repoId={repoIdOf(e)}
            outbox={entries} online={online} />
        )}
        {moreFor === e.ackId && (
          <div className="queue-row-acts queue-more">
            <button className="key" data-hint="queue.moveup" title="move earlier" disabled={locked || i === 0} onClick={() => onMove(e.ackId, -1)}><ArrowUp size={16} /></button>
            <button className="key" data-hint="queue.movedown" title="move later" disabled={locked || i === arr.length - 1} onClick={() => onMove(e.ackId, 1)}><ArrowDown size={16} /></button>
            <button className={`key ${e.holdUntilIdle ? "on" : ""}`} data-hint="queue.hold" disabled={e.status !== "queued"}
              // The composer's words for this WHEN, not a fifth spelling of it:
              // *when it's free* on the split button, on the Backlog row and on
              // the next-prompt strip, and the same sentence here.
              title={e.status !== "queued" ? "already on its way"
                : e.holdUntilIdle
                ? "when it's free — the turn has ended, no question box is up and it isn't blocked on a usage limit. Tap to send at the next opportunity instead"
                : "when it's free: the turn ended, no question is on screen, no usage-limit block (exact for sessions that report turn boundaries; a guess from silence otherwise)"}
              onClick={() => onToggleHold(e.ackId)}><Hourglass size={16} /></button>
            {/* Only an open that RUNS something can pile up: a bare terminal
                costs nothing and edits nothing, so there is nothing to
                serialize. */}
            {isSerializable(e) && (
              <button className={`key ${e.serial ? "on" : ""}`} data-hint="queue.serial" disabled={e.status !== "queued"}
                title={e.status !== "queued" ? "already on its way"
                  : e.serial
                  ? "waiting until this repo's other sessions have finished — one agent at a time, so they don't spend the usage limit in parallel or edit the same files. Tap to let it start straight away"
                  : "start it straight away, even if another session in this repo is working. Tap to make it wait its turn instead"}
                onClick={() => onToggleSerial(e.ackId)}><ListOrdered size={16} /></button>
            )}
            {canAim && (
              <button className={`key ${retargeting === e.ackId ? "on" : ""}`} data-hint="queue.retarget" disabled={e.status !== "queued"}
                title={e.status !== "queued" ? "already on its way" : "send it somewhere else"}
                onClick={() => setRetargeting(retargeting === e.ackId ? null : e.ackId)}><Shuffle size={16} /></button>
            )}
            {/* A queued open is worth queuing only for what runs in it.
                This adds another prompt to its chain — delivered after
                the one before it has finished its turn. */}
            {isCreateOp(e) && (
              <button className={`key ${adding === e.ackId ? "on" : ""}`} data-hint="queue.addprompt" disabled={e.status !== "queued"}
                title={e.status !== "queued" ? "already on its way" : "add a prompt to run after this session opens"}
                onClick={() => { setAdding(adding === e.ackId ? null : e.ackId); setAddDraft(""); }}><Plus size={16} /></button>
            )}
            {/* An op has no text to hand back to a compose box — its
                label is a description, not something you'd retype. Nor
                does an answer: pasting "2" into the composer would type
                a stray digit at whatever the session is doing now. */}
            <button className="key" data-hint="queue.restore" title="put the text back in the message box" disabled={locked || isOp || isUpload || isAnswer}
              onClick={() => { track("action:queue.restore"); onRestore(e.ackId); }}><CornerDownLeft size={16} /></button>
            {/* Rewrite it, check the files it names, send it as a new message.
                What "try again" cannot do: a retry re-sends the same words at
                the same target with the same attachments, which is precisely
                what already failed. On an UPLOAD row it opens the message that
                names the file — the editor's whole job there is picking the
                file again or dropping the mention, and this row IS where the
                failure is printed. */}
            <button className="key" data-hint="queue.resend"
              title={isUpload
                ? "rewrite the message that names this file — re-attach it, swap it, or drop the mention"
                : "rewrite it, check the files it names, and send it again"}
              disabled={locked || isAnswer || !resendTarget}
              onClick={() => { track("action:queue.resend"); onResend(resendTarget!); }}><FilePenLine size={16} /></button>
          </div>
        )}
        {adding === e.ackId && (
          <div className="queue-edit">
            <div className="form-hint" style={{ padding: 0 }}>
              Runs in this session once it is open — after everything already queued for it has finished.
            </div>
            {/* Same composer: a prompt queued behind an open is a prompt. */}
            <PromptComposer inline rows={3} autoFocus prompts={[addDraft]}
              onChange={(next) => setAddDraft(next[0] ?? "")} placeholder="…and then do this" />
            <div className="queue-row-acts">
              <button className="key" onClick={() => setAdding(null)}><X size={16} /> cancel</button>
              <span className="spacer" />
              <button className="send" disabled={!addDraft.trim()}
                onClick={() => { onAddPrompt(e.ackId, addDraft.trim()); setAdding(null); setAddDraft(""); }}>Add</button>
            </div>
          </div>
        )}
        {retargeting === e.ackId && canAim && (
          // Offline text goes stale in a way editing can't fix: the
          // session it was written for may have died, or the thought may
          // simply belong to a different repo now. Re-aiming keeps the
          // words and changes the destination — a fresh ackId is minted
          // App-side, because the host may already hold a verdict for
          // the old one.
          <div className="queue-aim">
            <div className="form-hint">Send it to another session, or park it in a repo’s backlog.</div>
            {live.filter((s) => s.id !== e.sessionId).map((s) => (
              <button key={s.id} className="row" onClick={() => { setRetargeting(null); onRetarget(e.ackId, { sessionId: s.id, cwd: s.cwd, mode: "input" }); }}>
                <span className="row-title"><SendHorizontal size={12} /> {s.title}</span>
                <SessionName s={s} />
                <span className="row-sub">{s.turnActive ? "working" : "idle"}</span>
              </button>
            ))}
            {/* The shared picker (`RepoPicker.tsx`). `home` is the repo the
                entry was written against, so re-aiming a stranded prompt starts
                with the answer it already carried. */}
            <RepoPicker repos={repos} listClass="" home={e.cwd || null} subLead="backlog item"
              icon={<CheckCheck size={12} />}
              onPick={(r) => { setRetargeting(null); onRetarget(e.ackId, { sessionId: r.worktreePath, cwd: r.worktreePath, mode: "backlog" }); }} />
          </div>
        )}
        </div>
      );
  }

  return (
    <div className="sheet">
      <SheetHead title={"Queued messages"} onClose={onClose}>
        {queuedCount > 0 && (
          <button className="key" data-hint="queue.sendall" title={online ? "send everything queued now" : "no connection — this stays queued"}
            onClick={() => { track("action:queue.sendall"); onSendAll(); }}>
            <CheckCheck size={16} /> send all
          </button>
        )}
      </SheetHead>
      {/* Four sentences of standing explanation above every list is the wall a
          phone screen can least afford. The state sentence stays; the manual
          moves behind a disclosure. */}
      <div className="form-hint">
        {online
          ? "Connected. One message per session at a time, in order."
          : "No connection. Everything here is kept on this phone and sent when the link is back."}
        {retryable > 0 && (
          <> {retryable} gave up waiting. Try them again and they go back in the queue — now, or as soon as the link is back.</>
        )}
        {/* Said once, above the list, for the same reason the retry-all button
            is: a whole lane is stranded by ONE fact, and per-row is the wrong
            place to learn it. "Try again" is deliberately not offered — it would
            re-aim at the same dead session and fail instantly. */}
        {strandedCount > 0 && (
          <> {strandedCount} {strandedCount > 1 ? "are" : "is"} waiting for a session that has gone — they will not be sent. Under “⋯”, aim them at another session or at the repo’s backlog.</>
        )}
      </div>
      {/* The answer to a sheet of red, above the list rather than once per row:
          an outage past the queue's TTL expires the whole backlog at once, so
          the per-row retry is the right control for one message and the wrong
          one for twenty. */}
      {retryable > 0 && (
        <div className="queue-row-acts" style={{ padding: "0 12px 8px" }}>
          <button className="key" data-hint="queue.retryall"
            title="put every message that gave up back in the queue, with its retry budget reset"
            onClick={() => { track("action:queue.retryall"); onRetryFailed(); }}>
            <RotateCw size={14} /> try {retryable} again
          </button>
        </div>
      )}
      <div className="queue-row-acts" style={{ padding: "0 12px 8px" }}>
        <button className={`key ${serialSessions ? "on" : ""}`} data-hint="queue.serialall"
          title={serialSessions
            ? "New queued prompts that open a session run ONE AT A TIME per repo: the next one starts when the one before it has finished its turn. Tap to let them all start together"
            : "New queued prompts that open a session all start as soon as the link is back — several agents in one repo at once. Tap to run them one at a time instead"}
          onClick={onToggleSerialAll}>
          <ListOrdered size={14} /> one session at a time per repo: {serialSessions ? "on" : "off"}
        </button>
      </div>
      <details className="hint-more">
        <summary>what the buttons do</summary>
        <p>Tap a message to rewrite it. The extra actions per row are behind “⋯”: reorder, hold until that session finishes its turn, aim it at another session, or put the text back in the message box.</p>
        <p>Rows marked “action” (fan out, run a build) carry a payload rather than text — they can be held, sent or dropped, but not rewritten or re-aimed.</p>
        <p>A row that OPENS a session is different: tap it to write what it should do first, or use + to queue further prompts, each delivered once the one before it has finished.</p>
        <p>Several opens queued for the SAME repo run one after another by default — otherwise they would all start at once, spend the usage limit in parallel without finishing anything, and edit the same files. The list icon on a row flips that for that one open; the switch above flips it for new ones.</p>
        <p>A row in red gave up — the link was down longer than a message is allowed to wait. Nothing was sent and nothing was lost: “try again” puts it back in the queue, and works with the link still down. Under “⋯”, the pencil-and-page rewrites it instead, which is also where a file that never uploaded is re-attached or dropped.</p>
        <p>Press and hold any button — here or anywhere in the app — to read what it does. Holding never presses it.</p>
      </details>
      <div className="list">
        {/* Handed over to the desktop: listed FIRST, because these are the ones
            that no longer need this phone at all, and reading them as "still
            stuck in my queue" is exactly the wrong conclusion. */}
        {held.length > 0 && (
          <div className="queue-lane">
            <div className="queue-lane-head">
              <span className="queue-lane-title">waiting on the desktop</span>
              <span className="queue-lane-count">{held.length}</span>
            </div>
            <div className="form-hint" style={{ paddingTop: 0 }}>
              The desktop has these and will open them itself when the files land — this phone can be closed.
            </div>
            {held.map((l) => (
              <div key={l.id} className="queue-row-wrap">
                <div className="queue-row queued">
                  <div className="queue-text" style={{ cursor: "default" }}>
                    <span className="queue-text-body"><Play size={11} /> {l.prompt || `open ${l.repoName || l.cwd}`}</span>
                    <span className="queue-meta">
                      <CloudOff size={12} /> {describeLaunch(l)}
                      {l.repoName ? ` · ${l.repoName}` : ""}
                      {` · gives up ${new Date(l.deadlineAt).toLocaleString()}`}
                    </span>
                  </div>
                  <div className="queue-row-acts">
                    <button className="key" title="open the session now, without the files it is waiting for — the prompt inside it will still name them"
                      onClick={() => { track("action:launch.run"); onRunLaunch(l.id); }}>
                      <Play size={16} />
                    </button>
                    <button className="key danger" title="call it off — the session never opens"
                      onClick={() => { track("action:launch.cancel"); onCancelLaunch(l.id); }}>
                      <X size={16} />
                    </button>
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
        {/**
          * The empty state is the ANSWER, not an absence.
          *
          * "Nothing queued." is true and says nothing about the thing a person
          * opened this sheet to find out — whether what they wrote is anywhere
          * but this phone. An empty queue is most of that answer and not all of
          * it: `settings.ts`'s pushes (the pad, templates, every synced
          * preference) travel on their own path, so the sheet reads the ONE
          * combined number the strip reads (`link.outstanding`) rather than
          * inferring an all-clear from its own emptiness and being wrong about
          * the half it cannot see.
          */}
        {lanes.length === 0 && held.length === 0 && (
          <Empty>{outstanding === 0
            ? <span className="qs-clear"><CircleCheck size={14} /> Nothing queued — everything written on this phone has reached the desktop.</span>
            : <>Nothing queued to send. {outstanding === 1 ? "One thing" : `${outstanding} things`} written here {outstanding === 1 ? "is" : "are"} still being pushed to the desktop — settings, templates and notes travel on their own path and need no tap.</>}
          </Empty>
        )}
        {grouped.map((lane) => (
          <div key={lane.id} className="queue-lane">
            <div className="queue-lane-head">
              <span className="queue-lane-title">{lane.label}</span>
              <span className="queue-lane-count">{lane.items.length}</span>
            </div>
            {lane.groups.map((g) => {
              // One card = one thing you meant to send. Its rows are still the
              // separate deliveries they are — each keeps its own status, its
              // own retry and its own discard — but they are drawn as a unit,
              // so a message with two files reads as a message with two files
              // rather than as three unrelated queue entries.
              const files = g.rows.length - 1;
              if (!files) return <div key={g.key}>{renderRow(g.rows[0].e, g.rows[0].i, lane.items)}</div>;
              return (
                <div key={g.key} className="queue-bundle">
                  <div className="queue-bundle-head">
                    <ImageIcon size={11} /> {files} {files === 1 ? "file" : "files"} + the message that names {files === 1 ? "it" : "them"} — sent in this order
                  </div>
                  {/* The message is the LAST row of the bundle — the files it
                      names go out before it. */}
                  {g.rows.map((r) => renderRow(r.e, r.i, lane.items, g.rows[g.rows.length - 1].e))}
                </div>
              );
            })}
          </div>
        ))}
      </div>
      <div className="sheet-actions">
        <button className="key" onClick={onClose}><ChevronLeft size={16} /> back</button>
        <span className="spacer" />
        <span className="set-note" style={{ padding: 0 }}>{queuedCount} waiting</span>
        <Pencil size={14} style={{ opacity: 0.35 }} />
      </div>
    </div>
  );
}
