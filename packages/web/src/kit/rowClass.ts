export type RowKind = "grow" | "wrap";

/** The wrapper's class string, byte for byte what the hand-written sites had:
 *  `row`, `row grow`, `row-wrap`. */
export function rowClass(kind?: RowKind): string {
  return kind === "wrap" ? "row-wrap" : kind === "grow" ? "row grow" : "row";
}

/** `base` (`row-title` | `row-sub`), then " " + className when it is non-empty — an EMPTY
 *  className adds nothing (the "row-sub " of `row-sub ${bad ? "warn" : ""}` is gone, as in keyClass). */
export function rowPartClass(base: "row-title" | "row-sub", className?: string): string {
  return base + (className ? ` ${className}` : "");
}
