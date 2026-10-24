/**
 * WHERE a fork actually cuts, given the turn you tapped it on.
 *
 * The reader's document is not the conversation log. Two kinds of row in it
 * have no record in the file the host would cut:
 *
 *  - a turn read off the TERMINAL (`screen:<id>`, `local: "screen"`). The
 *    measured case is `/btw`: the CLI answers it in its own TUI and writes
 *    NOTHING to the conversation log, so waterplane's per-turn PTY capture is the
 *    only record there is (`host/transcript.ts` `screenCommandTurns`).
 *  - a turn the reader SYNTHESIZED (`t<N>`): the "(continued)" row a resumed
 *    conversation opens with, and every row of the PTY-history fallback.
 *
 * (Where the cut lands relative to the tapped turn — BEFORE it — is argued at
 * `forkAnchor()`.)
 *
 * Until now both answered a tap with the same refusal — "this turn isn't in the
 * conversation log" — and two greyed buttons. Reported from the phone: fork
 * "not working", on a session whose newest turn was a `/btw`. The refusal was
 * accurate about the RECORD and useless about the REQUEST, because for a screen
 * turn there is an exact answer available:
 *
 * **A screen turn changed nothing in the log, so the conversation state after
 * it IS the state after the previous logged turn.** Cutting there is not an
 * approximation of what was asked for — it is the same cut, addressed by the
 * one record that exists. So the verbs stay live and the row says which turn
 * the cut lands on.
 *
 * A SYNTHETIC turn gets no such redirect, and the difference is the whole
 * reason this is two rules rather than one: a `t<N>` row stands for real
 * history that IS in the file under records the parse could not name. Cutting
 * at the previous logged turn would silently drop it — a fork that arrives with
 * less conversation than the number promised, which is exactly the failure
 * `pruneStranded` exists to prevent on the host side. There the refusal is the
 * honest answer and stays.
 *
 * Pure and DOM-free so `node --test` can pin it over the TypeScript directly
 * (`forkAnchor.test.mjs`); `ForkTurn.tsx` is the rendering half.
 */
import type { TranscriptDoc, TranscriptTurn } from "@waterplane/shared";

/** A turn the reader synthesized rather than read out of the log. */
const SYNTHETIC_TURN = /^t\d+$/;
/** A turn rebuilt from the PTY capture — the log holds nothing at all. */
const SCREEN_TURN = /^screen:/;

/** True when the host can cut the conversation file AT this turn. */
export function isLogTurn(turn: TranscriptTurn): boolean {
  return !SYNTHETIC_TURN.test(turn.id) && !SCREEN_TURN.test(turn.id);
}

/** True when this row exists only because waterplane captured the screen. */
export function isScreenTurn(turn: TranscriptTurn): boolean {
  return SCREEN_TURN.test(turn.id);
}

/** The turn a fork composed on `turn` would actually cut at. */
export interface ForkAnchor {
  /** The turn whose uuid goes on the wire as `forkAtTurn`: the host keeps
   *  everything up to and including THIS turn, so it is the newest logged turn
   *  BEFORE the tapped one. */
  turn: TranscriptTurn;
  /** Screen turns between the anchor and the tapped row. They are in the copy
   *  in every sense that matters (they changed nothing in the log), but the
   *  number the copy ends on is not the one right above the tapped row. */
  skipped: number;
}

/**
 * Is this document the conversation's own exact record? claude's log names its conversation in the
 * document (`claudeSessionId`); a backend's own record (`"store"`, `"backend"`) does not — the
 * session's `backendSessionId` is the id, which `runForkRequest` supplies. Only the approximate
 * `"history"` fallback is never cut (equality, as everywhere: an unknown source reads as exact).
 * Whether the BACKEND can fork at all is the `fork` cap's call, made before a row is drawn.
 */
export function exactLog(doc: TranscriptDoc | null): doc is TranscriptDoc {
  if (!doc || doc.source === "history") return false;
  return doc.source !== "jsonl" || !!doc.claudeSessionId;
}

/**
 * The cut point for a tap on `turn`, or null when there is none.
 *
 * **"Here" is the START of the tapped turn.** The verbs sit on the turn's
 * header, above its prompt, and what a person reaches for them to do is take
 * that prompt BACK — ask again differently, or not at all. That is GitHub
 * Copilot's restore-checkpoint and the CLI's own `/rewind`, and R-prompts-001
 * names the first. The earlier reading — keep the tapped turn and its answer —
 * was reported from the phone as "fork ignores the point": forked at #8 of
 * nine, the copy was the whole conversation minus one line, and *reset to
 * here* on the fork's last turn changed nothing at all.
 *
 * The host cuts AFTER a turn (`host/convfork.ts`), so the anchor is the newest
 * LOGGED turn before the tapped row. Walking backward it steps over screen
 * turns — a `/btw` changed nothing in the log, so the state after it is the
 * state after the logged turn before it, exactly — and stops at a synthesized
 * one: a `t<N>` stands for real history the parse could not name, and cutting
 * past it would silently drop that (`pruneStranded`'s argument on the host).
 * Null when nothing logged comes first — there is no conversation to keep.
 */
export function forkAnchor(doc: TranscriptDoc | null, turn: TranscriptTurn): ForkAnchor | null {
  if (!exactLog(doc)) return null;
  if (!isLogTurn(turn) && !isScreenTurn(turn)) return null; // synthesized: see the header
  const i = doc.turns.findIndex((t) => t.id === turn.id);
  if (i < 0) return null;
  let skipped = 0;
  for (let j = i - 1; j >= 0; j--) {
    const prev = doc.turns[j];
    if (!prev) return null;
    if (isLogTurn(prev)) return { turn: prev, skipped };
    if (!isScreenTurn(prev)) return null; // a synthesized row: history we cannot address
    skipped += 1;
  }
  return null;
}

/**
 * Why this turn's verbs are unavailable, or null when they are not.
 *
 * Every answer is worth saying out loud rather than greying a button: one is a
 * property of the LINK (come back when it is up, every turn is the same) and
 * the others of the TURN. `Unavailable.tsx` is how they are rendered — a verb
 * that cannot run is not drawn as a control at all.
 */
export function forkBlocker(doc: TranscriptDoc | null, turn: TranscriptTurn, online: boolean, hasId = true): string | null {
  // A backend's record is readable before the plugin has bound its conversation id: say it here,
  // where the control is, not in a toast after the tap.
  if (!hasId) return "this conversation has no id yet, so nothing can be cut from it";
  if (!forkAnchor(doc, turn)) {
    if (!exactLog(doc) || (!isLogTurn(turn) && !isScreenTurn(turn))) {
      return "this turn isn't in the conversation record";
    }
    const i = doc.turns.findIndex((t) => t.id === turn.id);
    const before = doc.turns.slice(0, Math.max(0, i));
    return before.some((t) => !isLogTurn(t) && !isScreenTurn(t))
      ? "the turns before this one were not read from the conversation log, so there is no exact point to rewind to"
      : "nothing in the conversation log comes before this turn — a copy from here would be empty; open a new session instead";
  }
  if (!online) return "no connection — forking starts a session on the host";
  return null;
}

/**
 * The sentence a cut owes the reader when the copy does not end on the turn
 * right above the tapped one, or null when it does.
 *
 * Said unprompted: the number in the confirm, the toast and the fork's title is
 * the TAPPED row's ("before #N"), and a copy ending on #k with k < N-1 needs the
 * reason for the gap on screen.
 */
export function anchorNote(turn: TranscriptTurn, anchor: ForkAnchor): string | null {
  if (anchor.skipped === 0) return null;
  return `The ${anchor.skipped === 1 ? "turn" : `${anchor.skipped} turns`} between #${anchor.turn.n} and #${turn.n} `
    + `${anchor.skipped === 1 ? "was a command" : "were commands"} the CLI answered in the terminal and wrote nothing to the conversation log, `
    + `so the copy ends after #${anchor.turn.n}. Nothing is lost by that: the conversation is exactly what `
    + `${anchor.skipped === 1 ? "that command" : "those commands"} left it as.`;
}
