/**
 * "Change this" from anywhere in the app: open Settings narrowed to the ONE
 * row a readout is reporting, instead of on the top of a 54-row screen with a
 * toast saying "see Settings". A root module because doors live in features,
 * core and top-level sheets alike, and a feature may not import another.
 *
 * The pin is transient: the sheet drops it when it closes and when anything is
 * typed in the search box, and the filter bar says what it is hiding with a
 * clear button — a door is a filter, and a filter says "n of N".
 */
import { core, createStore, useStore } from "./sdk";
import { settingRow } from "./settingsIndex";

export const settingsOnly = createStore<string | null>(null);

export function useSettingsOnly(): string | null {
  return useStore(settingsOnly);
}

/** Open Settings showing only row `id` (a `settingsIndex.ts` id). An id the
 *  catalogue does not know opens the whole screen rather than an empty one. */
export function openSettingsAt(id: string): void {
  const c = core();
  settingsOnly.set(settingRow(id) ? id : null);
  c.say.track("action:settings.door");
  c.nav.open("settings");
}
