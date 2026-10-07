/**
 * What a session has SAID and what is written down about it: the prompt +
 * captured-output history, the reader's transcript, word search, and the
 * unattended tab-name spend (off the first prompt) with the two per-session
 * stores they persist to (`<state dir>/history/`, `<state dir>/summaries/`).
 *
 * Stateless: every function takes the session manager's `SessionCore` first
 * and reaches shared state and other slices only through it. Moved verbatim
 * out of `sessions.ts` (package S11 of docs/notes/host-architecture.md).
 *
 * `runSummaryTask` is the engine seam the tab-name call goes through — its
 * flags live in `sidecar.ts` and the prompt in `knobs.ts`.
 */
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { hostStateDir } from "../branddirs.js";
import { renderCapture } from "../render.js";
import type { HistoryEntry, SessionSearchMatch, SessionSearchResult, SessionSearchScope, TranscriptDoc } from "@waterplane/shared";
import { cleanTabTitle } from "@waterplane/shared";
import { namesStoreReader } from "../backends/index.js";
import { boxAnswersOf, lastTurnAt as readLastTurnAt, logMtime, mergeLocalTurns, parseTranscript, queuedTurns, screenCommandTurns, transcriptFromHistory, transcriptPath } from "../transcript.js";
import { agentsMtime } from "../turnagents.js";
import { scanHistory, scanPrompts, scanText, searchResult } from "../sessionSearch.js";
import { runSummaryTask } from "../sidecar.js";
import { promptText } from "../prompts.js";
import { liveSourceFor } from "../livesources.js";
import type { ClosedRow, Session, SessionCore } from "./core.js";
import {
  HISTORY_LIMIT, OUTPUT_CAP, SUMMARY_MODEL, TAB_TITLE_SYSTEM, TAB_TITLE_PROMPT, NAME_INPUT_CHARS,
  RENAME_PROMPT, RENAME_RECENT_PROMPTS, RENAME_RECENT_CHARS,
} from "./knobs.js";
import { writeJsonAtomic } from "../jsonstore.js";

// ── History (prompt + captured output) ──────────────────────────────

/**
 * Record a prompt sent to a session and start capturing its turn's output.
 * Any still-pending capture is sealed first (covers back-to-back prompts where
 * the session never went idle between them). Emits 'history' so attached
 * clients update live.
 */
export function recordPrompt(core: SessionCore, id: string, text: string, kind: HistoryEntry["kind"]): void {
  const s = core.sessions.get(id);
  if (!s) return;
  // A SHELL keeps no prompt history (`caps.turns === false`): its "prompts" are
  // commands — a token pasted into `export`, a password into a login — and
  // `history/<id>.json`, the reader, the closed row and session search would
  // keep each one on disk for good. Nothing to capture either: no turns.
  if (s.backend.caps.turns === false) return;
  finalizeCapture(core, s); // seal any prior turn before opening a new one
  const entry: HistoryEntry = { id: randomUUID().slice(0, 8), kind, text: text.slice(0, 4000), sentAt: Date.now() };
  s.history.push(entry);
  if (s.history.length > HISTORY_LIMIT) s.history.splice(0, s.history.length - HISTORY_LIMIT);
  s.capturing = entry.id;
  s.captureBuf = "";
  // The second rung of the opencode id discovery, armed HERE because this is
  // the one place in the daemon that knows a delivery was CONFIRMED: the
  // caller (`deliver.ts`) reaches this line only after the text was seen in
  // the composer. The prompt is about to become a user message in opencode's
  // store, and an exact match on it names the conversation a `--continue`
  // never told us. Only while the id is still unknown, and only for a backend
  // whose record this host can read — for everything else it is a field that
  // is never set and never read.
  //
  // …and the rung is LOOKED at here, and the watcher RE-ARMED if it had
  // stopped, which is the other half of the same thought. It runs 60 ticks
  // from the spawn and then gives up, so a `--continue` session whose first
  // prompt landed six minutes in had its probe stored into a watcher that was
  // never going to look again: the rung existed, the evidence arrived, and the
  // reader stayed on its approximate document for the life of the session.
  //
  // The pass here almost never adopts — it cannot, because a rung-2 match has
  // to stand for a second look (`ocIdVerdict`) and this is the first. What it
  // does is START that clock at the delivery instead of up to five seconds
  // later, so the confirmation lands on the very next tick. Re-arming costs a
  // poll only while an id is still unknown, and the first thing an adoption
  // does is stop it.
  if (!s.info.backendSessionId && namesStoreReader(s.backend.caps)) {
    s.storePromptProbe = { text, at: entry.sentAt };
    // A new prompt is a new question: a sighting of the OLD probe's match is
    // not evidence about this one.
    s.storeIdCarry = null;
    core.adoptBackendId(s, core.detectBackendId(s));
    if (!s.info.backendSessionId && !s.storeIdTimer) core.watchBackendId(s);
  }
  saveHistory(core, s);
  core.applyPromptLabels(s);       // refresh first/last overview label
  core.emit("history", id, s.history);
  core.emit("updated", s.info);
}

export function getHistory(core: SessionCore, id: string): HistoryEntry[] {
  return core.sessions.get(id)?.history ?? [];
}

/** A contributed reader's answer, or `fallback` when it threw: a store that cannot be read is absent. */
function tryRead<T>(fn: () => T, fallback: T): T {
  try { return fn(); } catch { return fallback; }
}

/**
 * Structured transcript for a session — the reader view behind the terminal.
 * Prefers the CLI's own conversation log (exact turns/tools); falls back to
 * the recorded prompt+PTY-capture history when there's no log yet (stub
 * binary, a session that hasn't produced output). Works for a session that's
 * merely CLOSED too, as long as we still remember its conversation id.
 */
export function getTranscript(core: SessionCore, id: string, since = 0, detail: "lite" | "full" = "lite"): TranscriptDoc | "unchanged" | null {
  const store = core.storeFor(id);
  if (store) {
    const reader = store.reader;
    if (store.convId && reader) {
      const convId = store.convId;
      // The poll is answered from ONE indexed `MAX(time_updated)` per table,
      // which is this store's equivalent of the log's mtime — the thing that
      // makes a reader open on a five-megabyte conversation cost nothing while
      // nothing is happening in it.
      //
      // The STORE's stamp and nothing else. This used to carry the host's own
      // `localAt` beside it "for the same reason it does on the claude path",
      // which was that path's reasoning quoted where it is not true: nothing
      // from this host's history is ever merged into an opencode document, so
      // a re-read prompted by `localAt` returns a byte-identical document. It
      // was not free — opencode is hookless, the silence seal stamps `localAt`
      // about four seconds AFTER the last store write, and from then until the
      // next write every poll from an open reader forced a full synchronous
      // SQLite read and fold on the loop that pumps every PTY and re-shipped
      // the whole document. `ocPollUnchanged` states it once, where the reason
      // is written down.
      //
      // …unless the backend's side channel supplies the stamp
      // (`sources.transcript.updatedAt`, design §4: the SSE supplies `updatedAt`,
      // the document stays the DB reader's). Null from the source = it cannot
      // say, and the store's own stamp is asked exactly as before.
      const stamp = sourceStamp(id) ?? tryRead(() => reader.updatedAt(convId), null);
      // The STORE's stamp alone answers the idle poll — with ONE addition,
      // and it is the window the queued row exists for. A prompt this app has
      // just typed into a busy session is in our history and in nothing the
      // store will write until the binary takes it, so a document refused on
      // the store's stamp is a document that cannot carry it. Bounded by
      // construction: `updatedAt` is raised to the same stamp below, so the
      // NEXT poll is back to the cheap comparison and an idle session still
      // costs one indexed read.
      const storeLocalAt = store.live?.history.length ? store.live.history[store.live.history.length - 1].sentAt : 0;
      if (tryRead(() => reader.pollUnchanged(stamp, since), false) && !(storeLocalAt > since)) return "unchanged";
      const parsed = tryRead(() => reader.transcript(convId, detail), null);
      // `claudeSessionId` is ABSENT here and always will be — see
      // `octranscript.ts`'s header. The document's own id rides on
      // `SessionInfo.backendSessionId`, which the client already has.
      if (parsed) {
        // The holding is the TUI's, not claude's: this store also records a
        // prompt only once the binary takes it, so a prompt typed into a busy
        // opencode session is missing from its reader for exactly the same
        // minutes. Same rule, same row, one implementation.
        const queued = store.live ? queuedTurns(store.live.history, parsed.turns) : [];
        if (queued.length) {
          parsed.turns = mergeLocalTurns(parsed.turns, queued);
          parsed.updatedAt = Math.max(parsed.updatedAt, storeLocalAt);
        }
        return { sessionId: id, source: reader.source, ...parsed };
      }
    }
    // No id adopted yet (a `--continue`, or a tie the watcher will not break),
    // or a store this desktop cannot read. The reader falls back to the SAME
    // approximate document it has always had for a session with no log —
    // labelled `history`, which every client already special-cases — rather
    // than to a spinner. That fallback is what makes "stay absent when the
    // answer is ambiguous" affordable, and it is the precondition for
    // `caps.transcript` being true for this backend at all.
    //
    // No `noteLogHealth` on either branch: the health board measures how well
    // this app's readers track the CLAUDE TUI, and `backends/opencode.ts` is
    // out of that scope by declaration.
    if (!store.live) return null;
    const hist = transcriptFromHistory(store.live.history);
    if (since && hist.updatedAt && hist.updatedAt <= since) return "unchanged";
    return { sessionId: id, source: "history", ...hist };
  }
  const fromSource = sourceTranscript(core, id, since, detail);
  if (fromSource !== undefined) return fromSource;
  const log = core.logFor(id);
  if (!log) return null;
  const { cwd, cid, live } = log;
  if (cid) {
    const path = transcriptPath(cwd, cid);
    const mtime = logMtime(path);
    // The newest thing the daemon itself recorded for this session. It rides beside
    // the log's mtime in the poll below because a TUI-local command moves
    // neither the log nor its mtime (the CLI writes nothing for a `/btw`),
    // and answering "unchanged" off the log alone is what kept a command
    // typed thirty seconds ago out of an open reader until something else
    // happened to write to the log.
    const localAt = live?.history.length ? live.history[live.history.length - 1].outputAt ?? live.history[live.history.length - 1].sentAt : 0;
    // Answer a poll from the stat — a busy conversation log is tens of MB and
    // re-parsing it every few seconds to discover nothing changed is waste.
    // …and the subagents' logs: a background agent writes for minutes while
    // the parent log sleeps, and its turn's footer is counting what it spends.
    if (mtime != null && since && Math.max(mtime, localAt, agentsMtime(path)) <= since) return "unchanged";
    const parsed = parseTranscript(path, cwd, detail);
    if (parsed) {
      // Commands the log never wrote down (`/btw`), from our own PTY capture,
      // spliced in by time. The log's own local commands are already turns by
      // now (`local: "log"`) and `screenCommandTurns` skips those, so nothing
      // is said twice.
      const screen = live ? screenCommandTurns(live.history, parsed.turns) : [];
      if (screen.length) {
        parsed.turns = mergeLocalTurns(parsed.turns, screen);
        parsed.updatedAt = Math.max(parsed.updatedAt, localAt);
      }
      // …and what we have typed in that the CLI is still HOLDING. A prompt
      // delivered into a mid-turn session sits in the composer until the turn
      // ends, and the log says nothing about it until then, so the newest
      // thing the person sent was missing from every reader for as long as
      // the running turn lasted. Computed AFTER the screen turns, against the
      // merged list, so a local command already spliced in counts as "the log
      // has moved past this" for anything older.
      const queued = live ? queuedTurns(live.history, parsed.turns, boxAnswersOf(parsed)) : [];
      if (queued.length) {
        parsed.turns = mergeLocalTurns(parsed.turns, queued);
        parsed.updatedAt = Math.max(parsed.updatedAt, localAt);
      }
      // A log with bytes in it that parses to no turns at all is the record
      // shape having moved under us — which is the failure worth naming,
      // since this log is the witness that settles everything a screen
      // cannot. An EMPTY file is not that: the CLI creates it before it has
      // anything to write.
      core.noteLogHealth(live, parsed.turns.length ? "good" : parsed.bytes > 0 ? "miss" : null,
        `${parsed.bytes} bytes, ${parsed.turns.length} turns`);
      return { sessionId: id, claudeSessionId: cid, source: "jsonl", ...parsed };
    }
  }
  if (!live) return null;
  const hist = transcriptFromHistory(live.history);
  // Falling back to OUR OWN record of what we typed. It keeps the reader view
  // useful and it is not the same witness: `settle.ts` refuses to prove
  // anything from it, precisely because a prompt that echoed and was never
  // submitted is in it.
  core.noteLogHealth(live, "fallback", `${live.history.length} recorded turns`);
  if (since && hist.updatedAt && hist.updatedAt <= since) return "unchanged";
  return { sessionId: id, claudeSessionId: cid, source: "history", ...hist };
}

/** The live side channel's change stamp for this session's conversation, or
 *  null when there is no `TranscriptSource` or it cannot say. */
function sourceStamp(id: string): number | null {
  const live = liveSourceFor(id);
  const src = live?.sources.transcript;
  if (!live || !src) return null;
  try {
    const at = src.updatedAt(live.session);
    return typeof at === "number" && Number.isFinite(at) ? at : null;
  } catch { return null; }
}

/**
 * The reader's document from a backend's own `TranscriptSource`
 * (`source: "backend"`, design §2) — ONLY for a live session whose backend has
 * no core reader (`caps.transcript === "none"`). Core keeps `claude-jsonl` and
 * `opencode-db`; a source never replaces a reader this host measured.
 *
 * `undefined` = this rung does not apply, and `getTranscript` carries on exactly
 * as before (for such a backend that was `null`). Otherwise the ladder is
 * source → history → nothing: a source that answers null (or throws) gets the
 * SAME approximate `history` document every client already special-cases, never
 * a spinner and never a document dressed up as exact.
 *
 * The poll is the source's own stamp, with the opencode path's one addition: a
 * prompt this host typed into a busy session is in our history before the CLI
 * records it, so a newer local send re-reads and the queued row is merged in by
 * the same `queuedTurns` rule.
 */
function sourceTranscript(core: SessionCore, id: string, since: number, detail: "lite" | "full"): TranscriptDoc | "unchanged" | null | undefined {
  const s = core.sessions.get(id);
  if (!s || s.backend.caps.transcript !== "none") return undefined;
  const live = liveSourceFor(id);
  const src = live?.sources.transcript;
  if (!live || !src) return undefined;
  const localAt = s.history.length ? s.history[s.history.length - 1].sentAt : 0;
  const stamp = sourceStamp(id);
  if (stamp != null && since && stamp <= since && !(localAt > since)) return "unchanged";
  let doc: Omit<TranscriptDoc, "sessionId" | "source"> | null = null;
  try { doc = src.read(live.session, detail); } catch { doc = null; }
  if (doc && Array.isArray(doc.turns)) {
    const queued = queuedTurns(s.history, doc.turns);
    const out: TranscriptDoc = { ...doc, sessionId: id, source: "backend" };
    if (queued.length) {
      out.turns = mergeLocalTurns(doc.turns, queued);
      out.updatedAt = Math.max(doc.updatedAt, localAt);
    }
    return out;
  }
  const hist = transcriptFromHistory(s.history);
  if (since && hist.updatedAt && hist.updatedAt <= since) return "unchanged";
  return { sessionId: id, source: "history", ...hist };
}

/**
 * Word search across session terminal text. `id` set → just that session
 * (the in-CLI find); absent → every live session (the main-screen search).
 *   scope "recent"  = the current rendered terminal text (renderCapture of the
 *                     scrollback ring: the visible screen for a claude alt-buffer
 *                     TUI, up to 5000 lines of scrollback for a normal shell).
 *   scope "history" = the persisted prompt+output history (every turn, deep),
 *                     with each hit labelled by the turn it came from.
 *   scope "prompts" = the persisted prompts ALONE — what was sent into the
 *                     session, never the CLI's reply to it.
 * Case-insensitive substring. Each hit carries ±CTX context lines so the phone
 * can read it in place (no jumping into the terminal). Capped per session.
 */
export async function search(core: SessionCore, query: string, scope: SessionSearchScope, id?: string): Promise<SessionSearchResult[]> {
  const q = query.trim();
  if (!q) return [];
  const targets = id
    ? ([core.sessions.get(id)].filter(Boolean) as Session[])
    : [...core.sessions.values()];
  const out: SessionSearchResult[] = [];
  for (const s of targets) {
    // WHICH text to scan is the only part that needs a session. The scan
    // itself — its context lines and its two caps — is in `sessionSearch.ts`.
    let matches: SessionSearchMatch[] = [];
    let total = 0;
    if (scope === "recent") {
      total = scanText(await renderCapture(s.scrollback, s.cols), q, matches, 0);
    } else if (scope === "prompts") {
      ({ matches, total } = scanPrompts(s.history, q));
    } else {
      ({ matches, total } = scanHistory(s.history, q));
    }
    const r = searchResult(
      { id: s.info.id, title: s.info.title, cwd: s.info.cwd, running: s.info.running },
      matches, total,
    );
    if (r) out.push(r);
  }
  return out;
}

/**
 * The text a tab name is asked about: the session's FIRST prompt, nothing else.
 *
 * Never the screen, never later prompts, never output — the opening prompt is
 * what a person wrote to say what this conversation is for, it is already on
 * disk (the history), and it makes the whole call a ~1,000-character one.
 */
export function firstPromptOf(s: Session): string {
  // A typed slash command says what the CLI was told, not what the work is
  // (same rule as `recentPromptsOf`) — a `/compact` is no name for a tab.
  return (s.history.find((e) => e.kind !== "command")?.text ?? "").trim().slice(0, NAME_INPUT_CHARS);
}

/**
 * The later prompts a HAND-ASKED rename is also shown: the last
 * `RENAME_RECENT_PROMPTS` after the opening one, oldest first, each clipped.
 * Typed slash commands are left out — they say what the CLI was told, not
 * what the work is. Never read by the automatic pass.
 */
export function recentPromptsOf(s: Session): string[] {
  return s.history.filter((e) => e.kind !== "command").slice(1)
    .map((e) => (e.text ?? "").trim())
    .filter(Boolean)
    .slice(-RENAME_RECENT_PROMPTS)
    .map((t) => t.slice(0, RENAME_RECENT_CHARS));
}

/** The prompt `nameNow` sends: the opening prompt plus the recent ones. */
export function renamePrompt(firstPrompt: string, recent: string[]): string {
  const opening = `----- THE SESSION'S OPENING PROMPT -----\n${firstPrompt.slice(0, NAME_INPUT_CHARS)}`;
  const wording = promptText("session-rename", RENAME_PROMPT);
  if (!recent.length) return `${wording}\n\n${opening}`;
  return `${wording}\n\n${opening}\n\n----- ITS MOST RECENT PROMPTS, OLDEST FIRST -----\n${recent.join("\n---\n")}`;
}

/** One toolless naming call. "" on any failure. */
function askName(s: Session, prompt: string): Promise<string> {
  return runSummaryTask({
    cwd: s.info.cwd,
    prompt,
    // Only the WORDS are a fork's (`prompts.ts`); the engine, model and the
    // cheap flags `runSummaryTask` sets are not reachable from a file.
    system: promptText("session-title-system", TAB_TITLE_SYSTEM),
    model: SUMMARY_MODEL,
  });
}

/** The prompt `askName` sends: the wording plus the opening prompt, verbatim. */
export function tabTitlePrompt(firstPrompt: string): string {
  return `${promptText("session-title", TAB_TITLE_PROMPT)}\n\n----- THE SESSION'S OPENING PROMPT -----\n${firstPrompt.slice(0, NAME_INPUT_CHARS)}`;
}

/**
 * Name this conversation NOW, because somebody asked.
 *
 * `nameTab` below fires once per session ever, and that gate is the feature: a
 * tab that renames itself as the conversation moves is a tab whose position
 * cannot be learned. This is the hand-asked other half of the same rule — the
 * moment is a person's, so the cost is one they chose and the rename is one
 * they will not be surprised by. One cheap toolless call — but NOT off the
 * automatic pass's input alone: a person taps this because the opening prompt's
 * name went stale (or never existed), so it also sees the last few prompts
 * (`recentPromptsOf`, `RENAME_PROMPT`).
 *
 * Answers a verdict rather than throwing, and every failure leaves the
 * existing name exactly where it was — an absent answer is the shipped state
 * of this field, and a wrong title is the version of "degrade to a wrong
 * number" that a person taps.
 */
export async function nameNow(core: SessionCore, id: string): Promise<{ name?: string; reason?: string }> {
  const s = core.sessions.get(id);
  if (!s) return { reason: "that session is gone" };
  if (s.backend?.caps.turns === false) return { reason: "a shell is not named by a model; rename it by hand" };
  if (s.naming) return { reason: "a name is already being written for this session" };
  const first = firstPromptOf(s);
  if (!first) return { reason: "no prompt has been sent to this session yet" };
  // Held across the call, so the automatic pass cannot start a second naming
  // of the same session behind this one and land after it.
  s.naming = true;
  try {
    const raw = await askName(s, renamePrompt(first, recentPromptsOf(s)));
    if (core.sessions.get(id) !== s) return { reason: "that session is gone" };
    if (raw.trim() === "(none)") return { reason: "the model saw no real work in this session's prompts to name it after" };
    const name = cleanTabTitle(raw);
    if (!name) return { reason: "what came back was not a name — the tab keeps the one it had" };
    s.info.tabTitle = name;
    saveSummary(core, s);
    core.emit("updated", s.info);
    return { name };
  } catch (e) {
    return { reason: `the naming call failed (${(e as Error)?.message ?? "no detail"})` };
  } finally {
    s.naming = false;
  }
}

/**
 * A name a PERSON typed — the pencil on a launcher row and on the session
 * header. It lands in `tabTitle`, the one field every surface draws a session's
 * name from, and is written down the way a derived name is so a restart keeps
 * it. It used to land in `info.title` (`<repo> · <branch>`), which no row, tab
 * or header shows once a name exists — so a rename was saved and seen nowhere.
 *
 * Through `cleanTabTitle` like the model's answer, because the strip's width
 * is the same either way and `loadSummary` reads the file back through it — a
 * name that fit only until the next restart is a name that changed by itself.
 * Present, it also stops the automatic pass ever replacing it.
 */
export function renameTab(core: SessionCore, id: string, typed: string): void {
  const s = core.sessions.get(id);
  if (!s) return;
  const name = cleanTabTitle(typed);
  if (!name) return;
  s.info.tabTitle = name;
  saveSummary(core, s);
  core.emit("updated", s.info);
}

/**
 * A SHELL session's tab name (`caps.turns === false`): static, `shell · <repo>`,
 * in the info literal `create()` builds so `session.created` already carries it,
 * then persisted (`shellTabTitle`) like any other name so a restart keeps it. No
 * model is ever asked (`nameTab` refuses a shell). A repo name too long for the
 * strip leaves just `shell` — never a clipped one. Empty for every agent.
 */
export function shellTitleField(backend: Session["backend"], cwd: string): { tabTitle?: string } {
  if (backend.caps.turns !== false) return {};
  const full = `shell · ${basename(cwd)}`;
  return { tabTitle: cleanTabTitle(full) === full ? full : "shell" };
}

/** Write a shell's static name down (`shellTitleField`), once, at create. */
export function shellTabTitle(core: SessionCore, s: Session): void {
  if (s.backend.caps.turns === false && s.info.tabTitle) saveSummary(core, s);
}

/**
 * Give a session the ≤3-word name its TAB wears — once, ever, off its FIRST
 * PROMPT (`firstPromptOf`).
 *
 * Gated on `info.tabTitle` being absent rather than on a clock, because this
 * is not a refresh: a tab that renames itself as the conversation moves is a
 * tab whose position cannot be learned, and learning the position is the
 * whole reason the strip exists. The same gate is what makes the cost a
 * one-off, and why the persisted copy (`saveSummary`) matters: losing it
 * across a restart renames every tab at once.
 *
 * Refuses in the two directions the strip can survive: a model that says
 * there is nothing to name, and a model that answered with prose
 * (`cleanTabTitle`). Either way the field stays ABSENT and the tab wears the
 * repo and branch it always had. `s.nameAsked` keeps a refusal from being
 * re-bought on every later turn of the same process.
 */
export async function nameTab(core: SessionCore, id: string): Promise<void> {
  const s = core.sessions.get(id);
  if (!s || s.info.tabTitle || s.naming || s.nameAsked) return;
  if (s.backend?.caps.turns === false) return; // a shell is never named by a model (no spend, no turns)
  const first = firstPromptOf(s);
  if (!first) return;
  s.naming = true;
  s.nameAsked = true;
  try {
    const raw = await askName(s, tabTitlePrompt(first));
    if (raw.trim() === "(none)") return;
    const name = cleanTabTitle(raw);
    if (!name || core.sessions.get(id) !== s || s.info.tabTitle) return;
    s.info.tabTitle = name;
    saveSummary(core, s);
    core.emit("updated", s.info);
  } catch { /* best-effort — a tab with no name is the shipped state */ } finally {
    s.naming = false;
  }
}

/** Seal the in-flight capture onto its history entry (ANSI-stripped) and persist. */
export function finalizeCapture(core: SessionCore, s: Session): void {
  if (!s.capturing) return;
  const entry = s.history.find((e) => e.id === s.capturing);
  const raw = s.captureBuf;
  const cols = s.cols;
  s.capturing = null;
  s.captureBuf = "";
  if (!entry) return;
  // Render is async (emulator replay). The entry object stays referenced in
  // s.history, so assigning output once it resolves updates it in place.
  void renderCapture(raw, cols).then((text) => {
    entry.output = text.slice(0, OUTPUT_CAP);
    entry.outputAt = Date.now();
    saveHistory(core, s);
    core.emit("history", s.info.id, s.history);
  });
}

export function historyPath(core: SessionCore, id: string): string {
  return join(hostStateDir(core.root), "history", `${id}.json`);
}

export function summaryPath(core: SessionCore, id: string): string {
  return join(hostStateDir(core.root), "summaries", `${id}.json`);
}

/**
 * The tab name this session last had, across a host restart.
 *
 * Not a cache for speed: the name is derived once and never again, so losing
 * it across a restart would RENAME every tab on the strip. The file is the
 * old `summaries/<id>.json`; files written by older builds also carry
 * `text`/`len` (the retired per-turn summary), which are ignored.
 */
export function loadSummary(core: SessionCore, id: string): { tab?: string } | null {
  try {
    const p = summaryPath(core, id);
    if (existsSync(p)) {
      const j = JSON.parse(readFileSync(p, "utf8"));
      // `tab` is read through the same cleaner the model's answer goes
      // through, never trusted because it is on disk: one hand-edited to a
      // paragraph must not become a tab as wide as the strip.
      if (j && typeof j === "object") return { tab: cleanTabTitle(j.tab) };
    }
  } catch { /* corrupt/missing — start fresh */ }
  return null;
}

function saveSummary(core: SessionCore, s: Session): void {
  try {
    const p = summaryPath(core, s.info.id);
    mkdirSync(dirname(p), { recursive: true });
    writeJsonAtomic(p, { tab: s.info.tabTitle ?? "" });
  } catch { /* non-fatal */ }
}

export function loadHistory(core: SessionCore, id: string): HistoryEntry[] {
  try {
    const p = historyPath(core, id);
    if (existsSync(p)) return JSON.parse(readFileSync(p, "utf8"));
  } catch { /* corrupt/missing — start fresh */ }
  return [];
}

/**
 * What a relaunch carries from the session it replaces: the prompt history
 * (the row's Started/Latest labels and the reader's history) and the tab name.
 * Both stores are keyed by the BOOT id, and the replaced session's are deleted
 * by its kill — so a model switch that resumes the very same conversation came
 * back as a row with no words on it and a tab renamed off nothing.
 */
export interface SessionCarry { history: HistoryEntry[]; tabTitle?: string }

/**
 * Snapshot taken BEFORE the kill that deletes the files it reads from — and
 * only when the new spawn resumes the SAME conversation. A fork, a reset or a
 * fresh start is a different conversation, and its row must not wear this
 * one's prompts.
 */
export function carryOf(core: SessionCore, id: string, resumeSessionId: string | undefined): SessionCarry | null {
  const s = core.sessions.get(id);
  if (!s || !resumeSessionId) return null;
  if (resumeSessionId !== s.info.claudeSessionId && resumeSessionId !== s.info.backendSessionId) return null;
  return { history: s.history.map((e) => ({ ...e })), ...(s.info.tabTitle ? { tabTitle: s.info.tabTitle } : {}) };
}

/**
 * What a reopen carries when the conversation's last session is already GONE —
 * closed, its `history/` file deleted by the kill. The reopen stack's row kept
 * the two verbatim prompts and the tab name, so the reopened row starts with
 * those instead of with no words on it. Only the first and the latest survive
 * (the middle was never on the row); they are the person's own words, never
 * a guess.
 */
export function carryOfClosed(row: ClosedRow): SessionCarry | null {
  const history: HistoryEntry[] = [];
  const at = row.closedAt;
  if (row.firstPrompt) history.push({ id: randomUUID().slice(0, 8), kind: "prompt", text: row.firstPrompt, sentAt: row.openedAt ?? at });
  if (row.lastPrompt && row.lastPrompt !== row.firstPrompt) history.push({ id: randomUUID().slice(0, 8), kind: "prompt", text: row.lastPrompt, sentAt: row.lastActiveAt ?? at });
  if (!history.length && !row.tabTitle) return null;
  return { history, ...(row.tabTitle ? { tabTitle: row.tabTitle } : {}) };
}

/** Seed a just-registered session with what it carries, and write it down. */
export function adoptCarry(core: SessionCore, s: Session, carry: SessionCarry): void {
  if (carry.history.length && !s.history.length) {
    s.history = carry.history;
    saveHistory(core, s);
    core.applyPromptLabels(s);
  }
  if (carry.tabTitle && !s.info.tabTitle) {
    s.info.tabTitle = carry.tabTitle;
    saveSummary(core, s);
  }
}

function saveHistory(core: SessionCore, s: Session): void {
  if (s.backend.caps.turns === false) return; // never on disk for a shell (`recordPrompt`)
  try {
    const p = historyPath(core, s.info.id);
    mkdirSync(dirname(p), { recursive: true });
    writeJsonAtomic(p, s.history);
  } catch { /* non-fatal */ }
}

/**
 * When the CLI last wrote a turn for this conversation — the mtime of its own
 * log.
 *
 * The honest answer to "how long has this session been untouched", and
 * deliberately not `idleSince`. That one is stamped by `markIdle`, four seconds
 * after ANY output, and a tmux re-attach repaints every pane — so on a host
 * holding a hundred rediscovered sessions it means "time since the last host
 * restart". Measured: "close everything quiet for over 2h" answered ZERO across
 * 65 sessions nobody had opened since the previous day.
 *
 * Fixing `idleSince` in place is the wrong move — it is not wrong, it answers a
 * different question (is a turn running right now), and the repaint that resets
 * it also legitimately clears the idle flag. So this is its own field, read off
 * the CLI's own OUTPUT rather than off any clock this daemon keeps.
 *
 * Not the log's mtime either, for the same class of reason one level down: the
 * CLI rewrites bookkeeping rows on every attach. `lastTurnAt` reads the newest
 * real message record — see `transcript.ts` for the 92-of-97 measurement.
 */
export function lastTurnOf(cwd: string, claudeSessionId: string | undefined): number | null {
  if (!claudeSessionId) return null;
  return readLastTurnAt(transcriptPath(cwd, claudeSessionId));
}
