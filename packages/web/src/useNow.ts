/**
 * A clock that ticks, so a rendered age stays true.
 *
 * Every "4m ago" on a screen is computed once, at render, and a sheet that is
 * open for twenty minutes with nothing arriving renders nothing: the age freezes
 * at whatever it was when the list last changed. That is invisible and wrong in
 * the one direction that matters here — an item said to be four minutes old is
 * how a person decides it is still running rather than stuck.
 *
 * `ActivitySheet` had this privately and `Backlog` needed the same thing; one
 * copy, so the two screens cannot disagree about what time it is.
 */
import { useEffect, useState } from "react";

export function useNow(everyMs: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), everyMs);
    return () => window.clearInterval(t);
  }, [everyMs]);
  return now;
}
