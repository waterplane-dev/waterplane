/**
 * Forking a conversation: a second log file holding the first N turns of an
 * existing one, so a session can be reopened at the point BEFORE it went wrong.
 *
 * A session misreads the request and spends an hour down a wrong path. Today the
 * only moves are to let it finish, interject, or kill it and lose the good half
 * with it — all three expensive on a phone. What is missing is a way to say
 * "start again from turn 7", and the CLI does not offer one non-interactively:
 * `--fork-session` forks from the END, and `/rewind` is a TUI picker.
 *
 * So we write the file ourselves. That is only defensible because of two facts
 * about the format, both checked against real logs on this machine rather than
 * assumed:
 *
 * 1. **The message CHAIN points backward, but the bookkeeping does not.** Over
 *    132,320 `parentUuid` values in three projects' logs, not one names a record
 *    that appears later in its file; the same holds for `leafUuid`,
 *    `snapshotMessageId`, `logicalParentUuid` and the compact metadata's
 *    `headUuid`/`tailUuid`. So the conversation itself is a prefix-safe
 *    structure and there is no `parentUuid` to re-point and no `last-prompt` to
 *    patch.
 *
 *    What is NOT true — and the design note that preceded this file said it was,
 *    on the strength of one 399-record sample — is that *nothing* points
 *    forward. Two record kinds are written slightly AHEAD of the message they
 *    name, because the CLI writes them when a turn begins rather than when it
 *    lands: `file-history-snapshot.messageId`, and the `system` record that
 *    opens a compact, whose `compactMetadata.preservedSegment.anchorUuid` names
 *    the compact SUMMARY record that follows it. Simulating this function's cut
 *    at all 7,076 turn boundaries in four projects' logs, 4.8% of them left at
 *    least one such reference naming a record the cut had removed.
 *    `pruneStranded()` is the answer, and the note there explains why it is not
 *    cosmetic.
 *
 *    With that pruning, the prefix we keep is exactly the state the file was in
 *    when that line was its tail — a state the CLI itself wrote and has resumed
 *    before.
 *
 * 2. **The CLI's own `--fork-session` output is the template.** Three logs in
 *    `~/.claude/projects/-Users-me-dev-Tiptoi/` are one parent and two
 *    independent forks of it. Diffing the 1,241 records all three share, keyed
 *    by `uuid`:
 *
 *      - `sessionId` is rewritten on every copied record — 1,241 of 1,241.
 *      - `session_id` (the other spelling, which really does occur alongside it
 *        on `user`/`assistant`/`attachment`/`system` records) is NOT rewritten:
 *        all 1,226 copied records that carry it still name the PARENT in both
 *        forks. See the note on `rewriteInto()` — this is the one place where
 *        this module deliberately does less than a naive reading of "rewrite
 *        the session id" would do.
 *      - `uuid`, `parentUuid` and `timestamp` are untouched. That is what makes
 *        the backward-pointing property survive the copy at all: rewriting a
 *        uuid would orphan every reference to it.
 *      - The two sibling forks differ from EACH OTHER in exactly two keys:
 *        `sessionId` (by construction) and `promptId` (regenerated per fork on
 *        357 user records). We leave `promptId` alone — see below.
 *
 * The failure mode is contained by construction, which is the other half of why
 * this is allowed to be tried at all: **the source is opened read-only and is
 * never modified**, a fresh uuid is minted for the output, and so a malformed
 * result is a NEW file under a new id that nothing yet points at. The original
 * conversation is never the file we wrote. Two forks from one turn are simply
 * two files. `deleteArchived` stays the only way to lose a conversation.
 */
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { claudeProjectDir, promptOf, transcriptPath } from "./transcript.js";

/**
 * The same bare-id regex `deleteArchived` uses, for the same reason: an id
 * reaches `transcriptPath`, which is a `join` and would take `../../…`
 * perfectly happily. A traversal-shaped id is REFUSED rather than sanitised —
 * stripping the dots would silently fork some other directory's conversation,
 * and a refusal is a bug report where a sanitisation is a mystery.
 */
const BARE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

/**
 * Refuse to fork a source larger than this. `parseTranscript` gets to tail-read
 * a huge log because it only shows the newest turns; a fork needs the HEAD, so
 * it has to hold the whole file. 256 MB is far past any real conversation (the
 * largest here is single-digit MB) and exists so that a corrupted or
 * runaway file becomes an error message instead of an out-of-memory kill of the
 * daemon that is driving every other session on this machine.
 */
const MAX_SOURCE_BYTES = 256 * 1024 * 1024;

export type ForkOk = {
  /** The conversation id of the file just written. `--resume <newId>` opens it. */
  newId: string;
  /** Records copied. Useful in a log line; the caller has no other cheap count. */
  records: number;
  /** Lines that would not parse and were therefore dropped. Normally 0. */
  dropped: number;
  /** Bookkeeping records about the turn after the cut, removed by
   *  `pruneStranded()`. Fires on roughly one fork in twenty. */
  pruned: number;
};
export type ForkResult = ForkOk | { error: string };

/**
 * Rewrite one parsed record for the new conversation, and serialise it.
 *
 * Only `sessionId` moves. The evidence for leaving `session_id` alone is in the
 * header; the ARGUMENT for it, which is what makes it more than cargo-culting
 * the CLI's output, is that the two fields answer different questions. On a
 * natively forked log, `sessionId` is uniform across the whole file and
 * `session_id` is not: copied records keep the parent's, records the fork itself
 * produced carry the fork's. So `sessionId` is "which conversation file is this
 * record part of" — a property of the file, which must be rewritten or the
 * records do not belong to it — while `session_id` is "which session actually
 * produced this record", which is provenance, and for the records we copy the
 * honest answer is still the source session. Rewriting it would make the fork
 * claim it produced turns it did not.
 *
 * `promptId` is left alone too, where the CLI mints a fresh one. Nothing in the
 * format points at a `promptId` — every backward reference names a `uuid` — so
 * regenerating it buys no consistency, and it would put nondeterminism in the
 * output of a function whose whole safety story is that you can diff its result
 * against the source and see that only one field moved.
 *
 * `JSON.stringify` on a `JSON.parse` result is byte-identical to the input for
 * everything the CLI writes: key insertion order is preserved, the CLI's own
 * lines are compact (no spaces), and `JSON.parse` can produce no value —
 * `undefined`, `NaN`, a function — that would serialise differently. Verified
 * over a real 197-record log, all 197 round-tripping exactly.
 */
/**
 * Keys whose value is the `uuid` of another RECORD in the same log.
 *
 * The list is short and closed on purpose, because the format is full of ids
 * from other namespaces that look identical and resolve to nothing: `id`,
 * `tool_use_id` and `toolUseID` are API message and tool-call ids, and across
 * 100,808 of them in three projects' logs not one named a record uuid. Treating
 * those as references would make `pruneStranded()` delete most of the
 * conversation. The eight below resolve essentially always — 146,849 hits, 8
 * misses, all of them `messageId` on a snapshot whose message is not in the file
 * at all — which is what makes "not in the prefix" a sound reading of "the cut
 * removed it" without a second parse of everything past the cut.
 */
const REF_KEYS = new Set([
  "parentUuid", "logicalParentUuid", "leafUuid", "snapshotMessageId",
  "messageId", "headUuid", "tailUuid", "anchorUuid",
]);

/**
 * Subtrees never walked when collecting references. `message` and
 * `toolUseResult` hold the API payload — every `id`/`tool_use_id` above lives
 * there, none of the eight keys does, and between them they are ~all the bytes
 * of a log. Skipping them is a correctness rule first and a cost rule second.
 */
const REF_SKIP = new Set(["message", "toolUseResult"]);

/** Every record-uuid this record names, at any depth outside the skipped subtrees. */
function referencedUuids(o: unknown, out: string[] = [], depth = 0): string[] {
  if (depth > 8 || o == null || typeof o !== "object") return out;
  if (Array.isArray(o)) { for (const v of o) referencedUuids(v, out, depth + 1); return out; }
  for (const [k, v] of Object.entries(o as Record<string, unknown>)) {
    if (REF_SKIP.has(k)) continue;
    if (REF_KEYS.has(k) && typeof v === "string") out.push(v);
    referencedUuids(v, out, depth + 1);
  }
  return out;
}

/**
 * Drop the records in the prefix that are ABOUT a turn the cut removed.
 *
 * This exists because of one measured case, and it is worth stating in full
 * because the obvious reading — "a dangling id in a bookkeeping record, who
 * cares" — is wrong in exactly the situation the feature is for.
 *
 * A `/compact` writes a `system` record carrying `compactMetadata`, and then a
 * `user` record carrying the SUMMARY of everything it dropped. `promptOf`
 * accepts that summary as a real prompt — correctly; it is what the reader shows
 * as a turn — so a fork at the last turn BEFORE a compact cuts between the two.
 * The prefix then keeps the instruction to discard the pre-compact history and
 * loses the summary that was standing in for it. Observed, not reasoned: a
 * two-turn conversation forked that way could name only its second turn, where
 * the same fork with this `system` record pruned named both. So the pruning is
 * the difference between "fork from turn N" meaning what it says and a fork that
 * silently arrives with less history than either the original or the turn number
 * promises.
 *
 * The other 99% of the class is `file-history-snapshot`, whose `messageId` names
 * the first message of the turn we cut away. Those are harmless — a resume with
 * one dangling was verified to work — but they are the same fact (a record about
 * a turn that is no longer here), so they go the same way rather than by a
 * second rule.
 *
 * Bounded and conservative: only a record naming a uuid that is absent from the
 * prefix is dropped, so a chain record can never be — `parentUuid` always points
 * backward, and everything backward is in the prefix by construction. Over 7,076
 * simulated cuts this removed only `file-history-snapshot` (838) and compact
 * `system` (8) records, never a `user`, `assistant` or `attachment`, left zero
 * stranded references behind, never lost the turn the cut was aimed at, and
 * reached a fixed point in a single pass every time. The loop is capped anyway: a rule
 * that can delete records must not be able to delete all of them because of a
 * format change nobody has seen yet.
 */
function pruneStranded(recs: unknown[]): { kept: unknown[]; pruned: number } {
  let kept = recs;
  let pruned = 0;
  for (let pass = 0; pass < 4; pass++) {
    const have = new Set(
      kept.map((r) => (r as { uuid?: unknown } | null)?.uuid).filter((u): u is string => typeof u === "string"),
    );
    const next = kept.filter((r) => !referencedUuids(r).some((u) => !have.has(u)));
    if (next.length === kept.length) break;
    pruned += kept.length - next.length;
    kept = next;
  }
  return { kept, pruned };
}

function rewriteInto(rec: unknown, newId: string): string {
  if (rec && typeof rec === "object" && typeof (rec as { sessionId?: unknown }).sessionId === "string") {
    (rec as { sessionId: string }).sessionId = newId;
  }
  return JSON.stringify(rec);
}

/**
 * Write a new conversation log holding `sourceId`'s history up to and including
 * the turn whose prompt record has uuid `atTurnUuid`, and return its new id.
 *
 * **The cut point is a TURN boundary, not a record.** We find the record with
 * that uuid — which for a turn is the prompt record, since `parseTranscript`
 * names a turn after exactly that — and then keep going until the next record
 * `promptOf()` accepts as a real user prompt (or EOF), cutting immediately
 * BEFORE it. That is what makes the fork resumable rather than merely
 * well-formed: everything the turn produced after its prompt — the assistant's
 * response, its tool calls, the `tool_result` records that answer them, the
 * attachments, the `file-history-*` bookkeeping — rides along, so the kept
 * prefix ends on a completed exchange instead of a dangling `tool_use` the
 * model would be asked to resume in the middle of.
 *
 * `promptOf` is IMPORTED, never re-implemented. It is the rule that already
 * decides what counts as a real prompt rather than a hook echo, a slash-command
 * envelope, a tool result or a resume caveat, and `archive.ts`'s header explains
 * at length what a second copy of it costs: the visible symptom of the drift is
 * an archive row titled `<command-name>`, and the symptom here would be a fork
 * cut in the middle of a turn because a `<system-reminder>` read as a prompt.
 *
 * A line that will not parse is DROPPED rather than aborting the fork. The one
 * way that happens in practice is a half-written tail: a live session is
 * appending to this file while we read it, and we caught it mid-line. Dropping
 * is safe for exactly the reason the whole feature is safe — every reference
 * points backward, so a record nobody has written yet is a record nobody can
 * reference — and it is the right call over aborting because the alternative is
 * a feature that fails whenever the session you want to fork is busy, which is
 * precisely when you want to fork it.
 */
export function forkConversationFile(cwd: string, sourceId: string, atTurnUuid: string): ForkResult {
  if (!BARE_ID.test(sourceId)) return { error: "bad id" };
  // The turn uuid never reaches the filesystem — it is compared against record
  // uuids — but a shape check turns "some id from a stale cached transcript"
  // into an immediate refusal instead of a full read of a multi-MB log that was
  // never going to match.
  if (!BARE_ID.test(atTurnUuid)) return { error: "bad turn" };

  const path = transcriptPath(cwd, sourceId);
  let st;
  try { st = statSync(path); } catch { return { error: "no such conversation" }; }
  if (!st.isFile()) return { error: "not a conversation" };
  if (st.size > MAX_SOURCE_BYTES) return { error: "conversation too large to fork" };

  let text: string;
  try { text = readFileSync(path, "utf8"); } catch { return { error: "read failed" }; }

  const newId = randomUUID();
  const prefix: unknown[] = [];
  let found = false;
  let dropped = 0;

  for (const raw of text.split("\n")) {
    const ln = raw.trim();
    if (!ln) continue;
    let rec: unknown;
    try { rec = JSON.parse(ln); } catch { dropped += 1; continue; } // half-written tail of a live turn
    // The break is checked BEFORE the push and only once the target has been
    // seen, so a prompt record earlier in the file cannot end the copy and the
    // target's own prompt record cannot end it either.
    if (found && promptOf(rec) != null) break;
    prefix.push(rec);
    if (!found && (rec as { uuid?: unknown } | null)?.uuid === atTurnUuid) found = true;
  }

  // A uuid that is not in this file is an error, never an empty (or whole-file)
  // fork. Silently forking everything would be the worst possible answer to
  // "fork at turn 7": it looks like it worked.
  if (!found) return { error: "turn not found" };

  const { kept: keptRecs, pruned } = pruneStranded(prefix);
  const kept = keptRecs.map((r) => rewriteInto(r, newId));

  const dir = claudeProjectDir(cwd);
  const out = join(dir, newId + ".jsonl");
  // Astronomically unlikely, and checked anyway because the one invariant this
  // module sells is that it never writes over a conversation that already exists.
  if (existsSync(out)) return { error: "id collision" };

  // tmp+rename, the house discipline: the CLI or `archive.ts` may `readdir` this
  // directory at any moment, and a partially written `<id>.jsonl` is an archive
  // row that resumes into a truncated conversation. The tmp name deliberately
  // does not end in `.jsonl`, so it is invisible to that listing even in the
  // window before the rename.
  const tmp = join(dir, `.${newId}.jsonl.tmp`);
  try {
    writeFileSync(tmp, kept.join("\n") + "\n", "utf8");
    renameSync(tmp, out);
  } catch {
    try { unlinkSync(tmp); } catch { /* never existed, or already gone */ }
    return { error: "write failed" };
  }

  return { newId, records: kept.length, dropped, pruned };
}
