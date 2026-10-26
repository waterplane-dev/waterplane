/**
 * Where What's new (`features/whatsnew`) reads the notification feed's facts
 * and finds its doors. Features never import each other
 * (`local/feature-boundary`), so `features/notifications` hands its stores, its
 * one failure cut and its three open verbs to this top-level slot at boot —
 * `automationSlot.ts`'s shape. Empty (a build without the feature, or before
 * boot) ⇒ every fact reads as not read, and What's new draws no state line.
 */
import type { NotificationItem } from "@waterplane/shared";
import { createStore, useStore, type Store } from "./sdk/store.ts";

export interface FeedSource {
  /** The feed as the notifications feature holds it. */
  items: Store<NotificationItem[]>;
  /** Push information too, as the host last said. */
  pushInfo: Store<boolean>;
  /** Which of the host's answers have arrived: an empty feed before the list is not "nothing". */
  heard: Store<{ list: boolean; prefs: boolean }>;
  /** The bell's cut (needs you) and the repo-failure cut — the feature's own functions, never a copy. */
  needsYouIds(items: readonly NotificationItem[]): string[];
  failures(items: readonly NotificationItem[]): NotificationItem[];
  openBell(): void;
  openCut(ids: string[]): void;
  openFeed(): void;
}

const slot = createStore<FeedSource | null>(null);
const noItems = createStore<NotificationItem[]>([]);
const noBool = createStore<boolean>(false);
const noHeard = createStore<{ list: boolean; prefs: boolean }>({ list: false, prefs: false });

export function setFeedSource(src: FeedSource | null): void {
  slot.set(src);
}

export interface FeedFacts {
  /** null = the list has not arrived. */
  needsYou: number | null;
  failures: NotificationItem[] | null;
  /** null = the host has not said. */
  pushInfo: boolean | null;
}

/** The facts, read reactively, and the source for its verbs; null without the feature. */
export function useFeedFacts(): { facts: FeedFacts; src: FeedSource | null } {
  const src = useStore(slot);
  const items = useStore(src?.items ?? noItems);
  const info = useStore(src?.pushInfo ?? noBool);
  const heard = useStore(src?.heard ?? noHeard);
  if (!src) return { facts: { needsYou: null, failures: null, pushInfo: null }, src: null };
  return {
    facts: {
      needsYou: heard.list ? src.needsYouIds(items).length : null,
      failures: heard.list ? src.failures(items) : null,
      pushInfo: heard.prefs ? info : null,
    },
    src,
  };
}
