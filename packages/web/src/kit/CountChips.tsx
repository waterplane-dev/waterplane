import { chipRows, toggleChip, type Bucket } from "./chips";

/**
 * Filter chips that each carry a count. A 0-count bucket is STILL drawn —
 * "nothing here is older than a year" is an answer, a missing chip is not.
 *
 * `bucket` is the sheet's ONE bucketing function: the number on the chip and the
 * rows the tap opens must both come from it (a count on a control is a filter).
 * Tapping the active chip clears the cut (`onPick(null)`).
 */
export function CountChips<K extends string | number>({ keys, bucket, label, active, onPick, className = "annot-tools" }: {
  keys: readonly K[];
  bucket: (k: K) => Bucket;
  label: (k: K) => string;
  active: K | null;
  onPick: (k: K | null) => void;
  /** The wrapper's whole class string. */
  className?: string;
}) {
  return (
    <div className={className}>
      {chipRows(keys, bucket, label).map((c) => (
        <button key={c.key} className={`key ${active === c.key ? "active" : ""}`}
          onClick={() => onPick(toggleChip(active, c.key))}>
          {c.text}
        </button>
      ))}
    </div>
  );
}
