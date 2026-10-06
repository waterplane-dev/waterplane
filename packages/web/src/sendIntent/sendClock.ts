/** What a decision is called, and the clock chips it is chosen from. Split from `sendIntent.ts` (docs/notes/send-architecture.md); pure, no React. */
import { DEFAULT_GRACE_MIN } from "@waterplane/shared";
import { type SendWhen } from "./sendTypes.ts";

// ── What a decision is called ────────────────────────────────────────

/** The device's own zone — the one the user thinks in, and the right default
 *  for an anchor they are about to type ("Thursday 18:00" means theirs). */
export const DEVICE_TZ = (() => {
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone || ""; } catch { return ""; }
})();

// `fmtWhen` and `inWords` moved to `@waterplane/shared` (`schedule.ts`), with
// `afterWords`/`whenWords` below: the host's agent route answers "when will
// this fire" in the SAME words this sheet uses, and it cannot import the web.
export { fmtWhen, inWords } from "@waterplane/shared";

/** `<input type="datetime-local">` wants local wall time with no zone suffix. */
export const toLocalInput = (t: number) => {
  const d = new Date(t - new Date(t).getTimezoneOffset() * 60_000);
  return d.toISOString().slice(0, 16);
};

/** A wall-clock instant today (or `addDays` on), used by the quick chips. */
export function atClock(hour: number, minute: number, addDays = 0): number {
  const d = new Date();
  d.setDate(d.getDate() + addDays);
  d.setHours(hour, minute, 0, 0);
  return d.getTime();
}

/**
 * One tap = a time. The whole ask behind "later" is a date and a time, and a
 * `datetime-local` on a phone is a five-spin modal for what is nearly always
 * one of these. Each chip carries its own label because the answer moves: at
 * 21:00 "tonight 20:00" is tomorrow, and saying so is the difference between a
 * chip you trust and one you check afterwards.
 */
export function quickTimes(): { key: string; label: string; at: number }[] {
  const now = Date.now();
  const tonight = atClock(20, 0);
  const rolled = tonight <= now;
  const nextMon = (() => {
    const d = new Date();
    d.setDate(d.getDate() + ((8 - d.getDay()) % 7 || 7));
    d.setHours(9, 0, 0, 0);
    return d.getTime();
  })();
  return [
    { key: "1h", label: "in 1h", at: now + 3600e3 },
    { key: "3h", label: "in 3h", at: now + 3 * 3600e3 },
    { key: "eve", label: rolled ? "tomorrow 20:00" : "tonight 20:00", at: rolled ? atClock(20, 0, 1) : tonight },
    { key: "tom", label: "tomorrow 09:00", at: atClock(9, 0, 1) },
    { key: "mon", label: "Mon 09:00", at: nextMon },
  ];
}

/** Lead times worth one tap. "2h before" is the motivating case: spend what is
 *  left of the week's quota before the window rolls over and it evaporates. */
export const LEADS = [0, 30, 60, 120, 180, 360];

/**
 * **The headroom percentages worth one tap**, and the four the row offered
 * before anything else could be typed. Quarters, because the question people
 * actually ask is "is a quarter of the week still there", never "is 37% of it".
 */
export const PCT_LEFTS = [10, 25, 50, 75];

/**
 * A typed percentage worth keeping, or null.
 *
 * `0` is deliberately NOT one: "at least 0% left" is true of every meter, so it
 * is `no condition` written the long way round, and that chip already exists
 * one tap to the left. Accepting it would put two controls on the same row that
 * mean the same thing, one of which looks like a condition and is not.
 */
export function pctOk(v: unknown): number | null {
  const n = typeof v === "string" ? Number(v.trim()) : typeof v === "number" ? v : NaN;
  if (!Number.isFinite(n)) return null;
  const r = Math.round(n as number);
  return r >= 1 && r <= 100 ? r : null;
}

/**
 * **The chips the headroom row draws**: the four fixed ones, plus every
 * percentage a person actually typed — the one this phone saved and the one the
 * rule being edited already carries.
 *
 * Sorted and deduped rather than appended, because a saved 30 tacked on after
 * 10·25·50·75 reads as a different KIND of thing than the four beside it, and
 * it is not one: it is the same answer to the same question. The rule's OWN
 * value is included whatever it is, so a rule written on another device — or by
 * an older build, or by hand — opens with its condition lit rather than with
 * nothing selected and a number on the wire that nothing on screen accounts for.
 */
export function pctChoices(saved?: number | null, current?: number | null): number[] {
  const out = new Set<number>(PCT_LEFTS);
  for (const v of [saved, current]) {
    const n = pctOk(v);
    if (n != null) out.add(n);
  }
  return [...out].sort((a, b) => a - b);
}

/**
 * **Why a typed percentage is not being applied yet**, or null while it is.
 *
 * Words under the field and never a dimmed one: the chips above still work, the
 * rule still holds whatever it held, and nothing is refused — so what the
 * screen owes the reader is what this box wants, on the row where they are
 * typing it. A half-typed value is the normal state of a number field, so an
 * empty box asks rather than complains.
 */
export function pctWords(raw: string): string | null {
  const t = raw.trim();
  if (!t) return "Type a percentage — 1 to 100 — or pick one above.";
  if (pctOk(t) != null) return null;
  const n = Number(t);
  if (!Number.isFinite(n)) return `“${t}” is not a number. 1 to 100.`;
  if (Math.round(n) === 0) return "0% left is met by every meter, which is what no condition already says — tap that instead.";
  return `${t}% is outside 1–100: a window reads 100% at its reset and 0% when it is spent.`;
}

export const GRACES = [
  { min: 0, label: "skip it" },
  { min: DEFAULT_GRACE_MIN, label: "up to 2h late" },
  { min: 12 * 60, label: "up to 12h late" },
  { min: 3 * 24 * 60, label: "up to 3 days late" },
];

/** A blank one-off, an hour out — what "later" means before anything is picked. */
export const onceIn = (ms: number): SendWhen =>
  ({ kind: "at", rule: { kind: "once", at: Date.now() + ms, offsetMin: 0 }, graceMin: DEFAULT_GRACE_MIN });

/** A blank usage-window anchor — "later", but tracking a reset instead of a
 *  clock. What tapping *a usage window* means before anything is picked.
 *  `oneShot` defaults on, same as the clock anchor's blank state (`onceIn`) —
 *  "once" is the default for either anchor, and repeating is the thing you
 *  opt into, not the thing you have to opt out of. */
export const windowIn = (): SendWhen =>
  ({ kind: "at", rule: { kind: "window", window: "session", edge: "before", offsetMin: -60, oneShot: true }, graceMin: DEFAULT_GRACE_MIN });

