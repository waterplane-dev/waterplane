// Cut from schedule.ts (move only): cleaning a rule or action off disk
// The one door stays `./schedule.js`; this slice imports its siblings directly, never the barrel.

import type { SessionBudget } from "../sessionbudget.js";
import { cleanSessionBudget } from "../sessionbudget.js";
import type { ScheduleRule } from "./schedrule.js";
import { INTENT_MAX_STEPS, type ScheduleAction } from "./schedaction.js";
import { zoneOffsetMs } from "./schedzone.js";

const clampInt = (v: unknown, lo: number, hi: number, dflt: number): number => {
  const n = Math.round(Number(v));
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : dflt;
};

/**
 * A run window, or nothing.
 *
 * Neither end is CLAMPED and nothing here is interpreted: a value that is not
 * already a minute of day is refused, and so is a pair that does not name two
 * DIFFERENT minutes. `from === to` has two readings — "every minute" and "no
 * minute" — and a sanitiser that picks one silently turns a typo into a
 * schedule that never fires again.
 *
 * Clamping had the same shape one step further out: `{from: 5000, to: 100}`
 * became `{from: 1439, to: 100}`, a 23:59–01:40 night window nobody typed, on a
 * rule that then quietly never ran in the daytime. The phone's `<input
 * type=time>` cannot produce a value outside 0..1439, so anything outside is a
 * corrupt file or a hostile draft, and the honest answer to both is the same as
 * for `from === to`: drop it. Absent is the old behaviour — any hour — which is
 * the one thing a dropped field is always safe to be here.
 */
function cleanHours(v: any): { from: number; to: number } | undefined {
  if (!v || typeof v !== "object") return undefined;
  const minute = (x: unknown): number => {
    const n = Math.round(Number(x));
    return Number.isFinite(n) && n >= 0 && n <= 1439 ? n : -1;
  };
  const from = minute(v.from);
  const to = minute(v.to);
  if (from < 0 || to < 0 || from === to) return undefined;
  return { from, to };
}

/** Sanitize a rule from the wire or a hand-edited file. Never throws. */
export function cleanRule(v: any): ScheduleRule {
  const raw = v && typeof v === "object" ? v : {};
  // A lead time longer than a week would silently re-order occurrences; a day
  // either side covers every real "before the reset" case.
  const offsetMin = clampInt(raw.offsetMin ?? 0, -1440, 1440, 0);
  // Quiet hours are a policy over the anchor, so they survive every kind —
  // "at 03:00 but not while I am asleep" and "the moment the weekly window is
  // back, but not at 04:00" are the same instruction about two anchors.
  const hours = cleanHours(raw.hours);
  // An unresolvable zone would make every occurrence fall back to host-local
  // silently — drop it to undefined instead, which the UI shows as "host time".
  const tz = typeof raw.tz === "string" && raw.tz.trim() && zoneOffsetMs(raw.tz.trim(), Date.now()) != null
    ? raw.tz.trim() : undefined;
  // **`hours` carries its zone on EVERY kind, not just `weekly`.** `hours` is
  // documented as minutes of day IN `tz`, and `inHours`/`hoursOpenFrom` read
  // `rule.tz || null` — so a `window` or `once` rule that lost its zone here is
  // evaluated against `getHours()`, the DAEMON's clock. The same rule
  // {window, 07:00–22:00} was open at 05:30Z under `TZ=Asia/Tokyo` and shut
  // under `TZ=UTC`: launchd sets no `TZ` so a Mac in the user's own zone
  // happened to be right, and a `TZ` in the plist, a Linux host or a person
  // travelling shifted the whole window by the offset in silence. This is the
  // drift the weekly zone has always been stored to prevent; quiet hours are a
  // policy over every anchor (see `hours` above), so they carry the same fact.
  //
  // Tied to `hours` rather than kept unconditionally: a `window` rule's anchor
  // is a reset instant and a `once` rule's is absolute, so on those two kinds a
  // zone with no window to read means nothing, and storing one would invite the
  // next reader to think it moved the anchor.
  const only = hours ? (tz ? { hours, tz } : { hours }) : {};
  if (raw.kind === "window") {
    const edge = raw.edge === "after" ? "after" : "before";
    // A percentage is a COUNT-shaped field and is clamped like one. `null` (no
    // condition) and 0 (a condition that always passes) are different things
    // and both are kept — writing 0 is how somebody says "any headroom at all".
    const pct = raw.minPctLeft;
    const minPctLeft = pct == null || pct === "" ? undefined : clampInt(pct, 0, 100, 0);
    const window: "session" | "weekly" = raw.window === "weekly" ? "weekly" : "session";
    // A guard naming the window the rule is already anchored to is not a guard,
    // and keeping it would leave two fields saying one thing — the next reader
    // has to work out that they agree before they can read either. Only the
    // other window survives.
    const guard: "session" | "weekly" | undefined =
      (raw.guardWindow === "weekly" || raw.guardWindow === "session") && raw.guardWindow !== window ? raw.guardWindow : undefined;
    // The condition survives an `after` edge ONLY behind a guard. Without one
    // it would be a question about a window that has just emptied — the reading
    // that can only ever mean "never run", which is why it has always been
    // dropped here rather than stored and quietly ignored at fire time.
    const keepPct = minPctLeft != null && (edge === "before" || guard != null);
    return {
      kind: "window",
      window,
      edge,
      // `before` must be a LEAD: a positive offset there would place the run
      // after the reset it claims to precede, which is the one reading of this
      // rule nobody could act on.
      offsetMin: edge === "before" ? Math.min(0, offsetMin) : Math.max(0, offsetMin),
      ...(keepPct ? { minPctLeft } : {}),
      ...(guard ? { guardWindow: guard } : {}),
      ...(raw.oneShot === true ? { oneShot: true } : {}),
      ...only,
    };
  }
  if (raw.kind === "once") {
    const at = Number(raw.at);
    return { kind: "once", at: Number.isFinite(at) ? at : 0, offsetMin, ...only };
  }
  const rawDays: number[] = Array.isArray(raw.days) ? raw.days.map((d: any) => clampInt(d, 0, 6, 0)) : [];
  const days: number[] = [...new Set<number>(rawDays)].sort((a, b) => a - b);
  return {
    kind: "weekly",
    days,
    hour: clampInt(raw.hour ?? 9, 0, 23, 9),
    minute: clampInt(raw.minute ?? 0, 0, 59, 0),
    tz,
    offsetMin,
    ...(raw.oneShot === true ? { oneShot: true } : {}),
    ...only,
  };
}

/** Sanitize an action. Returns null when it names nothing runnable. */
export function cleanAction(v: any): ScheduleAction | null {
  const raw = v && typeof v === "object" ? v : {};
  const text = typeof raw.text === "string" ? raw.text.trim() : "";
  if (!text) return null;
  if (raw.kind === "backlog") {
    const repoDir = typeof raw.repoDir === "string" ? raw.repoDir : "";
    if (!repoDir) return null;
    // The chain, bounded on the COUNT and never on the words — the same
    // constant `cleanIntentPayload` applies downstream, declared above because
    // `intent.ts` imports THIS file. A chain of exactly the head is not a
    // chain: `[text]` is stored as absent, so a rule written before this field
    // and one written after it read back identically and `intentToSchedule` has
    // nothing to invent.
    const rawSteps: string[] = Array.isArray(raw.steps)
      ? raw.steps.filter((s: unknown): s is string => typeof s === "string" && !!s.trim()).slice(0, INTENT_MAX_STEPS)
      : [];
    const steps = rawSteps.length > 1 ? rawSteps : undefined;
    // `steps[0]` REPEATS `text` by contract, and until now nothing enforced it:
    // `scheduleToIntent` trusts `steps`, `intentToSchedule` re-derives
    // `text = steps[0]`, so a rule stored with the two disagreeing came back
    // from one round trip with a `text` nobody wrote. The head is the copy that
    // survives — it is what actually RUNS as turn one — and the rule's own
    // `text` follows it rather than the sheet's label quietly rewriting turn
    // one. Nothing is clipped: this picks which of two existing strings is the
    // head, it never edits either.
    const head = steps ? steps[0] : text;
    return {
      kind: "backlog", repoDir, text: head,
      label: typeof raw.label === "string" && raw.label.trim() ? raw.label.trim().slice(0, 80) : undefined,
      // Default ON: a scheduled item that waits for a human tap is not a schedule.
      autoFire: raw.autoFire !== false,
      ...(steps ? { steps } : {}),
      ...(typeof raw.closeWhenDone === "boolean" ? { closeWhenDone: raw.closeWhenDone } : {}),
      ...actionBudget(raw.budget),
    };
  }
  const rawDirs: string[] = Array.isArray(raw.dirs) ? raw.dirs.filter((d: any) => typeof d === "string" && d) : [];
  const dirs: string[] = [...new Set<string>(rawDirs)].slice(0, 60);
  if (!dirs.length) return null;
  return { kind: "fanout", dirs, text, launch: raw.launch && typeof raw.launch === "object" ? raw.launch : undefined, ...actionBudget(raw.budget) };
}

/**
 * An action's budget, three ways: a valid cap, an explicit `null` (the person
 * CLEARED it — `upsert()` drops the stored cap), or absent (nobody said — the
 * stored cap is kept). Anything else that is not a valid cap is absent, never
 * a clear: a malformed field must not delete a cap somebody set.
 */
function actionBudget(raw: unknown): { budget?: SessionBudget | null } {
  if (raw === null) return { budget: null };
  const b = cleanSessionBudget(raw);
  return b ? { budget: b } : {};
}
