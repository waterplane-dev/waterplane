/**
 * **A lead time somebody typed** — *how long before* the reset a usage-window
 * rule fires, past the presets in `LEADS`. The headroom field's shape
 * (`pctOk`/`pctChoices`/`pctWords`), applied to minutes.
 */
import { LEADS } from "./sendClock.ts";

/**
 * **A lead time as a chip says it**: `45m`, `4h`, `1h30m`. The presets only
 * ever needed the first two shapes; a typed lead is the reason for the third.
 */
export function leadLabel(min: number): string {
  if (min < 60) return `${min}m`;
  const h = Math.floor(min / 60), m = min % 60;
  return m ? `${h}h${m}m` : `${h}h`;
}

/** The longest lead the host keeps: `cleanRule` clamps `offsetMin` to a day. */
export const LEAD_MAX_MIN = 1440;

/**
 * A typed lead time in minutes, or null.
 *
 * `45`, `45m`, `4h`, `1.5h`, `1h30`, `1h30m`. A bare number is MINUTES — the
 * field echoes what it read, so a `4` meant as hours says "4m" on the row the
 * person is typing on rather than being guessed at. `0` is not one: zero before
 * the reset is the reset itself, which is the other segment above. Past a day
 * is not one either, because the host would clamp it to a day silently and the
 * chip would then name a lead the rule does not hold.
 */
export function leadOk(v: unknown): number | null {
  const n = typeof v === "number" ? v : typeof v === "string" ? leadParse(v) : NaN;
  if (!Number.isFinite(n)) return null;
  const r = Math.round(n);
  return r >= 1 && r <= LEAD_MAX_MIN ? r : null;
}

/** Minutes a duration string says, unbounded; NaN when it is not one. */
function leadParse(raw: string): number {
  const t = raw.trim().toLowerCase().replace(/\s+/g, "");
  const m = /^(?:(\d+(?:\.\d+)?)h)?(?:(\d+(?:\.\d+)?)m?)?$/.exec(t);
  if (!t || !m || (m[1] == null && m[2] == null)) return NaN;
  // `1h30` is 1h and 30 minutes; a lone `30` is 30 minutes.
  return Number(m[1] ?? 0) * 60 + Number(m[2] ?? 0);
}

/**
 * **The chips the *how long before* row draws**: the presets, plus the lead this
 * phone saved and the one the rule already carries — same reasoning as
 * `pctChoices`: a rule written elsewhere opens with its own lead lit.
 */
export function leadChoices(saved?: number | null, current?: number | null): number[] {
  const out = new Set<number>(LEADS.filter((m) => m > 0));
  for (const v of [saved, current]) {
    const n = leadOk(v);
    if (n != null) out.add(n);
  }
  return [...out].sort((a, b) => a - b);
}

/** **Why a typed lead is not being applied yet**, or null while it is. Words,
 *  never a dimmed field — the chips above still answer the question. */
export function leadWords(raw: string): string | null {
  const t = raw.trim();
  if (!t) return "Type a lead — 45m, 4h, 1h30 — or pick one above.";
  if (leadOk(t) != null) return null;
  if (t.startsWith("-")) return "Type how long before, without a minus — the segment above already says before.";
  const n = leadParse(t);
  if (!Number.isFinite(n)) return `“${t}” is not a duration. Try 45m, 4h or 1h30.`;
  if (Math.round(n) === 0) return "0 before the reset is the reset itself — that is right after it resets, above.";
  return "Up to 24h before: the host keeps a lead within a day of the reset.";
}
