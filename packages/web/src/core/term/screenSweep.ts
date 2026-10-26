/**
 * The offline TERMINAL of every session, not only the one this phone attached.
 *
 * `ptyTail.ts` saves the tail of the session on screen, so a session started at
 * the desk (or opened only in another tab) walked into a dead zone as "nothing
 * cached for this session yet" — while its transcript, swept by
 * `sweepTranscripts`, was right there. This tops up the terminal the same way:
 * newest first, one at a time, `since` = the seq we hold (an unmoved session
 * is a 204), and what comes back is stored exactly as a watched session's tail
 * is — raw bytes + seq + boot — so a later attach stitches only the delta on.
 *
 * A RUNNING session's seq moves with every spinner frame, so `since` never
 * saves it a fetch; it is re-read at most every `RUNNING_GAP_MS` (×4 on data
 * saver) instead of every sweep. The attached session is never swept: its
 * tail is the live stream's, saved by the feed itself.
 */

export const RUNNING_GAP_MS = 15 * 60_000;
/** The phone keeps this many tails (`ptyTail.ts`' `PTY_MAX_SESSIONS`). */
export const SCREEN_SWEEP_MAX = 12;

export interface SweepCandidate { id: string; running: boolean; idle?: boolean }

/** Which sessions this sweep asks for, in the order given (newest first). */
export function screenSweepIds(
  sessions: readonly SweepCandidate[], attachedId: string | null,
  lastAsked: ReadonlyMap<string, number>, now: number, saver: boolean,
): string[] {
  const gap = RUNNING_GAP_MS * (saver ? 4 : 1);
  return sessions
    .filter((s) => s.id !== attachedId)
    .slice(0, SCREEN_SWEEP_MAX)
    .filter((s) => !(s.running && !s.idle) || now - (lastAsked.get(s.id) ?? 0) >= gap)
    .map((s) => s.id);
}

export interface ScreenTail { data: string; seq: number; boot?: string }

export interface ScreenSweepDeps {
  /** null = 204, unchanged since `since`. Throws on a refusal (an older host's 404 included). */
  fetchTail(id: string, since: number | undefined): Promise<ScreenTail | null>;
  /** The seq this phone already holds for `id` in the CURRENT boot's numbering, if any. */
  heldSeq(id: string): number | undefined;
  /** Is `id` attached now? Re-asked after the fetch: a tap during it wins. */
  attached(id: string): boolean;
  apply(id: string, tail: ScreenTail): Promise<void>;
}

let sweeping = false;

/** Sequential, best-effort per session; one sweep at a time. */
export async function sweepScreens(ids: readonly string[], deps: ScreenSweepDeps, lastAsked: Map<string, number>): Promise<void> {
  if (sweeping) return;
  sweeping = true;
  try {
    for (const id of ids) {
      lastAsked.set(id, Date.now());
      try {
        const tail = await deps.fetchTail(id, deps.heldSeq(id));
        if (tail && tail.data && !deps.attached(id)) await deps.apply(id, tail);
      } catch {
        lastAsked.delete(id); // retried next sweep
      }
    }
  } finally {
    sweeping = false;
  }
}
