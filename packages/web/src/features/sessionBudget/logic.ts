/**
 * The session budget's pure half — no React, no DOM — so `logic.test.mjs` runs
 * it under `node --test`.
 *
 * Every sentence about a verdict is `@waterplane/shared`'s (`sessionbudget.ts`):
 * the host and the phone must not word one cap two ways, so what is here is
 * only where those sentences go (a chip, a title, a toast) and the once-per-
 * crossing decision. **Unknown never trips and never holds** — a chip that is
 * `budget ?` says why in its own text and the sentence ends on "nothing is held".
 */
import {
  sessionBudgetChip, sessionBudgetHoldText, sessionBudgetText, sessionBudgetUnknownText, sessionBudgetWindowsOffText,
  type BackendInfo, type SessionBudget, type SessionBudgetInfo, type SessionBudgetUnknown, type SessionInfo,
} from "@waterplane/shared";
import { runsClaudeTui } from "../../backendCaps.ts";
import { HELD_SENDS, budgetStateLine } from "../../budgetInput.ts";

// One copy of both: the context sheet's panel words the state with the same line.
export { HELD_SENDS, budgetStateLine };

/** The reason as two or three words, for a chip — the long form is `sessionBudgetUnknownText`. */
export const BUDGET_WHY_SHORT: Record<SessionBudgetUnknown, string> = {
  noSpark: "no turn logged yet",
  unpriced: "model has no list price",
  noReading: "no usage reading",
  stale: "usage reading is old",
  noCalibration: "window too young to convert",
  notRunning: "not running",
  unstated: "backend states no figure",
  notClaude: "not claude's window",
  undated: "ledger has undated records",
};

/** The chip's words for a reason a newer host sent and this bundle does not know. */
export const BUDGET_WHY_UNKNOWN = "can't tell";

/**
 * The budget field's sentence for a session whose backend does not spend from
 * claude's 5-hour and weekly windows — or null, where a percent is offered as
 * ever. The host judging from the backend's own source (`sourceSpend`) says so;
 * so does a backend that is not claude's TUI (`runsClaudeTui`, which answers
 * true on a host too old to list backends).
 */
export function budgetWindowsOff(s: Pick<SessionInfo, "backend" | "sourceSpend">, backends: readonly BackendInfo[] | null): string | null {
  if (!s.sourceSpend && runsClaudeTui(backends, s.backend)) return null;
  const label = backends?.find((b) => b.id === s.backend)?.label;
  return sessionBudgetWindowsOffText(label || "this session's backend");
}

/** The subject backend's own spend unit (`caps.spendUnit`), or undefined — absent means no native unit offered. */
export function budgetSpendUnit(s: Pick<SessionInfo, "backend">, backends: readonly BackendInfo[] | null): string | undefined {
  return backends?.find((b) => b.id === s.backend)?.caps?.spendUnit?.trim() || undefined;
}

export interface BudgetTagFacts {
  /** An existing `.tag` class — no new colour for this chip. */
  cls: string;
  /** Always in TEXT: a `title` is invisible on a phone. */
  text: string;
  /** The same fact in a full sentence, for hover and screen readers. */
  title: string;
}

/**
 * The chip a session wears while it has a budget.
 *
 * ok ⇒ `$0.31 / $0.50`; over ⇒ `budget hit · $0.52 / $0.50 · sends held` (the
 * held-sends clause is in the chip's own words; a hard budget ends `· hard:
 * asks before sends` instead); unknown ⇒ `budget ? — <why>`.
 * A session that is not running wears nothing: its verdict is `notRunning`
 * whatever it spent, and a chip saying so on every closed row is furniture.
 */
export function budgetTagFacts(s: { running?: boolean; budget?: SessionBudgetInfo }, now: number): BudgetTagFacts | null {
  const b = s.budget;
  if (!b || !s.running) return null;
  const v = b.verdict;
  if (v.state === "over") {
    // Hard says its mode in the chip: "sends held" would be untrue of the
    // person's own sends, which ask instead.
    const tail = b.cfg.hard ? "hard: asks before sends" : "sends held";
    return { cls: "ctx-low", text: `budget hit · ${sessionBudgetChip(v)} · ${tail}`, title: `${sessionBudgetText(v)}. ${sessionBudgetHoldText(b.cfg)}` };
  }
  if (v.state === "unknown") {
    const age = v.why === "stale" && b.cal ? now - b.cal.checkedAt : undefined;
    const why = v.why ?? "noSpark";
    // `?? BUDGET_WHY_UNKNOWN`: a newer host's reason this bundle has no words for.
    return { cls: "idle", text: `budget ? — ${BUDGET_WHY_SHORT[why] ?? BUDGET_WHY_UNKNOWN}`, title: sessionBudgetUnknownText(why, age, v.unit, undefined, v.undated) };
  }
  return { cls: "ctx-ok", text: sessionBudgetChip(v), title: sessionBudgetText(v) };
}

/** The toast for a crossing, naming the session. */
export function budgetToast(title: string, b: SessionBudgetInfo): string {
  return `${title}: ${sessionBudgetText(b.verdict)}. Its sends are held — raise or clear the budget to release them.`;
}

/**
 * Say it ONCE per crossing, for the session on screen. `seen` is the set of
 * sessions already told they are over; leaving over (raised, cleared, or the
 * reading went unknown) removes the id, which re-arms the next crossing. Pure
 * because `active` is a fresh object every frame and the effect around it
 * cannot be pinned by a test (`costNotice.ts`'s argument).
 */
export function shouldNoticeBudget(id: string, over: boolean, seen: ReadonlySet<string>): { notice: boolean; next: ReadonlySet<string> } {
  if (over) {
    if (seen.has(id)) return { notice: false, next: seen };
    return { notice: true, next: new Set([...seen, id]) };
  }
  if (!seen.has(id)) return { notice: false, next: seen };
  const next = new Set(seen);
  next.delete(id);
  return { notice: false, next };
}

/** WHICH session the sheet is about: `sid` when a row or the context panel opened
 *  it, the attached one otherwise; an id that names no row falls back to the
 *  attached session rather than painting a sheet about nothing. */
export function budgetSubject<S extends { id: string }>(sid: string | null, sessions: readonly S[], active: S | null): S | null {
  return (sid ? sessions.find((x) => x.id === sid) : null) ?? active;
}

/**
 * The receipts for the two writes, in TWO steps. The send-time toast says only
 * that the desktop was ASKED — an older host ignores `session.budget.set`
 * without a word, and "budget set" on the send would then tell the person a
 * cap holds when nothing does. "Set"/"cleared" is said when a `session.updated`
 * comes back carrying exactly what was asked (`budgetConfirmed`).
 */
export const budgetAskedToast = (label: string) => `asked the desktop to set the budget — ${label}`;
export const BUDGET_ASKED_CLEAR_TOAST = "asked the desktop to clear the budget";
export const budgetSetToast = (label: string) => `budget set — ${label}`;
export const BUDGET_CLEARED_TOAST = "budget cleared — this session's sends are no longer held by it";
/** How long an ask may go unanswered before the sheet says so. */
export const BUDGET_CONFIRM_MS = 10_000;
export const BUDGET_UNCONFIRMED =
  "The desktop has not confirmed this yet. If it does not, the host there may be an older version that does not know session budgets — then nothing is capped.";

/** Did the session come back carrying exactly the cap that was asked for (null: cleared)? */
export function budgetConfirmed(asked: SessionBudget | null, now: SessionBudget | null | undefined): boolean {
  if (!asked) return !now;
  return !!now && now.unit === asked.unit && now.max === asked.max && now.interrupt === asked.interrupt && !!now.hard === !!asked.hard;
}
export const BUDGET_OFFLINE_TOAST = "no connection — the desktop didn't get the budget. Try again when the link is back.";
