import { useRef, type KeyboardEvent, type ReactNode } from "react";

/**
 * A choice among options: one row per option, a round dot on the left (filled when chosen) and
 * the label as a full, wrapping sentence. Owner decision 2026-10-13: a solid accent fill means
 * ONLY "tap here next" (`.key.primary`), so a chosen option is never a fill, a pill or a
 * segmented button — it is a dot.
 *
 * For SINGLE-choice groups with worded options only. An icon-only on/off toggle, a multi-select
 * chip set and a lone on/off switch keep their own controls (`FilterChip`, `.key.active`).
 *
 * Tapping the chosen row does nothing: there is no "none" to fall back to. Arrow keys move the
 * choice, as a native radio group's do (roving tabindex: only the chosen row is a tab stop).
 */
export type RadioOption<K extends string> = {
  key: K;
  label: ReactNode;
  /** A second, muted line under the label: what this option means or costs. */
  note?: ReactNode;
  title?: string;
};

export function RadioRows<K extends string>({ options, value, onChange, label, className }: {
  options: readonly RadioOption<K>[];
  /** The chosen key; a value matching no option leaves every dot empty (and the first row a tab stop). */
  value: K | null | undefined;
  onChange: (key: K) => void;
  /** What the group chooses, for a screen reader — the visible heading's words. */
  label?: string;
  className?: string;
}) {
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const at = options.findIndex((o) => o.key === value);
  const onKey = (e: KeyboardEvent, i: number) => {
    const step = e.key === "ArrowDown" || e.key === "ArrowRight" ? 1 : e.key === "ArrowUp" || e.key === "ArrowLeft" ? -1 : 0;
    if (!step || options.length === 0) return;
    e.preventDefault();
    const j = (i + step + options.length) % options.length;
    refs.current[j]?.focus();
    onChange(options[j].key);
  };
  return (
    <div role="radiogroup" aria-label={label} className={className ? `radio-rows ${className}` : "radio-rows"}>
      {options.map((o, i) => {
        const on = i === at;
        return (
          <button
            key={o.key}
            ref={(el) => { refs.current[i] = el; }}
            type="button"
            role="radio"
            aria-checked={on}
            tabIndex={on || (at < 0 && i === 0) ? 0 : -1}
            className={on ? "radio-row on" : "radio-row"}
            title={o.title}
            onClick={() => { if (!on) onChange(o.key); }}
            onKeyDown={(e) => onKey(e, i)}
          >
            <span className="radio-dot" aria-hidden />
            <span className="radio-label">
              {o.label}
              {o.note != null && <span className="radio-note">{o.note}</span>}
            </span>
          </button>
        );
      })}
    </div>
  );
}
