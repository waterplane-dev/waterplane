/**
 * What a desktop is waiting on a person for — ONE answer both ends read.
 *
 * `sessionWaits` is the session leg: the phone's `sessionStatus()` "wait" bucket
 * (`packages/web/src/attention.ts`) calls it, and the host's `GET /api/attention`
 * counts with it, so the number another desktop reports and the launcher's
 * "N waiting" chip after a switch come from one predicate, never two copies.
 * Blocked sessions (signed out, out of credit, at a limit, on a network retry)
 * are walls, not questions, and are left out — the launcher words them apart.
 *
 * `summarizeWaiting` is the whole read: waiting sessions plus attention items
 * that still `needsYou()` — minus a waiting session's own `prompt` item, which
 * is the same wait (counted once, as the session). Pure, no clock of its own (the caller passes `now`).
 */
import { blockOf, type BlockFacts } from "./block.js";
import { needsYou, type NotificationItem, type NotificationKind } from "./wire/notify.js";
import type { SessionInfo } from "./wire/session.js";

/** The facts `sessionWaits` reads off a session. */
export type WaitFacts = BlockFacts & Pick<SessionInfo, "running" | "prompt" | "awaitingInput" | "asking">;

/**
 * Is this session waiting on the person: running, behind no outside wall, and
 * showing a box, an unparsed dialog, or a turn that ended on a question.
 */
export function sessionWaits(s: WaitFacts): boolean {
  if (!s.running) return false;
  if (blockOf(s)) return false;
  return Boolean(s.prompt || s.awaitingInput || s.asking);
}

/** One attention item as a LINE — no body: a pointer at the feed, not the feed. */
export interface WaitingAttention {
  id: string;
  ts: number;
  kind: NotificationKind;
  title: string;
  sessionId?: string;
  plugin?: string;
  tag?: string;
}

/** `GET /api/attention`'s answer. */
export interface WaitingSummary {
  /** The host's clock when it answered, so the phone can say the age. */
  ts: number;
  /** Sessions `sessionWaits` holds; `ids` capped at `WAITING_IDS_MAX`, `n` never capped. */
  sessions: { n: number; ids: string[] };
  /** Items that `needsYou()`; newest first, `items` capped at `WAITING_ITEMS_MAX`, `n` never capped. */
  attention: { n: number; items: WaitingAttention[] };
}

export const WAITING_IDS_MAX = 20;
export const WAITING_ITEMS_MAX = 10;

type ItemIn = Pick<NotificationItem, "id" | "ts" | "kind" | "title" | "level" | "handled" | "sessionId" | "plugin" | "tag">;

/** The whole read, from the host's session list and its attention store. */
export function summarizeWaiting(sessions: readonly (WaitFacts & { id: string })[], items: readonly ItemIn[], now: number): WaitingSummary {
  const ids = sessions.filter(sessionWaits).map((s) => s.id);
  // A waiting session's own "needs you" item (kind `prompt`, filed under its id) is the SAME
  // wait the session leg already counts: counted once, as the session, never twice.
  const waiting = new Set(ids);
  const open = items.filter((i) => needsYou(i) && !(i.kind === "prompt" && i.sessionId && waiting.has(i.sessionId)))
    .slice().sort((a, b) => b.ts - a.ts);
  return {
    ts: now,
    sessions: { n: ids.length, ids: ids.slice(0, WAITING_IDS_MAX) },
    attention: {
      n: open.length,
      items: open.slice(0, WAITING_ITEMS_MAX).map((i) => ({
        id: i.id, ts: i.ts, kind: i.kind, title: i.title,
        ...(i.sessionId ? { sessionId: i.sessionId } : {}),
        ...(i.plugin ? { plugin: i.plugin } : {}),
        ...(i.tag ? { tag: i.tag } : {}),
      })),
    },
  };
}

/** A summary's total — what a chip counts for that desktop. */
export function waitingTotal(w: Pick<WaitingSummary, "sessions" | "attention">): number {
  return w.sessions.n + w.attention.n;
}

/**
 * A summary as read off the wire, or null when it is not one. The phone reads
 * another desktop's answer; a shape it cannot trust is ABSENT, never a 0.
 */
export function parseWaitingSummary(v: unknown): WaitingSummary | null {
  if (!v || typeof v !== "object") return null;
  const o = v as Record<string, unknown>;
  const s = o.sessions as Record<string, unknown> | undefined;
  const a = o.attention as Record<string, unknown> | undefined;
  const isN = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n) && n >= 0;
  if (!isN(o.ts) || !s || !a || !isN(s.n) || !isN(a.n) || !Array.isArray(s.ids) || !Array.isArray(a.items)) return null;
  const items: WaitingAttention[] = [];
  for (const raw of a.items.slice(0, WAITING_ITEMS_MAX)) {
    if (!raw || typeof raw !== "object") continue;
    const r = raw as Record<string, unknown>;
    if (typeof r.id !== "string" || typeof r.title !== "string" || typeof r.kind !== "string" || !isN(r.ts)) continue;
    items.push({
      id: r.id, ts: r.ts, kind: r.kind as NotificationKind, title: r.title,
      ...(typeof r.sessionId === "string" ? { sessionId: r.sessionId } : {}),
      ...(typeof r.plugin === "string" ? { plugin: r.plugin } : {}),
      ...(typeof r.tag === "string" ? { tag: r.tag } : {}),
    });
  }
  const ids = s.ids.filter((x): x is string => typeof x === "string").slice(0, WAITING_IDS_MAX);
  return { ts: o.ts, sessions: { n: s.n, ids }, attention: { n: a.n, items } };
}
