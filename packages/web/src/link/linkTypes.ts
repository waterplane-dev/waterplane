export type LinkStatus = "connecting" | "open" | "closed";

/**
 * The delivery/quality window.
 *
 * A WINDOW, not a log. Individual events are aggregated on the spot into
 * counters and two bounded sample arrays; nothing accumulates per message.
 * localStorage is shared with the send outbox — the one store that must never be
 * evicted — so a telemetry buffer that grew with usage would eventually cost a
 * prompt, which is the exact failure this exists to measure.
 */
export interface LinkLogDoc {
  since: number;
  /** ws ping→pong samples, ms. */
  rtt: number[];
  /** queued → confirmed samples, ms. */
  send: number[];
  reconnects: number;
  reloads: number;
  /** Accumulated time with no open socket, ms. */
  offlineMs: number;
  /** When the current connected/disconnected stretch began. */
  markTs: number;
  /** Is a socket open right now? Drives which side `offlineMs` accrues to. */
  online: boolean;
  sent: number;
  /**
   * TOTAL give-ups. Every path that flips a queue row to `failed` increments
   * this exactly once — so this is the number to show, never a sum with
   * `expired`. Adding the two was how the health sheet reported an expiry twice.
   */
  failed: number;
  /** Of those, the ones that ran out of ATTEMPTS — a BREAKDOWN of `failed`, not
   *  a second population. Nothing runs out of TIME any more: the queue's
   *  thirty-minute expiry is deleted, so this counts a host that kept refusing
   *  a delivery and nothing else. */
  expired: number;
  ackTimeouts: number;
  queuedMaxMs: number;
}

/** The halves of a full sync. Adding one here (a third screen-defining fetch)
 *  automatically makes `syncedAt` wait for it — which is the intent: this is a
 *  claim about the whole screen, not about whichever call happened to answer. */
export type SyncPart = "sessions" | "repos";

export interface LinkSyncDoc {
  /** Newest inbound frame, ever. */
  lastSeenAt: number;
  /** Per-part "this was refreshed at". Zero = never on this device. */
  parts: Record<SyncPart, number>;
}

export interface LinkTrafficDoc {
  since: number;
  up: number;
  down: number;
}

export interface LinkDoc {
  /** Bumped when the shape changes; an absent `v` is the pre-consolidation
   *  `waterplane.netlog` document and is migrated in `load()`. */
  v: 2;
  log: LinkLogDoc;
  sync: LinkSyncDoc;
  traffic: LinkTrafficDoc;
}

/** One probe outcome. `ms === null` = asked and got nothing back (or there was
 *  no socket to ask over) — the case the whole graph exists to show. */
export interface PulseSample {
  at: number;
  ms: number | null;
}

export interface LinkPulse {
  /** Is the permanent strip switched on? No strip ⇒ no probes. */
  enabled: boolean;
  status: LinkStatus;
  samples: readonly PulseSample[];
}

export interface LinkSync {
  online: boolean;
  /** When the socket that is up now came up. Null while it is not. */
  connectedSince: number | null;
  /** Newest proof the host was there. Null on a phone that has never connected. */
  lastSeenAt: number | null;
  /** When the whole screen was last current — the older of the two parts, and
   *  null until both have landed on this connection. */
  syncedAt: number | null;
  /** The halves that have NOT refreshed since the socket came up. Empty when in
   *  sync; the reason a `syncedAt` is null while online. */
  pending: SyncPart[];
}

export interface LinkTraffic {
  /** Epoch ms the totals started accumulating. */
  since: number;
  /** Bytes, total, since `since`. */
  up: number;
  down: number;
  /** Bytes per second over the last few seconds, 0 when idle. */
  upRate: number;
  downRate: number;
}

/** What the health sheet renders and what gets POSTed to the host. Nothing
 *  per-message is in here, and nothing ever will be — see the file header. */
export interface LinkLog {
  since: number;
  rttP50?: number;
  rttP95?: number;
  reconnects: number;
  reloads: number;
  offlineShare: number;
  sendP50?: number;
  sendP95?: number;
  sent: number;
  /** Total give-ups (see `LinkLogDoc.failed` — never sum this with `expired`). */
  failed: number;
  /** Of those, the ones that aged out. */
  expired: number;
  ackTimeouts: number;
  queuedMaxMs: number;
  ua?: string;
}

export interface NetOp {
  id: number;
  /** Human label, shown once the wait is long enough to warrant words. */
  label: string;
  /** Epoch ms the request went out — the elapsed counter reads from this. */
  started: number;
}

/**
 * Everything, in one object.
 *
 * Each section keeps its identity while it has not changed, which is what makes
 * one emit serve consumers with very different appetites: `NetActivity` is
 * mounted on every screen and only cares about `ops`, and it must not repaint
 * because a ping came back. `now` moves only for `live` subscribers.
 */
export interface LinkSnapshot {
  status: LinkStatus;
  online: boolean;
  /** The clock the "14m ago" labels are rendered against. Only advances while
   *  somebody has asked for a `live` subscription. */
  now: number;
  pulse: LinkPulse;
  sync: LinkSync;
  traffic: LinkTraffic;
  log: LinkLog;
  ops: readonly NetOp[];
  /**
   * How many sends have given up and not been dealt with — the one red reading
   * on the strip. Pushed in by App (which owns the rows and their words); this
   * file only ever holds the number.
   */
  stuckSends: number;
  /**
   * How many things this phone is holding that the desktop does not have: the
   * live send queue plus the synced settings keys still waiting on a push.
   * Pushed in by App for `stuckSends`' reason.
   */
  outstanding: number;
  /**
   * Whether the all-clear is worth printing at all on this DEVICE.
   *
   * It is what keeps the green check honest and rare. "All saved" printed on a
   * phone that has never sent anything would be true and worthless — nothing was
   * ever at risk — and a strip that speaks on a good link is a strip people stop
   * glancing at. So the mark is EARNED.
   *
   * Earned by the DEVICE, not by the page. A latch that only counted this
   * page's own history went quiet on every reload, which is precisely the wrong
   * moment: someone opening the app the next morning to check that yesterday's
   * queue drained is the person this reading exists for, and they would have
   * been met with silence. `doc.log.sent` is the already-persisted answer to
   * "has this phone ever put something through the queue" — no second store, no
   * new key, and it survives the reload for the same reason the rest of the log
   * does.
   */
  everOutstanding: boolean;
}

export type Section = "status" | "pulse" | "sync" | "traffic" | "log" | "ops" | "sends";
