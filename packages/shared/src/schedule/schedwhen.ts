// Cut from schedule.ts (move only): when a piece of work will fire, in words
// The one door stays `./schedule.js`; this slice imports its siblings directly, never the barrel.

import type { ScheduleRule } from "./schedrule.js";
import { describeRule } from "./schedtext.js";

/** An instant in the reader's locale: "Tue 1 Oct, 14:00". On the host it is the
 *  desktop's locale and zone — the same machine the agent asking runs on. */
export const fmtWhen = (t: number) =>
  new Date(t).toLocaleString(undefined, { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });

/**
 * "in 3d 4h" / "in 12m" / "due now". Relative is what a waiting row is read for.
 *
 * `now` is a parameter with a default rather than a bare `Date.now()` so a
 * caller that already froze a clock for the whole render can hand it over —
 * `backlogFilter.ts`'s `clockWords` does, because a sentence a `node --test`
 * has to pin cannot read the wall clock, and because two readings of the clock
 * inside one row is how "in 60m" sits under a chip saying "in 59m".
 */
export function inWords(t: number, now = Date.now()): string {
  const ms = t - now;
  if (ms <= 0) return "due now";
  const m = Math.round(ms / 60_000);
  if (m < 60) return `in ${m}m`;
  const h = Math.floor(m / 60), rm = m % 60;
  if (h < 24) return `in ${h}h${rm ? ` ${rm}m` : ""}`;
  const d = Math.floor(h / 24), rh = h % 24;
  return `in ${d}d${rh ? ` ${rh}h` : ""}`;
}

/**
 * A chain, as one short clause — the *When* row's collapsed line, and the tail
 * of the primary button's sentence.
 *
 * The title is quoted because it is somebody else's words appearing inside
 * ours, and it is the same reason `shared/intent.ts` quotes it in the sentence
 * the waiting row then wears. Absent, the clause names no title rather than a
 * placeholder: a row that says "the item before it" is vague, and a row that
 * invents a name is wrong, and only one of those can be fixed by looking.
 *
 * `onlyIfOk` belongs in the same clause rather than in a second line, because
 * the *When* row is read at a glance and "after X" and "after X, but only if X
 * worked" are two different instructions, not one instruction with a detail.
 */
export function afterWords(title?: string, onlyIfOk?: boolean): string {
  const what = title ? `after “${title}”` : "after the item before it";
  return onlyIfOk ? `${what}, only if it worked` : what;
}

/** The WHEN half of a send, structurally — the web's `SendWhen` is one of
 *  these, and so is what the agent route reads off a posted row. */
export type WhenShape =
  | { kind: "now" }
  | { kind: "idle" }
  | { kind: "after"; title?: string; onlyIfOk?: boolean }
  | { kind: "at"; rule: ScheduleRule };

/**
 * The *When* row's own words. `preview` is the resolved instant for an `at`.
 *
 * **No preview is two different facts and they must not share a sentence.** A
 * `once` rule with nothing ahead of it HAS a time and it is behind us. A
 * `window` rule has no clock at all until the host has read the usage meter
 * once — that is the normal state of a freshly written rule, said on this very
 * screen ("Nothing is armed until the host has read the window once"), and
 * calling it "never" told the user their schedule was dead on arrival.
 */
export function whenWords(w: WhenShape, preview: number | null): string {
  if (w.kind === "now") return "now";
  if (w.kind === "idle") return "when it's free";
  if (w.kind === "after") return afterWords(w.title, w.onlyIfOk);
  if (preview != null) return `${fmtWhen(preview)} · ${inWords(preview)}`;
  if (w.rule.kind === "window") return `${describeRule(w.rule)} — armed once the host reads the window`;
  return "never — the time it resolves to has passed";
}
