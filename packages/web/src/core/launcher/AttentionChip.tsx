/**
 * The cross-session attention chips — `{icon} {n} {noun}` — drawn ONCE for the
 * launcher's two global chips (*2 waiting*, *1 blocked*: a tap opens the sheet
 * listing exactly those) and their per-repo twins in a repo group header (a tap
 * is the launcher's status filter for that repo). The number is always the
 * length of an `attentionCut` / `sessionStatus` bucket, never counted here.
 *
 * Colours as before: `head-wait` pulses for a question (it needs an answer);
 * `.limit` is the steady blocked tone — a wall the desktop is mostly already
 * handling is not an alarm.
 */
import { CalendarClock, CircleDot, OctagonPause } from "lucide-react";
import { ATTENTION_NOUN, attentionTitle, type AttentionKind } from "../../attention";

export function AttentionChip({ kind, n, onClick, repo, on, replies, hint }: {
  kind: AttentionKind;
  n: number;
  onClick: () => void;
  /** A per-repo twin: names the repo in its title and wears the group-header class. */
  repo?: string;
  /** The twin's filter is the one in force. */
  on?: boolean;
  /** Some of these already have a reply on a clock: a DOT, never a second number —
   *  the chip is already the count and the way in. */
  replies?: boolean;
  /** `data-hint` id (the long-press explanation). */
  hint?: string;
}) {
  if (n <= 0) return null;
  const Icon = kind === "wait" ? CircleDot : OctagonPause;
  const cls = repo
    ? (kind === "wait" ? "repo-group-wait" : "repo-group-stat limit")
    : (kind === "wait" ? "head-wait" : "head-wait limit");
  return (
    // A BUTTON, not a label: a count on a control is the way to those rows.
    <button className={`${cls}${on ? " on" : ""}`} data-hint={hint}
      title={attentionTitle(kind, n, { repo, replies })} onClick={onClick}>
      <Icon size={13} />{repo ? "" : " "}{n}{repo && kind === "blocked" ? "" : ` ${ATTENTION_NOUN[kind]}`}
      {replies && <CalendarClock size={11} className="wait-sched" />}
    </button>
  );
}
