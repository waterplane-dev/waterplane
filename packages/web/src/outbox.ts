// Compose durability — never lose typed or sent text to a stale/zombie socket.
//
// Two localStorage-backed stores:
//   drafts — per-session UNSENT text. Persisted on every keystroke so a reload,
//            navigation, or the mobile OS killing the backgrounded tab can't lose
//            an in-progress message.
//   outbox — the SEND QUEUE. Every compose/slash send lands here first and is
//            only dropped once the host acks delivery to a live PTY. It is the
//            single send path: nothing is written to the socket that isn't in
//            here, so there is exactly one thing to retry.
//
// The whole point: text lives in browser storage from the first keystroke until
// the host has *confirmed* it reached a running session.
//
// Statuses:
//   queued  — not on the wire (offline, or a delivery attempt timed out). Sent
//             automatically the moment a socket is open again.
//   pending — written to a live socket, awaiting the host's receipt.
//   failed  — given up on, and ONLY because the host answered and said no in a
//             way that is not safe to send again (a refused op, a stale answer,
//             a prompt left unsubmitted). Running out of attempts does NOT land
//             here: nobody answered those, so they go back to `queued` on a long
//             backoff and keep trying (`roundDelay`). The row STAYS, with its
//             full words and the repo they were written for, until the user acts
//             on it. Nothing expires and nothing retires; Activity is where it
//             is triaged.
//
// Retrying is only safe because the HOST is idempotent on `ackId` (see
// main.ts "session.input"): a repeat of an ackId it already handled is re-ACKed
// without typing the text a second time. Do not retry without that ledger.

import {
  adoptPad, draftToRescue, parsePad, padFullText, removeNotes, serializePad, upsertNote,
  PAD_BYTES, PAD_CAP, PAD_WRITE_REFUSED,
  type ClientMessage, type PadDoc, type PadNote, type SendView, type SessionBudget, type LaunchOpts,
} from "@waterplane/shared";
import { LS, lsGet, lsSetJson } from "./storage";
import { announceSetting, onAdopt } from "./settings";

const DRAFTS_KEY = LS.composeDrafts;
const OUTBOX_KEY = LS.composeOutbox;
const PAD_KEY = LS.pad; // untargeted drafts (the prompt pad)
/**
 * Hard bound on the queue — and the number that had to move first.
 *
 * It was 50, against a phone holding 47 undelivered sends. The cap is enforced
 * on the way IN (see `addOutbox`) precisely because trimming on the write path
 * can only drop the oldest entry silently, and the oldest entry is routinely an
 * undelivered prompt — but a bound that tight turns "the tunnel was bad for an
 * afternoon" into an eviction, and eviction is the one path out of this queue
 * that keeps nothing.
 *
 * Nothing retires a row any more: no TTL, no `FAILED_RETIRE_MS`, no move to the
 * pad. A row stays until it is delivered, discarded by hand, or posted to the
 * desktop. So the cap has to be sized for the state the app is actually in when
 * it is failing — hundreds of rows, for days — rather than for a tidy queue.
 * 500 mirrors the host's own `INTENT_PENDING_MAX`, and a row is a few hundred
 * bytes: the whole queue at the cap is well inside one localStorage origin.
 */
export const OUTBOX_CAP = 500;
/**
 * The last resort, and the only delete left in this file.
 *
 * Past `OUTBOX_CAP` a row is FAILED rather than removed — its words stay on
 * screen. That bounds nothing on its own (each further send adds one more), so
 * there has to be a real ceiling somewhere or a phone left composing offline
 * for a week eventually hits the localStorage quota, at which point `write`
 * swallows the throw and the WHOLE queue stops persisting — every row lost on
 * the next reload rather than the oldest few.
 *
 * So: twice the cap, only `failed` rows, oldest first, and LOUDLY — the toast
 * names how many and says the words go with them. Reaching it means a thousand
 * undelivered sends, which is not a state to paper over.
 */
export const OUTBOX_HARD_MAX = OUTBOX_CAP * 2;

export type OutboxStatus = "queued" | "pending" | "failed";

export interface OutboxEntry {
  ackId: string;
  /** Delivery lane. Entries sharing it are sent strictly one at a time (see
   *  shared/queue.ts): a PTY composer concatenates two writes into one line. */
  sessionId: string;
  cwd: string;
  text: string;
  ts: number;
  status: OutboxStatus;
  /** Delivery attempts made so far (a reconnect flush counts as one). Rolled
   *  BACK when an attempt could not have been answered — see `tries`. */
  attempts?: number;
  /**
   * Attempts made including the ones rolled back out of `attempts` — the
   * backoff clock. Never decremented. See `SendQueueEntry.retryAt` in
   * shared/queue.ts for why the two counters have to be separate: a dead link
   * must not spend the give-up budget, and a failure that returns instantly
   * must not be re-fired at 2 Hz for half an hour.
   */
  tries?: number;
  /** Earliest ms-epoch this entry may be attempted again (`retryDelay(tries)`).
   *  Cleared by any explicit "send it now" and by a reconnect. */
  retryAt?: number;
  /**
   * When the CURRENT attempt went on the wire. Distinct from `ts` (which is
   * when the entry was queued, and is what bounds retries/expiry): the send bar
   * counts elapsed seconds off this, so "Sending…" on a slow link reads as
   * progress rather than as a hang. Reset on every attempt.
   */
  sentAt?: number;
  /**
   * When the FIRST attempt for this entry went on the wire, ever — never reset.
   * `MIN_TRY_MS` (shared/queue.ts) is measured off it: the attempts cap may not
   * give up on a delivery that has been trying for less than a minute, however
   * fast a bad radio manages to spend eight receipt windows.
   */
  firstTryAt?: number;
  /**
   * How many times the whole attempts ladder has been spent without the host
   * ever answering. Each round parks the entry on `roundDelay(round)` and tries
   * again; it is not a failure and the row does not go red for it.
   */
  round?: number;
  /** Why it ended up `failed` — shown in the recovery bar. */
  reason?: string;
  /**
   * Why the CURRENT wait is happening, for a row that is still being delivered
   * — set when a round is exhausted, cleared the moment an attempt goes out.
   * Distinct from `reason`, which belongs to a row that has stopped.
   */
  waitReason?: string;
  /**
   * WHICH failure it was — the host's `input.ack.state`, kept because the
   * reason string is prose for a human and this is what code has to branch on
   * later.
   *
   * `unconfirmed` and `unsubmitted` are the two verdicts that are honest about
   * a 4-second echo window and useless afterwards, and neither may be
   * auto-retried at the time. The phone no longer chases them: the HOST keeps
   * the open question (`opendeliveries.ts`), re-asks the CLI's own conversation
   * log on its own sweep whether or not anybody is connected, re-sends a
   * provably-`absent` one exactly once, and pushes the resolution as
   * `delivery.settled`. This field is what lets that verdict find the red row it
   * belongs to.
   *
   * `refused` is the OP half of `stale`: the host answered `op.ack` with
   * `ok:false`, which on the durable-op path means the action never started
   * (see `routes/session.ts`'s create and `routes/work.ts` — every `ok:false`
   * there is returned BEFORE anything is spawned or typed). Recorded as its own
   * word because `other` renders as "nobody recorded whether it ran", and a row
   * the desktop explicitly said no to is the one case where somebody did.
   */
  failState?: "unconfirmed" | "unsubmitted" | "stale" | "refused" | "other";
  /** When this row was failed — the clock for retirement, distinct from `ts`
   *  (queued) because a row can sit queued for a long time before it fails. */
  failedAt?: number;
  /**
   * A verdict for this ackId has arrived from the host's own sweep
   * (`delivery.settled` / `delivery.list`), so nobody is still asking.
   *
   * It is the difference between "the desktop could not read the screen back
   * seven seconds ago" and "the desktop has finished looking" — and until it is
   * true, an `unconfirmed`/`unsubmitted` row is NOT presented as something to
   * deal with (`sendConfirm.ts`). Without it the strip went red one echo window
   * after Send, while the host had four re-sends still to come.
   */
  hostSettled?: boolean;
  /** Slash/compose distinction, so a retry re-records it the same way. */
  kind?: "prompt" | "command";
  /**
   * What the entry DOES on delivery. Default `input` = type it into the live
   * session. `backlog` = add it as a work item for the repo (the compose bar's
   * "queue" modes), which used to be a bare socket write and was therefore lost
   * outright when the tunnel was down — the one send path that skipped this
   * queue. `op` = a durable ACTION (start a session here, fan out to these
   * repos, run this build): same problem, same fix. All three are acked and
   * de-duped by ackId host-side (`input.ack` / `backlog.ack` / `op.ack`).
   * `upload` = a file of any kind on its way to a repo inbox; the only mode that is NOT a
   * socket message (it is the HTTP POST `api.uploadInbox` makes) and the only
   * one whose payload is too big for localStorage, so its bytes live in
   * IndexedDB keyed by ackId. It is in this queue purely for ORDER: the prompt
   * that names `.claude/inbox/<file>` sits behind it in the same lane, so the
   * agent never reads a path whose file hasn't landed yet.
   */
  mode?: "input" | "backlog" | "op" | "upload";
  /**
   * op mode: the EXACT ClientMessage to put on the wire, its `ackId` already
   * filled in — so a re-send after a reload is byte-identical and the host's
   * ledger recognises it. Must stay JSON-safe (it round-trips through
   * localStorage) and small: an op payload is a handful of strings, never a
   * blob. `text` alongside it is the human-readable body for the queue UI.
   */
  op?: ClientMessage;
  /**
   * op mode: navigate to the session the host names in `op.ack`. Set only for
   * an op fired with the link UP — an op queued offline may be delivered
   * minutes later, and yanking the view then is an ambush, not a convenience
   * (same reasoning as the backlog "add & run now" path in App.tsx).
   */
  focus?: boolean;
  /**
   * "Send it when the agent is done." Parks the entry while its lane is mid-turn
   * instead of dropping it into the composer in the middle of an answer. Exact
   * only for a `hooked` session; otherwise the host's silence guess decides what
   * "busy" means. Scheduling lives in shared/queue.ts (`selectSendable`).
   */
  holdUntilIdle?: boolean;
  /**
   * Which screen this was composed over — `term` or `read`.
   *
   * Stamped at COMPOSE time, not at flush time, and that is the whole value of
   * it: the question it exists to answer is whether sends written over the
   * reader confirm at a different rate from sends written over the live grid,
   * and a queued entry may well leave the phone minutes later on a screen the
   * person has since switched away from. Rides to the host on `session.input`
   * and lands on the audit row; nothing on either side branches on it.
   */
  view?: SendView;
  /**
   * A prompt for a session that does not exist yet: it sits in the
   * `create:<cwd>` lane BEHIND a `session.create` op and is bound to the real
   * session id when `op.ack` names it (`bindPendingSession` in shared/queue.ts).
   *
   * Queuing a bare "open a CLI here" is close to useless — the work you meant
   * to queue is what should run once it is open — but offline there is no
   * session id a `session.input` could be addressed to. The first prompt
   * therefore rides inside the create op itself (`op.prompt`, typed host-side
   * by `deliverToNewSession`) and every further one waits here.
   *
   * Unsendable while the flag is set, and it holds its lane. Its fate follows
   * the create ahead of it: App fails these alongside a create that could not
   * be delivered, because a prompt whose session was never opened has nowhere
   * to go.
   */
  pendingCreate?: true;
  /**
   * The ackId of the `session.create` this parked prompt hangs off.
   *
   * The lane is `create:<cwd>` — per repo — and two Start sheets can be queued
   * for one repo before either has been delivered. This is what keeps each
   * chain with its own create when the acks land (see `bindPendingSession` and
   * `ownedPendingCreates` in shared/queue.ts).
   */
  createAck?: string;
  /**
   * upload mode: where the bytes are going and what path the queued prompt was
   * written against. `relPath` is PREDICTED (the client mints a collision-proof
   * name), because the text referencing the file has to exist before the upload
   * does. If the host still renames the file, App rewrites the queued text to
   * the path it actually got.
   */
  upload?: { repoId: string; name: string; relPath: string; size: number; type: string };
  /** backlog mode: item label, run-now flag, per-item auto-fire, target session. */
  label?: string;
  fire?: boolean;
  autoFire?: boolean;
  targetSessionId?: string;
  /**
   * backlog mode: the whole prompt CHAIN, `steps[0]` repeating `text`.
   *
   * A chain used to be queued as N items and run in order by the repo's own
   * queue. That stopped being right the day every item opened its own
   * conversation: step 2 would land in a session that had never seen step 1.
   * One item carrying the chain is what the host delivers a turn at a time —
   * and `text` still being turn one is what makes a desktop that has never
   * heard of this field run something correct rather than nothing.
   */
  steps?: string[];
  /** backlog mode: the session this item opens picks up the repo's last
   *  conversation (`claude --continue`) instead of starting clean. */
  resume?: boolean;
  /** backlog mode: the item's own *close its session when done* — absent
   *  follows the global setting, so it is never folded into `false`. */
  closeWhenDone?: boolean;
  /** backlog mode: "flag for follow up when done" — absent is off. */
  flagWhenDone?: boolean;
  /** backlog mode: the budget the session this item opens is born with. */
  budget?: SessionBudget;
  /** backlog mode: the model/effort/backend that session starts with. */
  launch?: LaunchOpts;
  /** backlog mode: let this row past the usage budget as it is added. */
  pastBudget?: boolean;
  /**
   * This entry is an ANSWER to a question the CLI was showing — a one-tap
   * approve-bar choice, a checkbox toggle, a Submit, an Esc — rather than text
   * to type. `text` holds the raw keystrokes ("2\r", "\x1b"); this holds what
   * they MEAN, and the identity of the box they were minted against.
   *
   * The whole reason answering works offline. Text queued for later is merely
   * stale when it lands; a keystroke queued for later is aimed at whatever box
   * happens to be up, which is a different thing entirely — "2" is "use the
   * existing branch" at the question you read and "delete it" at the next one.
   * So the fingerprint (`shared/promptid.ts`) rides along and the host refuses
   * to write the bytes unless that exact question is still live (`input.ack`
   * state "stale"). `question`/`label` are for the UI: the queue sheet and the
   * failure toast have to be able to say WHICH answer didn't land, and by the
   * time either is read the box is long gone from the screen.
   *
   * Never combined with `submit`: a dialog takes raw keystrokes, not the
   * type-echo-Return composer path deliver.ts runs for prose.
   *
   * `submitBox` marks the one answer that is an ACTION rather than a key: the
   * Submit row of a checkbox box. The Return only submits once the TUI's cursor
   * is on that row, and where the cursor is is knowable only host-side — see
   * `promptSubmit` on `session.input`.
   *
   * `choice` is the other one, for a box with NO NUMBERS (`DetectedPrompt.nav`):
   * there is no digit to send, so the entry names the option and the host walks
   * the selection onto it before pressing Return (`promptChoice`). `text` is ""
   * on such an entry — the queue sheet and the failure toast read `label`, which
   * every answer already carries, so nothing downstream needs the keystroke that
   * does not exist.
   *
   * `text` is a TYPED answer (contract 2.0): words for a `question` box with
   * `freeText`, or the reason on a `takesText` row — sent as `promptText`, checked
   * by `answerTextProblem` before it is queued and again by the host. Still an
   * answer, never a prompt: the host hands it to the CLI's own channel.
   */
  answer?: { fingerprint: string; question: string; label: string; submitBox?: boolean; choice?: number; text?: string };
  /**
   * Serialization group (`shared/queue.ts`). Set on a queued `session.create`
   * that CARRIES A PROMPT, so a repo's queued work runs one session at a time
   * instead of N agents starting together, spending one usage limit N times and
   * editing the same files. A bare "open a CLI here" is never serialized — it
   * runs nothing and edits nothing, and making an interactive tap wait for
   * another session to finish would be an obstruction, not a safeguard.
   *
   * Cleared by "send this one now": an explicit tap outranks the default.
   */
  serial?: string;
  /** Queued while there was no open socket — what the reconnect prompt counts. */
  offline?: boolean;
  /**
   * The user explicitly released this one (tapped Send with the link up, "Try
   * now", or "Send all" on the reconnect prompt). Persisted, so the intent
   * survives a reload: an armed entry goes out regardless of the auto-send
   * switch or a pending reconnect confirmation.
   */
  armed?: boolean;
}

/**
 * The only give-up bound left: how many times a delivery the host keeps
 * REFUSING may be re-attempted.
 *
 * `QUEUE_TTL_MS` used to sit beside it — thirty minutes, after which a queued
 * message was expired as "queued too long". That sentence is the one this whole
 * rework exists to delete. It is about a clock, and every failure it fired on
 * was about something else: a session that had exited, a repo that was busy, a
 * tunnel that was down. It shredded work somebody had spent an evening on and
 * then told them the reason was that they had waited.
 *
 * Deleting it is safe because at-most-once no longer rests on it. It rested on
 * the host's 45-minute ack ledger: an entry that outlived the ledger and then
 * retried was delivered twice, and the client's shorter clock was the guard.
 * The durable Intent store keys at-most-once on an id that lives as long as the
 * work does, so the guard is no longer a deadline.
 *
 * An attempt made with no socket open is rolled back by the caller, so riding
 * out an outage of any length still costs nothing. What this counts is a host
 * that answered and said no, over and over.
 */
export const MAX_SEND_ATTEMPTS = 8;

// ── Uploads that will never arrive ───────────────────────────────────
//
// A queue entry can be failed, discarded or evicted; the PATH it was going to
// land at does not disappear with it — it was copied into the compose draft (or
// a backlog item, or the clipboard) the moment the image was attached, and the
// draft outlives the queue. Sending that text later points the agent at a file
// nothing is uploading any more, and there is no entry left to notice.
//
// So the paths that died are remembered on their own: a bounded, per-device
// list consulted at send time. Bounded because it is only ever needed while the
// text that names one is still sitting in a box.
const DEAD_UPLOADS_KEY = LS.deadUploads;
const DEAD_UPLOADS_CAP = 40;

export function noteDeadUpload(relPath: string, reason: string): void {
  const all = read<{ p: string; r: string }[]>(DEAD_UPLOADS_KEY, []);
  write(DEAD_UPLOADS_KEY, [...all.filter((x) => x.p !== relPath), { p: relPath, r: reason }].slice(-DEAD_UPLOADS_CAP));
}

/** Why this inbox path is never going to exist, or null if nothing says so. */
export function deadUploadReason(text: string): { relPath: string; reason: string } | null {
  for (const x of read<{ p: string; r: string }[]>(DEAD_UPLOADS_KEY, [])) {
    if (text.includes(x.p)) return { relPath: x.p, reason: x.r };
  }
  return null;
}

/** The whole record, path → reason. `deadUploadReason` answers "may this text be
 *  sent"; the attachment check needs the set itself, one entry per file it is
 *  reporting on. */
export function deadUploads(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const x of read<{ p: string; r: string }[]>(DEAD_UPLOADS_KEY, [])) out[x.p] = x.r;
  return out;
}

/**
 * Forget that a path was ever dead.
 *
 * The mark exists to refuse a send that would point at nothing — so the moment
 * something IS uploading those bytes again (a re-attach), keeping it would refuse
 * a prompt that is now perfectly good. Called from the re-attach path only:
 * nothing else can make a dead path live.
 */
export function clearDeadUpload(relPath: string): void {
  const all = read<{ p: string; r: string }[]>(DEAD_UPLOADS_KEY, []);
  write(DEAD_UPLOADS_KEY, all.filter((x) => x.p !== relPath));
}

function read<T>(key: string, fallback: T): T {
  try {
    const v = lsGet(key);
    return v ? (JSON.parse(v) as T) : fallback;
  } catch {
    return fallback;
  }
}
function write(key: string, val: unknown): void {
  lsSetJson(key, val); // quota/private-mode — best effort, swallowed there
}

// ── Drafts (unsent, per session) ─────────────────────────────────────
export function loadDraft(sessionId: string): string {
  return read<Record<string, string>>(DRAFTS_KEY, {})[sessionId] ?? "";
}
export function saveDraft(sessionId: string, text: string): void {
  const all = read<Record<string, string>>(DRAFTS_KEY, {});
  if (text) all[sessionId] = text;
  else delete all[sessionId];
  write(DRAFTS_KEY, all);
}
/** Every session id carrying an unsent draft right now — the close sheet's
 *  "words at stake" facet, read once rather than `loadDraft` re-parsing the
 *  whole map once per session in the scope. */
export function draftSessionIds(): Set<string> {
  return new Set(Object.keys(read<Record<string, string>>(DRAFTS_KEY, {})));
}

// ── Outbox (sent, awaiting/failed ack) ───────────────────────────────
export function loadOutbox(): OutboxEntry[] {
  return read<OutboxEntry[]>(OUTBOX_KEY, []);
}
/**
 * Persist the whole array — ALL of it.
 *
 * This used to end in `.slice(-OUTBOX_CAP)`, which was safe only because
 * `addOutbox` guaranteed the array was already inside the cap: the slice was a
 * no-op that existed as a belt. It is not a belt now. Nothing retires a row, so
 * the array can legitimately be longer than the cap for a moment, and a slice
 * on the WRITE path drops the oldest entry with no status, no reason and
 * nothing on screen — which is the queue's one job failing quietly, and (with
 * the give-ups ledger gone) the only remaining way this app could delete words
 * somebody typed. Bounding is `addOutbox`'s, where it can say so.
 */
export function saveOutbox(list: OutboxEntry[]): void {
  write(OUTBOX_KEY, list);
}

// ── Prompt pad (untargeted drafts) ───────────────────────────────────
// A draft belongs to a session; a THOUGHT does not. Everything else here needs
// a target before you can even type it, which is the wrong order when the idea
// arrives on a train with no tunnel: you write it now and decide where it goes
// later. The pad never touches the socket — sending, filing it onto a repo's
// backlog and using it in a fan-out all route through the durable paths above,
// so the at-most-once contract is unchanged.
//
// The STORE is `shared/pad.ts`: one synced JSON array holding notes and the
// tombstones that make a delete travel, merged per note when a remote value is
// adopted. This file is the localStorage half and nothing more.

/** A note on the pad. The shape is `shared/pad.ts`'s; the alias is kept because
 *  a dozen import sites name it, and renaming them is not this change. */
export type PadDraft = PadNote;

/** The pad as stored — notes plus the deletes that still have to travel. */
export function loadPadDoc(): PadDoc {
  // `lsGet` swallows the private-mode throw and `parsePad` swallows every bad
  // shape, so there is no third way for this to fail.
  return parsePad(lsGet(PAD_KEY));
}

/**
 * Persist a whole doc, canonically. `false` = the store refused it.
 *
 * Raw, not through `write`: the value IS a string already, and re-encoding it
 * would put a JSON document inside a JSON string. Canonical because two devices
 * holding the same notes have to produce the same bytes — see `serializePad`.
 *
 * Raw rather than `lsSet`, too, and that one is deliberate in the other
 * direction: `lsSet` swallows the quota throw, and swallowing it here is the
 * whole bug this return value exists to stop. `false` is what makes `addPadNote`
 * refuse in words with the editor still holding the text, and what makes the
 * rescue migration retry on the next boot instead of marking itself done over
 * notes it never wrote.
 */
export function writePadDoc(doc: PadDoc): boolean {
  // eslint-disable-next-line no-restricted-properties -- this write must be able to THROW; `lsSet` swallows the quota error, which is the one thing this function may not do (see above)
  try { localStorage.setItem(PAD_KEY, serializePad(doc)); } catch { return false; }
  // Tell whoever is rendering the pad. A local write is not announced by the
  // settings patch (see `announceSetting`), and this store has several writers.
  announceSetting(PAD_KEY);
  return true;
}

/** The notes, newest first. */
export function loadPad(): PadDraft[] {
  return loadPadDoc().notes;
}

/**
 * Add a note — or REFUSE, in words, and change nothing.
 *
 * This used to shed the oldest notes to make room and report the loss
 * afterwards, which deleted words for being old; a note is old exactly when
 * nobody has dealt with it yet. Refusing is better in every case that matters,
 * because the caller here is an editor: the words are still in its persisted
 * buffer, on screen, and the person who wrote them decides what goes.
 *
 * Returns the REASON when it refused (a sentence from `shared/pad.ts`), or
 * `null` when the note landed.
 */
export function addPadNote(note: PadNote): string | null {
  const doc = loadPadDoc();
  const full = () => padFullText(doc.notes.length, Math.round(serializePad(doc).length / 1024));
  if (!doc.notes.some((n) => n.id === note.id) && doc.notes.length >= PAD_CAP) return full();
  const next = upsertNote(doc, note);
  if (serializePad(next).length > PAD_BYTES) return full();
  return writePadDoc(next) ? null : PAD_WRITE_REFUSED;
}

/** Rewrite an existing note. The count cannot move, so only the bytes are
 *  checked — an edit that shrinks a note must never be refused for a cap it is
 *  not pushing against. */
export function updatePadNote(note: PadNote): string | null {
  const doc = loadPadDoc();
  const next = upsertNote(doc, note);
  if (serializePad(next).length > PAD_BYTES) return padFullText(doc.notes.length, Math.round(serializePad(doc).length / 1024));
  return writePadDoc(next) ? null : PAD_WRITE_REFUSED;
}

/**
 * Delete notes — the ONE removal path, and every caller uses it.
 *
 * `removeNotes` writes a tombstone as well as dropping the note, and that
 * tombstone is the whole point: without it the other device still holds the
 * note, unions it back in at the next merge, and a note dispatched from this
 * phone is sent a second time from the desktop. It is the one place this
 * merge could produce a duplicate delivery, so PadSheet's trash, "emptied =
 * deleted", App's `retireSendSource`, the Send sheet's discard and *file it*
 * all come through here.
 */
export function removePadNotes(ids: readonly string[]): void {
  if (!ids.length) return;
  writePadDoc(removeNotes(loadPadDoc(), ids, Date.now()));
}

/**
 * WHERE `retireToPad` USED TO BE.
 *
 * It moved the text of a dead queue row onto the pad on a CLOCK, an hour after
 * the row failed — so a phone off the tunnel for a day came back to find its
 * prompts already shredded into a list nobody had asked for. A failed row keeps
 * its own row, its full words and its `cwd`, for as long as it takes, and
 * Activity is where it is triaged. The pad is a place to write things, not a
 * graveyard.
 *
 * The device-local rescue list that guarded the pad against its own sync is
 * gone with it (`waterplane.padRescue`, retired and read once by `migratePadRescue`).
 * What replaced it is the merge itself: `shared/pad.ts` reconciles per note and
 * a delete travels as a tombstone, so there is nothing left for a rescue list
 * to catch.
 */

// A remote pad value is about to replace this device's copy: MERGE the two and
// write that instead. Registered at module load — `App` imports this file
// before a socket exists, so no merge can land ahead of it.
onAdopt(PAD_KEY, (incoming, current) => adoptPad(incoming, current, Date.now()).value);

/**
 * May this queued entry's text be rewritten in the queue sheet?
 *
 * Text entries and work items: always. An OP is a payload, not prose — a
 * `build.run` names a saved command by id, so "tap to rewrite" there could only
 * corrupt it. A fan-out run or follow-up IS carried by its text, and so is a
 * `session.create` that carries a first prompt: what a queued open is FOR is
 * the prompt that runs once the CLI is up, and a queue you cannot put that
 * prompt into (or fix, once the link has been down for twenty minutes) is a
 * queue holding an empty terminal. The caller rewrites the payload field
 * alongside `text` — `op.text` for a fan-out, `op.prompt` for a create.
 */
export function isEditableEntry(e: OutboxEntry): boolean {
  if (e.status !== "queued") return false;
  // An upload is bytes, not prose: its `text` is a label ("file · shot.jpg").
  if (e.mode === "upload") return false;
  // An answer is a KEYSTROKE ("2\r", "\x1b") bound to one question box by
  // fingerprint. There is nothing to edit — the meaning is the option that was
  // tapped, not the character — and a hand-typed replacement would be delivered
  // against a fingerprint it no longer matches. Change your mind by discarding
  // it and tapping another option.
  if (e.answer) return false;
  if (e.mode !== "op") return true;
  const t = e.op?.t;
  return t === "fanout.run" || t === "fanout.followup" || t === "session.create";
}

/** Is this the op that OPENS a session? Its lane (`create:<cwd>`) is where the
 *  prompts meant to run afterwards queue up, so the queue UI needs to tell it
 *  apart from a fan-out or a build. */
export function isCreateOp(e: OutboxEntry): boolean {
  return e.mode === "op" && e.op?.t === "session.create";
}

/**
 * Would running this entry start WORK in a repo — i.e. is it a candidate for
 * "one at a time in this repo"?
 *
 * A create that carries a first prompt, and nothing else. A bare open is an
 * empty terminal (no tokens, no edits); a fan-out is parallel across repos by
 * definition and has its own concurrency cap host-side; a build runs no agent;
 * ordinary text is already serialized by the lane rule of the session it names.
 */
export function isSerializable(e: OutboxEntry): boolean {
  return isCreateOp(e) && !!(e.op as { prompt?: string } | undefined)?.prompt && !!e.cwd;
}

/** Random id that works in a NON-secure context (plain http over Tailscale) —
 *  crypto.randomUUID is unavailable there, but getRandomValues is not. */
export function newAckId(): string {
  try {
    const a = new Uint8Array(8);
    crypto.getRandomValues(a);
    return Array.from(a, (b) => b.toString(16).padStart(2, "0")).join("");
  } catch {
    return `${Date.now().toString(36)}-${Math.floor(Math.random() * 1e9).toString(36)}`;
  }
}

/** The repo-relative dir every phone upload lands in (mirrors host files.ts). */
export const INBOX_REL = ".claude/inbox";

/**
 * Mint the name an uploaded file will be stored under, and the path a prompt may
 * reference right now — BEFORE the bytes have gone anywhere.
 *
 * An offline attach has to write "look at .claude/inbox/x.jpg" into a prompt it
 * queues in the same breath, so the path cannot wait for the upload's answer.
 * The host uniquifies names (`ensureUnique`), so a predicted path is only
 * trustworthy if a collision is effectively impossible: stem + timestamp +
 * random suffix. If it collides anyway, the upload's real `relPath` comes back
 * and App rewrites whatever queued text referenced the prediction.
 */
export function plannedInboxPath(filename: string): { name: string; relPath: string } {
  const dot = filename.lastIndexOf(".");
  const ext = dot > 0 ? filename.slice(dot) : "";
  const stem = (dot > 0 ? filename.slice(0, dot) : filename).replace(/[/\\\s]+/g, "_").slice(0, 40) || "file";
  const name = `${stem}-${Date.now().toString(36)}${newAckId().slice(0, 6)}${ext}`;
  return { name, relPath: `${INBOX_REL}/${name}` };
}

// ── Sheet drafts (text typed in a sheet that has no session yet) ─────
// The compose bar persists every keystroke per session; the sheets that write
// text BEFORE a target exists (the prompt pad's editor, "start a session with
// this prompt") kept theirs in React state only. On a phone that is not a
// theoretical gap: the tab is killed when backgrounded, and the reconnect
// watchdog can reload the page mid-sentence — either way a paragraph typed on a
// train was gone with no trace. Same store as the compose drafts, same
// `waterplane.compose` prefix, so BootGuard's hard reset preserves it too.
const SHEET_KEY = LS.composeSheets;
const SHEET_CAP = 20;

export function loadSheetDraft(key: string): string {
  return read<Record<string, string>>(SHEET_KEY, {})[key] ?? "";
}
/** A fresh pad note's id. Not an ackId — nothing is SENT when a note is kept —
 *  but drawn from the same generator so ids never collide; one helper, so a
 *  keep-on-pad site does not look like a second place a message is minted. */
export function padNoteId(): string {
  return newAckId();
}
/**
 * Seed a draft with words the USER did not type — and never destroy the ones
 * they did.
 *
 * A sheet that composes for a target it was handed (`openSend`) writes its seed
 * into the draft before it mounts, which is an overwrite of whatever was in
 * there. That is right in the ordinary case (the slot holds the last send,
 * already posted) and catastrophic in the one that matters: a draft is left
 * behind whenever anything breaks the single route back to the sheet that wrote
 * it — a routing bug, a reload, an OTA bundle swap, a killed tab — and this
 * store has no listing of its own, so those words exist and nothing on the
 * phone can reach them. The next open then deleted them silently.
 *
 * So a non-empty draft that is not already the seed becomes a PAD NOTE first —
 * the pad being the one store for words with no target yet that has a listing
 * of its own. Returns which of the three things happened, so the caller can SAY
 * so; a silent rescue is a file nobody looks in.
 *
 * `"refused"` is the case worth stating: the pad would not take the note (it is
 * at its cap, or this browser refused the write), so the draft is LEFT ALONE.
 * Seeding anyway would be `local/no-draft-clobber` applied on the one path where
 * the rescue itself can fail — a rescue that did not happen must not also be a
 * delete. The caller opens its sheet on the existing draft and says why.
 */
export function seedSheetDraft(key: string, text: string, cwd?: string | null): "seeded" | "kept" | "refused" {
  const keep = draftToRescue(loadSheetDraft(key), text);
  if (!keep) { saveSheetDraft(key, text); return "seeded"; }
  const refused = addPadNote({ id: padNoteId(), ts: Date.now(), ...keep, ...(cwd ? { cwd } : {}) });
  if (refused) return "refused";
  saveSheetDraft(key, text);
  return "kept";
}
/**
 * Append to a draft's FIRST step, leaving the rest of the chain alone.
 *
 * \f separates the chain, so a second or third step written before an image was
 * attached has to survive the round trip through the annotator. It lives beside
 * the store that defines that separator rather than at the two call sites that
 * used to each re-split it.
 */
export function appendSheetDraft(key: string, ref: string): void {
  const parts = loadSheetDraft(key).split("\f");
  const head = parts[0] ?? "";
  parts[0] = head ? `${head}${/\s$/.test(head) ? "" : " "}${ref}` : ref;
  saveSheetDraft(key, parts.join("\f"));
}
/** Throw a draft away — the user saying so, which is the only safe way to lose
 *  one. Distinct from `seedSheetDraft` on purpose: this one does not rescue. */
export function clearSheetDraft(key: string): void {
  saveSheetDraft(key, "");
}
export function saveSheetDraft(key: string, text: string): void {
  const all = read<Record<string, string>>(SHEET_KEY, {});
  if (text) all[key] = text;
  else delete all[key];
  // Bound it: a repo-keyed draft per repo would otherwise grow without limit.
  const keys = Object.keys(all);
  if (keys.length > SHEET_CAP) for (const k of keys.slice(0, keys.length - SHEET_CAP)) delete all[k];
  write(SHEET_KEY, all);
}
