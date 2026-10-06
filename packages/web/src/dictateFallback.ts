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
  return `${lead}: ${f.status.reason ?? "the desktop says whisper is not available"}`;
}
