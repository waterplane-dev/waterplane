/** Turns that are not in the log (screen commands, queued prompts), merged in; the history fallback. Moved from transcript.ts. */
import type { HistoryEntry, TranscriptBlock, TranscriptDoc, TranscriptTurn } from "@waterplane/shared";
import { squash } from "../echo.js";
import { TEXT_CAP, answeredOnlyInCli, oneLine } from "@waterplane/shared";
import { localCommandOf, promptOf, queuedPromptOf } from "./transcriptlog.js";
import { foldRepaints, scrollHintTrimmed, sliceToCommand, trimTuiChrome } from "./transcriptscreen.js";

/**
 * The commands the conversation log never wrote down, as turns.
 *
 * Measured case: `/btw`. The CLI answers it entirely in its own TUI and writes
 * NOTHING to the conversation log — not an envelope, not a stdout record — so
 * the reader showed a conversation in which the question and its answer had
 * never happened, while the terminal one swipe away showed both. waterplane's own
 * per-turn PTY capture (`HistoryEntry.output`) is the only record of it, and
 * this is where that record gets to be part of the document.
 *
 * …as a ROW, not as its answer, for `/btw` itself: typed into a running turn
 * (its whole purpose) the capture is that turn's screen with the overlay on it,
 * and carving one out of the other kept breaking. The row stays — the reader
 * says where the answer is and opens the CLI (`answeredOnlyInCli`); commands
 * typed into an idle session keep their captured answer.
 *
 * Only COMMANDS, and only ones the log does not already carry: a prompt reaches
 * the log by definition, and a command the log DID write is already a `"log"`
 * turn with exact words — re-adding it from the screen would print it twice,
 * the second time approximately. Matching is on the command word within a short
 * window, because the two records are the same act seen from two sides and
 * their timestamps differ by however long delivery took.
 */
export const LOCAL_MATCH_MS = 3 * 60_000;

export function screenCommandTurns(entries: HistoryEntry[], logged: TranscriptTurn[]): TranscriptTurn[] {
  const out: TranscriptTurn[] = [];
  for (const e of entries) {
    const text = (e.text ?? "").trim();
    if (!text.startsWith("/")) continue;
    const head = text.split(/\s+/)[0];
    const already = logged.some((t) =>
      t.prompt.trim().split(/\s+/)[0] === head &&
      Math.abs((t.sentAt ?? 0) - e.sentAt) < LOCAL_MATCH_MS);
    if (already) continue;
    // Typed into a turn that was still running, and the capture never shows the
    // command's echo: then the capture is that TURN's output, which the log
    // already holds, not the command's answer. Measured: an `/effort high`
    // typed 50 s into a turn that launched background agents came back as a
    // frozen copy of the turn's screen, sorted after it, so the reader's tail
    // was a 20:42 snapshot ("took 2m") while the turn above it ran to 21:08.
    // Absent, not someone else's words: no body and no finish claimed.
    const midTurn = logged.some((t) =>
      !t.local && (t.sentAt ?? Infinity) <= e.sentAt && (t.endedAt ?? 0) > e.sentAt);
    const echoed = !!e.output && e.output.split("\n").some((l) => l.trim().startsWith(head));
    const own = !midTurn || echoed;
    // `/btw`: a row with no body, by decision rather than by miss — the reader
    // says the answer is in the CLI and opens it (`answeredOnlyInCli`).
    const cut = e.output && own && !answeredOnlyInCli(text) ? sliceToCommand(e.output, text) : "";
    const body = cut ? trimTuiChrome(foldRepaints(cut, text)) : "";
    // Asked of the CUT capture, not of `body`: the hint is exactly what `body`
    // has had removed, so reading it back off the trimmed text finds nothing.
    const clipped = cut ? scrollHintTrimmed(cut) : false;
    out.push({
      id: `screen:${e.id}`,
      n: 0,                                   // renumbered by `mergeLocalTurns`
      prompt: text.slice(0, TEXT_CAP),
      promptLabel: oneLine(text),
      sentAt: e.sentAt,
      endedAt: own ? e.outputAt : undefined,
      blocks: body
        ? [{ kind: "screen", text: body.slice(0, TEXT_CAP), ...(clipped ? { scrollable: true } : {}) }]
        : [],
      toolCount: 0,
      files: [],
      sidechains: 0,
      local: "screen",
    });
  }
  return out;
}

/**
 * **What waterplane has typed in that the log has not taken yet.**
 *
 * The TUI HOLDS a prompt typed into a session that is mid-turn: it sits in the
 * composer, accepted, and the CLI writes nothing to the conversation log until
 * it actually starts it. Measured on this desktop — a prompt sent at 09:57
 * landed in the log at 10:04, behind a turn that ran 131 tools — and for those
 * seven minutes every reader built on that log was missing the newest thing the
 * person had sent. The report was "the last thing I sent was accepted by the
 * CLI and is worked on but it does not show in the list", and the outline was
 * not wrong about the log; the log was simply not the whole of what is known.
 *
 * `HistoryEntry` is the other half, and a narrow one: `recordPrompt` writes it
 * only for a delivery whose text was SEEN in the composer, so a row here means
 * *these words are in that session*, never *this prompt ran*. That is exactly
 * what the turn claims — no blocks, no tools, no summary, `queued`.
 *
 * Three rules keep it from becoming a second, fictional conversation:
 *
 *  - **Newer than everything the log has.** An entry at or before the newest
 *    logged prompt is one the log has already taken (or one the CLI dropped and
 *    a later turn has since overtaken), and the log is the better record of it.
 *    This is also what makes the list self-healing: nothing has to be retired,
 *    because the next logged turn is what ends a queued row's life.
 *  - **Not already in the log**, matched on the squashed head rather than on
 *    equality: the log stores the prompt with whatever the CLI appended to it
 *    (an image note, a pasted-file expansion), so equality would redraw a turn
 *    that is plainly there.
 *  - **Bounded**, because a session can be typed into all day and the tail of
 *    this list is the part anybody is waiting on.
 *
 * Local commands are `screenCommandTurns`'s: those never reach the log at all,
 * which is a different fact needing a different row.
 */
/** How much of a prompt's head identifies it against the log's own copy. */
export const QUEUED_HEAD = 40;
/** Most queued rows a document will carry. */
export const QUEUED_MAX = 5;

/**
 * **Which `queued_command` attachments are the log's ONLY record of a prompt**,
 * by record uuid — the question `parseTranscript` has to answer before one of
 * them may open a turn.
 *
 * The CLI writes that attachment for every prompt it took out of the composer
 * queue, and then does one of two things. Usually it starts the prompt as a
 * turn of its own and writes a `user` record for it, in which case the
 * attachment is a duplicate and opening a turn on it would both double the
 * prompt and steal the running turn's remaining blocks — measured: 134 records
 * and four minutes sat between the two in one log. Sometimes it absorbs the
 * prompt into the turn already running and writes no `user` record at all, and
 * then the attachment is all there is.
 *
 * Which of the two happened is a fact about the whole file, not about the
 * record, so it is asked here and not in `queuedPromptOf`. The `queue-operation`
 * rows carry the CLI's own word for it (`reason: "absorbed_mid_turn"`), and it
 * is deliberately NOT what this reads: 78 of 151 of those rows had no matching
 * attachment at all and 5 of the remaining 73 were written the other way round
 * in the file, so a correlation on them answers wrongly about half the time.
 * The presence or absence of the prompt's own `user` record is the thing that
 * actually decides where the blocks belong, and it is what this asks.
 *
 * Matched on the squashed head with `queuedTurns`' prefix rule, and for its
 * reason: the log stores a prompt with whatever the CLI appended to it (an
 * image note, a pasted-file expansion), so equality would miss the duplicate
 * and draw the turn twice.
 *
 * Costs a second parse of the same lines, so it is gated on the file holding
 * such an attachment at all — measured: 78 of 1,375 logs on this desktop, and
 * the gate is a substring scan.
 */
export function absorbedOpeners(lines: string[]): Set<string> {
  const out = new Set<string>();
  if (!lines.some((l) => l.includes('"queued_command"'))) return out;
  const logged: string[] = [];
  const cand: { uuid: string; head: string }[] = [];
  for (const raw of lines) {
    const ln = raw.trim();
    if (!ln) continue;
    let rec: any;
    try { rec = JSON.parse(ln); } catch { continue; }
    const q = queuedPromptOf(rec);
    if (q != null) {
      const head = squash(q).slice(0, QUEUED_HEAD);
      const uuid = String(rec.uuid ?? "");
      if (head && uuid) cand.push({ uuid, head });
      continue;
    }
    // Both openers `parseTranscript` has. A local command counts: `/compact`
    // queued behind a turn reaches the log as its own envelope, and a turn
    // opened twice for it is the same duplicate.
    const text = promptOf(rec) ?? localCommandOf(rec);
    if (text == null) continue;
    const head = squash(text).slice(0, QUEUED_HEAD);
    if (head) logged.push(head);
  }
  for (const c of cand) {
    if (logged.some((h) => h.startsWith(c.head) || c.head.startsWith(h))) continue;
    out.add(c.uuid);
  }
  return out;
}

/**
 * **Words a person typed into a choice box, as the log recorded them.**
 *
 * An `AskUserQuestion` box with an "Other" field takes free text, and the phone
 * types it there through the ordinary send path — so it is in our history as a
 * prompt. The CLI never logs it as one: the words come back once, inside the
 * box's `tool_result` (`The user answered: "question"="words", …`). Nothing in
 * `queuedTurns` matched that, so both answers to a two-question box sat under
 * the reply as *the CLI has not started it yet* for ever — reported as "read
 * mode is not getting the latest output", and again it was the bookkeeping,
 * not the output.
 *
 * Kept OFF the document (a `WeakMap` on the parse result): it is a fact the
 * host needs to retire its own rows, not something the wire should carry, and
 * a `lite` parse drops tool results, so it cannot be read back off the blocks.
 */
export type BoxAnswer = { at: number; text: string };
export const BOX_ANSWER_LEAD = "The user answered";
export const boxAnswerTable = new WeakMap<object, BoxAnswer[]>();
/** The box answers `parseTranscript` saw in this document's log, oldest first. */
export function boxAnswersOf(doc: object | null | undefined): BoxAnswer[] {
  return (doc && boxAnswerTable.get(doc)) || [];
}

export function queuedTurns(entries: HistoryEntry[], logged: TranscriptTurn[], answers: BoxAnswer[] = []): TranscriptTurn[] {
  const newestLogged = logged.reduce((m, t) => Math.max(m, t.sentAt ?? 0), 0);
  const heads = logged.map((t) => squash(t.prompt).slice(0, QUEUED_HEAD)).filter(Boolean);
  const out: TranscriptTurn[] = [];
  for (const e of entries) {
    const text = (e.text ?? "").trim();
    if (!text || text.startsWith("/")) continue;      // a command is the other function's
    if (!(e.sentAt > newestLogged)) continue;
    const head = squash(text).slice(0, QUEUED_HEAD);
    if (!head || heads.some((h) => h.startsWith(head) || head.startsWith(h))) continue;
    // Typed into a box rather than the composer: the answer recorded after it
    // carries the words. Only a LATER answer — an older one with the same
    // words is a different send.
    if (answers.some((a) => a.at >= e.sentAt && a.text.includes(head))) continue;
    out.push({
      id: `queued:${e.id}`,
      n: 0,                                   // renumbered by `mergeLocalTurns`
      prompt: text.slice(0, TEXT_CAP),
      promptLabel: oneLine(text),
      sentAt: e.sentAt,
      blocks: [],
      toolCount: 0,
      files: [],
      sidechains: 0,
      queued: true,
    });
  }
  return out.slice(-QUEUED_MAX);
}

/**
 * Merge screen-only turns into a parsed document, in time order.
 *
 * Renumbering is the point: `n` is what the outline lists and what the reader
 * scrolls to, so a turn spliced into the middle without renumbering gives two
 * turns the same number and the outline lands on the wrong one. Anything
 * without a timestamp keeps its place rather than sorting to the front.
 */
export function mergeLocalTurns(turns: TranscriptTurn[], extra: TranscriptTurn[]): TranscriptTurn[] {
  if (!extra.length) return turns;
  // Stable by construction: every turn from the log carries a timestamp, and a
  // screen turn carries the moment waterplane typed it, so ties are the two records
  // of one act and either order reads correctly.
  const all = [...turns, ...extra].sort((a, b) => (a.sentAt ?? 0) - (b.sentAt ?? 0));
  return all.map((t, i) => ({ ...t, n: i + 1 }));
}

/**
 * Fallback for sessions with no conversation log yet (stub binary, a session
 * that hasn't produced output, hooks off): synthesize turns from the recorded
 * prompt + ANSI-stripped PTY capture. Approximate by construction — one opaque
 * text block per turn — but it keeps the reader view useful everywhere.
 */
export function transcriptFromHistory(entries: HistoryEntry[]): Omit<TranscriptDoc, "sessionId" | "source"> {
  const turns: TranscriptTurn[] = entries.map((e, i) => {
    const blocks: TranscriptBlock[] = e.output ? [{ kind: "text", text: e.output.slice(0, TEXT_CAP) }] : [];
    return {
      id: e.id,
      n: i + 1,
      prompt: e.text,
      promptLabel: oneLine(e.text),
      sentAt: e.sentAt,
      endedAt: e.outputAt,
      blocks,
      summary: e.output ? oneLine(e.output.trim().split("\n").filter(Boolean).slice(-1)[0] ?? "", 200) : undefined,
      toolCount: 0,
      files: [],
      sidechains: 0,
    };
  });
  // `full` is the honest label: there are no tool blocks here to have withheld
  // anything from, so the reader must not offer a "load details" affordance.
  return { turns, truncated: false, bytes: 0, updatedAt: entries.length ? entries[entries.length - 1].sentAt : 0, detail: "full" };
}
