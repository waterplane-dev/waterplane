/**
 * The first-app journey's state. One writer each: `onboard.progress` and the GET on welcome write
 * `jobStore` (`actions.ts`), the card's "Not now" writes `dismissedStore`, the hand-off writes
 * `seededStore`. None of it is persisted on the phone: the job lives on the desktop
 * (`GET /api/onboard` after a reload), and a dismissal is for this page only.
 */
import { createStore, useStore } from "../../sdk";
import type { OnboardJob } from "@waterplane/shared";

/** The current (or last) job; `undefined` until the host has been asked. */
export const jobStore = createStore<OnboardJob | null | undefined>(undefined);
/** The first-run card's "Not now", for this page. */
export const dismissedStore = createStore<boolean>(false);
/** Job ids whose suggested prompt already went into the composer: a second tap never appends twice. */
export const seededStore = createStore<ReadonlySet<string>>(new Set());

/** The job Go started on this page: its finished checklist stays on screen until "Build another". */
export const startedHereStore = createStore<string | null>(null);

export const useOnboardJob =(): OnboardJob | null | undefined => useStore(jobStore);
export const useFirstRunDismissed = (): boolean => useStore(dismissedStore);
