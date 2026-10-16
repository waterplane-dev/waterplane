/**
 * A MARK a person puts on a session by hand — the star, the follow-up flag —
 * pressed while the desktop may not be listening. The pure half of the one
 * mechanism `localState.ts` (storage) and `useSessionVerbs.ts` (the verb) share.
 *
 * Both frames (`session.star`, `session.followup`) are fire-and-forget,
 * idempotent set-state. Offline they land in the socket's in-memory queue,
 * which paints nothing and dies with the next reload, so the INTENT is kept:
 * id → wanted, painted over the host's value and re-sent on reconnect until a
 * LIVE row shows the host holding the same value. Two marks, one shape — a
 * second copy of this logic is how the two would come to disagree about when a
 * press counts as confirmed.
 *
 * No React, no DOM, no storage — `pendingMarks.test.mjs` under `node --test`.
 */
import type { SessionInfo } from "@waterplane/shared";

/** Session id → the value the person asked for. */
export type PendingMarks = Record<string, boolean>;

/** How one mark is read off a session and painted onto it. */
export interface SessionMark {
  has(s: SessionInfo): boolean;
  /** The session with the mark as wanted — only called when it differs. */
  paint(s: SessionInfo, want: boolean): SessionInfo;
}

export const STAR_MARK: SessionMark = {
  has: (s) => !!s.starred,
  paint: (s, want) => ({ ...s, starred: want }),
};

/**
 * The follow-up flag. A press can only ever SET it as the person's (`hand`) —
 * `session.followup` on:true is exactly that on the desktop too — and clear it
 * whoever set it. The painted flag's `at` is the press, as near as this phone
 * knows; the host's own stamp replaces it the moment a row confirms.
 */
export const FOLLOWUP_MARK: SessionMark = {
  has: (s) => !!s.followUp,
  paint: (s, want) => {
    if (want) return { ...s, followUp: { by: "hand", at: Date.now() } };
    const { followUp: _gone, ...rest } = s;
    return rest;
  },
};

/** Parse a stored record, keeping only boolean values. */
export function parsePendingMarks(raw: string | null): PendingMarks {
  try {
    const v = JSON.parse(raw || "{}");
    if (!v || typeof v !== "object" || Array.isArray(v)) return {};
    const out: PendingMarks = {};
    for (const [k, b] of Object.entries(v)) if (typeof b === "boolean") out[k] = b;
    return out;
  } catch { return {}; }
}

/** The session list as the person last left it: host rows with the
 *  un-acknowledged presses painted over them. Same array back when there is
 *  nothing to paint, so the common case costs no re-render. */
export function applyPendingMarks(list: SessionInfo[], pending: PendingMarks, mark: SessionMark): SessionInfo[] {
  if (Object.keys(pending).length === 0) return list;
  let touched = false;
  const out = list.map((s) => {
    const want = pending[s.id];
    if (want === undefined || want === mark.has(s)) return s;
    touched = true;
    return mark.paint(s, want);
  });
  return touched ? out : list;
}

/**
 * Drop the presses the host has now confirmed. `dropMissing` is for an
 * AUTHORITATIVE list (`session.list`): a session the host no longer lists
 * cannot carry the mark, so its intent is dead. A single-session update carries
 * no such proof, so it may only clear its own id.
 *
 * Returns null when nothing changed — the caller keeps its object identity.
 */
export function reconcileMarks(pending: PendingMarks, live: SessionInfo[], dropMissing: boolean, mark: SessionMark): PendingMarks | null {
  const ids = Object.keys(pending);
  if (ids.length === 0) return null;
  const byId = new Map(live.map((s) => [s.id, s]));
  const out: PendingMarks = {};
  let changed = false;
  for (const id of ids) {
    const s = byId.get(id);
    if (!s) {
      if (dropMissing) { changed = true; continue; }
      out[id] = pending[id];
      continue;
    }
    if (mark.has(s) === pending[id]) { changed = true; continue; }
    out[id] = pending[id];
  }
  return changed ? out : null;
}
