export type KeyVariant = "primary" | "danger";

/** "key", then " " + variant if given, then " " + className whenever it is not undefined —
 *  an EMPTY className still adds its space, because `key ${on ? "x" : ""}` rendered "key ". */
export function keyClass(variant?: KeyVariant, className?: string): string {
  return "key" + (variant !== undefined ? ` ${variant}` : "") + (className !== undefined ? ` ${className}` : "");
}
