/**
 * The question the CLI is asking, read from the CLI's own conversation log
 * rather than off the screen.
 *
 * `prompt.ts` scrapes a rendered terminal, which is the only source for a tool
 * approval or a trust dialog — but `AskUserQuestion` is a TOOL CALL, and its
 * input (the question, every option's label AND its full description) is written
 * to `~/.claude/projects/<slug>/<uuid>.jsonl` the moment the assistant asks,
 * before anyone answers. That text is complete; the screen's copy is not:
 *
 *   • descriptions are truncated at the right edge, and cut again by the preview
 *     pane the newer box draws beside the options,
 *   • a six-option box with a description each is TALLER than a phone's terminal,
 *     so the question and the first options scroll off entirely.
 *
 * A one-tap button reading "A + B + C" with the paragraph that explains it
 * nowhere on the phone is a button you cannot honestly press. So the detected
 * box is ENRICHED from here: same indices, same keystrokes, real words.
 *
 * Read-only, best-effort, and heuristic in exactly the way `transcript.ts` is —
 * the record shape is the CLI's internal format, not a contract. Nothing here
 * may throw into the prompt path: every failure returns null and the scraped box
 * is published unchanged.
 */
import { closeSync, openSync, readSync, statSync } from "node:fs";
import { transcriptPath } from "./transcript.js";

/**
 * Tail bytes scanned. A PENDING tool call is by construction the last thing in
 * the log, so this needs to cover one exchange, not the conversation —
 * `transcript.ts`'s 24 MB budget is for rendering the whole thing and would be
 * absurd on a poll that runs while a box is up.
 */
const TAIL_BYTES = 512 * 1024;
/** Caps, so a pathological input can't push a wire message to megabytes. */
const MAX_OPTIONS = 12;
const DESC_CAP = 600;
const QUESTION_CAP = 400;

export interface AskOption { label: string; desc?: string }
export interface AskQuestion {
  /**
   * This question's identity: the pending call's `tool_use` id, plus which of
   * its questions this is (`<toolUseId>#<n>`).
   *
   * The CLI mints the id, it is in the log before anyone answers, and it is the
   * one thing about a box on screen that a repaint cannot change — which is
   * exactly what `prompt.ts`'s `sameBox` needs and could not otherwise get.
   * Everything scrapeable moves: a box taller than the terminal loses its
   * question row, and what the detector then joins above option 1 is whatever
   * happens to be there.
   *
   * The `#n` is not decoration. One `AskUserQuestion` may carry several
   * questions and the TUI draws them one at a time with Tab between them, so
   * the tool_use id alone would call two different boxes one box.
   */
  id: string;
  question: string;
  header?: string;
  multi?: boolean;
  options: AskOption[];
}

const str = (v: unknown, cap: number): string | undefined => {
  if (typeof v !== "string") return undefined;
  const t = v.replace(/\s+/g, " ").trim();
  return t ? t.slice(0, cap) : undefined;
};

/**
 * Every `AskUserQuestion` in the log's tail that has no `tool_result` yet.
 *
 * "No result" is what makes it the box currently on screen. The pairing is done
 * over the tail only: a tool_use older than the window is invisible here, which
 * yields no enrichment — never a WRONG one, since a result always follows its
 * call and both would be in the window together.
 */
export function pendingAskQuestions(cwd: string, claudeSessionId: string | undefined): AskQuestion[] {
  if (!claudeSessionId) return [];
  const raw = logTail(cwd, claudeSessionId);
  if (raw == null) return [];
  return pendingIn(raw);
}

/**
 * The newest log record carrying an `AskUserQuestion` call, as the raw line —
 * the input to the `askbox.enrich` fixture capture, which keeps only its
 * skeleton (`clifixtures.ts`). Null when there is none.
 */
export function pendingAskRecord(cwd: string, claudeSessionId: string | undefined): string | null {
  if (!claudeSessionId) return null;
  const lines = (logTail(cwd, claudeSessionId) ?? "").split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!lines[i].includes("AskUserQuestion")) continue;
    try {
      const content = JSON.parse(lines[i])?.message?.content;
      if (Array.isArray(content) && content.some((b: any) => b?.type === "tool_use" && b?.name === "AskUserQuestion")) return lines[i];
    } catch { /* not a record */ }
  }
  return null;
}

/** The log's last `TAIL_BYTES`, starting on a whole record; null when unreadable. */
function logTail(cwd: string, claudeSessionId: string): string | null {
  let raw: string;
  try {
    const path = transcriptPath(cwd, claudeSessionId);
    const st = statSync(path);
    const start = Math.max(0, st.size - TAIL_BYTES);
    const len = st.size - start;
    if (len <= 0) return null;
    const buf = Buffer.allocUnsafe(len);
    const fd = openSync(path, "r");
    try { readSync(fd, buf, 0, len, start); } finally { closeSync(fd); }
    raw = buf.toString("utf8");
    if (start > 0) raw = raw.slice(raw.indexOf("\n") + 1); // first line of a tail-read is half a record
  } catch { return null; }
  return raw;
}

/**
 * The questions of ONE call, from its input as a `PreToolUse` hook carried it —
 * the source while the log does not hold the call yet. Unless the log already
 * shows it ANSWERED: then the box on screen is not this call's.
 */
export function asksFromCall(cwd: string, claudeSessionId: string | undefined, call: { id: string; input: unknown }): AskQuestion[] {
  const raw = claudeSessionId ? logTail(cwd, claudeSessionId) : null;
  if (raw?.includes(`"tool_use_id":${JSON.stringify(call.id)}`)) return [];
  return parseAsk(call.input, call.id);
}

function pendingIn(raw: string): AskQuestion[] {
  const asks = new Map<string, AskQuestion[]>();
  const answered = new Set<string>();
  const order: string[] = [];
  for (const line of raw.split("\n")) {
    // Cheap reject before JSON.parse: most lines are tool results and text.
    if (!line || (!line.includes("AskUserQuestion") && !line.includes("tool_result"))) continue;
    let rec: any;
    try { rec = JSON.parse(line); } catch { continue; }
    const content = rec?.message?.content;
    if (!Array.isArray(content)) continue;
    for (const b of content) {
      if (!b || typeof b !== "object") continue;
      if (b.type === "tool_result" && typeof b.tool_use_id === "string") { answered.add(b.tool_use_id); continue; }
      if (b.type !== "tool_use" || b.name !== "AskUserQuestion" || typeof b.id !== "string") continue;
      const qs = parseAsk(b.input, b.id);
      if (qs.length) { asks.set(b.id, qs); order.push(b.id); }
    }
  }
  // Newest unanswered call wins: a box re-asked after a refusal leaves the older
  // one stranded in the same window.
  for (let i = order.length - 1; i >= 0; i--) {
    const id = order[i];
    if (!answered.has(id)) return asks.get(id)!;
  }
  return [];
}

function parseAsk(input: unknown, id: string): AskQuestion[] {
  const list = (input as any)?.questions;
  if (!Array.isArray(list)) return [];
  const out: AskQuestion[] = [];
  let n = -1;
  for (const q of list) {
    // Counted over the RAW list, not over what survives the filter below: the
    // index has to name the question's place in the call the CLI is drawing.
    n++;
    const question = str(q?.question, QUESTION_CAP);
    const opts = Array.isArray(q?.options) ? q.options : [];
    const options: AskOption[] = [];
    for (const o of opts.slice(0, MAX_OPTIONS)) {
      const label = str(o?.label, 200);
      if (!label) continue;
      options.push({ label, ...(str(o?.description, DESC_CAP) ? { desc: str(o?.description, DESC_CAP)! } : {}) });
    }
    if (!question || options.length < 2) continue;
    out.push({
      id: `${id}#${n}`,
      question,
      ...(str(q?.header, 40) ? { header: str(q?.header, 40)! } : {}),
      ...(q?.multiSelect ? { multi: true } : {}),
      options,
    });
  }
  return out;
}

/** Normalized label, for matching a scraped row against the log's own text. The
 *  screen's copy loses characters to truncation and to the preview pane, so the
 *  comparison is prefix-based rather than equality. */
const key = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

/**
 * Does this logged question describe the box we scraped?
 *
 * Matched on LABELS, not on the question text: the question is exactly the row
 * that scrolls off a tall box, so requiring it would fail precisely when the
 * enrichment matters most.
 *
 * Two labels have to agree, and they have to be a majority of the SMALLER side.
 * One is never enough — two questions in a row can both offer "Yes", and putting
 * the previous box's paragraphs under this one's buttons is worse than showing
 * no paragraphs at all. The smaller side is what keeps the rule usable in both
 * directions the two lists differ: the TUI appends rows the tool never sent
 * ("Type something."), and a truncated screen shows only the tail of the tool's.
 */
export function askMatches(ask: AskQuestion, labels: readonly string[]): boolean {
  const seen = labels.map(key).filter(Boolean);
  if (!seen.length) return false;
  let hit = 0;
  for (const o of ask.options) {
    const k = key(o.label);
    if (!k) continue;
    // The scraped row is a PREFIX of the real label when the terminal cut it
    // (and never the other way round), so test containment in that direction.
    if (seen.some((s) => k === s || (s.length >= 6 && k.startsWith(s)))) hit++;
  }
  return hit >= 2 && hit * 2 >= Math.min(ask.options.length, seen.length);
}

/**
 * How many of `ask`'s labels the scraped run agrees with. The matcher's own
 * arithmetic, exposed so `pickAsk` can COMPARE two candidates instead of
 * taking the first that passes.
 */
function askHits(ask: AskQuestion, labels: readonly string[]): number {
  const seen = labels.map(key).filter(Boolean);
  let hit = 0;
  for (const o of ask.options) {
    const k = key(o.label);
    if (!k) continue;
    if (seen.some((sv) => k === sv || (sv.length >= 6 && k.startsWith(sv)))) hit++;
  }
  return hit;
}

/**
 * WHICH logged question is the box on screen — or nothing, if two of them
 * could be.
 *
 * `asks.find(askMatches)` took the FIRST question of the call that overlapped,
 * and one `AskUserQuestion` may carry several. Two questions sharing two labels
 * is not exotic — "Yes"/"No" appear in both halves of most pairs — so after a
 * Tab to question 2 the matcher could hand back question 1, which then supplied
 * question 1's `askId` (so `sameBox` called the new box the old one), question
 * 1's descriptions, and question 1's first options as the "recovered" head that
 * a digit would select. Every one of those is a wrong number where the rule is
 * that a heuristic degrades to absent.
 *
 * So: score every candidate and require a UNIQUE winner. A tie means the screen
 * does not say which question it is showing, and the honest answer to that is
 * no enrichment at all — the box is still published, with the labels as the
 * terminal cut them.
 */
export function pickAsk(asks: readonly AskQuestion[], labels: readonly string[]): AskQuestion | null {
  let best: AskQuestion | null = null;
  let bestHits = 0;
  let tied = false;
  for (const a of asks) {
    if (!askMatches(a, labels)) continue;
    const hits = askHits(a, labels);
    if (!best || hits > bestHits) { best = a; bestHits = hits; tied = false; }
    else if (hits === bestHits) tied = true;
  }
  return tied ? null : best;
}

/**
 * The options a TALL box scrolled off the top, recovered from the log.
 *
 * A box with six options and a description each is taller than a phone's
 * terminal, so the CLI scrolls its own top away and the strict pass publishes a
 * run starting at 4. The card then says "options above 4 are off the screen" and
 * offers three buttons for a six-option question — the complaint this answers.
 *
 * The recovery is EXACT rather than heuristic, because the TUI's numbering is
 * the tool's own: measured on claude 2.1.267, the list it draws is
 * `[...the tool's options, "Other", ("Chat about this")]` numbered from 1, so
 * the log's option *i* is the row a keystroke of *i* selects. What comes back is
 * the head (indices 1..first-1) with the words the tool wrote, prepended to the
 * run exactly as it was scraped.
 *
 * Two rules keep it honest:
 *
 *   • it must be PROVED, not assumed. At least one index the two lists share has
 *     to agree (prefix-wise, since the screen cuts a label and the log does
 *     not), and no shared index may disagree. A run made up entirely of the
 *     TUI's own appended rows overlaps nothing and returns null — absent, never
 *     a wrong number.
 *   • it only ever ADDS. A label already on screen is left exactly as scraped,
 *     because `promptFingerprint` is built from the labels and rewriting one
 *     would make an answer already queued against this box read as stale.
 */
export function recoverHead(ask: AskQuestion, options: readonly { index: number; label: string }[]): AskOption[] | null {
  const first = options[0]?.index ?? 1;
  if (first <= 1) return null;
  if (ask.options.length < first) return null;   // the log cannot reach up to this run
  let agreed = 0;
  for (const o of options) {
    const logged = ask.options[o.index - 1];
    if (!logged) continue;                       // a row the TUI appended ("Other")
    const k = key(logged.label);
    const s = key(o.label);
    if (!k || !s) continue;
    if (k !== s && !(s.length >= 6 && k.startsWith(s))) return null;
    agreed++;
  }
  if (agreed < 1) return null;
  return ask.options.slice(0, first - 1);
}

/** The description the log holds for a scraped label, if any. */
export function descFor(ask: AskQuestion, label: string): string | undefined {
  const s = key(label);
  if (!s) return undefined;
  const exact = ask.options.find((o) => key(o.label) === s);
  if (exact) return exact.desc;
  if (s.length < 6) return undefined;
  return ask.options.find((o) => key(o.label).startsWith(s))?.desc;
}
