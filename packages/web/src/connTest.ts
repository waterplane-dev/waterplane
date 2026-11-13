/**
 * Doors to the connection test and the speed test from anywhere: Connection
 * health, a desktop's edit form, Settings. A root module for `settingsFocus.ts`'s
 * reason — the doors live in two features and a top-level sheet, and a feature
 * may not import another.
 *
 * The door's tap IS the ask, so the sheet opens with that test already running;
 * the pin is consumed once by the sheet and never routed (a reload must not
 * start a 32 MB transfer nobody just asked for).
 */
import { core, createStore } from "./sdk";

export type ConnTestKind = "ping" | "speed";

/** What a door's speed test moves EACH WAY — the sheet's default size, and the number the door's label states. */
export const DEFAULT_SPEED_MB = 32;

/** The test the next opening of the speed-test sheet starts by itself. */
export const connTestStart = createStore<ConnTestKind | null>(null);

export function openConnTest(kind: ConnTestKind): void {
  const c = core();
  connTestStart.set(kind);
  c.say.track(`action:conntest.${kind}`);
  c.nav.open("speedtest");
}

/** Connection health, from a screen that is not the strip. */
export function openNetHealth(): void {
  const c = core();
  c.say.track("overlay:nethealth");
  c.nav.open("nethealth");
}
