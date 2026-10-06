/** When a reader turn was posted and when it finished — pure, so node tests it. */
/** "Tue 29 Sep, 15:08" — the date AND time, for a reader scrolled back past
 *  midnight where a bare clock no longer says which day. The year only when it
 *  is not this one. */
export const stamp = (ts?: number, now = Date.now()): string => {
  if (!ts) return "";
  const d = new Date(ts);
  const year = d.getFullYear() !== new Date(now).getFullYear();
  return d.toLocaleString([], {
    weekday: "short", day: "numeric", month: "short", ...(year ? { year: "numeric" } : {}),
    hour: "2-digit", minute: "2-digit",
  });
};

/** "40s" / "23m" / "1h 5m" — how long a turn ran, sent to last record. */
export const took = (from?: number, to?: number): string => {
  if (!from || !to || to < from) return "";
  const s = Math.round((to - from) / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.round(s / 60);
  return m < 60 ? `${m}m` : `${Math.floor(m / 60)}h ${m % 60}m`;
};
