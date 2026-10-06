/**
 * **The link, as one store.** Everything this device knows about the tunnel to
 * the desktop: how good it is right now, how current the screen is, how much
 * data has moved, what the link has been DOING to the send queue, and what is on
 * the wire this second.
 *
 * It was six modules — `netlog`, `netpulse`, `netsync`, `nettraffic`,
 * `netstate` and the strip's own stitching — with five persistence keys, four
 * bespoke subscribe/emit systems, three copies of the `pagehide` write-through
 * handler, and, the part that actually cost bugs, **four independent derivations
 * of "am I online"**: the socket's `readyState`, `netsync`'s `connectedSince`,
 * `netpulse`'s `status` and each caller's own `conn.status !== "open"`. Two
 * readouts disagreeing about the link is a whole bug class, and it lived here:
 * a strip whose dot was green beside a sheet that said "last connected 14m ago"
 * is not a cosmetic defect, it is the app being unable to answer the one
 * question a bad tunnel makes people ask.
 *
 * So: **one status, one document, one emit.**
 *
 *  • `noteLinkStatus()` is the ONLY writer of online-ness. It is edge-triggered
 *    and idempotent, which is what lets the transport keep calling it from every
 *    place it already did (open, close, and the status emit) without any of them
 *    double-counting a reconnect.
 *
 *  • one persisted document with four sections — `pulse` / `sync` / `traffic` /
 *    `log` — written by one debounced writer, flushed by one `pagehide`
 *    handler. It survives a reload because **the reload IS a data point**: the
 *    `ws.ts` watchdog hard-reloads the page exactly when the link is at its
 *    worst, so a counter living only in memory would reset itself at the one
 *    moment it matters and report a perfect score.
 *
 *  • one `subscribeLink`. Sections keep their object identity while they have
 *    not changed, so a consumer that only watches `ops` does not repaint when a
 *    ping lands, and the once-a-second clock that the "14m ago" labels need is
 *    OPT-IN (`live`) rather than something an always-mounted strip imposes on a
 *    phone in a pocket.
 *
 * What deliberately stayed OUT of here:
 *
 *  • the sends that gave up, BY NAME. The roll-up below is POSTed to the host
 *    once a minute and what somebody typed into a prompt is not telemetry, so
 *    the words stay on their own rows in the send queue, on this phone only.
 *    All this file takes is a count (`noteStuckSends`), PUSHED rather than
 *    read, because the strip repaints once a second and the queue is a parse of
 *    up to five hundred rows.
 *
 *  • `shared/netfuse.ts` — the fetch timeout fuse. It is shared with the host
 *    and it is not a readout; a fuse that fires is a decision, not an
 *    observation.
 *
 * Everything here is best-effort and must never throw into a caller: a full or
 * disabled localStorage means no telemetry, never a broken send.
 */

export { deviceId, noteAckTimeout, noteOutstanding, noteReload, noteRtt, noteSendConfirmed, noteSendExpired, noteSendFailed, noteStuckSends, resetLinkWindow, rollup, rttP95 } from "./link/linkLog";
export { installLinkMeters, startLinkReporting } from "./link/linkMeters";
export { labelForUrl, netBegin } from "./link/linkOps";
export { PULSE_CAP, pulseEnabled, setPulseEnabled, startLinkProbes, summarize } from "./link/linkPulse";
export type { PulseSource, PulseSummary } from "./link/linkPulse";
export { linkOnline, linkStatus, noteLinkStatus } from "./link/linkStatus";
export { linkSnapshot, subscribeLink, useLink } from "./link/linkStore";
export { lastSyncEver, noteHostSeen, noteSynced, syncSnapshot, whenText } from "./link/linkSync";
export { fmtRate, fmtTotal, noteTraffic, trafficSnapshot } from "./link/linkTraffic";
export type { TrafficDir } from "./link/linkTraffic";
export type { LinkLog, LinkPulse, LinkSnapshot, LinkStatus, LinkSync, LinkTraffic, NetOp, PulseSample, SyncPart } from "./link/linkTypes";
export { fmtMs, fmtSince, linkVerdict } from "./link/linkVerdict";
export type { HostLinkStats } from "./link/linkVerdict";
