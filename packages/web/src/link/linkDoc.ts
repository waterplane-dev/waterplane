import { LS, lsDel, lsGet, lsSetJson } from "../storage";
import type { LinkDoc, LinkLogDoc, LinkSyncDoc, LinkTrafficDoc } from "./linkTypes";

/** Percentiles off a bounded reservoir — see `LinkLogDoc`. */
export const SAMPLE_CAP = 200;
/** Roll-ups go to the host at most this often; also on hide, via sendBeacon. */
export const FLUSH_MS = 60_000;
/**
 * One debounced writer for the whole document. Between the old three (2 s for
 * the counters, 4 s for the byte totals, a 10 s ration for the frame stamp): the
 * only thing any of these writes buys is surviving a reload, and the two paths
 * that genuinely cannot wait — a disconnect and the watchdog's own reload — go
 * through `persistNow()` instead.
 */
const WRITE_DEBOUNCE_MS = 3000;
/** Restart the delivery window past this age, so a month-old p95 can't dominate
 *  today's. The byte totals and the sync stamps are NOT restarted with it —
 *  those are answers to "since when", and the sheet prints the date. */
const WINDOW_MAX_MS = 24 * 60 * 60_000;

/**
 * The store's key.
 *
 * Still `waterplane.netlog` because `storage.ts` is the registry of every key this app
 * owns and it is not mine to edit in this pass — the document under it is now
 * the whole link store, not just the request window. Renaming it to `waterplane.link`
 * is a two-line change there plus the `v: 2` migration below, which already
 * handles reading a foreign shape.
 */
const KEY = LS.netlog;
export const DEVICE_KEY = LS.deviceId;

export function blankLog(now: number): LinkLogDoc {
  return { since: now, rtt: [], send: [], reconnects: 0, reloads: 0, offlineMs: 0, markTs: now, online: false, sent: 0, failed: 0, expired: 0, ackTimeouts: 0, queuedMaxMs: 0 };
}

function load(): LinkDoc {
  const now = Date.now();
  const fresh: LinkDoc = {
    v: 2,
    log: blankLog(now),
    sync: { lastSeenAt: 0, parts: { sessions: 0, repos: 0 } },
    traffic: { since: now, up: 0, down: 0 },
  };
  const raw = lsGet(KEY);
  if (!raw) return migrateOld(fresh);
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { return fresh; }
  const d = parsed as Partial<LinkDoc> & Partial<LinkLogDoc>;
  if (!d || typeof d !== "object") return fresh;
  // No `v` ⇒ this is the old flat `netlog` document. Its fields are the `log`
  // section verbatim, and the other two sections are still under their own old
  // keys — read them once, then take those keys out of circulation.
  if (d.v !== 2) return migrateOld({ ...fresh, log: readLog(d as Partial<LinkLogDoc>, now) });
  return {
    v: 2,
    log: readLog(d.log ?? {}, now),
    sync: {
      lastSeenAt: Number(d.sync?.lastSeenAt) || 0,
      parts: { sessions: Number(d.sync?.parts?.sessions) || 0, repos: Number(d.sync?.parts?.repos) || 0 },
    },
    traffic: {
      since: Number(d.traffic?.since) || now,
      up: Math.max(0, d.traffic?.up || 0),
      down: Math.max(0, d.traffic?.down || 0),
    },
  };
}

function readLog(d: Partial<LinkLogDoc>, now: number): LinkLogDoc {
  if (typeof d.since !== "number" || now - d.since > WINDOW_MAX_MS) return blankLog(now);
  return {
    ...blankLog(now),
    ...d,
    rtt: Array.isArray(d.rtt) ? d.rtt : [],
    send: Array.isArray(d.send) ? d.send : [],
  };
}

/**
 * Fold the two keys the split store used into the new document, once.
 *
 * These are user-visible numbers with a date printed next to them — "downloaded
 * 2.1 GB since 12/04" and "last connected Tue 09:14" — so a consolidation that
 * silently zeroed them would look exactly like the bug this whole file exists to
 * prevent: a readout that reset itself and then claimed everything was fine.
 */
function migrateOld(into: LinkDoc): LinkDoc {
  try {
    const s = lsGet(LS.netSync);
    if (s) {
      const d = JSON.parse(s) as LinkSyncDoc;
      if (d && typeof d.lastSeenAt === "number") {
        into.sync = {
          lastSeenAt: d.lastSeenAt,
          parts: { sessions: Number(d.parts?.sessions) || 0, repos: Number(d.parts?.repos) || 0 },
        };
      }
      lsDel(LS.netSync);
    }
  } catch { /* nothing to carry over */ }
  try {
    const t = lsGet(LS.netTraffic);
    if (t) {
      const d = JSON.parse(t) as LinkTrafficDoc;
      if (d && typeof d.since === "number") into.traffic = { since: d.since, up: Math.max(0, d.up | 0), down: Math.max(0, d.down | 0) };
      lsDel(LS.netTraffic);
    }
  } catch { /* nothing to carry over */ }
  return into;
}

export const doc: LinkDoc = load();
let writeTimer: number | null = null;

export function persist(): void {
  if (writeTimer != null) return;   // a pending write already covers this change
  writeTimer = window.setTimeout(() => {
    writeTimer = null;
    lsSetJson(KEY, doc);
  }, WRITE_DEBOUNCE_MS);
}

export function persistNow(): void {
  if (writeTimer != null) { window.clearTimeout(writeTimer); writeTimer = null; }
  lsSetJson(KEY, doc);
}
