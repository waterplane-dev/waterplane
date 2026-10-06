/**
 * The host-tools feature's state: where to LOOK when two of its sheets open.
 *
 * Neither is in the route: each is about the tap that opened the sheet, not
 * about the screen — restoring one from a URL would re-flash a section nobody
 * just tapped. Written only by `actions.ts` (the strip doors) and cleared by
 * the sheets' own `onLeave` in `index.ts`.
 */
import { createStore } from "../../sdk";
import type { NetHealthFocus } from "../../NetHealthSheet";
import type { LocalRtFocus } from "../../LocalRtBar";

/** Which reading on the connection strip asked for the health sheet. */
export const netFocus = createStore<NetHealthFocus | undefined>(undefined);
/** Which reading on the local-runtime strip was tapped — same shape and same
 *  reason as `netFocus`. */
export const localRtFocus = createStore<LocalRtFocus | undefined>(undefined);
