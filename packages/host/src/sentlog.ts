/**
 * The sent-command audit log — "what did waterplane type into my agent, and when?".
 *
 * The app drives sessions from a lot of places (a backlog item firing, a
 * fan-out target, a follow-up, the compose bar, a plugin's gated answer, a
 * usage-limit `continue`), and in the terminal every one of them looks exactly
 * like a human typing: bytes appear in the composer with nothing saying who put
 * them there. That is fine while you are watching and useless afterwards, which
 * is precisely when the question gets asked — a session that ran something
 * nobody remembers asking for is the one case where the scrollback cannot
 * answer, because the scrollback IS the thing under suspicion.
 *
 * Two rules make it worth reading:
 *  - **One entry per semantic command, not per PTY write.** `deliver.ts` writes
 *    the text and the Return separately and may re-press Return up to five
 *    times; a per-write log would show six rows for one prompt. The entry is
 *    recorded when delivery SETTLES, so it carries the verdict.
 *  - **The verdict is kept, not flattened.** `unsubmitted` (text sitting in the
 *    composer, Return swallowed) and `ok` are opposite facts, and a log that
 *    called both "sent" would state the exact thing that is untrue.
 *
 * Persisted to <STATE_DIR>/sent.json — tmp+rename and a debounced write (same
 * shape as `acks.ts`/`netstats.ts`), flushed on shutdown. On disk because
 * `npm run restart` is routine and an in-memory trail would be empty every time
 * something surprising happened before the last restart. Every I/O failure
 * degrades to in-memory; nothing here may throw into a delivery path.
 */
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { DeliveryShape, SentCommand, SentSource } from "@waterplane/shared";
import { hostStateDir } from "./branddirs.js";
import { readJsonGuarded, writeJsonAtomic } from "./jsonstore.js";

/** Ring size. Entries are small (a capped text plus labels). */
const LOG_LIMIT = 1000;
/** Per-entry text cap — a pasted file must not turn the log into the file. */
const TEXT_MAX = 2000;
const SAVE_DEBOUNCE_MS = 500;

/** What the caller knows; the log fills in the session facts and the id. */
export interface SentRecord {
  sessionId: string;
  actor: SentCommand["actor"];
  source: SentSource;
  kind: SentCommand["kind"];
  text: string;
  result: SentCommand["result"];
  detail?: string;
  /**
   * What the delivery was shaped like — length, lines, the grid it was drawn
   * in, the view it was composed over, which rules answered.
   *
   * Optional, and absent from every raw automation write (`SessionManager`'s
   * own `recordSent`), which has no echo rule and no submit proof because it
   * has no confirmation step at all. A reader may therefore never treat a
   * missing shape as a zero: `written` rows and every row from before this
   * existed have none.
   */
  shape?: DeliveryShape;
}

/** Resolves the session facts stamped onto an entry (title can change later). */
export type SessionFacts = (id: string) => { title: string; repoDir: string } | null;

export class SentLog {
  private path: string;
  private entries: SentCommand[] = [];
  private timer: NodeJS.Timeout | null = null;
  private seq = 0;

  /** `onAdd` is how a new entry reaches connected phones (main.ts broadcasts
   *  it): the log is written from inside a delivery, and re-fetching the whole
   *  list on every send would be pointless traffic on the link this app spends
   *  its life apologising for. */
  constructor(root: string, private facts: SessionFacts = () => null, private onAdd?: (e: SentCommand) => void) {
    this.path = join(hostStateDir(root), "sent.json");
    try {
      if (existsSync(this.path)) {
        const parsed = readJsonGuarded<any>(this.path, null);
        if (Array.isArray(parsed)) this.entries = parsed;
      }
    } catch { /* corrupt or unreadable → start empty rather than throw */ }
  }

  /** Record one settled command. Returns the stored entry (for broadcasting). */
  add(rec: SentRecord): SentCommand {
    const f = this.facts(rec.sessionId);
    const text = rec.text ?? "";
    const entry: SentCommand = {
      id: `snd_${Date.now().toString(36)}_${(this.seq++).toString(36)}`,
      ts: Date.now(),
      sessionId: rec.sessionId,
      sessionTitle: f?.title ?? rec.sessionId,
      repoDir: f?.repoDir ?? "",
      actor: rec.actor,
      source: rec.source,
      kind: rec.kind,
      text: text.length > TEXT_MAX ? text.slice(0, TEXT_MAX) : text,
      ...(text.length > TEXT_MAX ? { truncated: true } : {}),
      result: rec.result,
      ...(rec.detail ? { detail: rec.detail } : {}),
      ...(rec.shape ? { shape: rec.shape } : {}),
    };
    this.entries.unshift(entry);
    if (this.entries.length > LOG_LIMIT) this.entries.length = LOG_LIMIT;
    this.schedule();
    try { this.onAdd?.(entry); } catch { /* a broadcast failure must not fail the send */ }
    return entry;
  }

  /**
   * Write a LATER verdict onto a row that was recorded ambiguous.
   *
   * The two rules above say the entry is written when delivery SETTLES and that
   * the verdict is kept rather than flattened. Both were true and both were
   * quietly incomplete: `unconfirmed` and `unsubmitted` are not outcomes, they
   * are open questions (`opendeliveries.ts`), and this log had no way to hear
   * the answer. So a delivery the host had proved `landed` minutes later still
   * read `"result":"unconfirmed"` on disk for ever — and this file is what a
   * person, and the measurement behind this rework, reads as "what happened to
   * my deliveries". A log that only ever records the pessimistic half of an
   * open question does not merely lose detail; it manufactures a failure rate.
   *
   * Additive, never destructive: `result` stays exactly as delivery reported
   * it. Returns the updated entry so the caller can push it to whoever is
   * looking (the row is keyed by id and clients replace by id).
   */
  settle(id: string, verdict: NonNullable<SentCommand["settled"]>, detail?: string): SentCommand | null {
    const e = this.entries.find((x) => x.id === id);
    if (!e) return null;                         // rolled out of the ring — nothing to correct
    if (e.settled === verdict && e.settledDetail === detail) return null;
    e.settled = verdict;
    e.settledAt = Date.now();
    if (detail) e.settledDetail = detail;
    this.schedule();
    try { this.onAdd?.(e); } catch { /* a broadcast failure must not fail the sweep */ }
    return e;
  }

  /** Newest first, optionally filtered to one session. */
  list(sessionId?: string, limit = 200): SentCommand[] {
    const rows = sessionId ? this.entries.filter((e) => e.sessionId === sessionId) : this.entries;
    return rows.slice(0, limit);
  }

  /** Total kept (the list is capped for the wire). */
  count(sessionId?: string): number {
    return sessionId ? this.entries.filter((e) => e.sessionId === sessionId).length : this.entries.length;
  }

  clear(): void {
    this.entries = [];
    this.flush();
  }

  flush(): void {
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    this.persist();
  }

  private schedule(): void {
    if (this.timer) return;
    this.timer = setTimeout(() => { this.timer = null; this.persist(); }, SAVE_DEBOUNCE_MS);
  }

  /** tmp + rename: a kill mid-write must not leave truncated JSON that the
   *  constructor's catch silently turns into an empty audit trail. */
  private persist(): void {
    try {
      mkdirSync(join(this.path, ".."), { recursive: true });
      writeJsonAtomic(this.path, this.entries);
    } catch { /* non-fatal — keep serving from memory */ }
  }
}

/**
 * Module-level singleton, set once at boot by `main.ts`.
 *
 * `deliver.ts` and `sessions.ts` are the two chokepoints every command passes
 * through, and threading a log handle through every caller of both (the
 * backlog, the fan-out, follow-ups, creates, the compose path, the limit
 * scheduler) would mean a new call site could forget it and go unrecorded —
 * which is the one failure an audit trail cannot have. Reading it here instead
 * makes recording the default. Unset (e.g. a unit import) = a silent no-op.
 */
let current: SentLog | null = null;
export function setSentLog(log: SentLog | null): void { current = log; }
export function sentLog(): SentLog | null { return current; }

/** Record + hand back the entry, or null when no log is installed. */
export function recordSent(rec: SentRecord): SentCommand | null {
  return current ? current.add(rec) : null;
}

/**
 * Correct a row once the host has PROVED what became of the delivery.
 *
 * Same singleton argument as `recordSent`: the sweep that settles an open
 * question has no business holding a log handle, and a call site that could
 * forget to correct the trail is a call site that leaves it lying.
 */
export function recordSettled(
  id: string,
  verdict: NonNullable<SentCommand["settled"]>,
  detail?: string,
): SentCommand | null {
  return current ? current.settle(id, verdict, detail) : null;
}
