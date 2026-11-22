/**
 * **Which session an "ask the agent" button started last time** — the pure half.
 *
 * Every hand-to-the-agent button (a Setup & health finding, CLI health's inspect, the vault's
 * asks, …) opens the ONE Send sheet with a seed; the seed may carry an `askKey` naming that
 * button for that subject. When the send actually goes to a session — an existing one, or a new
 * one whose `session.create` is minted — the pair is remembered here, so the button can say
 * where the last answer is and jump there.
 *
 * A new session is known first by its create's ackId; the session id arrives later on the ack
 * (`noteAdopted`, `core/queue/adoptions.ts`). `resolveAsk` reads that map, so the record stays
 * right even when the person never stood on the pending screen. Bounded: newest `LAST_ASK_CAP`.
 *
 * Nothing here starts, sends or reopens anything: a link to an existing screen, or a sentence.
 */
import type { Adoptions } from "./core/queue/adoptions.ts";

export interface LastAsk {
  /** The session the send went to, once known. */
  sid?: string;
  /** The `session.create` ackId of a NEW session, until its id is known. */
  ack?: string;
  cwd: string;
  at: number;
}
export type LastAsks = Record<string, LastAsk>;

export const LAST_ASK_CAP = 200;

/** CLI health's "inspect in a session", per signal. */
export const cliHealthAskKey = (signalId: string): string => `clihealth:${signalId}`;

/** A repo-readings ask (`remedySeed`), keyed by the label the button passes. */
export const readingsAskKey = (repoId: string, label: string): string => `readings:${repoId}:${label}`;

/** The map with `key` set to `a`, newest first, capped. */
export function recordAsk(map: LastAsks, key: string, a: LastAsk): LastAsks {
  const rest = Object.entries(map).filter(([k]) => k !== key);
  return Object.fromEntries([[key, a] as [string, LastAsk], ...rest].slice(0, LAST_ASK_CAP));
}

/** Fill in the session a create became, on every record waiting on that ack (the durable copy:
 *  the adoption map itself forgets after a week or fifty creates). Same object when nothing waits. */
export function adoptAsks(map: LastAsks, ack: string, sid: string): LastAsks {
  if (!Object.values(map).some((a) => a.ack === ack && !a.sid)) return map;
  return Object.fromEntries(Object.entries(map).map(([k, a]) => [k, a.ack === ack && !a.sid ? { ...a, sid } : a]));
}

/** The session id behind a record: its own, or what its create was adopted as; null while still on its way. */
export function resolveAsk(a: LastAsk, adoptions: Adoptions): string | null {
  if (a.sid) return a.sid;
  return a.ack ? adoptions[a.ack]?.sid ?? null : null; // keyed by the create's ack (`recordAdoption`)
}

export interface AskPlace {
  kind: "live" | "closed" | "starting";
  sid?: string;
  title?: string;
  at: number;
}

/**
 * Where the last answer is now: a live session (a jump), a closed one (a sentence: it is in
 * Recently closed), a create still on its way, or null when this desktop no longer knows the
 * session at all — then nothing is drawn rather than a link to nowhere.
 */
export function askPlace(
  a: LastAsk | undefined, adoptions: Adoptions,
  live: readonly { id: string; title: string }[], closed: readonly { id: string; title: string }[],
  createQueued: (ack: string) => boolean,
): AskPlace | null {
  if (!a) return null;
  const sid = resolveAsk(a, adoptions);
  if (sid) {
    const s = live.find((x) => x.id === sid);
    if (s) return { kind: "live", sid, title: s.title, at: a.at };
    const c = closed.find((x) => x.id === sid);
    if (c) return { kind: "closed", sid, title: c.title, at: a.at };
    return null;
  }
  return a.ack && createQueued(a.ack) ? { kind: "starting", at: a.at } : null;
}
