/**
 * The host settles its own open questions, with nobody watching.
 *
 * `settle.ts` could always answer "what became of that delivery?" — it just had
 * to be ASKED, by a phone, over a live socket, at most three times, from a
 * browser tab that reloads on the worst link and whose queue rows retire after
 * an hour. So on a good day the machinery worked and on a bad day — which is
 * the day the question gets asked — nothing ever revisited the row. That is how
 * one device accumulated 67 prompts filed as "reached a session but could not
 * be confirmed as running", several of them running at that moment.
 *
 * So the question is written down HERE, on the machine that holds the evidence,
 * and re-asked until it has an answer:
 *
 *  - Nothing is armed with a timer. A tick re-asks `settleDelivery()`, exactly
 *    as `schedule.ts` and `launch.ts` re-ask their pure rules, so a restart, a
 *    laptop sleep or a clock jump cannot mis-fire or lose one.
 *  - Persisted tmp+rename. `npm run restart` is the documented way to pick up a
 *    change in this project, and a question a restart forgets is the original
 *    bug with a longer fuse.
 *  - The FULL text is kept. It is what makes the row actionable rather than
 *    merely informative — an `absent` verdict is re-delivered from this copy —
 *    and the complaint this whole thing answers is words that went missing.
 *  - `absent` is re-sent exactly ONCE, and the fact that it was is written to
 *    disk BEFORE the delivery starts. A crash between the two must leave
 *    evidence, never an invitation to send a second copy: the entire reason
 *    `unconfirmed` was un-retryable in the first place is that retrying what may
 *    already be there is how one prompt ended up stacked five times.
 *
 * `composer` and `unknown` are never re-sent, and that is the whole discipline
 * of this file. `composer` means the text is sitting in that session one
 * keypress from running — sending it again puts a second copy under the first.
 * `unknown` means we cannot see, and an action taken on "cannot see" is a
 * guess. Only `absent` — a READABLE conversation log that does not contain the
 * prompt, plus a screen that does not either — is a proof of a negative, and it
 * is the only verdict that authorises anything.
 */
import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";
import { basename, join } from "node:path";
import type { OpenDelivery, SentSource } from "@waterplane/shared";
import type { SessionManager } from "./sessions.js";
import { HOST_SLACK_MS, settleDelivery, spendTurn } from "./settle.js";
import { recordSettled } from "./sentlog.js";
import { env } from "./env.js";
import { hostStateDir } from "./branddirs.js";
import { readJsonGuarded, writeJsonAtomic } from "./jsonstore.js";

/** What a delivery attempt answered — mirrors `deliver.ts`'s `DeliveryResult`,
 *  declared structurally so this module does not import the delivery path it is
 *  imported BY. */
export type Redelivered = "ok" | "retry" | "unconfirmed" | "unsubmitted";

/**
 * The base of the back-off, and the tick that drives it.
 *
 * 5 s for the first re-ask, because the CLI writes its user turn when it
 * ACCEPTS a prompt: the overwhelming majority of these are answerable
 * immediately, and `deliver.ts` has already spent its own 2.5-second poll
 * looking. This first sweep is for the cases that need a moment more — a
 * conversation id detected late, a log file created on the first turn, a screen
 * that has finished repainting by now.
 *
 * Then doubling. A row that is still open after the first ask is one where
 * nothing is going to change in the next five seconds — a session mid-turn, a
 * log that does not exist yet — and every ask parses a transcript that can be
 * megabytes. Doubling gets four asks into the first minute (where the answer
 * usually is) and then stops being a poller.
 */
const BASE_MS = Math.max(200, Number(env("SETTLE_BASE_MS") || 5_000));
/** Ceiling on the back-off: past three minutes a re-ask is a background chore. */
const MAX_GAP_MS = Math.max(BASE_MS, Number(env("SETTLE_MAX_GAP_MS") || 180_000));
/**
 * How long the host keeps asking before settling for `unknown`.
 *
 * 15 minutes. A row that is still open then is not waiting on a slow answer, it
 * is waiting on evidence that does not exist: a session whose conversation log
 * was never written (an old tmux session the daemon adopted, a `claude` that
 * died before its first turn), or one whose screen cannot be read. More sweeps
 * cannot produce a log. `unknown` is the honest end of that — it says "still
 * cannot see", which is a different sentence from "never ran", and it is the
 * one verdict this file will not act on.
 */
const GIVE_UP_MS = Math.max(BASE_MS * 4, Number(env("SETTLE_GIVEUP_MS") || 15 * 60_000));
/**
 * …and how long for a SLASH COMMAND, which the log can never report.
 *
 * The CLI writes a slash command as an envelope the transcript reader drops, so
 * for one of those the conversation log is silent whether it ran or not (see
 * `echo.ts`'s `isSlashText`). That leaves the live screen as the only witness,
 * and a screen answers now or never — the view a command opened is either up or
 * gone. Sweeping one of these for fifteen minutes buys nothing and ends in a
 * quarter-hour-late push about a `/cost`.
 */
const SLASH_GIVE_UP_MS = Math.min(GIVE_UP_MS, BASE_MS * 4);
/**
 * …and how long for a prompt the CLI is HOLDING in its own queue (`settle.ts`'s
 * `held`). That row is not short of evidence: the log says the CLI took it and
 * will run it when the turn in front of it pauses or ends — which can be a long
 * build later. So it is asked past `GIVE_UP_MS`, until the log shows the turn,
 * for up to two hours.
 */
const HELD_GIVE_UP_MS = Math.max(GIVE_UP_MS, 2 * 60 * 60_000);
/**
 * How many times the host will type a provably-absent prompt again.
 *
 * One was too few, and the complaint was about the WORDING before it was about
 * the count: a send went red inside fifteen seconds saying nothing ran and
 * nobody would try again, which reads as fatal for what is usually a session
 * that was busy for another moment. Each re-send is authorised by a FRESH
 * `absent` verdict — the CLI's own log is readable and does not contain the
 * prompt, and the live screen does not either, so there is no copy for this one
 * to stack on — so the argument that made one send safe makes the third safe on
 * exactly the same terms. What bounds it is not that argument but this number:
 * four attempts over the doubling gap below keep the host trying for the first
 * minute or so, which is where the answer nearly always is, and then it is a
 * person's turn.
 */
const RESEND_TRIES = Math.max(1, Number(env("RESEND_TRIES") || 4));
/** Rows kept. Small records; the cap exists so a pathological week cannot grow
 *  a file without bound. Resolved rows are evicted first — never an open one. */
const LIMIT = 200;
/** Head of the text kept as a row label. */
const HEAD_CAP = 120;

/** What `deliver.ts` hands over when a verdict comes back unconfirmable. */
export interface AmbiguousDelivery {
  sessionId: string;
  text: string;
  result: "unconfirmed" | "unsubmitted";
  startedAt: number;
  ackId?: string;
  source: SentSource;
  kind: "prompt" | "command";
  /** The audit row `deliver.ts` already wrote for this attempt, so a verdict
   *  settled minutes later can be written back onto it rather than leaving the
   *  sent log permanently over-counting failures. */
  sentId?: string;
}

/**
 * Deliveries being typed RIGHT NOW, and the other texts that could be in a
 * session's composer.
 *
 * The screen half of every verdict in this app is a fourteen-character prefix
 * match, which says "text starting like this is here" and not "your text is
 * here". Whether that difference matters is a question about the OTHER
 * candidates: with no rival, a prefix hit is as good as an identification; with
 * a rival that starts the same way, it is not evidence at all
 * (`echo.ts`'s `echoAmbiguous`).
 *
 * Two populations qualify as rivals, and this module is where both are known:
 * the open questions (a prompt whose delivery could not be confirmed may well
 * be sitting in that composer — that is what `composer` MEANS) and the
 * deliveries in flight (two features can type into one session at once). The
 * in-flight half is module state rather than a field on the store because it
 * outlives no restart and belongs to no row: it is a fact about this instant.
 *
 * `key` is the same stable name the spent-turn ledger uses — the ackId when
 * there is one — so a delivery is never its own rival.
 */
const inFlight = new Map<string, { sessionId: string; text: string }>();

export function noteDeliveryStarted(key: string, sessionId: string, text: string): void {
  if (key) inFlight.set(key, { sessionId, text });
}

export function noteDeliveryEnded(key: string): void {
  if (key) inFlight.delete(key);
}

/**
 * The other texts that could be in this session's composer, minus the caller's
 * own.
 *
 * Never a claim that the list is complete — a person typing at the keyboard is
 * a rival this can never see. It only ever turns a confident answer into "I
 * cannot tell", so an incomplete list degrades to exactly the behaviour that
 * was here before it existed.
 */
export function rivalTexts(sessionId: string, exceptKey?: string): string[] {
  const out: string[] = [];
  for (const [key, d] of inFlight) {
    if (d.sessionId !== sessionId || key === exceptKey) continue;
    out.push(d.text);
  }
  for (const q of current?.open() ?? []) {
    if (q.sessionId !== sessionId) continue;
    if ((q.ackId ?? q.id) === exceptKey) continue;
    out.push(q.text);
  }
  return out;
}

/**
 * Type the text again. Injected, so this module never imports `deliver.ts` —
 * it owns WHEN and WHY, `main.ts` owns WHAT, exactly as `launch.ts` does with
 * its opener. (It is also what breaks the import cycle: `deliver.ts` registers
 * questions here.)
 */
export type Redeliverer = (q: OpenDelivery) => Promise<Redelivered>;

export class OpenDeliveries extends EventEmitter {
  private entries: OpenDelivery[] = [];
  private path: string;
  private timer: NodeJS.Timeout | null = null;
  /** Rows whose settle or re-delivery is in flight, so a tick cannot re-enter
   *  one. The persisted `resentAt` covers restarts; this covers overlap. */
  private busy = new Set<string>();

  constructor(
    private root: string,
    private sessions: SessionManager,
    private redeliver: Redeliverer,
    private onChange: () => void,
  ) {
    super();
    this.path = join(hostStateDir(root), "deliveries.json");
    try {
      if (existsSync(this.path)) {
        const arr = readJsonGuarded<any>(this.path, null);
        if (Array.isArray(arr)) {
          const now = Date.now();
          this.entries = arr.filter((e: any) => e && typeof e.id === "string" && typeof e.text === "string")
            .map((e: OpenDelivery) => e.verdict !== "open" ? e : {
              ...e,
              // Ask again promptly after a restart rather than honouring a
              // back-off measured against a clock that has since jumped. The
              // ask is read-only; the only thing it can cost is a transcript
              // parse.
              nextAskAt: now + BASE_MS,
            })
            .slice(-LIMIT);
          // Evidence already spent, put back where the matcher can see it. The
          // ledger is in-memory, and these rows are precisely the long-lived
          // questions — a restart that forgot which turn proved which row would
          // let a second delivery of the same words inherit the first one's
          // proof, which is the collision the ledger exists to stop.
          for (const e of this.entries) if (e.turnId) spendTurn(e.turnId, e.ackId ?? e.id);
        }
      }
    } catch { /* corrupt or missing → start empty, exactly like a fresh host */ }
  }

  /** Newest first — the order every list in this app is read in. */
  list(): OpenDelivery[] {
    return [...this.entries].sort((a, b) => b.startedAt - a.startedAt);
  }

  /** Still being asked about. What a badge would count. */
  open(): OpenDelivery[] {
    return this.entries.filter((e) => e.verdict === "open");
  }

  start(): void {
    if (this.timer) return;
    // The tick only compares clocks; the work is per-row and gated on
    // `nextAskAt`, so a short interval costs nothing and keeps the first ask
    // close to the 5 s it is meant to be.
    this.timer = setInterval(() => void this.tick(), Math.max(250, Math.min(BASE_MS, 2500)));
    if (typeof this.timer.unref === "function") this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /**
   * Write down a delivery whose verdict was unconfirmable.
   *
   * Idempotent on the ackId when there is one: a client retry that races the
   * first delivery is joined upstream (`inputsInFlight`), but a re-send after
   * the ledger's TTL is a second delivery of the same row, and two open
   * questions about one prompt would mean two re-sends of it.
   */
  add(rec: AmbiguousDelivery): OpenDelivery | null {
    if (!rec.text.trim()) return null;
    if (rec.ackId) {
      const twin = this.entries.find((e) => e.ackId === rec.ackId && e.verdict === "open");
      if (twin) return twin;
    }
    const info = this.sessions.get(rec.sessionId);
    const cwd = info?.cwd ?? "";
    const now = Date.now();
    const q: OpenDelivery = {
      id: `dq_${now.toString(36)}_${randomUUID().slice(0, 6)}`,
      ackId: rec.ackId,
      sentId: rec.sentId,
      sessionId: rec.sessionId,
      sessionTitle: info?.title ?? rec.sessionId,
      cwd,
      repoName: cwd ? basename(cwd) : "",
      text: rec.text,
      head: rec.text.trim().split("\n")[0].slice(0, HEAD_CAP),
      kind: rec.kind,
      source: rec.source,
      reported: rec.result,
      startedAt: rec.startedAt,
      verdict: "open",
      asks: 0,
      nextAskAt: now + BASE_MS,
      // `kind` is the same first-token test `echo.ts` calls `isSlashText`, and
      // it decides how long there is any point in asking.
      deadlineAt: now + (rec.kind === "command" ? SLASH_GIVE_UP_MS : GIVE_UP_MS),
    };
    this.evict();
    this.entries.push(q);
    this.persist();
    this.onChange();
    return q;
  }

  /**
   * A client is asking about this ackId — who owns what happens next?
   *
   * Both sides can re-send a prompt proved absent, and both doing it is the one
   * outcome neither is allowed to produce. Timing cannot separate them (each
   * would have to guess what the other is about to do), so OWNERSHIP does, and
   * the rule is the same one that justifies this whole file: **the host acts
   * for rows nobody is watching.** A phone that sends `input.settle` has proved
   * by asking that it is awake and still holding the row, so it keeps its own
   * re-send and the host stands down — still recording every verdict, because
   * the row is also what a notification and a reconnect are built from.
   *
   *   "yours" — answer honestly; the client acts.
   *   "mine"  — the host has ALREADY re-sent this one. The client must not act
   *             on any verdict about it: whatever it does now is a second copy
   *             of a prompt already on its way.
   */
  claim(ackId: string): "yours" | "mine" {
    const q = this.entries.find((e) => e.ackId === ackId);
    if (!q) return "yours";
    if (q.resentAt) return "mine";
    if (!q.clientOwned) {
      q.clientOwned = true;
      this.persist();
      this.onChange();
    }
    return "yours";
  }

  /** Drop the oldest RESOLVED row to make space. Never an open one: that is a
   *  question somebody is still owed an answer to. */
  private evict(): void {
    while (this.entries.length >= LIMIT) {
      const victim = this.entries.find((e) => e.verdict !== "open");
      if (!victim) return;                       // all open — grow rather than forget
      this.entries = this.entries.filter((e) => e !== victim);
    }
  }

  private async tick(): Promise<void> {
    const now = Date.now();
    for (const q of [...this.entries]) {
      if (q.verdict !== "open" || this.busy.has(q.id) || now < q.nextAskAt) continue;
      this.busy.add(q.id);
      try { await this.ask(q, now); }
      catch { /* a settle that threw is one unanswered ask, not a dead sweep */ }
      finally { this.busy.delete(q.id); }
    }
  }

  /** One re-ask, and whatever it authorises. */
  private async ask(q: OpenDelivery, now: number): Promise<void> {
    // The floor is the delivery's own start, on this host's clock — the same
    // clock that stamps the log, so the window can be tight (`HOST_SLACK_MS`),
    // and an identical prompt fired at this session this morning can never
    // stand in as proof about this one.
    // `claimer` and `others` are the two halves of "answer about THIS row, or
    // do not answer". The key is stable across every re-ask of this row (the
    // ackId when it has one — the same name the phone's own `input.settle`
    // uses), so a row keeps its own proof for as long as it is asked; the
    // rivals are every other prompt that could be in that composer, which is
    // what stops one prompt's echo from settling another's row.
    const key = q.ackId ?? q.id;
    const res = await settleDelivery(this.sessions, q.sessionId, q.text, q.startedAt,
      { slackMs: HOST_SLACK_MS, claimer: key, others: rivalTexts(q.sessionId, key) });
    q.asks++;
    q.alive = res.alive;

    if (res.verdict === "landed") {
      // Written down BEFORE the row is finished: the turn is this row's
      // evidence from now on, and it survives the restart that empties the
      // in-memory ledger.
      q.turnId = res.turnId;
      this.finish(q, "landed", "the conversation log has it — it ran");
      return;
    }
    if (res.verdict === "composer") {
      this.finish(q, "composer", "it is sitting in that session's composer, unsent — press Return there, never retype it");
      return;
    }
    if (res.verdict === "absent") {
      await this.onAbsent(q, res.alive);
      return;
    }
    if (res.held) {
      // Taken by the CLI, not yet run. The one move that is never right here is
      // a second copy, so every ending says so.
      if (!res.alive) {
        this.finish(q, "unknown", "claude had it queued when that session ended — open the conversation to see whether it ran before sending it again");
        return;
      }
      if (now - q.startedAt >= HELD_GIVE_UP_MS) {
        this.finish(q, "unknown", "claude still has it queued behind the running turn — it runs when claude takes it; do not send it again");
        return;
      }
      q.nextAskAt = now + Math.min(MAX_GAP_MS, BASE_MS * 2 ** Math.min(q.asks, 20));
      this.persist();
      this.onChange();
      return;
    }

    // `unknown` on a session that is GONE. Nothing more is coming: a dead PTY
    // has no screen, and a conversation log that could not be resolved while
    // the session existed will not resolve now — the id is retired, and a
    // limit-exit resurrection comes back as a NEW one. Waiting out the deadline
    // would only mean saying the same thing fifteen minutes later.
    if (!res.alive) {
      this.finish(q, "unknown", "that session is gone and left no readable conversation log — nothing can say whether this ran");
      return;
    }
    // `unknown`. Ask again later — unless later has run out, in which case say
    // so honestly rather than promoting a blind spot to a fact.
    if (now >= q.deadlineAt) {
      this.finish(q, "unknown", q.reported === "unsubmitted"
        ? "the host could not read that session's conversation log or its screen — check its composer before sending it again"
        : "the host could not read that session's conversation log or its screen — check it before sending it again");
      return;
    }
    q.nextAskAt = now + Math.min(MAX_GAP_MS, BASE_MS * 2 ** Math.min(q.asks, 20));
    this.persist();
    this.onChange();
  }

  /**
   * Provably never ran. Send it again — up to `RESEND_TRIES` times.
   *
   * This is the one verdict that makes another send safe, and the argument is
   * narrow enough to be worth restating: the CLI's own log is readable and does
   * not contain the prompt, and the live screen does not either, so nothing is
   * running it and nothing is holding it in a composer. There is no copy for
   * the next one to stack on.
   *
   * That argument is per-verdict, not per-row, which is why the count is a
   * budget rather than a boolean: every attempt here is preceded by its own
   * fresh `absent`, so the third is as provably safe as the first was. The
   * budget exists because a row that has been proved absent four times is not
   * waiting on another five seconds — something about that session is wrong in
   * a way typing cannot fix, and the honest end of that is a sentence a person
   * reads, not a fifth attempt.
   *
   * The re-send is not gated on the usage budget. That gate exists to stop the
   * host STARTING work nobody asked for while a window is nearly spent; this is
   * finishing work a person explicitly sent and was told had been accepted.
   */
  private async onAbsent(q: OpenDelivery, alive: boolean): Promise<void> {
    const tried = q.resends ?? (q.resentAt ? 1 : 0);
    if (tried >= RESEND_TRIES) {
      // Out of budget. Said as what it is — the words are still here and the
      // session is still there — rather than as a failure with no next move,
      // which is how one attempt and a full stop used to read.
      this.finish(q, "absent", q.resentResult === "retry"
        ? `nothing ran, and the session never became ready for the host's re-send (${tried} ${tried === 1 ? "try" : "tries"})`
        : `nothing ran — the host typed it again ${tried} ${tried === 1 ? "time" : "times"} and could not confirm any of them. The words are kept: open the session to look, or send a fresh copy`);
      return;
    }
    if (q.clientOwned) {
      // A phone asked about this row, so the re-send is its move. Record the
      // verdict — the row still says truthfully that nothing ran — and act on
      // nothing.
      this.finish(q, "absent", "nothing ran — the phone was told, and owns the re-send");
      return;
    }
    if (!alive) {
      this.finish(q, "absent", "nothing ran, and that session is gone — send it somewhere else");
      return;
    }
    const info = this.sessions.get(q.sessionId);
    if (info && info.remoteControl === false) {
      // The session's own switch says this app may not type into it. It is off
      // for a reason and a recovery path is not an exception to it.
      this.finish(q, "absent", "nothing ran, and remote control is off for that session");
      return;
    }
    // Written BEFORE the delivery, and persisted synchronously: a crash between
    // the two must leave a row that says "the host tried" rather than one that
    // invites a copy the budget has not paid for.
    q.resentAt = Date.now();
    q.resends = tried + 1;
    this.persist();
    this.onChange();

    let res: Redelivered;
    try { res = await this.redeliver(q); }
    catch { res = "retry"; }
    q.resentResult = res;

    if (res === "ok") {
      this.finish(q, "landed", "nothing had run, so the host sent it again — it is running now");
      return;
    }
    if (res === "retry") {
      // Provably nothing typed, so nothing changed and nothing is stacked — and
      // unlike an unconfirmable re-send there is no new evidence to wait for.
      // "The session never became ready" is a state, not a race: another
      // attempt in five seconds is a poller with a nice name, so the row is
      // answered here whatever the budget still holds.
      this.finish(q, "absent", "nothing ran, and the session never became ready for the host's re-send");
      return;
    }
    // The re-send is itself unconfirmable — the same four-second window, one
    // layer down. Re-open the SAME row (never a second one) so the log gets a
    // chance to settle it; the try budget is what stops that becoming endless.
    //
    // The gap before the next ask widens with the attempts. The first re-ask is
    // for a log written a moment late; by the third, five seconds has already
    // failed twice for this exact row and asking again that fast only spends
    // transcript parses. Doubling from the base keeps all four attempts inside
    // the first minute or so, which is the window the complaint was about — a
    // send must not read as lost while the host is still working on it.
    const now = Date.now();
    q.reported = res;
    q.startedAt = q.resentAt;
    q.asks = 0;
    q.nextAskAt = now + Math.min(MAX_GAP_MS, BASE_MS * 2 ** Math.min(q.resends - 1, 20));
    q.deadlineAt = now + GIVE_UP_MS;
    this.persist();
    this.onChange();
  }

  /**
   * The row is answered — and so, at last, is the audit trail.
   *
   * `sentlog.ts` is written from inside the delivery, which means it is written
   * at the one moment the answer is not yet known: an `unconfirmed` row there
   * is a four-second echo window's opinion, and until now nothing ever went
   * back to correct it. That log is what anyone reads as "what happened to my
   * deliveries" — it is the file the measurement behind this whole rework was
   * taken from — so leaving it un-corrected makes it permanently over-count
   * failures, and does so in the one place someone goes looking for the truth.
   *
   * The reported verdict is KEPT beside the settled one rather than
   * overwritten. "Reported unconfirmed, settled landed" is a more useful
   * sentence than either half alone: the first says what the confirmation
   * machinery could see at the time, the second says what was actually true,
   * and the gap between them is the signal this app is supposed to be watching.
   */
  private finish(q: OpenDelivery, verdict: OpenDelivery["verdict"], reason: string): void {
    q.verdict = verdict;
    q.reason = reason;
    q.resolvedAt = Date.now();
    if (q.sentId && verdict !== "open") recordSettled(q.sentId, verdict, reason);
    this.persist();
    this.onChange();
    this.emit("settled", q);
  }

  flush(): void { this.persist(); }

  private persist(): void {
    try {
      mkdirSync(hostStateDir(this.root), { recursive: true });
      writeJsonAtomic(this.path, this.entries, { space: 2 });
    } catch { /* best-effort — the in-memory list still works for this boot */ }
  }
}

/**
 * Module-level singleton, set once at boot by `main.ts`.
 *
 * Same argument as `sentlog.ts`'s: `deliver.ts` is the chokepoint every
 * delivery in this app passes through, and threading a handle through the
 * backlog, the fan-out, follow-ups, creates, the compose path and the limit
 * scheduler would mean a new call site could forget it. A forgotten one here is
 * a prompt whose fate nobody ever asks about again — the exact failure this
 * exists to end. Unset (a unit import, a test) = a silent no-op.
 */
let current: OpenDeliveries | null = null;
export function setOpenDeliveries(store: OpenDeliveries | null): void { current = store; }
export function openDeliveries(): OpenDeliveries | null { return current; }

/** Register an unconfirmable delivery, or do nothing if no store is installed. */
export function noteAmbiguousDelivery(rec: AmbiguousDelivery): OpenDelivery | null {
  return current ? current.add(rec) : null;
}
