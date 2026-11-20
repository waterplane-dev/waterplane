/**
 * A backlog row's two triage facts: what it will COST and what it is WORTH.
 *
 * Both optional, both absent on most rows written before they existed, and
 * absent means NOBODY SAID — never "cheap" or "low". They are written by
 * whoever files the row (a person on the phone, an agent through
 * `/api/agent/backlog` or `/api/agent/intents`) and changed by a person's edit;
 * no pass overwrites them, so they carry no author stamp.
 *
 * The phone draws them in FRONT of the row's title (`estimatePrefix`), because
 * a list of fifty rows is triaged by exactly these two facts.
 */

/** How much the work is worth to the person, in three words and no more —
 *  read as a filter on a phone, like `ITEM_CATEGORIES`. */
export type ItemValue = "high" | "medium" | "low";

export const ITEM_VALUES: readonly ItemValue[] = ["high", "medium", "low"];

/** An estimate is a few words ("~$3 · 20 min"), never a paragraph: it sits in
 *  front of a title on a phone line. Longer is clipped, never dropped. */
export const MAX_ESTIMATE_CHARS = 24;

/** One line of at most `MAX_ESTIMATE_CHARS`, or nothing. */
export function cleanEstimate(raw: unknown): string | undefined {
  if (typeof raw !== "string") return undefined;
  const s = raw.trim().replace(/\s+/g, " ").slice(0, MAX_ESTIMATE_CHARS).trim();
  return s || undefined;
}

/** One of the three words, or nothing — no synonym table (`cleanCategory`'s rule). */
export function cleanValue(raw: unknown): ItemValue | undefined {
  if (typeof raw !== "string") return undefined;
  const s = raw.trim().toLowerCase();
  return ITEM_VALUES.find((v) => v === s);
}

/** The sentence an edit gets back when its value was not one of the three. */
export function valueRefusedText(value: string): string {
  return `"${value.trim().slice(0, 40)}" is not one of ${ITEM_VALUES.join("/")} — the value was left as it was`;
}

/**
 * The words drawn in front of a row's title: `~$3 · 20 min · high value`.
 * `null` when neither was said.
 */
export function estimatePrefix(it: { estimate?: string; value?: ItemValue }): string | null {
  const parts = [it.estimate?.trim(), it.value ? `${it.value} value` : undefined].filter(Boolean);
  return parts.length ? parts.join(" · ") : null;
}

/**
 * The dollar figure an estimate names, for sorting and bucketing: the middle of
 * a range (`~$2-8` → 5), the figure itself (`~$3` → 3). `null` when it names
 * none — sorted after every row that does, never read as free.
 */
export function estimateDollars(estimate: string | undefined): number | null {
  const m = /\$\s*(\d+(?:\.\d+)?)(?:\s*[-–]\s*(?:\$\s*)?(\d+(?:\.\d+)?))?/.exec(estimate ?? "");
  if (!m) return null;
  const lo = Number(m[1]);
  const hi = m[2] === undefined ? lo : Number(m[2]);
  return (lo + hi) / 2;
}

/** high → 0 … low → 2, nobody said → 3: the value sort's key. */
export function valueRank(value: ItemValue | undefined): number {
  return value ? ITEM_VALUES.indexOf(value) : ITEM_VALUES.length;
}
