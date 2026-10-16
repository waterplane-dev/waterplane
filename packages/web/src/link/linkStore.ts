import { useEffect, useRef, useState } from "react";
import type { LinkSnapshot } from "./linkTypes";
import { dirty, emit, invalidate, listeners, setSnapshotBuilder, type Listener } from "./linkBus";
import { doc } from "./linkDoc";
import { status } from "./linkStatus";
import { pulseOn, samples } from "./linkPulse";
import { syncSnapshot } from "./linkSync";
import { trafficSnapshot } from "./linkTraffic";
import { everOutstanding, outstanding, rollup, stuckSends } from "./linkLog";
import { ops } from "./linkOps";

// The dirty set, the listeners and `emit` are `linkBus.ts`'s, so the slices
// that emit never import this module back (it reads all of them).
let snap: LinkSnapshot | null = null;

export function linkSnapshot(): LinkSnapshot {
  if (snap && !dirty.size) return snap;
  const prev = snap;
  const built: LinkSnapshot = {
    status,
    online: status === "open",
    now: clockNow,
    pulse: prev && !dirty.has("pulse") && !dirty.has("status") ? prev.pulse : { enabled: pulseOn, status, samples: samples.slice() },
    sync: prev && !dirty.has("sync") && !dirty.has("status") ? prev.sync : syncSnapshot(),
    traffic: prev && !dirty.has("traffic") ? prev.traffic : trafficSnapshot(),
    log: prev && !dirty.has("log") && !dirty.has("status") ? prev.log : rollup(),
    ops: prev && !dirty.has("ops") ? prev.ops : ops.slice(),
    stuckSends,
    outstanding,
    // Either this page has had work in flight, or this device has ever sent
    // anything at all. The second is what makes the reading survive a reload.
    everOutstanding: everOutstanding || doc.log.sent > 0,
  };
  dirty.clear();
  snap = built;
  return built;
}

setSnapshotBuilder(linkSnapshot);

let ticker: number | null = null;
export let clockNow = Date.now();

/** The once-a-second clock. Rebuilds the top-level object so time-since labels
 *  move, without touching a section — a consumer watching one section still
 *  does not re-render. */
function tickClock(): void {
  clockNow = Date.now();
  // The three sections that move without an event of their own: `traffic`'s
  // rates decay back to zero when nothing arrives (a readout that never reads
  // zero cannot say "nothing is happening"), `log`'s offline share grows for as
  // long as the socket is down, and `sync`'s `lastSeenAt` is stamped by every
  // inbound frame WITHOUT an emit — thousands a minute on a busy PTY, so it is
  // an assignment there and it is picked up here. `ops` and `pulse` are
  // event-driven and keep their identity across the tick.
  invalidate("traffic", "log", "sync");
  emit();
}

function retimeTicker(): void {
  const wantsClock = [...listeners].some((l) => l.live);
  if (wantsClock && ticker == null) ticker = window.setInterval(tickClock, 1000);
  if (!wantsClock && ticker != null) { window.clearInterval(ticker); ticker = null; }
}

/**
 * Subscribe to the whole link.
 *
 * `live` opts into the once-a-second clock, and is what a readout with a
 * "14m ago" in it needs. It is opt-in rather than always-on because the strip
 * can be switched off and `NetActivity` is mounted on every screen: a timer that
 * wakes a backgrounded phone to recompute a number nobody is looking at is
 * exactly the cost this file is supposed to be measuring, not paying.
 */
export function subscribeLink(fn: (s: LinkSnapshot) => void, live = false): () => void {
  const l: Listener = { fn, live };
  listeners.add(l);
  retimeTicker();
  fn(linkSnapshot());
  return () => {
    listeners.delete(l);
    retimeTicker();
  };
}

/**
 * The React half of that one subscription.
 *
 * `select` is what makes a single emit affordable for everybody: `NetActivity`
 * is mounted on every screen and asks for `s.ops`, which keeps its identity
 * while nothing is in flight, so a ping landing three times a minute repaints
 * nothing. A readout that genuinely wants the whole thing (the strip, the health
 * sheet) asks for `s` with `live`, and gets the once-a-second clock with it.
 *
 * The selector is held in a ref rather than being a dependency: it is written
 * inline at every call site, so a dependency array would resubscribe on every
 * render — which for a store whose subscribe emits immediately is an infinite
 * loop, not a slow path.
 */
export function useLink<T>(select: (s: LinkSnapshot) => T, live = false): T {
  const sel = useRef(select);
  sel.current = select;
  const [v, setV] = useState<T>(() => select(linkSnapshot()));
  useEffect(() => subscribeLink((s) => {
    const next = sel.current(s);
    // Identity, not deep equality: sections are memoized above precisely so this
    // comparison can be the cheap one. React bails out of the re-render when the
    // value is unchanged.
    setV((prev) => (Object.is(prev, next) ? prev : next));
  }, live), [live]);
  return v;
}
