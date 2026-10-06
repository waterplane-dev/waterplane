/**
 * The tour's one store: this device's `TourState`. Read from `LS.demoTour` by
 * the manifest's `boot` (not at module load — the static demo's storage facade,
 * `demo/world.ts`, must be in place first). One writer: `actions.ts`'s
 * `saveTour`, which writes the store and storage together.
 */
import { createStore, useStore } from "../../sdk";
import { EMPTY_TOUR, type TourState } from "./logic";

export const tourStore = createStore<TourState>(EMPTY_TOUR);

export const useTour = (): TourState => useStore(tourStore);
