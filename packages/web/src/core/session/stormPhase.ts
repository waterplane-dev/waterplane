/**
 * When the storm overlay (`StormOverlay.tsx`) is up, and when the plane lands.
 *
 * Native shell only, and only over NOTHING: the storm is a convenience for an
 * empty screen on a dead link, never a curtain over words someone could read.
 * Pure so the edges are tested, not eyeballed:
 *
 * - `quiet` = nothing to read: no terminal output, no scrollback, no cached or
 *   live transcript. Not quiet ⇒ off, at once, whatever phase it was in.
 * - It starts only after `down` (the banner's own condition, already past its
 *   grace window) has held another `START_MS` — a cold start that connects in
 *   a few seconds never sees it.
 * - A short outage gets no show: storm up for less than `SHOW_MIN_MS` and the
 *   link back ⇒ off, no landing to sit through.
 * - Otherwise the plane lands only once the socket has stayed open for
 *   `STABLE_MS`; a drop on approach or on finals is a go-around (`storm`).
 * - A dismiss holds until the link is open again; the next outage may bring
 *   the plane back.
 */
export type StormPhase = "off" | "pending" | "storm" | "approach" | "landing";

export const START_MS = 2000;
export const SHOW_MIN_MS = 8000;
export const STABLE_MS = 1500;
export const LAND_MS = 5200;

export interface StormInput {
  /** The banner's own condition: not open, past the grace window. */
  down: boolean;
  open: boolean;
  /** Nothing on screen or cached that a person could read. */
  quiet: boolean;
  dismissed: boolean;
  now: number;
}

/** `shownAt`: when the storm first drew for this outage (0 = not yet). */
export interface StormState { phase: StormPhase; since: number; shownAt: number }

export const STORM_OFF: StormState = { phase: "off", since: 0, shownAt: 0 };

export function nextStorm(s: StormState, i: StormInput): StormState {
  const off = (): StormState => (s.phase === "off" ? s : { phase: "off", since: i.now, shownAt: 0 });
  if (i.dismissed || !i.quiet) return off();
  const age = i.now - s.since;
  switch (s.phase) {
    case "off":
      return i.down ? { phase: "pending", since: i.now, shownAt: 0 } : s;
    case "pending":
      if (!i.down) return off();
      return age >= START_MS ? { phase: "storm", since: i.now, shownAt: i.now } : s;
    case "storm":
      if (!i.open) return s;
      return i.now - s.shownAt < SHOW_MIN_MS ? off() : { ...s, phase: "approach", since: i.now };
    case "approach":
      if (!i.open) return { ...s, phase: "storm", since: i.now };
      return age >= STABLE_MS ? { ...s, phase: "landing", since: i.now } : s;
    case "landing":
      if (!i.open) return { ...s, phase: "storm", since: i.now };
      return age >= LAND_MS ? off() : s;
  }
}

/** Is anything drawn for this phase? (`pending` is a wait, not a picture.) */
export const stormShown = (s: StormState): boolean => s.phase !== "off" && s.phase !== "pending";
