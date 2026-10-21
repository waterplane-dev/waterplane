export type RowKind = "grow" | "wrap";

/** The wrapper's class string, byte for byte what the hand-written sites had:
 *  `row`, `row grow`, `row-wrap`. */
export function rowClass(kind?: RowKind): string {
  return kind === "wrap" ? "row-wrap" : kind === "grow" ? "row grow" : "row";
}

/** `base` (`row-title` | `row-sub`), then " " + className whenever it is not undefined — an EMPTY
 *  className still adds its space, because `row-sub ${bad ? "warn" : ""}` rendered "row-sub ". */
export function rowPartClass(base: "row-title" | "row-sub", className?: string): string {
  return base + (className !== undefined ? ` ${className}` : "");
}
