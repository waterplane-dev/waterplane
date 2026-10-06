/**
 * The ONE way a reader outside the session slices reaches a live session's
 * `BackendSources` (`docs/analysis/backends-design.md` §2, WP1c).
 *
 * `deliver.ts`, `settle.ts`, `sessions/record.ts` and `sessions/ctxseries.ts`
 * each ask a source for one fact — a landed prompt, the user turns since a
 * delivery, the reader's document, the current fill — and none of them owns the
 * channel that answers. The channel (attach, health, teardown) is the side
 * channel slice's (`sessions/sidechannel.ts`, WP1b), so this module is a narrow
 * LOOKUP the slice installs and the readers consult, the same singleton posture
 * as `setCliHealth` / `setOpenDeliveries`:
 *
 *  - **Nothing installed ⇒ every lookup is null ⇒ every reader is exactly
 *    today's.** That is the whole compatibility argument: a backend with no
 *    `sources`, or a host whose slice has not wired this yet, takes the path it
 *    always took, byte for byte.
 *  - **A throwing lookup is a null**, never an exception into a delivery: a
 *    source is a higher rung, and losing it can only cost the fact, never the
 *    send.
 *  - `channelUp` is asked only by `deliver.ts`, where a down channel would make
 *    `landed` wait out its whole timeout for an answer it cannot give. The other
 *    readers ask the source and trust its `null` — that is the source contract.
 */
import type { BackendSources, ChannelHealth, SourceSession } from "@waterplane/shared";

/** One live session as the readers see its sources. */
export interface LiveSource {
  readonly session: SourceSession;
  readonly sources: BackendSources;
  /** The attached handle's health; null when no handle is attached (yet). */
  health(): ChannelHealth | null;
}

export type LiveSourceLookup = (sessionId: string) => LiveSource | null;

let lookup: LiveSourceLookup | null = null;

/** Installed by the side channel slice (or a test); null uninstalls. */
export function setLiveSourceLookup(fn: LiveSourceLookup | null): void {
  lookup = fn;
}

/** The live session's sources, or null — never a throw. */
export function liveSourceFor(sessionId: string): LiveSource | null {
  if (!lookup) return null;
  try { return lookup(sessionId) ?? null; } catch { return null; }
}

/** Is the channel attached and up? A handle that cannot say is not up. */
export function channelUp(l: LiveSource): boolean {
  try { return l.health()?.state === "up"; } catch { return false; }
}
