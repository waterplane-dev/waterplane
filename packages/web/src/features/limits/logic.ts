/**
 * The limits feature's pure half: the toolbar toggle's cycle and the words
 * every tap here toasts. Moved verbatim out of `App.tsx` (`renderToolbarItem`'s
 * `limit` arm and `overlayViews.limits`), pinned by `logic.test.mjs`.
 */
import type { LimitResumeMode, SessionInfo } from "@waterplane/shared";

/** The per-session override's cycle: inherit (the global) → on → off → inherit. */
export function nextOverride(override: boolean | null | undefined): boolean | null {
  return override == null ? true : override ? false : null;
}

/** The toolbar toggle's receipt, naming what `inherit` currently means. */
export function overrideToast(next: boolean | null, globalAuto: boolean): string {
  return `auto-continue: ${next == null ? `inherit (${globalAuto ? "on" : "off"})` : next ? "on for this session" : "off for this session"}`;
}

/** Where the session's effective value comes from, for the toggle's title. */
export function overrideSource(override: boolean | null | undefined, globalAuto: boolean): string {
  return override == null ? `global (${globalAuto ? "on" : "off"})` : "session override";
}

/** The receipt for a change of the resume queue's release mode. */
export function modeToast(mode: LimitResumeMode): string {
  return mode === "one" ? "resuming one session at a time"
    : mode === "repo" ? "resuming one session per repo at a time"
    : "resuming every queued session once the limit lifts";
}

/**
 * The blocked sheet's sign-in card: what ONE tap can do for every signed-out
 * session, decided once (`logic.test.mjs`).
 *
 *  - `link`  — a session has printed a sign-in link (`SessionInfo.login`): open
 *              the newest one; it is the session `BlockBar`'s link card offers the same link in.
 *  - `login` — no link yet: send `/login` into a session whose last turn ended
 *              signed out and that shows no box (the composer is free — typed at a
 *              dialog, it would go into the dialog), the way `BlockBar`'s signed-out card does.
 *  - `setup` — every one of them is in the CLI's own first-launch setup (or has a
 *              box up): `/login` typed there lands in a menu, so the card says to
 *              open one and finish there instead of offering a keystroke.
 */
export type SignInPlan =
  | { kind: "link"; url: string; from: SessionInfo }
  | { kind: "login"; target: SessionInfo }
  | { kind: "setup"; why: string };

export function signInPlan(auth: readonly SessionInfo[]): SignInPlan {
  const linked = auth.filter((s) => s.login?.url).sort((a, b) => b.login!.at - a.login!.at)[0];
  if (linked) return { kind: "link", url: linked.login!.url, from: linked };
  const target = auth.find((s) => s.running && s.signedOut && !s.cliSetup && !s.prompt && !s.awaitingInput && !s.turnActive);
  if (target) return { kind: "login", target };
  return { kind: "setup", why: "open one of them and finish the CLI's own setup there — its sign-in link shows up here once it prints one" };
}

/**
 * The sign-in card's split of the auth group, ONE function (`logic.test.mjs`)
 * that feeds the count on *continue all N*, the ids that tap sends, each row's
 * *continue* and the card's headline — so the number and the cut cannot be two
 * copies of one edge.
 *
 *  - `ready`    — the host confirmed the account is signed in again
 *                 (`signInWait.signedInAt`) and the person has not tapped yet:
 *                 these, exactly these, are what *continue all N* sends. A
 *                 session showing its own sign-in link is NOT ready — that
 *                 sign-in is still under way on its screen (`blockOf`).
 *  - `inFlight` — already tapped: queued behind the first, or its continue is
 *                 typed and its verdict owed. Never offered again.
 *  - `unsure`   — the host cannot tell (`signInWait.unsure`: the local
 *                 credential keeps reading "in" while the API refused it). Both
 *                 the sign-in controls and *continue* are offered — the person
 *                 knows whether they signed in. Never mixed with `ready`: one
 *                 confirmation stamps every member of the account.
 *  - `out`      — still signed out: the sign-in controls act on these.
 */
export interface SignInSplit {
  ready: SessionInfo[];
  inFlight: SessionInfo[];
  unsure: SessionInfo[];
  out: SessionInfo[];
}

export function signInSplit(auth: readonly SessionInfo[]): SignInSplit {
  const ready: SessionInfo[] = [];
  const inFlight: SessionInfo[] = [];
  const unsure: SessionInfo[] = [];
  const out: SessionInfo[] = [];
  for (const s of auth) {
    const w = s.signInWait;
    if (!w || s.login) out.push(s);
    else if (w.continuing || w.queued) inFlight.push(s);
    else if (w.signedInAt != null) ready.push(s);
    else if (w.unsure) unsure.push(s);
    else out.push(s);
  }
  return { ready, inFlight, unsure, out };
}

const sessionsOf = (n: number) => `${n} session${n === 1 ? "" : "s"}`;

/** The card's headline: what is true of the account right now. */
export function signInHeadline(sp: SignInSplit): string {
  if (sp.out.length > 0) return `Signed out · ${sessionsOf(sp.out.length)} stopped`;
  if (sp.unsure.length > 0) return `Signed in again? · ${sessionsOf(sp.unsure.length)} stopped`;
  if (sp.ready.length > 0) return `Signed in again · ${sessionsOf(sp.ready.length)} can continue`;
  return "Signed in again · continuing";
}

/** The card's button. */
export function continueAllLabel(n: number): string {
  return n === 1 ? "continue 1" : `continue all ${n}`;
}

/** The sentence over the button: nothing is typed by itself, and what the tap does. */
export function continueAskNote(n: number, online: boolean): string {
  return `${n === 1 ? "1 session is" : `${n} sessions are`} signed in again — nothing is typed until you tap`
    + (n > 1 ? "; the first goes alone, the rest follow once it gets through" : "")
    + (online ? "" : " · offline: the tap is kept and sent when the link is back");
}

/** The sentence over the button when the host cannot tell whether the sign-in held. */
export function continueUnsureNote(n: number, online: boolean): string {
  return `the desktop cannot tell whether you signed in again — if you have, continue ${n === 1 ? "it" : "them"}; nothing is typed until you tap`
    + (online ? "" : " · offline: the tap is kept and sent when the link is back");
}

/** The in-flight line, or null when nobody has been tapped. */
export function continueProgressNote(sp: SignInSplit): string | null {
  const going = sp.inFlight.filter((s) => s.signInWait?.continuing).length;
  const waiting = sp.inFlight.length - going;
  if (!sp.inFlight.length) return null;
  return [going ? `${going} continuing` : "", waiting ? `${waiting} waiting behind the first` : ""].filter(Boolean).join(" · ");
}

/** The queue row's name for a `signin.continue` (Queue / Activity). */
export function continueQueueLabel(n: number): string {
  return `continue ${sessionsOf(n)} after the sign-in`;
}

/** The receipt for a tap made with the link down; online the host's own sentence is the receipt. */
export function continueQueuedToast(n: number): string {
  return `queued — continues ${sessionsOf(n)} when the link is back`;
}
