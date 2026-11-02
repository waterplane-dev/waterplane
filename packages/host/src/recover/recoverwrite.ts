/**
 * THE automatic `continue` — one writer for every recovery that types into a
 * session the CLI stopped on something outside it: the account wall (usage
 * limit and spend, `sessions/wall.ts`'s `doLimitContinue`) and the net retry
 * (`sessions/apiretry.ts`'s `fire`). Before this they were two copies of the
 * same eleven lines; the POLICY around them (ladders, the resume queue, the
 * stall probe, what a busy session means) stays with the callers.
 *
 * Two halves, both asked by the caller:
 *  - `continueBlocker` — may a continue be typed at all, NOW: the session gone
 *    or replaced, the emergency halt, a wall (net only), a turn running (net
 *    only), a foreign box, output still arriving. One ladder in one order; what
 *    a blocker MEANS (park, cancel, release the queue slot) is the caller's.
 *    `continueBlockerNow` adds the last rung, which needs a screen read:
 *    `draft` — words a PERSON typed sit in the live composer. Typing
 *    `continue` + Return there would submit "<their draft>continue": words
 *    merged that nobody wrote together, and their last copy of the draft gone
 *    (CLAUDE.md: never overwrite typed words). Read by `composer.ts`'s
 *    `composerReading` — the same plain-vs-dim-blanked rule delivery asks, so
 *    claude's dim hint or proposal is an EMPTY box, never a draft; a screen
 *    where no composer can be placed is no opinion (as before this rung).
 *  - `writeContinue` — the typing: optionally the CLI's own menu answered
 *    first (the wall's stop-and-wait option, as a tap would), then `continue`
 *    and Return as TWO writes 250 ms apart (one chunk reads as a paste), a
 *    history row, and a `sent.json` row with `result: "written"`.
 *
 * **Why this is a blind writer and not `deliver.ts`** (CLAUDE.md: never fork
 * deliver.ts — this is not a fork of it, it is the one other writer, and it
 * stays one). Measured against deliver/deliverrun.ts + deliverreturn.ts and
 * opendeliveries.ts on 2026-11-02:
 *  1. An unconfirmable verdict REGISTERS an open delivery
 *     (`noteAmbiguousDelivery`), and opendeliveries' `absent` verdict makes the
 *     HOST type the same text again, up to `RESEND_TRIES` (4). That is a
 *     second recovery typing `continue` outside the ladder, the resume queue's
 *     first-of-a-wave-alone gate, the halt check and the net cap.
 *  2. deliverreturn presses Return up to 5 times until a hook says a turn
 *     STARTED, and files `deliver.submit` "miss" when none does. A CLI behind a
 *     wall may reject the prompt without the turn-start the proof waits for, so
 *     every one of up to 64 ladder attempts would read as a broken CLI in the
 *     health record (`clihealth.ts`: a miss is only the RIGHT rule failing) and
 *     come back `unsubmitted` — while the wall's real verdict is limit rule 1:
 *     the banner below our echo on the next idle scan (`checkLimit`).
 *  3. The echo-miss sweep sends Esc (`clearComposer`) to close "a view covering
 *     the composer" — at a wall that view is the CLI's own stop-and-wait menu,
 *     which this writer answers deliberately instead.
 *  4. Every deliver write goes through the facade's `write`, which calls off a
 *     pending net retry (`netTyped`) unless the net's own-write mark is up — and
 *     a delivery is async for up to ~50 s (`waitReady` 45 s, submit polls), so
 *     the mark would have to cover a person's real keystroke too.
 *  5. `waitReady` (1.2 s quiet, up to 45 s) would hold the resume queue's one
 *     slot while it waits; the callers already ask their own readiness here
 *     (`continueBlocker`) and park or release instead of blocking.
 * What deliver would have added is the echo proof that `continue` reached the
 * composer. Neither recovery needs it to decide anything: the wall verifies on
 * the next idle scan, the net retry on the next turn end's log row.
 */
import type { DetectedPrompt, SentSource } from "@waterplane/shared";
import { recordSent as realRecordSent } from "../sentlog.js";
import { haltRefusal } from "../halt.js";
import { ROW_WINDOW, composerAnchorsFor, composerReading, type ComposerAnchors } from "../composer.js";

/** Which recovery is typing. `spend` is the wall's other kind (`blockOf`); `auth` is
 *  the sign-in episode's continue, typed only after the person's tap (`sessions/signinwait.ts`). */
export type RecoverKind = "limit" | "spend" | "net" | "auth";

/** The words typed. The e2e suites pin them; never vary them per kind. */
export const CONTINUE_TEXT = "continue";
/** Text, then Return this much later: one chunk would be read as a paste. */
export const RETURN_GAP_MS = 250;
/** After answering the CLI's own menu, the composer needs this long to come back. */
export const MENU_SETTLE_MS = 1200;

/**
 * The `sent.json` source per kind. A spend wall has its own word (`spend`); rows
 * written before it say `limit`.
 */
const SENT_SOURCE: Record<RecoverKind, SentSource> = { limit: "limit", spend: "spend", net: "netretry", auth: "signin" };
/** The prompt-history row per kind (unchanged wording). */
const HISTORY: Record<RecoverKind, string> = {
  limit: "continue (auto, usage limit reset)",
  spend: "continue (auto, usage limit reset)",
  net: "continue (auto, network error)",
  auth: "continue (after sign-in, you tapped)",
};

/** What stops a continue before a byte is typed — in the order `continueBlocker` asks. */
export type ContinueBlocker = "gone" | "halted" | "wall" | "turn" | "box" | "unsettled" | "draft";

/** Which of the ladder's questions a caller asks. Absent = not asked. */
export interface ContinuePolicy {
  /** Output newer than this ⇒ `unsettled`: the screen is still moving. */
  quietMs: number;
  /** A usage or spend wall outranks this recovery (the net retry). */
  wallBlocks?: boolean;
  /**
   * A running turn ⇒ `turn` (the net retry: a turn that is not ours ends the
   * episode). The wall never asks: a wall-rejected turn can end with no hook
   * that clears the flag, and asking would stall every attempt behind it.
   */
  turnBlocks?: boolean;
  /** An unreadable dialog (`awaitingInput`) counts as a box (the net retry). */
  dialogBlocks?: boolean;
  /** The CLI's OWN menu this recovery answers first (the wall's stop-and-wait
   *  option): a box offering it is not foreign. */
  ownMenu?: RegExp;
}

/** The facts `continueBlocker` reads off a session. */
export interface ContinueFacts {
  info: {
    prompt?: DetectedPrompt | null;
    awaitingInput?: boolean;
    limit?: { blocked: boolean } | null;
  };
  turnActive?: boolean;
  lastDataAt: number;
}

/**
 * The first reason not to type a continue now, or null. `alive` is the
 * caller's own "still this session object, still running" (each has its own
 * extra condition: the wall's block, the net's episode state). The halt latch is
 * read here, for both: nothing automatic types while it is on.
 */
export function continueBlocker(
  s: ContinueFacts,
  alive: boolean,
  policy: ContinuePolicy,
  now: number = Date.now(),
  halted: boolean = haltRefusal() != null,
): ContinueBlocker | null {
  if (!alive) return "gone";
  if (halted) return "halted";
  if (policy.wallBlocks && s.info.limit?.blocked) return "wall";
  if (policy.turnBlocks && s.turnActive) return "turn";
  const p = s.info.prompt;
  const own = !!p && !!policy.ownMenu && p.options.some((o) => policy.ownMenu!.test(o.label));
  if ((p && !own) || (policy.dialogBlocks && s.info.awaitingInput)) return "box";
  if (now - s.lastDataAt < policy.quietMs) return "unsettled";
  return null;
}

/** One grid row as `composerReading` asks it: the plain text and the text with dim cells blanked. */
export type DraftRow = { text: string; undimmed: string };

/**
 * Words a person typed into the live composer, or null — null for an empty box,
 * a box holding only a dim hint or proposal, a screen where no composer can be
 * placed (`anchors` null, a torn replay, a menu covering it), or a read that
 * failed. Only a POSITIVE reading blocks: an unreadable screen does what it did
 * before this rung existed.
 */
export async function composerDraft(
  read: () => Promise<readonly DraftRow[]>,
  anchors: ComposerAnchors | null,
): Promise<string | null> {
  if (!anchors) return null;
  let rows: readonly DraftRow[];
  try { rows = await read(); } catch { return null; }
  const r = composerReading(rows, anchors);
  return r?.typed ? r.typed : null;
}

/**
 * The draft reader for one session: its backend's own composer anchors (none ⇒
 * no opinion), over the facade's `screenCells` (the same `ROW_WINDOW` delivery reads).
 */
export function draftReader(
  delivery: Parameters<typeof composerAnchorsFor>[0] | null | undefined,
  cells: (lines: number) => Promise<readonly DraftRow[]>,
): () => Promise<string | null> {
  const anchors = delivery ? composerAnchorsFor(delivery) : null;
  return () => composerDraft(() => cells(ROW_WINDOW), anchors);
}

/**
 * `continueBlocker`, then the `draft` rung (a screen read) — the whole ladder
 * every recovery asks before its first byte. The sync ladder is asked again
 * after the read: the session may have moved while the grid was replayed.
 */
export async function continueBlockerNow(
  s: ContinueFacts,
  alive: () => boolean,
  policy: ContinuePolicy,
  draft: () => Promise<string | null>,
): Promise<ContinueBlocker | null> {
  const first = continueBlocker(s, alive(), policy);
  if (first) return first;
  const words = await draft();
  const again = continueBlocker(s, alive(), policy);
  if (again) return again;
  return words ? "draft" : null;
}

/** The option of the CLI's own menu to take first, by `ownMenu`; null when none is up. */
export function ownMenuOption(prompt: DetectedPrompt | null | undefined, ownMenu: RegExp): number | null {
  const o = prompt?.options.find((x) => ownMenu.test(x.label));
  return o ? o.index : null;
}

/** The menu-answer row's detail when the composer under the menu held a person's
 *  words, so the continue it cleared the way for was held, never typed. */
export const MENU_HELD_DETAIL = "menu cleared, continue held: words in the composer";

/** One continue, bound to its session by the caller. */
export interface ContinueWrite {
  sessionId: string;
  kind: RecoverKind;
  /** Who decided: `user` where a person's tap released it (the sign-in continue). Default `auto`. */
  actor?: "auto" | "user";
  /** The `sent.json` row's detail (the caller's attempt count and reason). */
  detail: string;
  /** Still the session to type into — asked after each pause (the net adds "its
   *  episode is still `sent`", so a person typing in the gap skips the Return). */
  stillOurs(): boolean;
  /** Through the facade's `write` (the net wraps it in its own-write mark). */
  write(data: string): void;
  recordPrompt(text: string): void;
  /** The CLI's own menu answered first: that option's index, and how to press
   *  it — raw, as the phone's tap on that box would. */
  menu?: { index: number; press(data: string): void } | null;
  /** After the menu settles, the composer it covered is back: words a person
   *  typed there ⇒ `draft`, nothing typed (`composerDraft`). Asked only with a
   *  `menu` — without one the caller's `continueBlockerNow` just asked. */
  draft?: () => Promise<string | null>;
}

/** Seams for a test; production passes nothing. */
export interface ContinueIO {
  sleep?: (ms: number) => Promise<void>;
  recordSent?: typeof realRecordSent;
}

const realSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Type the continue. `written` once the Return is pressed — blind, as the
 * header says, so the outcome is the caller's next reading. `gone` when the
 * session stopped being ours in a pause: nothing more is typed, no row written
 * for the Return that was not pressed. `draft` when the composer the menu had
 * covered holds a person's words: the menu was answered, `continue` was not typed.
 */
export async function writeContinue(w: ContinueWrite, io: ContinueIO = {}): Promise<"written" | "gone" | "draft"> {
  const sleep = io.sleep ?? realSleep;
  const sent = io.recordSent ?? realRecordSent;
  const source = SENT_SOURCE[w.kind];
  const actor = w.actor ?? "auto";
  if (w.menu) {
    w.menu.press(String(w.menu.index) + "\r");
    // The menu answer DID happen, whatever follows: one row, worded by what came
    // of the continue it was clearing the way for — written once that is known.
    const menuRow = (detail: string) => sent({
      sessionId: w.sessionId, actor, source, kind: "answer",
      text: String(w.menu!.index), result: "written", detail,
    });
    await sleep(MENU_SETTLE_MS);
    if (w.stillOurs() && w.draft && await w.draft()) {
      menuRow(MENU_HELD_DETAIL);
      return "draft";
    }
    menuRow(`cleared the usage-limit menu before continuing`);
    if (!w.stillOurs()) return "gone";
  }
  w.write(CONTINUE_TEXT);
  await sleep(RETURN_GAP_MS);
  if (!w.stillOurs()) return "gone";
  w.write("\r");
  w.recordPrompt(HISTORY[w.kind]);
  // `written`, not `ok`: the Return is pressed blind (above), and the outcome
  // lands on the caller's next reading.
  sent({ sessionId: w.sessionId, actor, source, kind: "prompt", text: CONTINUE_TEXT, result: "written", detail: w.detail });
  return "written";
}
