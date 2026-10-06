import type { ReactNode } from "react";

/**
 * "n of N — clear": what a filtered list is hiding, and the way out. The markup
 * behind `.filter-bar` in styles.css — say the counts in `children`.
 */
export function FilterBar({ children, onClear, clearLabel = "clear", clearTitle, section = false, className }: {
  children: ReactNode;
  onClear: () => void;
  /** Usually "clear"; say the effect where "clear" could read as dismissing something. */
  clearLabel?: ReactNode;
  clearTitle?: string;
  /** Adds the `section` class (the bar sits in a sheet's section flow). */
  section?: boolean;
  /** Extra classes after `filter-bar`. */
  className?: string;
}) {
  const cls = `${section ? "section " : ""}filter-bar${className ? ` ${className}` : ""}`;
  return (
    <div className={cls}>
      <span className="filter-bar-txt">{children}</span>
      <button className="filter-bar-clear" title={clearTitle} onClick={onClear}>{clearLabel}</button>
    </div>
  );
}
