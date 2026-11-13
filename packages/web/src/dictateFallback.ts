import type { DictateStatus } from "@waterplane/shared";

/**
 * Why a tap on the microphone is going to the PHONE's recogniser rather than
 * the desktop's whisper — as a sentence, because the two engines are one button
 * and nothing else on screen says which one is listening.
 *
 * It mattered the day Android's recogniser dictated "orsofixorsofix" into a
 * prompt: the person had every reason to think whisper wrote that, and the fix
 * (open the app over https) was one tap away on a banner they had snoozed.
 *
 * `null` means either whisper IS the engine, or the desktop has not answered
 * yet — a reason is never guessed before it is known.
 */
export interface FallbackFacts {
  /** `window.isSecureContext` — plain `http://100.x` is not. */
  secure: boolean;
  /** This document can open a microphone for recording at all. */
  canRecord: boolean;
  /** What `GET /api/host/dictate` said; undefined while it is in flight. */
  status?: DictateStatus;
}

/** The pill's face while the phone's recogniser is listening. */
export const FALLBACK_FACE = "phone recogniser";

export function dictateFallbackWhy(f: FallbackFacts): string | null {
  const lead = "dictating with the phone's own recogniser, not the desktop's whisper";
  if (!f.secure) {
    return `${lead}: this page is plain http, where the app may not record audio — open it over its https address and whisper takes over`;
  }
  if (!f.canRecord) return `${lead}: this browser gives the app no way to record audio`;
  if (!f.status) return null;
  if (f.status.available) return null;
  let reason = (f.status.reason ?? "the desktop says whisper is not available").trim();
  while (reason.endsWith(".")) reason = reason.slice(0, -1);
  return `${lead}: ${reason}. ${WEAKER} ${DOOR_TAIL}`;
}

/** What the phone's recogniser costs the person — said once, in the tap's sentence. */
const WEAKER = "It is weaker on code words and mixed languages, and on Android it may send your audio to Google.";
/** The way out; the pill opens Settings at that row when the sentence ends with this. */
const DOOR_TAIL = "Settings › Writing & reading › Local dictation sets whisper up.";
/** Whether a fallback sentence points at the Local dictation row (the https and no-recorder cases have a different fix). */
export const fallbackHasDoor = (why: string): boolean => why.endsWith(DOOR_TAIL);

/**
 * A link listener that calls `ask` once each time the link comes back.
 *
 * `wasOpen` moves BEFORE `ask` runs, and the order is the point: `ask` starts a
 * request, a request's `netBegin` emits the link synchronously, and this listener
 * hears that emit from inside `ask`. Read the other way round it still sees a link
 * that has just come back and asks again, on and on, until the stack overflows: a
 * "no" is not memoised, so every reconnect to a desktop without whisper did that.
 */
export function askOnLinkBack(wasOpen: boolean, ask: () => void): (link: { status: string }) => void {
  return (link) => {
    const open = link.status === "open";
    const back = open && !wasOpen;
    wasOpen = open;
    if (back) ask();
  };
}
