/**
 * The account's usage wall on the demo desktop: a session parked until the
 * window resets, then continued by the host's auto-continue — the lifecycle of
 * host `sessions/wall.ts` + `server/sessionEvents.ts`, as the phone sees it
 * (`SessionInfo.limit`, the decision rows, the notifications), worded the way
 * the host words them.
 *
 * What it never does is print the CLI's own banner into the PTY: those phrases
 * are kept out of every string in this repo, because one on screen
 * false-positives the detector. The scenario says what happened in its own
 * words instead.
 *
 * A reply reaches the wall with a `wall` step; the reset arrives on the demo's
 * clock (a `clock` step gets there without making anyone wait), and the
 * `autoContinue` step it laid out at `resetAt` then types "continue", starts
 * the turn — the one thing that clears a block on the host — and runs what
 * the scenario scripted for after.
 */
import type { DecisionLogEntry, SessionInfo, SessionLimit } from "@waterplane/shared";
import { mint } from "./model.ts";
import type { Desk } from "./model.ts";

const clockText = (ms: number) => new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

const durText = (ms: number) => {
  const m = Math.max(0, Math.round(ms / 60_000));
  return m >= 60 ? `${Math.floor(m / 60)}h ${m % 60}m` : `${m}m`;
};

/** The host's shape for a session with no block (`wall.ts`'s `idleLimit`). */
export const clearLimit = (autoContinue: boolean): SessionLimit => ({
  blocked: false, blockedSince: 0, resetAt: null, nextAttemptAt: null, attempts: 0, weekly: false,
  autoContinue, autoContinueOverride: null, queuePos: null, resuming: false, first: false,
});

const autoOn = (d: Desk) => d.m.limitConfig?.enabled ?? false;

function decide(d: Desk, s: SessionInfo, phase: NonNullable<DecisionLogEntry["phase"]>, question: string, rationale: string): void {
  const rows = (d.m.decisions ??= []);
  rows.unshift({
    id: mint(d.m, "d"), ts: d.now(), sessionId: s.id, sessionTitle: s.title,
    source: "limit", phase, question, options: [], choice: null, rationale, outcome: "limit",
  });
  d.broadcast({ t: "decisions.log", entries: rows.slice(0, 200) });
}

function notify(d: Desk, s: SessionInfo, title: string, body: string): void {
  const items = (d.m.notifications ??= []);
  items.unshift({ id: mint(d.m, "n"), ts: d.now(), kind: "limit", title, body, sessionId: s.id });
  d.broadcast({ t: "notification.list", items });
}

/** The turn stopped at the wall: park the session until `resetAt`. Returns
 *  whether the host would continue it by itself (the auto-continue switch). */
export function parkAtWall(d: Desk, s: SessionInfo, resetAt: number): boolean {
  const now = d.now();
  const auto = autoOn(d);
  s.limit = {
    blocked: true, blockedSince: now, resetAt, nextAttemptAt: auto ? resetAt : null, attempts: 0, weekly: false,
    autoContinue: auto, autoContinueOverride: null, queuePos: auto ? 1 : null, resuming: false, first: false,
  };
  s.turnActive = false;
  s.idle = true;
  s.idleSince = now;
  delete s.turnStartedAt;
  d.broadcast({ t: "session.updated", session: s });
  const plan = auto ? `auto-continue after the reset (~${clockText(resetAt)})` : "auto-continue is off — resume manually";
  decide(d, s, "blocked", "Session stopped at the Claude usage limit.", plan.charAt(0).toUpperCase() + plan.slice(1) + ".");
  notify(d, s, `Usage limit · ${s.title}`, plan);
  return auto;
}

/** The reset came: type "continue", start the turn, and clear the block the
 *  way the host does — on the turn STARTING, never on the clock alone. */
export function autoContinue(d: Desk, s: SessionInfo): "continued" | "notBlocked" {
  const lim = s.limit;
  if (!lim?.blocked) return "notBlocked";
  const now = d.now();
  decide(d, s, "attempt", `Auto-continue attempt 1 — typing "continue" into the session.`, "");
  const blockedFor = lim.blockedSince ? now - lim.blockedSince : 0;
  s.limit = clearLimit(lim.autoContinue);
  Object.assign(s, { turnActive: true, turnStartedAt: now, idle: false, lastTurnAt: now });
  delete s.idleSince;
  d.broadcast({ t: "session.updated", session: s });
  const dur = blockedFor ? ` · blocked ${durText(blockedFor)}` : "";
  decide(d, s, "resumed", "Usage limit lifted — session resumed.", `1 attempt${dur}`);
  notify(d, s, `Session resumed · ${s.title}`, `usage limit lifted after 1 attempt${dur} — work continues`);
  return "continued";
}
