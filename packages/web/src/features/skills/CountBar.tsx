/**
 * A use count the host is still running, as a real bar: the share done, the log count, and what waits
 * for it. The sheet polls every few seconds, so this moves; without a total it is the sentence alone.
 */
import { Hint } from "../../kit";
import { countProgress } from "./logic";

export function CountBar({ label, u, note }: { label: string; u: { state: string; done?: number; total?: number } | undefined; note?: string }) {
  const p = countProgress(u);
  if (!p) return u?.state === "counting" ? <Hint>{label}…{note ? ` ${note}` : ""}</Hint> : null;
  return (
    <div className="sk-countbar">
      <Hint>{label}: {p.pct}% · {p.done.toLocaleString("en-US")} of {p.total.toLocaleString("en-US")} logs{note ? `. ${note}` : ""}</Hint>
      {/* Native <progress>: the same bar DictateLocalRow uses for a download; no kit piece exists for one. */}
      <progress max={p.total} value={p.done} aria-label={label} />
    </div>
  );
}
