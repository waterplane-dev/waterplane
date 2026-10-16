/**
 * The ack ledger — "have I already done this one?".
 *
 * Every durable client action carries an `ackId`, and the phone re-sends the
 * SAME id when it never saw the receipt (a dead socket, a reload, the tunnel
 * flapping). Without a memory of what has already been handled, that retry
 * types the prompt a second time / adds the work item twice / spawns a second
 * 12-repo fan-out. This module is that memory: a repeat is re-ACKed with the
 * ORIGINAL verdict and the action is not re-run. It is the client-retry twin of
 * the at-most-once rule `deliver.ts` enforces on the PTY side.
 *
 * Two things about it are load-bearing and were wrong when it lived inline in
 * main.ts:
 *
 *   • The TTL outlives the client's queue. It was 15 min while the phone's
 *     `QUEUE_TTL_MS` (web/outbox.ts) is 30 — so an entry could still be sitting
 *     in localStorage, eligible for one more retry, after the host had already
 *     forgotten it. That is a double-type hole, not a theoretical one. 45 min
 *     keeps the host's memory strictly longer than anything the client will
 *     still send.
 *
 *   • It survives a restart. `npm run restart` is routine (every host edit), and
 *     an in-memory-only ledger forgets everything across it — so a queued
 *     `fanout.run` re-sent after a restart would start the whole sweep again.
 *     The map is therefore persisted to <STATE_DIR>/acks.json:
 *
 *       { "updatedAt": …, "acks": { "<ackId>": { ts, ok, reason?, itemId?, sessionId?, runId?, op? } } }
 *
 * Three details of HOW it is persisted are load-bearing, because the window they
 * cover is exactly the window a restart lands in:
 *
 *   • OP verdicts are written SYNCHRONOUSLY, not debounced. `npm run restart`
 *     goes through launchd `kickstart -k` — an immediate SIGTERM — so a 500 ms
 *     debounce is long enough to lose the one record that matters: the phone
 *     sends `fanout.run {ackId}`, the host spawns 12 sessions, the socket dies
 *     before `op.ack` lands, the restart happens inside the debounce window, and
 *     the retry runs the whole sweep again. Ops are rare (a tap each); only the
 *     keystroke-frequency `input.ack` receipts need the debounce.
 *
 *   • `flush()` runs on SIGTERM/SIGINT (wired in server/shutdown.ts) so whatever IS still
 *     debounced reaches the disk before the process goes.
 *
 *   • The write is atomic (tmp file + rename). A kill mid-`writeFileSync` leaves
 *     truncated JSON, the constructor's catch silently starts empty, and the
 *     result is the same duplicate sweep the file exists to prevent.
 *
 * Persistence is best-effort throughout — a read or write that fails degrades to
 * the old in-memory behaviour and must never throw into the request path. But a
 * failed WRITE is not silent: it is logged, kept (`lastWriteError()`) and told
 * once (`onWriteError` → a feed row and a doctor row), because a receipt that
 * never reached the disk is a retry a restart lets run twice.
 *
 * A file that is PRESENT and does not parse is not "start empty" any more: it is
 * moved aside (`jsonstore.ts`, `acks.json.corrupt-<ts>`), logged, and the loss
 * is held in `lost` for one TTL so `main.ts` can tell a person. Inside that
 * window an UNKNOWN ackId whose message says it was first sent before the loss
 * (`firstSentAt`/`sentAt`, `shared/sendstamp.ts`) is REFUSED, never run —
 * `preLossRefusal` below, asked by every ackId path (`durableOp`,
 * `session.input`, `backlog.add`) after the known/in-flight checks — and the
 * refusal is remembered like any verdict, so its retries hear the same thing.
 * An ackId is random, so without the stamp a pre-loss retry and a fresh op are
 * the same bytes: a message with no `firstSentAt` (an older client) still runs,
 * exactly as before, because refusing every unknown ackId for the TTL would
 * refuse every new send for 45 minutes. A fresh send (first sent after the
 * loss) runs normally.
 *
 * Bounded both ways: entries expire, and the map is capped, so a long-lived
 * daemon never accumulates one entry per message ever sent.
 */
import { join } from "node:path";
import { readJsonGuardedDetail, writeJsonAtomic } from "./jsonstore.js";
import { hostStateDir } from "./branddirs.js";
import { preLossRefusal, type SendStamp } from "@waterplane/shared";

/** What one handled ackId produced. The optional fields are per message kind:
 *  `itemId` for backlog.add, `sessionId`/`runId` for the durable ops.
 *
 *  `op` marks the EXPENSIVE kind (`durableOp` in server/wsops.ts: a session, a sweep, a
 *  build). It drives two policies that a plain input receipt doesn't get:
 *  immediate persistence, and survival when the cap evicts — see `remember`. */
export interface AckRecord {
  ts: number;
  ok: boolean;
  reason?: string;
  itemId?: string;
  sessionId?: string;
  runId?: string;
  /** `session.create` that was parked rather than spawned: the host holds it
   *  until the files its prompt names land. A replay must get the SAME launch
   *  back, not a second parked session. */
  launchId?: string;
  /** The durable intent row the op produced or found — the same string as
   *  `launchId` for a parked create. Remembered for the same reason every other
   *  identifier here is: a replay must be answered with the row that already
   *  exists, never with a second one. */
  intentId?: string;
  /** `assess.apply` only: the pad notes whose backlog row actually landed. The
   *  phone clears a note on this receipt, so a replay that answered without it
   *  would leave words on the pad (recoverable) and one that answered with a
   *  wider list would delete them (not). Remembered like the identifiers. */
  filed?: string[];
  op?: boolean;
  /** `input.ack` only: how far a VERIFIED compose delivery got (see the wire
   *  type). Stored so a replayed receipt says the same thing as the original —
   *  "typed but Return was swallowed" and "never appeared on screen" call for
   *  opposite reactions from the phone, and a retry must not be told the wrong
   *  one. */
  state?: "ok" | "notready" | "unconfirmed" | "unsubmitted" | "stale" | "rescued" | "forked";
}

interface AckDoc {
  updatedAt: number;
  acks: Record<string, AckRecord>;
}

/** Must stay > the client's QUEUE_TTL_MS (30 min) — see the header. */
export const ACK_TTL_MS = 45 * 60_000;
const ACK_MAX = 1000;
/** Debounce for the high-frequency records only (`input.ack`). Op verdicts skip
 *  it entirely — see the header: a restart lands INSIDE this window. */
const SAVE_DEBOUNCE_MS = 500;

/**
 * The feed row for a lost ledger (`main.ts` fires it at boot; the in-app feed
 * is replayed on hello, so it waits for the first phone). It says what the
 * host can no longer promise and what to check — never that nothing ran.
 */
export function lostLedgerNotice(lost: NonNullable<AckLedger["lost"]>): { title: string; body: string; tag: string } {
  return {
    title: "Host lost its record of recent sends",
    body: "Its at-most-once ledger was unreadable at start-up, so a prompt or action retried from before this restart " +
      "may run a second time. Check the session before re-sending anything that looked unanswered." +
      (lost.movedTo ? ` The damaged file is kept as ${lost.movedTo}.` : ""),
    tag: "acks-lost",
  };
}

/** The words a person reads when receipts stop reaching the disk — the feed row and the log line say the same thing. */
export const ACK_WRITE_FAILED = "receipts not reaching disk — a retry after a restart may run twice";

/**
 * The feed row for a ledger that can no longer be WRITTEN (`onWriteError`,
 * wired in `main.ts`). Not a refusal: the op it was remembering has already
 * run and cannot be un-run, so its verdict still goes out — what changes is
 * that a restart forgets it, and that is what a person has to hear.
 */
export function ackWriteNotice(message: string): { title: string; body: string; tag: string } {
  return {
    title: "Host cannot save its record of sends",
    body: `${ACK_WRITE_FAILED[0]!.toUpperCase()}${ACK_WRITE_FAILED.slice(1)} (${message}). ` +
      "Until it can, check a session before re-sending anything after a host restart; check free disk space and that the host's state folder is writable.",
    tag: "acks-write",
  };
}

/** How often a STILL-failing write is logged again, and the floor between two feed rows. */
const WRITE_ERROR_LOG_MS = 10 * 60_000;
const WRITE_ERROR_NOTICE_MS = 30 * 60_000;

export class AckLedger {
  private path: string;
  private acks = new Map<string, AckRecord>();
  /** Why the last write failed (null once one landed). See `persist()`. */
  private writeError: { at: number; message: string } | null = null;
  private writeErrorLoggedAt = 0;
  private writeErrorToldAt = 0;
  /**
   * Told when the ledger stops reaching the disk — once per failing streak and
   * never twice inside `WRITE_ERROR_NOTICE_MS` (a nearly-full disk flaps).
   * `main.ts` turns it into a feed row (`ackWriteNotice`). Never throws into
   * the request path: a listener's failure is swallowed.
   */
  onWriteError: ((message: string) => void) | null = null;
  private timer: NodeJS.Timeout | null = null;

  /** Set when the persisted ledger was present but unreadable at boot: when,
   *  where its bytes were kept, and until when a re-send of a pre-loss op may
   *  still arrive (one TTL — after that nothing it held could be replayed). */
  readonly lost: { at: number; movedTo: string | null; until: number } | null = null;

  constructor(root: string) {
    this.path = join(hostStateDir(root), "acks.json");
    const isDoc = (v: unknown): boolean => !!v && typeof v === "object" && typeof (v as AckDoc).acks === "object" && (v as AckDoc).acks !== null;
    const read = readJsonGuardedDetail<AckDoc | null>(this.path, null, isDoc);
    const now = Date.now();
    if (read.corrupt) {
      this.lost = { at: now, movedTo: read.corrupt.movedTo, until: now + ACK_TTL_MS };
      console.error(
        `[acks] the at-most-once ledger was unreadable (${read.corrupt.error}). Any send retried from before this boot ` +
          "can no longer be recognised as a repeat and may run a second time." +
          (read.corrupt.movedTo ? ` Its bytes are kept at ${read.corrupt.movedTo}.` : ""),
      );
    }
    for (const [id, rec] of Object.entries(read.value?.acks ?? {})) {
      // Drop anything already stale on load: replaying a day-old verdict to a
      // client that has long since given up is worse than re-running.
      if (rec && typeof rec.ts === "number" && now - rec.ts <= ACK_TTL_MS) this.acks.set(id, rec);
    }
  }

  /**
   * The sentence refusing an UNKNOWN ackId that was first sent before this
   * ledger was lost — null when nothing was lost, the window has passed, or the
   * message cannot say when it was first sent (an older client: it runs, as it
   * always did). The caller has already asked `get` and the in-flight map; a
   * known ackId is re-acked, never judged here. Skew and margins: `sendstamp.ts`.
   */
  preLossRefusal(stamp: SendStamp | undefined, receivedAt = Date.now()): string | null {
    return preLossRefusal(this.lost, stamp, receivedAt);
  }

  /** The stored verdict for an ackId, or undefined if unknown/expired. */
  get(ackId: string): AckRecord | undefined {
    const rec = this.acks.get(ackId);
    if (!rec) return undefined;
    if (Date.now() - rec.ts > ACK_TTL_MS) { this.acks.delete(ackId); return undefined; }
    return rec;
  }

  /** Record what this ackId did, so a retry re-acks instead of re-running. */
  remember(ackId: string, rec: Omit<AckRecord, "ts">): void {
    const now = Date.now();
    this.acks.set(ackId, { ...rec, ts: now });
    if (this.acks.size > ACK_MAX) {
      for (const [k, v] of this.acks) {
        if (now - v.ts > ACK_TTL_MS) this.acks.delete(k);
      }
      // Still over budget after expiry ⇒ evict by insertion order (Map keeps
      // it), but NON-OP records first. The cap is shared between two very
      // different populations: keystroke-frequency `input.ack` receipts and the
      // handful of op verdicts. Plain oldest-first eviction means enough acked
      // sends inside the client's 30-minute retry window push a still-retryable
      // fan-out verdict out of the ledger — and the next retry re-runs the whole
      // sweep. So op verdicts survive to their TTL; a lost input receipt costs
      // at most one retyped line.
      this.evictOldest((v) => !v.op);
      this.evictOldest(() => true);
    }
    // An op verdict is the expensive one to forget and rare enough to afford a
    // synchronous write; everything else rides the debounce. See the header.
    if (rec.op) this.flush();
    else this.schedulePersist();
  }

  /** Drop oldest-inserted entries matching `pick` until we're back under the cap. */
  private evictOldest(pick: (rec: AckRecord) => boolean): void {
    for (const [k, v] of this.acks) {
      if (this.acks.size <= ACK_MAX) return;
      if (pick(v)) this.acks.delete(k);
    }
  }

  /** Write any debounced changes now. `false` ⇒ the write failed (`lastWriteError()`). */
  flush(): boolean {
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    return this.persist();
  }

  /** Why the last write failed, or null when it landed (or none was tried). */
  lastWriteError(): string | null { return this.writeError?.message ?? null; }

  private schedulePersist(): void {
    if (this.timer) return;
    this.timer = setTimeout(() => { this.timer = null; this.persist(); }, SAVE_DEBOUNCE_MS);
    this.timer.unref?.(); // never hold the daemon open for a receipt file
  }

  /**
   * Atomic write (`writeJsonAtomic`: tmp + fsync + rename). A plain
   * `writeFileSync` truncates first, so a SIGTERM landing mid-write leaves half
   * a JSON document — exactly the loss this file exists to prevent.
   *
   * A failed write still never breaks a send — the op it records has already
   * RUN by the time `remember` is called, and refusing its verdict cannot
   * un-run it — but it is no longer silent: the reason is kept
   * (`lastWriteError()`), logged once per streak (then every
   * `WRITE_ERROR_LOG_MS`), and handed to `onWriteError` so a person hears that
   * a restart will forget these receipts. Answers whether the bytes landed.
   */
  private persist(): boolean {
    try {
      const doc: AckDoc = { updatedAt: Date.now(), acks: Object.fromEntries(this.acks) };
      writeJsonAtomic(this.path, doc);
    } catch (e) {
      this.noteWriteFailed(String((e as Error)?.message ?? e));
      return false;
    }
    if (this.writeError) {
      console.log(`[acks] ${this.path} is being written again (it had failed since ${new Date(this.writeError.at).toISOString()}: ${this.writeError.message})`);
      this.writeError = null;
      this.writeErrorLoggedAt = 0;
    }
    return true;
  }

  private noteWriteFailed(message: string): void {
    const now = Date.now();
    const first = !this.writeError;
    this.writeError = { at: this.writeError?.at ?? now, message };
    if (first || now - this.writeErrorLoggedAt >= WRITE_ERROR_LOG_MS) {
      this.writeErrorLoggedAt = now;
      console.error(`[acks] could not write ${this.path} (${message}): ${ACK_WRITE_FAILED}`);
    }
    if (first && this.onWriteError && (this.writeErrorToldAt === 0 || now - this.writeErrorToldAt >= WRITE_ERROR_NOTICE_MS)) {
      this.writeErrorToldAt = now;
      try { this.onWriteError(message); } catch { /* telling must never break a send */ }
    }
  }
}
