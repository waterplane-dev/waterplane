import { chipText } from "../kit/chips.ts";
import { ACTIVITY_FILTERS } from "./activityFilters.ts";
import type { ActivityFilter } from "./activityTypes.ts";

export interface ActivityChip { id: ActivityFilter; text: string; on: boolean }

/**
 * The head's filter row: which chips are drawn, and the one line that says the empty ones.
 *
 * "Nothing failed" is a fact worth stating on this screen — it is the screen a person opens
 * after something went wrong. It used to be stated by drawing a `failed 0` chip, and six of
 * eight chips reading 0 was a row of buttons that each opened nothing. So a bucket with rows is
 * a chip, and every empty bucket is NAMED in one muted line under them (`none`), so the fact is
 * still on screen and no chip opens an empty cut.
 *
 * `all` is always a chip, and it is the row's way back: exactly one chip is lit (a choice, not
 * a cut — `clears={false}`), and `all · N` beside the lit one is the "n of N". The lit chip is
 * drawn even at 0, so a cut whose rows moved on still shows what it is. While the caller's
 * shortlist is on screen NO chip is lit — the shortlist is not "all" (`act-focus` says what it is).
 *
 * A bucket holding EVERY row is no chip either (the backlog's `drawnChips`: lit, or below its
 * pool): `done · 4` beside `all · 4` opened the list on screen. The line says `all done · …`.
 */
export function activityChips(
  counts: Readonly<Record<ActivityFilter, number>>,
  filter: ActivityFilter,
  focused: boolean,
): { chips: ActivityChip[]; none: string | null } {
  // Nothing posted at all: the list's own sentence says so, and a line of "nothing …" under an
  // `all · 0` would be that fact said twice more.
  if (counts.all + counts.dismissed === 0) return { chips: [], none: null };
  const chips: ActivityChip[] = [];
  const empty: string[] = [];
  let whole: string | null = null;
  for (const f of ACTIVITY_FILTERS) {
    const on = !focused && filter === f.id;
    // `dismissed` is outside `all`'s pool (`matchesFilter`): it never holds the whole of it.
    const isWhole = f.id !== "all" && f.id !== "dismissed" && counts[f.id] === counts.all;
    if (f.id === "all" || on || (counts[f.id] > 0 && !isWhole)) chips.push({ id: f.id, text: chipText(f.label, { count: counts[f.id] }), on });
    else if (counts[f.id] > 0) whole = f.id === "needsYou" ? "all need you" : `all ${f.label}`;
    else empty.push(f.label);
  }
  const line = [whole, empty.length ? `nothing ${orList(empty)}` : null].filter(Boolean).join(" · ");
  return { chips, none: line || null };
}

/** "a", "a or b", "a, b or c" — the chips' own labels, as drawn. */
function orList(words: readonly string[]): string {
  return words.length < 2 ? words.join("") : `${words.slice(0, -1).join(", ")} or ${words[words.length - 1]}`;
}
