import {
  AlertTriangle, CalendarClock, CheckCheck, Download, FileUp, Hammer, Hourglass, Loader, MessageCircleQuestion, Pencil, Play,
  Save, SearchCheck, SendHorizontal, Share2, Shuffle, SquareCheck, Terminal, Trash2, X, Clock, CloudOff,
} from "lucide-react";
import type { ActivityActionId } from "../activityRows";

export const ICON = 16;

/** id → glyph. The catalog is here rather than on the action so the selector
 *  stays DOM-free and node-testable. */
export const ACTION_ICON: Record<ActivityActionId, typeof SendHorizontal> = {
  sendNow: SendHorizontal,
  hold: Hourglass,
  retarget: Shuffle,
  edit: Pencil,
  fix: FileUp,
  retry: SendHorizontal,
  answer: MessageCircleQuestion,
  check: SearchCheck,
  open: Terminal,
  runNow: Play,
  cancel: X,
  toggle: SquareCheck,
  download: Download,
  save: Save,
  discard: Trash2,
  dismiss: Clock,
  confirmDone: CheckCheck,
  openSchedule: CalendarClock,
};

/** What KIND of thing a row is, at a glance. Icons only — the word is in the
 *  verdict, and a row that spends a line naming its own category has spent it
 *  on the one thing the person already knows. */
export const KIND_ICON = {
  prompt: MessageCircleQuestion,
  answer: SquareCheck,
  upload: FileUp,
  action: Play,
  sweep: Share2,
  build: Hammer,
  download: Download,
} as const;

/** The dot that carries the row's state. Verdict says the rest. */
export const STATE_ICON = {
  queued: CloudOff,
  blocked: Hourglass,
  starting: Loader,
  running: Loader,
  done: CheckCheck,
  failed: AlertTriangle,
  canceled: X,
} as const;

/**
 * The delivery axis, said out loud.
 *
 * Deliberately three separate sentences for the three that look alike. "The
 * host refused this" and "the host was not reachable" lead to different next
 * actions, and collapsing them is how a permissions problem reads as a bad
 * tunnel for a week — while `unknown` is neither, and is never rendered as
 * silence, because silence reads as fine.
 */
export const DELIVERY_TEXT = {
  landed: "it reached the session",
  unconfirmed: "it was written into the session, and nothing confirmed it submitted — do not retype it",
  unsubmitted: "it is sitting in the composer, unsent — do not retype it",
  refused: "the desktop answered and refused it, so nothing was written",
  unreachable: "the desktop never answered — it may have run",
  unknown: "nobody recorded whether it ran",
} as const;

/** Compact countdown for a future instant. `format.ts`'s `until` phrases a
 *  duration; this one is used where the row wants "in 2h 10m". */
export function inWords(at: number, now: number): string {
  const s = Math.round((at - now) / 1000);
  if (s <= 0) return "now";
  const m = Math.floor(s / 60);
  if (m < 60) return `in ${m || 1}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return m % 60 ? `in ${h}h ${m % 60}m` : `in ${h}h`;
  return `in ${Math.floor(h / 24)}d`;
}
