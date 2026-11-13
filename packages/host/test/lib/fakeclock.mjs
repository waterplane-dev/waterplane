/**
 * Virtual time for the delivery ladder (`waitclock.ts`'s `Clock`).
 *
 * `sleep(ms)` moves the virtual clock forward by `ms`, fires anything scheduled
 * with `at()` that has come due, and resolves on a microtask — so a polling loop
 * that waits 53 s finishes in microseconds, and `elapsed()` says exactly how
 * much virtual time the code asked to wait. `now()` starts at `start`.
 */
export function fakeClock(start = 1_700_000_000_000) {
  let t = start;
  const due = [];
  const fire = () => {
    for (let i = 0; i < due.length;) {
      if (due[i].at <= t) { const [d] = due.splice(i, 1); d.fn(); } else i++;
    }
  };
  return {
    now: () => t,
    sleep: async (ms) => { t += ms; fire(); await Promise.resolve(); },
    /** Virtual ms since the clock was made. */
    elapsed: () => t - start,
    /** Run `fn` the first time the clock reaches `ms` after the start. */
    at: (ms, fn) => { due.push({ at: start + ms, fn }); },
    /**
     * `Clock.after`: a cancellable timer `ms` from now. When nothing else moves
     * the clock (everything is waiting on time — a source that never answers),
     * time jumps to the next due entry once the microtasks drain, one entry at a
     * time, so a race bound fires in virtual time instead of hanging the test.
     */
    after: (ms, fn) => {
      const d = { at: t + ms, fn };
      due.push(d);
      const idle = () => {
        if (!due.includes(d)) return;
        t = Math.max(t, Math.min(...due.map((x) => x.at)));
        fire();
        setImmediate(idle);
      };
      setImmediate(idle);
      return () => { const i = due.indexOf(d); if (i >= 0) due.splice(i, 1); };
    },
    /** Entries still waiting (a cancelled `after` is gone). */
    pending: () => due.length,
  };
}
