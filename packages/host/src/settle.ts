/**
 * Settling a delivery that could not be confirmed WHEN IT HAPPENED.
 *
 * `deliver.ts` answers three verdicts the client cannot act on automatically —
 * `unconfirmed` (written, never seen on screen) and `unsubmitted` (provably in
 * the composer, every Return swallowed) — precisely because retrying what may
 * already be there is how the same prompt ended up stacked five times. So the
 * queue keeps the row and asks the person to sort it out.
 *
 * That is right at the moment of failure and wrong forever after: nothing ever
 * revisits the row. A queue whose whole job is "nothing typed is lost" ends up
 * displaying a permanent gravestone for a prompt whose fate is, by then,
 * knowable — the ambiguity is a property of a 4-second echo window, not of the
 * world. Later, one of three things is TRUE:
 *
 *   landed    — the CLI's own conversation log has a user turn with this text.
 *               It ran. There is nothing to recover and the row is a lie.
 *   composer  — the text is on the rendered screen right now, sitting unsent.
 *               Still exactly one keypress from running; still the user's call.
 *   absent    — the session is readable, the log doesn't have it and neither
 *               does the screen. It never ran and it is not queued anywhere:
 *               re-sending is now provably safe, which is what the original
 *               verdict could not say.
 *
 * `unknown` is reserved for "we still cannot see" (no conversation log, no live
 * screen) — the one answer that must never be turned into an action.
 *
 * Read-only by construction: this module never writes a byte to a PTY. It
 * decides what is true; `opendeliveries.ts` acts on it and `main.ts` reports
 * it.
 *
 * Two callers now, and the second is the important one. `input.settle` is the
 * PHONE asking — which needs a phone, a live socket and a client that
 * remembered to ask. `deliver.ts` and the open-question sweep ask the same
 * functions with nobody watching at all, which is the only version of this that
 * works on the link this app exists for.
 */
import type { SessionManager } from "./sessions.js";
import type { EchoRule } from "./echo.js";
import {
  echoAmbiguous,
  echoProbe,
  isSlashText,
  logEcho,
  screenEcho,
  squash,
} from "./echo.js";
import {
  FALLBACK_ROWS,
  ROW_WINDOW,
  composerEcho,
} from "./composer.js";
import { liveSourceFor } from "./livesources.js";

export type SettleVerdict = "landed" | "composer" | "absent" | "unknown";

export interface SettleResult {
  verdict: SettleVerdict;
  /** Is the session still running? `absent` on a dead session cannot be re-sent. */
  alive: boolean;
  /** The conversation-log turn this verdict was read off, when it was `landed`.
   *  Kept so the caller can write it down and no second delivery can settle on
   *  the same turn — see `spendTurn`. */
  turnId?: string;
}

/**
 * How far before the delivery a matching turn still counts as "this one".
 *
 * The client's `since` is when IT queued the entry; the turn is stamped by the
 * CLI when it accepted the prompt. Clock skew between the two is real (phone vs
 * desktop), and a delivery that raced a turn boundary can be stamped slightly
 * early. Generous, because the alternative failure is the bad one: a landed
 * prompt read as absent gets sent a second time.
 */
export const MATCH_SLACK_MS = 5 * 60_000;

/**
 * The same window when the HOST is the one asking.
 *
 * `deliver.ts` and the sweep pass their own `Date.now()` from the moment the
 * delivery started, on the same machine and the same clock that stamps the log,
 * so there is no skew to absorb — only the sub-second gap between "we began
 * typing" and "the CLI wrote the record". Tight on purpose: the whole risk on
 * this side is matching an OLDER identical prompt (the same instruction fired
 * at the same session twice in an afternoon is ordinary), and five minutes of
 * slack is five minutes in which that is possible.
 */
export const HOST_SLACK_MS = 30_000;

export interface SettleOpts {
  /** How far before `since` a logged turn may be stamped and still be this one. */
  slackMs?: number;
  /**
   * The OTHER texts that could be in that session's composer right now — open
   * questions about the same session, and deliveries still in flight into it.
   *
   * A screen match is a prefix match, so it says "text starting like this is
   * here". With a rival that starts the same way, that sentence is not about
   * our prompt, and the honest answer is `unknown` rather than a `composer`
   * verdict pointing the user at somebody else's words (see `echoAmbiguous`).
   * Absence of this list only means the caller does not know of any rival; it
   * is never a claim that there are none.
   */
  others?: readonly string[];
  /**
   * Who is asking, as a stable key — the ackId when there is one, else the open
   * row's id, else the delivery's own key.
   *
   * It is the name written into the spent-turn ledger, so the same delivery can
   * re-ask forever and keep its own proof, while a SECOND delivery asking about
   * the same words cannot inherit it. Stability matters more than the value: a
   * key that changes between asks locks a row out of its own evidence, which is
   * why the phone (`input.settle`, by ackId) and the host row (`ackId ?? id`)
   * deliberately agree on one.
   */
  claimer?: string;
}

/**
 * Log turns already spent as proof, and by whom.
 *
 * A whole-text comparison tells two DIFFERENT prompts apart; it cannot tell two
 * deliveries of the SAME text apart, and that is the ordinary case here —
 * re-sending the same words is what a person does when the app says a prompt
 * did not run. Without a ledger both rows read the one turn and both settle
 * `landed`; the second one never ran and its row retires saying it did.
 *
 * So a turn is evidence for exactly one delivery. The second one to arrive gets
 * `unknown` — deliberately NOT `absent`: "somebody already claimed this turn"
 * is not a readable log that lacks the words, and answering `absent` would
 * authorise a re-send and run the same instruction twice, which is a worse
 * outcome than the false `landed` it is replacing.
 *
 * In memory and bounded. Losing it at a restart only makes the host more
 * permissive, i.e. exactly as permissive as it was before this existed, and
 * `opendeliveries.ts` re-seeds it from the rows it persisted, which is where
 * the long-lived questions are.
 */
const SPENT_CAP = 500;
const spentTurns = new Map<string, string>();

/** Record that this delivery has used this log turn as its proof. Idempotent
 *  for the same claimer; a Map keeps insertion order, so eviction is FIFO. */
export function spendTurn(turnId: string, claimer: string): void {
  if (!turnId || !claimer) return;
  if (spentTurns.get(turnId) === claimer) return;
  if (!spentTurns.has(turnId)) {
    while (spentTurns.size >= SPENT_CAP) {
      const oldest = spentTurns.keys().next().value;
      if (oldest === undefined) break;
      spentTurns.delete(oldest);
    }
  }
  spentTurns.set(turnId, claimer);
}

/** Test seam: the ledger is per-boot module state, and a unit test that could
 *  not clear it would be asserting the previous test's leftovers. */
export function forgetSpentTurns(): void { spentTurns.clear(); }

/** Is this turn already somebody else's proof? A turn with no id at all cannot
 *  be tracked and is treated as free — an untracked turn is how the code
 *  behaved before the ledger, and never worse. */
function spentByAnother(turnId: string | undefined, claimer: string | undefined): boolean {
  if (!turnId) return false;
  const owner = spentTurns.get(turnId);
  return !!owner && owner !== claimer;
}

/**
 * The last parse of each session's log, reused only while the file has not
 * moved.
 *
 * Transcripts are parsed from a tail of the conversation log, which for a busy
 * session is megabytes. A phone settles its whole failed queue in one message,
 * and those rows are routinely all in the same session — so parsing once is
 * worth real time.
 *
 * The validity test is the log's MTIME, not a clock. It began as a five-second
 * time window, which was fine while a phone was the only caller and became a
 * bug the moment `deliver.ts` started asking: the delivery poll fills the cache
 * with "there is no log", the log appears a second later, and the next question
 * about that session is answered from the memory of the second before. A stat
 * per call is cheaper than being wrong, and `getTranscript` already answers
 * "unchanged" from one.
 */
const cache = new Map<string, { at: number; prompts: { id: string; text: string; at?: number }[] | null }>();

/**
 * How many sessions' parsed prompts to keep — the same argument as `SPENT_CAP`
 * above, which this map did not have.
 *
 * Every entry can hold 500 turns of FULL prompt text (`transcript.ts` caps one
 * prompt at 200 000 chars), session ids are minted freely — one per fan-out
 * target, a fresh one per resurrect — and nothing in this file ever hears that
 * a session ended, so the map was set-only for the life of a daemon that runs
 * for weeks. That is a slow, permanent leak of the user's own prose.
 *
 * A `Map` keeps insertion order and a hit is re-inserted, so eviction is LRU by
 * session: the sessions a phone is actually settling stay warm, which is the
 * whole point of the cache (a phone settles its failed queue in one message,
 * and those rows are routinely all in one session).
 */
const CACHE_CAP = 40;

/** User turns from the CLI's OWN log, or null when there is no such log. */
function loggedPrompts(sessions: SessionManager, sessionId: string): { id: string; text: string; at?: number }[] | null {
  // A backend that keeps no claude log is asked NOTHING, and the bail is here
  // rather than at the verdict below. `source === "jsonl"` already made an
  // opencode document count as no evidence — correctly, these verdicts are about
  // claude's log — but only AFTER `getTranscript` had opened opencode's SQLite
  // store, read every message and part of the conversation and folded it into a
  // document, synchronously, on the loop that pumps every PTY, once per settled
  // session. The answer was always "no evidence", so the work was pure cost —
  // and the cache below could not have absorbed it, since `getTranscript` is
  // what it asks to find out whether anything changed.
  if (!sessions.keepsClaudeLog(sessionId)) return null;
  const hit = cache.get(sessionId);
  // Stamped BEFORE the read: a write that lands during the parse must look
  // newer than the cache entry, or it is invisible until the next one.
  const at = Date.now();
  let prompts: { id: string; text: string; at?: number }[] | null = null;
  try {
    const doc = sessions.getTranscript(sessionId, hit?.at ?? 0, "lite");
    if (doc === "unchanged" && hit) {
      // Touch it, so the sessions being asked about are the ones that survive
      // eviction.
      cache.delete(sessionId);
      cache.set(sessionId, hit);
      return hit.prompts;
    }
    // ONLY the jsonl source counts. The `history` fallback is OUR OWN record of
    // what we typed (`recordPrompt`, called before the Return is pressed), so a
    // prompt that echoed and was never submitted is in it — using that as proof
    // it ran would confirm exactly the case this exists to catch.
    if (doc && doc !== "unchanged" && doc.source === "jsonl") {
      // `t.id` is the conversation log's own uuid for the prompt record — a
      // name for THIS turn that survives a re-parse, which is what makes the
      // spent-turn ledger possible at all.
      prompts = doc.turns.map((t) => ({ id: t.id, text: t.prompt, at: t.sentAt }));
    }
  } catch { /* unreadable log → no evidence, never an exception into a socket */ }
  if (!cache.has(sessionId)) {
    while (cache.size >= CACHE_CAP) {
      const oldest = cache.keys().next().value;
      if (oldest === undefined) break;
      cache.delete(oldest);
    }
  }
  cache.set(sessionId, { at, prompts });
  return prompts;
}

/**
 * What the CLI's own log says about a delivery — the half of settling that
 * needs no screen, no live session, and no client.
 *
 *   landed  — a user turn stamped at or after the delivery carries this text.
 *   absent  — the log is READABLE and no such turn is in it. Nothing ran.
 *   unknown — there is no jsonl to read, or the text is a slash command, whose
 *             envelope the transcript reader deliberately drops (`isSlashText`).
 *             Absence proves nothing about either.
 *
 * The recency floor is what makes a match mean THIS delivery rather than the
 * identical instruction somebody fired this morning. A turn with no timestamp
 * at all is matched anyway: the CLI always stamps one, and treating an undated
 * record as evidence of nothing would turn a log we can read into `absent`,
 * which is the verdict that authorises a re-send.
 *
 * Note on truncation: the parse drops the OLDEST records when a log is huge
 * (24 MB tail, 500 turns). Everything this asks about is by definition inside
 * the recent window, so a dropped record can never be the one being looked for.
 *
 * The comparison is `logEcho` — the WHOLE text, not the screen's fourteen-
 * character head. The log has no truncation to work around, and matching it on
 * a prefix is what let one prompt's turn prove a different prompt had run: the
 * row retires, the queue drops the words, and nothing revisits an answered
 * question. A prefix is the right needle for a terminal and was never the right
 * needle for a file.
 */
export interface LogMatch {
  verdict: "landed" | "absent" | "unknown";
  /** The turn that proved it, when one did. */
  turnId?: string;
}

export function logMatch(
  sessions: SessionManager,
  sessionId: string,
  text: string,
  since: number,
  opts: SettleOpts = {},
): LogMatch {
  if (!echoProbe(text)) return { verdict: "unknown" };
  if (isSlashText(text)) return { verdict: "unknown" };
  const logged = loggedPrompts(sessions, sessionId);
  if (!logged) return { verdict: "unknown" };
  const floor = since - (opts.slackMs ?? MATCH_SLACK_MS);
  /** A turn carrying our words that another delivery has already spent. It is
   *  not proof FOR us and it is emphatically not proof against us. */
  let taken = false;
  for (const p of logged) {
    if (p.at != null && p.at < floor) continue;
    if (!logEcho(p.text, text)) continue;
    if (spentByAnother(p.id, opts.claimer)) { taken = true; continue; }
    if (opts.claimer) spendTurn(p.id, opts.claimer);
    return { verdict: "landed", turnId: p.id };
  }
  // A readable log whose only matching turn belongs to someone else says
  // nothing about this delivery — so it says `unknown`. Answering `absent` here
  // would be the ledger causing the very duplicate it exists to prevent.
  return { verdict: taken ? "unknown" : "absent" };
}

/**
 * `logMatch`'s question asked of a backend's OWN channel — `sources.delivery
 * .userTurns` (design §2, WP1c) — for a session whose backend keeps no claude
 * log. Null means "no source applies here" and the caller asks `logMatch`,
 * which is every claude session and every backend without a source: exactly
 * the old path.
 *
 * The rules are `logMatch`'s, not a second opinion: the WHOLE text
 * (`logEcho`), the same recency floor, and the same spent-turn ledger keyed on
 * the SOURCE's turn id — one user message is evidence for exactly one delivery.
 * `absent` still requires evidence: only a list the source actually returned
 * can lack our words. A source that cannot say (`null`, a throw) is `unknown`,
 * never `absent`, because `absent` authorises a re-send.
 */
async function sourceMatch(
  sessions: SessionManager,
  sessionId: string,
  text: string,
  since: number,
  opts: SettleOpts,
): Promise<LogMatch | null> {
  if (sessions.keepsClaudeLog(sessionId)) return null;
  const live = liveSourceFor(sessionId);
  const src = live?.sources.delivery;
  if (!live || !src) return null;
  if (!echoProbe(text) || isSlashText(text)) return { verdict: "unknown" };
  const floor = since - (opts.slackMs ?? MATCH_SLACK_MS);
  let turns: { id: string; text: string; at: number }[] | null = null;
  try { turns = await src.userTurns(live.session, floor); } catch { turns = null; }
  if (!Array.isArray(turns)) return { verdict: "unknown" };
  let taken = false;
  for (const t of turns) {
    if (typeof t?.at === "number" && t.at < floor) continue;
    if (typeof t?.text !== "string" || !logEcho(t.text, text)) continue;
    if (spentByAnother(t.id, opts.claimer)) { taken = true; continue; }
    if (opts.claimer) spendTurn(t.id, opts.claimer);
    return { verdict: "landed", turnId: t.id };
  }
  return { verdict: taken ? "unknown" : "absent" };
}

/** The verdict alone — for callers with nothing to claim and nothing to record. */
export function logVerdict(
  sessions: SessionManager,
  sessionId: string,
  text: string,
  since: number,
  opts: SettleOpts = {},
): "landed" | "absent" | "unknown" {
  return logMatch(sessions, sessionId, text, since, opts).verdict;
}

/**
 * Wait a bounded moment for the log to say the prompt ran.
 *
 * The CLI writes the user record when it ACCEPTS the prompt, so in the ordinary
 * case the evidence is on disk before the caller even asks. The poll is for the
 * disorderly cases — a log file created milliseconds after the first turn, a
 * write that has not been flushed, a session whose conversation id was only
 * just detected. Polling rather than one blind read because a single early read
 * of a file that appears 200 ms later is indistinguishable from no log at all,
 * and that mistake costs a prompt its `ok`.
 *
 * LOOKING again is free — it is RETYPING that stacks copies, and nothing here
 * writes. Returns as soon as the answer is `landed`; `absent`/`unknown` keep
 * polling until the deadline, because both can still turn into `landed`.
 */
export async function awaitLanded(
  sessions: SessionManager,
  sessionId: string,
  text: string,
  since: number,
  ms: number,
  slackMs = HOST_SLACK_MS,
  claimer?: string,
): Promise<boolean> {
  if (isSlashText(text) || !echoProbe(text)) return false;
  const deadline = Date.now() + ms;
  for (;;) {
    // Claiming here matters as much as in the sweep: this is the path that
    // answers `ok`, and an `ok` is never revisited by anything. A turn spent on
    // this delivery cannot then prove a second delivery of the same words ran.
    if (logVerdict(sessions, sessionId, text, since, { slackMs, claimer }) === "landed") return true;
    if (Date.now() >= deadline) return false;
    await new Promise((r) => setTimeout(r, 250));
  }
}

/**
 * What actually became of a delivery the host could not confirm at the time.
 *
 * `text` is what was sent and `since` is when it was queued. From the phone
 * both come off the wire, because the host deliberately does not keep an
 * un-acked prompt anywhere it could be resurrected from; from the host's own
 * sweep they come off the open-question row, which is that copy, kept on
 * purpose.
 *
 * `opts.others` is what stops the screen half from answering about somebody
 * else's prompt, and `opts.claimer` is what stops the log half from handing one
 * turn to two rows. Both are the same principle applied at different distances:
 * this file may say "I cannot tell", and may not say something confident and
 * wrong.
 */
export async function settleDelivery(
  sessions: SessionManager,
  sessionId: string,
  text: string,
  since: number,
  opts: SettleOpts = {},
): Promise<SettleResult> {
  const info = sessions.get(sessionId);
  const alive = info?.running === true;
  const probe = echoProbe(text);
  if (!probe) return { verdict: "unknown", alive };

  // 1. Did it RUN? The conversation log is the CLI's own record and outlives
  //    the session, so this is answerable for a session that has since closed.
  //    A backend with no claude log but a delivery source answers from its own
  //    channel instead (`sourceMatch`); everything else is `logMatch`, unchanged.
  const fromLog = (await sourceMatch(sessions, sessionId, text, since, opts)) ?? logMatch(sessions, sessionId, text, since, opts);
  if (fromLog.verdict === "landed") return { verdict: "landed", alive, turnId: fromLog.turnId };

  // 2. Is it SITTING THERE? Only a live session has a screen to read.
  if (!alive) return { verdict: fromLog.verdict === "absent" ? "absent" : "unknown", alive };
  let screen = "";
  let inComposer: EchoRule = "none";
  try {
    // The ANCHORED read gets `deliver.ts`'s window, not the 40 rows this file
    // used to take. The two must not disagree about how much screen there is:
    // the tear this whole rule was written for can strand the composer frame
    // well above the bottom of the replay, and a narrower window here made
    // exactly that delivery confirmable by `deliver.ts` and invisible to the
    // reader asked about it minutes later (anchored ⇒ null on rows that do not
    // reach the box, fallback slice ⇒ `none`, verdict `unknown`).
    //
    // Everything else in here keeps the old depth. `screen` is what stands
    // between the fall-through and `absent`, and `absent` authorises a re-send:
    // widening it would change which prompts get sent twice, which is not a
    // change to make as a side effect of fixing a window. Same for the fallback
    // slice below, for the reason written at `composer.ts`'s `FALLBACK_ROWS`.
    const wide = (await sessions.screenText(sessionId, ROW_WINDOW)).split("\n");
    const rows = wide.slice(-FALLBACK_ROWS);
    const raw = rows.join("\n");
    screen = squash(raw);
    // `inComposer` is a claim about WHERE the text is, not merely that it is on
    // screen — the whole 40 rows include the scrollback, and this CLI scrolls
    // rather than repainting, so a prompt that already ran is still sitting up
    // there verbatim. Matching it there and answering `composer` tells the user
    // (and `opendeliveries.ts`) "it is in the box, press Return", which submits
    // an EMPTY composer.
    //
    // The narrowing used to be a bottom-`depth` slice, and `deliver.ts` used to
    // do the same thing — the two were meant to be the same rule and now
    // genuinely are: `composerEcho` finds the box the CLI draws to take typing
    // and asks whether the text is INSIDE it. Distance from the bottom of the
    // render was never the composer, it was the tear: the replay is a fixed
    // 50-row VT fed the whole buffer, so mid-turn a half-done repaint leaves
    // stale rows under the newest frame and the box is nowhere near the last
    // row. That is exactly the delivery that arrives here — an interjection the
    // echo window could not confirm — and it used to settle `unknown` with the
    // words visible in the box.
    //
    // A screen with no `❯` box on it falls back to the old slice, over the old
    // rows: deep enough for the wrapped text plus the box borders and the hint
    // line. An upstream redraw must cost us the improvement, never the reading.
    const anchored = composerEcho(wide, text);
    if (anchored !== null) inComposer = anchored;
    else {
      const depth = Math.min(FALLBACK_ROWS, 10 + Math.ceil(text.length / 40));
      inComposer = screenEcho(squash(rows.slice(Math.max(0, rows.length - depth)).join("\n")), text);
    }
  } catch { return { verdict: "unknown", alive }; }
  if (!screen) return { verdict: "unknown", alive };
  // The screen rules, in the order of how much they prove — and then the
  // question that decides whether the answer may be acted on at all.
  //
  // A long prompt in the composer shows as `[Pasted text #1 +N lines]` plus its
  // tail — or, when it holds no newline at all, as a bare `[Pasted text #1]`
  // with nothing beside it. Either way the head the probe is cut from is HIDDEN
  // behind the placeholder. Reading that as "not there" would answer `absent`, and
  // `absent` is acted on by the HOST as well as the client: a second copy
  // stacked on top of the first, in the composer, which is the one outcome this
  // file exists to prevent. Same rule as `deliver.ts`'s echo check, tied to
  // this text by its tail (or by a hidden-line count that covers all of it).
  // Asked of the WHOLE screen first, because that answer is what stands between
  // the fall-through and `absent` — and `absent` authorises a re-send. Text
  // visible anywhere means we may not claim it never ran, even when we cannot
  // say it is in the box. So the narrowing below only ever downgrades a
  // `composer` to `unknown`; it can never manufacture an `absent`.
  //
  // "Seen" is therefore the OR of the two readings, and it has to be: the
  // anchored rule can find the box further up the replay than the narrow tail
  // reaches, and gating it on the tail would have made the wider window here a
  // no-op — the text inside a composer frame fifty rows up would have fallen
  // through to `absent` for want of being visible in the last forty rows, and
  // `absent` is the verdict that sends a prompt a second time. The narrowing
  // still only ever DOWNGRADES: `rule` is the structural answer alone, so text
  // merely visible in the tail and not in any box is `unknown` exactly as
  // before.
  const rule = inComposer;
  const seen = rule !== "none" || screenEcho(screen, text) !== "none";
  if (seen && rule === "none") return { verdict: "unknown", alive };
  if (rule !== "none") {
    // …and the prefix half of that is only evidence about OUR prompt when
    // nothing else that could be in this composer would have matched it too.
    // Two prompts sharing a fourteen-character head were both settled
    // `composer` in the live run — "press Return there, never retype it" — and
    // the composer they pointed at was empty. `unknown` costs one more sweep
    // and says something true.
    if (!echoAmbiguous(rule, text, opts.others ?? [])) return { verdict: "composer", alive };
    return { verdict: "unknown", alive };
  }

  // 3. Readable, and not there.
  //
  // `absent` is only sayable with the LOG in hand. A screen is the last 40 rows:
  // a prompt that ran and then produced a long answer has scrolled off it, so
  // "not on screen" alone would call a delivered prompt absent — and `absent`
  // is the verdict that authorises sending it again. The log is what makes the
  // negative a fact rather than a small window.
  return { verdict: fromLog.verdict === "absent" ? "absent" : "unknown", alive };
}
