/**
 * The words and cuts of a usage SOURCE on the token statistics: which readings get a picker chip,
 * the "opened on" sentence, one window's line and its kept series. Pure, node-tested.
 *
 * A source here is an ACCOUNT's quota (Copilot, a plugin's probe), not a token ledger: it has
 * windows and a history of readings, never a merged total and never a price. A source with no
 * reading has no chip — ABSENT, not dimmed, not a `?`.
 */
import { chipCut, usageWindowPct, type UsageReading, type UsageSample, type UsageSourceHistoryDoc, type UsageWindow } from "@waterplane/shared";

/** The id a reading chip lives under in the body's `extraId` state — no ledger tab id can carry this prefix. */
export const READING_TAB = "reading:";

export interface ReadingChip { source: string; label: string }

/**
 * One chip per reading that DRAWS (`chipCut`'s own rule, so the chip, this picker and the "n of N" line
 * are one cut), minus claude (its ledger is the default view) and minus any source a ledger tab already
 * answers for — two chips for one source would be two doors to the same room.
 */
export function readingChips(readings: readonly UsageReading[] | null | undefined, ledgerIds: readonly string[] = []): ReadingChip[] {
  return chipCut(readings, Number.MAX_SAFE_INTEGER).segments
    .filter((s) => s.source !== "claude" && !ledgerIds.includes(s.source))
    .map((s) => ({ source: s.source, label: s.label }));
}

/** N in "1 of N sources": every source the launcher chip could draw, shown or hidden. */
export const sourceTotal = (readings: readonly UsageReading[] | null | undefined): number =>
  chipCut(readings, 3).total;

/**
 * The filtered view saying what it hides. Null when it hides nothing (one source) or when no source
 * was tapped open — a lone-claude tap sets nothing, so nothing is claimed.
 */
export function openedOnText(label: string | null, total: number): string | null {
  if (!label || total < 2) return null;
  return `opened on ${label} · 1 of ${total} sources`;
}

/** The label of a source id among the readings, else the id (a chip that left still names itself). */
export const sourceLabel = (readings: readonly UsageReading[] | null | undefined, source: string): string =>
  (readings ?? []).find((r) => r.source === source)?.label ?? source;

/**
 * The body's "opened on" line: only while the view is still ON the tapped source (`on`, the body's
 * own state — null after `all`), and only when other sources exist (`openedOnText`).
 */
export function openedOnFor(on: string | null, viewing: string | null, readings: readonly UsageReading[] | null | undefined): string | null {
  if (!on || !viewing || viewing !== on) return null;
  return openedOnText(sourceLabel(readings, on), sourceTotal(readings));
}

/** `chat · 5% used · 9 / 200 credits` — what the window said, and only that. */
export function windowText(w: UsageWindow): string {
  const pct = usageWindowPct(w);
  const parts = [w.id];
  if (pct != null) parts.push(`${pct}% used`);
  if (typeof w.used === "number" && typeof w.limit === "number") {
    parts.push(`${w.used} / ${w.limit}${w.unitName ? ` ${w.unitName}` : ""}`);
  }
  return parts.join(" · ");
}

export interface SparkPoint { t: number; pct: number; /** The reset the source named at that reading, or null. */ r: number | null }

/** One window's kept readings, oldest first. A reading that did not print the percentage is skipped, never zeroed. */
export function sparkPoints(doc: UsageSourceHistoryDoc | null | undefined, windowId: string): SparkPoint[] {
  if (!doc || !Array.isArray(doc.samples)) return [];
  const out: SparkPoint[] = [];
  for (const s of doc.samples) {
    const w = Array.isArray(s?.w) ? s.w.find((x) => x?.id === windowId) : undefined;
    if (!w || typeof w.pct !== "number" || !Number.isFinite(w.pct) || w.pct < 0 || w.pct > 100) continue;
    if (typeof s.t !== "number" || !Number.isFinite(s.t)) continue;
    out.push({ t: s.t, pct: w.pct, r: typeof w.resetAt === "number" && Number.isFinite(w.resetAt) ? w.resetAt : null });
  }
  return out.sort((a, b) => a.t - b.t);
}

/**
 * One window's kept readings in claude's `UsageSample` shape, on its `s`/`sr` lane — so `UsageSpark`
 * (labelled fixed axis, time axis, cut gaps and rollovers, the crosshair line, the projection) draws a
 * source's quota exactly as it draws claude's limit windows, instead of a second, barer chart.
 */
export const asUsageSamples = (pts: readonly SparkPoint[]): UsageSample[] =>
  pts.map((p) => ({ t: p.t, s: p.pct, w: null, sr: p.r, wr: null }));

/**
 * Where a tap that opened the sheet ON a source lands: a contributed view (`source`), a generic
 * ledger tab (`extraId` = its backend id), or a reading-only chip (`extraId` = `READING_TAB` + id).
 * A source that is its own backend (Copilot, `backend: "copilot"`) has a LEDGER tab and no reading
 * chip — two doors to one room — so its tap must open that tab; it fell through to Claude's.
 * Nothing matched (or no tap) ⇒ Claude's view, as before sources existed.
 */
export function openedTarget(openedOn: string | null | undefined, ids: { guests: readonly string[]; ledgers: readonly string[]; chips: readonly string[]; backendOf?: string | null }): { source: string; extraId: string | null } {
  if (!openedOn || openedOn === "claude") return { source: "claude", extraId: null };
  if (ids.guests.includes(openedOn)) return { source: openedOn, extraId: null };
  if (ids.ledgers.includes(openedOn)) return { source: "claude", extraId: openedOn };
  // A source named apart from its backend (`source: "gh"`, `backend: "copilot"`) opens that backend's tab.
  if (ids.backendOf && ids.ledgers.includes(ids.backendOf)) return { source: "claude", extraId: ids.backendOf };
  if (ids.chips.includes(openedOn)) return { source: "claude", extraId: READING_TAB + openedOn };
  return { source: "claude", extraId: null };
}

/** The reading a ledger tab leads with: the source of that id, else one whose `backend` is it. */
export function readingForLedger(readings: readonly UsageReading[] | null | undefined, id: string): UsageReading | null {
  const rs = readings ?? [];
  return rs.find((r) => r.source === id) ?? rs.find((r) => r.backend === id) ?? null;
}
