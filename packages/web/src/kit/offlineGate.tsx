import { useCallback, useState, useSyncExternalStore, type ReactNode } from "react";
import { linkOnline, subscribeLink } from "../link";
import { CantInline } from "../Unavailable";

/**
 * THE refusal of a change while the link to the desktop is down. A screen that shows its last copy
 * offline (`useRemoteResource`) must not let a person edit it: the write would be lost or, worse,
 * look done. The signal is the SOCKET (`linkOnline`), never `navigator.onLine`.
 *
 * Never a dimmed button (CLAUDE.md): the button stays pressable, a tap while offline runs nothing and
 * the sentence says what was not done and why. Usage:
 *
 *   const gate = useOfflineGate();
 *   <Button onClick={gate.guard("save the rule", save)}>save</Button>
 *   {gate.note}   // a quiet line, drawn only while offline
 *
 * `guard` returns a handler; `gate.online` is for code that must branch itself.
 */
export interface OfflineGate {
  online: boolean;
  /** Wrap a write: offline it runs nothing and records `verb` for the note; online it calls `fn`. */
  guard: <A extends unknown[]>(verb: string, fn: (...a: A) => unknown) => (...a: A) => void;
  /** The refusal sentence, or null while the link is up. */
  sentence: string | null;
  /** `sentence` drawn as the app's inline cant line; null while online. */
  note: ReactNode;
}

export function offlineSentence(verb?: string | null): string {
  return verb
    ? `Could not ${verb} — no connection to the desktop. Changes are not possible until it is back.`
    : "No connection to the desktop — what is shown is the last copy, and changes are not possible until it is back.";
}

export function useOfflineGate(): OfflineGate {
  const online = useSyncExternalStore(subscribeLink, linkOnline);
  const [refused, setRefused] = useState<string | null>(null);
  const guard = useCallback(<A extends unknown[]>(verb: string, fn: (...a: A) => unknown) => (...a: A): void => {
    if (!linkOnline()) { setRefused(verb); return; }
    setRefused(null);
    fn(...a);
  }, []);
  const sentence = online ? null : offlineSentence(refused);
  return { online, guard, sentence, note: sentence ? <CantInline>{sentence}</CantInline> : null };
}
