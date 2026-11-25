/**
 * What opens over a session a person just started: one thing, once that session is really the screen on top.
 *
 * A start may be deferred (the launch ask, the hosted notice), cancelled or refused, so the start itself
 * hands this over, after its op is queued and its screen asked for (`openRepoWith`, `openCwd`). The pending
 * screen is not it yet: the create can still be refused, and its ack focuses the session, which closes any
 * sheet. So the wish waits on the pending screen and is judged on the first other screen: the session that
 * create made, with no sheet over it, or nothing.
 */
import { useEffect, useState } from "react";
import { adoptedId } from "../../outbox.ts";
import type { Overlay } from "../../routing.ts";

export interface AfterStart { screen: string; at: number; open(): void }

/** A start the desktop took longer than this to answer is past: nothing opens over a screen somebody is using by now. */
export const AFTER_START_MS = 15_000;

/** The one decision, pure. `session` is what the pending screen became, null while it has not. */
export function afterStartStep(
  want: Pick<AfterStart, "screen" | "at">,
  on: { activeId: string | null; overlay: Overlay; session: string | null; now: number },
): "wait" | "open" | "drop" {
  if (on.overlay !== null || on.now - want.at > AFTER_START_MS) return "drop";
  if (on.session && on.activeId === on.session) return "open";
  return on.activeId === want.screen ? "wait" : "drop";
}

export function useAfterStart(activeId: string | null, overlay: Overlay): (want: AfterStart) => void {
  const [want, setWant] = useState<AfterStart | null>(null);
  useEffect(() => {
    if (!want) return;
    const step = afterStartStep(want, { activeId, overlay, session: adoptedId(want.screen), now: Date.now() });
    if (step === "wait") return;
    setWant(null);
    if (step === "open") want.open();
  }, [want, activeId, overlay]);
  return setWant;
}
