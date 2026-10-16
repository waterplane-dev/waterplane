/**
 * The follow-up flag as DRAWN (R-sessions-041/042): the toggle beside the star
 * and the one quiet line under a flagged row. Every word of the flag itself is
 * `@waterplane/shared`'s `followUpText` — this file only adds the verbs.
 *
 * Its colour is WHO set it, never the star's gold: `--fu-hand` (you, the
 * accent blue), `--fu-launch` (a launch you ticked, the schedule purple),
 * `--fu-agent` (the session's own agent, teal). `.fu-<by>` sets `color`, so an
 * icon, a line and a chip each take it by `currentColor`.
 */
import type { ReactNode } from "react";
import { Flag } from "lucide-react";
import type { FollowUp, SessionInfo } from "@waterplane/shared";
import { followUpText } from "@waterplane/shared";

/** The two verbs, as every surface words them. */
export const FOLLOWUP_SET = "Flag for follow up";
export const FOLLOWUP_CLEAR = "Done — clear flag";

/** `.fu-hand` / `.fu-launch` / `.fu-agent` — the colour of who set it. */
export const followUpClass = (f: FollowUp | undefined): string => (f ? ` fu-${f.by}` : "");

/**
 * The toggle's title: what a tap does, or — while this phone's press is not
 * confirmed — that it is only here so far (the star's two sentences).
 */
export function followUpButtonTitle(s: SessionInfo, waiting: boolean, online: boolean): string {
  if (waiting) {
    const what = s.followUp ? "flagged here" : "flag cleared here";
    return online ? `${what} — the desktop has not confirmed it yet` : `${what} — offline, so it is only on this phone until the link is back`;
  }
  return s.followUp ? `${FOLLOWUP_CLEAR} — ${followUpText(s.followUp)}` : `${FOLLOWUP_SET} — a one-shot mark; opening the session does not clear it`;
}

/** The flag glyph: outline when off, filled when on. */
export const FlagIcon = ({ on, size }: { on: boolean; size: number }): ReactNode =>
  <Flag size={size} fill={on ? "currentColor" : "none"} />;

/**
 * The one line under a flagged row: who set it and, from an agent, what to
 * read. Drawn ONCE per row — never repeated as a badge beside it.
 */
export function FollowUpLine({ f }: { f: FollowUp }): ReactNode {
  return (
    <span className={`fu-line${followUpClass(f)}`}>
      <Flag size={12} fill="currentColor" /> {followUpText(f)}
    </span>
  );
}
