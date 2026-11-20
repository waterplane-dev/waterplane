/**
 * **What a pending session (a queued `session.create`) says about itself** — the
 * card over its terminal and the line under its header, from ONE reading so the
 * two never disagree.
 *
 * The owner's report (2026-11-18): with the desktop not answering, New session
 * opened a card saying "warming up the CLI for you…" and a header saying
 * "opening…" while the queue bar beside them counted "Sending… 7s". Nothing was
 * warming up: the create had not even reached the desktop. "Warming up" is true
 * only once the desktop has TAKEN the create (the row is off the books); before
 * that the honest words are where the create is — on its way, unanswered, or
 * waiting for a link — and that what is written now goes in when it opens.
 *
 * Pure: the caller passes the clock, so the threshold is node-tested.
 */

/** How long a create may sit on the wire unanswered before the words say the
 *  desktop is not answering, rather than "asking". A healthy desktop takes a
 *  create in well under a second; the queue's own receipt window (20 s) is when
 *  it RETRIES, which is far too long to keep saying "asking". */
export const PENDING_SILENT_MS = 5000;

export type PendingOpenState =
  | "failed"     // refused, or given up: the queue row is failed
  | "starting"   // the desktop took the create; the CLI is starting
  | "held"       // online, not sent: something the queue names holds it
  | "asking"     // on the wire, a receipt not yet due
  | "silent"     // on the wire past PENDING_SILENT_MS with no answer
  | "nolink"     // queued with no link to the desktop
  | "queued";    // online, waiting its turn in its lane

export interface PendingOpenFacts {
  /** The queue row of the create, or null once the desktop has taken it. */
  entry: { status: string; sentAt?: number; ts?: number } | null;
  /** The socket is open. */
  linkOpen: boolean;
  /** The queue holds it for a reason it can name (budget, auto-send off, …). */
  held: boolean;
  now: number;
}

export function pendingOpenState(f: PendingOpenFacts): PendingOpenState {
  const e = f.entry;
  if (!e) return "starting";
  if (e.status === "failed") return "failed";
  if (e.status === "pending") {
    const since = e.sentAt ?? e.ts ?? f.now;
    return f.now - since >= PENDING_SILENT_MS ? "silent" : "asking";
  }
  if (!f.linkOpen) return "nolink";
  return f.held ? "held" : "queued";
}

/**
 * The pending screen says this ONCE, on its own line at the top of the session
 * area (`TermArea.tsx`'s `.term-pending`). The owner's 11-18 screenshot had one
 * fact five times — the link strip, the header line, the connection banner, a
 * floating card and the queue bar — so on this screen the header carries no
 * status, the banner is not drawn and the queue bar keeps only its buttons.
 * What is left here is the only sentence about where the open is.
 */

/** Something is actually on the wire, or the CLI is starting: the only states
 *  that spin. Offline, held or waiting its turn nothing moves, so the icon is still. */
export function pendingSpins(s: PendingOpenState): boolean {
  return s === "asking" || s === "starting";
}

/** The line's lead, which names what this screen IS: a session that does not exist yet. */
export function pendingLead(repo: string): string {
  return `New session in ${repo}`;
}

/** The line for the states that are not failed or held (those carry the
 *  queue's own reason, worded where it is known, after the same lead). */
export function pendingCardLine(s: PendingOpenState, repo: string): string {
  const lead = pendingLead(repo);
  switch (s) {
    case "starting": return `${lead} — starting…`;
    case "asking": return `${lead} — asking the desktop…`;
    case "silent": return `${lead} — the desktop is not answering; it starts when it does.`;
    case "nolink": return `${lead} — starts when the desktop is back.`;
    case "queued": return `${lead} — waiting its turn to go to the desktop.`;
    default: return lead;
  }
}

/** The hint under the line, while it is still waiting. `hasPrompt`: a first
 *  prompt already rides inside the create, so "write it now" would be stale. */
export function pendingCardHint(s: PendingOpenState, hasPrompt: boolean): string {
  const [main, more] = pendingCardHintParts(s, hasPrompt);
  return more ? `${main} ${more}` : main;
}

/** The same hint in two pieces: the sentence that must stay and the one a short area (keyboard up)
 *  may drop, so the screen never shows half a sentence. */
export function pendingCardHintParts(s: PendingOpenState, hasPrompt: boolean): [string, string] {
  const when = s === "starting" || s === "asking" ? "as it opens" : "then";
  return hasPrompt
    ? [`Your first prompt goes in ${when}.`, "Anything more you write follows it."]
    : [`Write your first prompt now; it goes in ${when}.`, ""];
}
