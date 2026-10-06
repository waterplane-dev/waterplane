import type { LinkLog } from "./linkTypes";

/**
 * The host's half of the numbers, mirroring `host/netstats.ts`.
 *
 * Kept here rather than in `shared`: it is a read-only diagnostic payload, and
 * putting it on the wire protocol would imply a compatibility promise nothing
 * needs. It lives beside the device half because the verdict below is the one
 * thing that has to read both, and a screen that had to know the shape of the
 * host's counters in order to render them was a screen doing the store's job.
 */
export interface HostLinkStats {
  updatedAt: number;
  since: number;
  sockets: {
    opened: number; closed: number;
    closeCodes: Record<string, number>;
    byPeer: Record<string, number>;
    peakConcurrent: number; totalOpenMs: number; minOpenMs: number | null;
  };
  delivery: { ok: number; retry: number; unconfirmed: number; unsubmitted: number };
  ackReplays: number;
  clients: Record<string, { at: number; ua?: string; rttP95?: number; reconnects?: number; offlineShare?: number }>;
}

/** A duration, in the words a readout uses. */
export function fmtMs(v: number | undefined | null): string {
  if (v == null) return "—";
  if (v < 1000) return `${Math.round(v)} ms`;
  if (v < 60_000) return `${(v / 1000).toFixed(1)} s`;
  return `${Math.round(v / 60_000)} min`;
}

/** How long ago, compactly — "the last 4h", "the last 2d". */
export function fmtSince(ts: number): string {
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (s < 90) return `${s}s`;
  if (s < 5400) return `${Math.round(s / 60)}m`;
  if (s < 172800) return `${Math.round(s / 3600)}h`;
  return `${Math.round(s / 86400)}d`;
}

/**
 * The one sentence worth reading, and the whole reason the health sheet exists.
 *
 * "Prompts go missing sometimes" is a symptom with four completely different
 * causes, and the numbers separate them: text never leaving the phone, receipts
 * not coming back, deliveries the host could not confirm, or the app being
 * reloaded out from under the queue.
 *
 * Ordered by how much the finding COSTS you, not by the severity of the number:
 * a prompt that never ran is worse than a slow link, and a reloaded app is worse
 * than either because it can take the queue's own in-memory state with it.
 *
 * Here rather than in the sheet because it is the store's own reading of itself
 * — pure, over one snapshot plus the host's counters — and because it is the
 * piece most likely to drift from the numbers it summarises if the two live on
 * different sides of a render.
 */
export function linkVerdict(me: LinkLog, host: HostLinkStats | null, named: number): { tone: "ok" | "warn" | "bad"; text: string } {
  const d = host?.delivery;
  const stuck = (d?.unsubmitted ?? 0) + (d?.unconfirmed ?? 0);
  if (stuck > 0) {
    return {
      tone: "bad",
      text: stuck === 1
        ? "1 prompt reached a session but could not be confirmed as running — check that session before re-sending, never retype."
        : `${stuck} prompts reached a session but could not be confirmed as running — check those sessions before re-sending, never retype.`,
    };
  }
  // `failed` is the TOTAL (see `LinkLogDoc`) — summing it with `expired` counted
  // every aged-out entry twice, which is how this line came to claim 18 dead
  // sends on a device that had nine.
  if (me.failed > 0) {
    const n = me.failed;
    // Never claim the list is complete when it isn't: the ledger is capped, and
    // a give-up from before it existed (or after the list was cleared) is
    // counted here and named nowhere.
    const listed = named <= 0
      ? "Their words are kept — on their queue rows, for as long as it takes; nothing retires one."
      : named >= n
        ? "Each one is listed below with its words and what stopped it."
        : `The newest ${named} are listed below with their words and what stopped them.`;
    return { tone: "bad", text: `${n} send${n > 1 ? "s" : ""} stopped trying in the last ${fmtSince(me.since)} — nothing was typed into a session, so nothing ran. ${listed}` };
  }
  if (me.reloads > 0) {
    return { tone: "warn", text: `The watchdog hard-reloaded the app ${me.reloads}×. That means the socket stayed dead long enough to look wedged — queued text survives (localStorage), but it is the clearest sign the tunnel is unhealthy.` };
  }
  if ((host?.ackReplays ?? 0) > 2) {
    return { tone: "warn", text: `${host!.ackReplays} receipts never made it back to a phone, so sends were retried against work the host had already done. Delivery is safe (the ack ledger de-dupes), but the link is dropping return traffic.` };
  }
  if (me.offlineShare > 0.15) {
    return { tone: "warn", text: `No socket for ${Math.round(me.offlineShare * 100)}% of the window. Sends queue and go out on reconnect, but nothing is live in the meantime.` };
  }
  if ((me.rttP95 ?? 0) > 1500) {
    return { tone: "warn", text: `Round trip is ${fmtMs(me.rttP95)} at the 95th percentile — likely a DERP-relayed Tailscale path rather than a direct one. Run the speed test for the direct/relay verdict.` };
  }
  return { tone: "ok", text: "Nothing queued has been lost or left unconfirmed in this window." };
}
