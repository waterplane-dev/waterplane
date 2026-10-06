/**
 * The demo tour's pure half: which rows it lists, where each one goes, and the
 * per-device "seen" record. No React, no storage, no DOM — `logic.test.mjs`
 * runs it under node.
 */
import type { Overlay } from "../../routing.ts";

/** The demo's session the tour drives into (`demo/scenarios/first-look.ts`). */
export const TOUR_SESSION = "demo-g1";
/** Its repo, the fallback when the scenario renames the session. */
export const TOUR_REPO = "todo-garden";
/** The words that make the first-look scenario ask its question (it matches "sort"). */
export const TOUR_ASK_PROMPT = "sort the tasks by due date";

/** Where a row goes. `inSession` sheets are scoped to a session, so the tour
 *  opens the demo session first and the sheet over it. */
export type TourTarget =
  | { kind: "session" }
  | { kind: "reader"; seed?: string }
  /** The session's repo-health series (`features/setup`, asked by `REPO_HEALTH_EVENT`). */
  | { kind: "health" }
  | { kind: "sheet"; overlay: Exclude<Overlay, null>; inSession?: boolean };

/** Icon names, mapped to lucide components in `DemoTourSheet.tsx`. */
export type TourIcon =
  | "terminal" | "pointer" | "book" | "list" | "clock" | "hourglass" | "activity"
  | "images" | "bell" | "send" | "search" | "gavel" | "coins" | "gauge" | "heart";

export interface TourRow {
  id: string;
  icon: TourIcon;
  headline: string;
  /** One sentence: what it does for the person. Plain words, no hype. */
  sentence: string;
  target: TourTarget;
}

export interface TourGroup {
  title: string;
  rows: readonly TourRow[];
}

export const TOUR: readonly TourGroup[] = [
  {
    title: "Drive it",
    rows: [
      {
        id: "live", icon: "terminal", headline: "Your session, in your pocket",
        sentence: "The real claude CLI on your desktop, in a terminal on your phone — every slash command, plan prompt and context meter works, because it is the same program.",
        target: { kind: "session" },
      },
      {
        id: "answer", icon: "pointer", headline: "Answer by tap",
        sentence: `We put "${TOUR_ASK_PROMPT}" in the box for you — send it, and when Claude asks which way, tap the answer instead of typing a number.`,
        target: { kind: "reader", seed: TOUR_ASK_PROMPT },
      },
      {
        id: "reader", icon: "book", headline: "Read it like a chat",
        sentence: "A long conversation as a scrollable, searchable transcript, tool output folded away until you open it.",
        target: { kind: "reader" },
      },
    ],
  },
  {
    title: "Leave it running",
    rows: [
      {
        id: "backlog", icon: "list", headline: "Backlog",
        sentence: "Line up the next jobs for a repo; each one starts by itself when the session goes quiet.",
        target: { kind: "sheet", overlay: "backlog" },
      },
      {
        id: "schedule", icon: "clock", headline: "Schedules",
        sentence: "Run a prompt on a clock — a weekly dependency check, a nightly test run — without being there.",
        target: { kind: "sheet", overlay: "schedule" },
      },
      {
        id: "limits", icon: "hourglass", headline: "Carries on after a usage limit",
        sentence: "When the account hits its limit, blocked sessions are parked and continue by themselves when it resets.",
        target: { kind: "sheet", overlay: "limits" },
      },
      {
        id: "activity", icon: "activity", headline: "Everything you posted",
        sentence: "Every prompt, schedule and build you sent, one row each from waiting to done — sent once, never lost on a bad connection.",
        target: { kind: "sheet", overlay: "activity" },
      },
    ],
  },
  {
    title: "See what it did",
    rows: [
      {
        id: "gallery", icon: "images", headline: "Gallery",
        sentence: "Screenshots and files Claude saved for you show up as pictures, ready to view, mark up or download.",
        target: { kind: "sheet", overlay: "gallery", inSession: true },
      },
      {
        id: "notifications", icon: "bell", headline: "Notifications",
        sentence: "One feed of what needs you: a session that finished, a question waiting, a job that failed.",
        target: { kind: "sheet", overlay: "notifications" },
      },
      {
        id: "sentlog", icon: "send", headline: "Sent log",
        sentence: "Every word the app typed into a session, automatic answers included, and whether it arrived.",
        target: { kind: "sheet", overlay: "sentlog" },
      },
      {
        id: "search", icon: "search", headline: "Search past sessions",
        sentence: "Find a conversation by something that was said in it, and open it where it was.",
        target: { kind: "sheet", overlay: "search" },
      },
      {
        id: "decisions", icon: "gavel", headline: "Decisions log",
        sentence: "What a plugin answered on your behalf, and why, so nothing was decided out of sight.",
        target: { kind: "sheet", overlay: "decisions" },
      },
    ],
  },
  {
    title: "Know what it costs",
    rows: [
      {
        id: "tokens", icon: "coins", headline: "Tokens and cost",
        sentence: "What each day, repo and model spent, with the split behind every total.",
        target: { kind: "sheet", overlay: "tokens" },
      },
      {
        id: "health", icon: "heart", headline: "Repo health",
        sentence: "How the code itself is trending — file sizes, tests, the weight of CLAUDE.md — read off the repo without spending a token.",
        target: { kind: "health" },
      },
      {
        id: "context", icon: "gauge", headline: "Context window",
        sentence: "How full this session's context is over time, and where it was compacted, before it surprises you.",
        target: { kind: "sheet", overlay: "context", inSession: true },
      },
    ],
  },
];

/** Every row, flat, in the order drawn. */
export const TOUR_ROWS: readonly TourRow[] = TOUR.flatMap((g) => g.rows);

/**
 * What this device remembers about this visit: which rows a tap has reached,
 * and how far the HOOK got — the first minute (docs/analysis/demo-pitch-plan.md
 * §1): `opened` the demo session by itself once, the reader toggle was `read`
 * (so its hint is gone), and the closing card was `closed`. Cleared when the
 * demo is entered or left.
 */
export interface TourState {
  seen: readonly string[];
  opened: boolean;
  read: boolean;
  closed: boolean;
}

export const EMPTY_TOUR: TourState = { seen: [], opened: false, read: false, closed: false };

/** A stored value, made safe: anything malformed reads as a fresh tour, and
 *  ids no longer in the list are dropped. */
export function parseTourState(raw: unknown): TourState {
  if (!raw || typeof raw !== "object") return EMPTY_TOUR;
  const r = raw as { seen?: unknown; opened?: unknown; read?: unknown; closed?: unknown };
  const known = new Set(TOUR_ROWS.map((x) => x.id));
  const seen = Array.isArray(r.seen) ? [...new Set(r.seen.filter((s): s is string => typeof s === "string" && known.has(s)))] : [];
  return { seen, opened: r.opened === true, read: r.read === true, closed: r.closed === true };
}

/** The state with `id` seen. Unknown ids and repeats change nothing (same object back). */
export function markSeen(s: TourState, id: string): TourState {
  if (s.seen.includes(id) || !TOUR_ROWS.some((r) => r.id === id)) return s;
  return { ...s, seen: [...s.seen, id] };
}

/** One hook step done. Already done ⇒ the same object back. */
export function markHook(s: TourState, step: "opened" | "read" | "closed"): TourState {
  return s[step] ? s : { ...s, [step]: true };
}

/** "3 of 14 tried", and whether all are. */
export function tourProgress(s: TourState): { seen: number; total: number; done: boolean } {
  const ids = new Set(s.seen);
  const seen = TOUR_ROWS.filter((r) => ids.has(r.id)).length;
  return { seen, total: TOUR_ROWS.length, done: seen === TOUR_ROWS.length };
}

export function progressText(s: TourState): string {
  const p = tourProgress(s);
  return p.done ? `All ${p.total} tried` : `${p.seen} of ${p.total} tried`;
}

// ── The hook: the demo's first minute ─────────────────────────────────────

/** The scenario that opens on a session already working (`demo/scenarios/first-look.ts`). */
export const HOOK_SCENARIO = "first-look";
/** What that scenario's annotate-and-send-back reply matches — the loop is done
 *  once a turn on that prompt has ended. `logic.test.mjs` holds it to the scenario. */
export const HOOK_REPLY_MATCH = "bigger";

/** The facts the hook decisions read: never the DOM, never a timer. */
export interface HookCtx {
  demo: boolean;
  /** The running demo scenario (`demoActiveId()`). */
  scenario: string | null;
}

const hooked = (f: HookCtx): boolean => f.demo && f.scenario === HOOK_SCENARIO;

/**
 * Open the demo session by itself? Once per visit, in the hook scenario, and
 * only while nothing else is on screen (a reload restores its own route).
 * Under browser automation too: the journeys walk this first minute.
 */
export function shouldOpenHook(s: TourState, f: HookCtx & { active: boolean }): boolean {
  return hooked(f) && !s.opened && !f.active;
}

/** The "Read it like a chat" hint: on the hook session, until the reader has
 *  been opened once (or the visit's closing card was dismissed). */
export function hintShown(s: TourState, f: HookCtx & { activeId: string | null }): boolean {
  return hooked(f) && f.activeId === TOUR_SESSION && !s.read && !s.closed;
}

/** The annotate-and-send-back turn has run and finished. */
export function loopDone(session: { turnActive?: boolean; lastPrompt?: string } | null | undefined): boolean {
  return !!session && !session.turnActive && (session.lastPrompt ?? "").toLowerCase().includes(HOOK_REPLY_MATCH);
}

/** The closing card ("While you're away"): on the hook session once the loop
 *  is done, until its X puts it away (a door leaves it standing). */
export function cardShown(s: TourState, f: HookCtx & { session: { id: string; turnActive?: boolean; lastPrompt?: string } | null }): boolean {
  return hooked(f) && f.session?.id === TOUR_SESSION && !s.closed && loopDone(f.session);
}

/** The session the tour drives into: the scenario's own id, else the first
 *  session in its repo, else none (the list has not arrived yet). */
export function tourSession<S extends { id: string; cwd: string }>(sessions: readonly S[]): S | null {
  return sessions.find((s) => s.id === TOUR_SESSION)
    ?? sessions.find((s) => s.cwd.replace(/\/+$/, "").endsWith(`/${TOUR_REPO}`))
    ?? null;
}

/** Does tapping this row need the demo session on the list? */
export function needsSession(t: TourTarget): boolean {
  return t.kind !== "sheet" || t.inSession === true;
}
