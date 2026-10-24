export type KeyVariant = "primary" | "danger";

/** "key", then " " + variant if given, then " " + className when it is non-empty — an EMPTY
 *  className adds nothing, so `className={on ? "x" : ""}` renders "key", not the "key " that the
 *  hand-written `key ${on ? "x" : ""}` did (the trailing space was never meaningful). */
export function keyClass(variant?: KeyVariant, className?: string): string {
  return "key" + (variant !== undefined ? ` ${variant}` : "") + (className !== undefined && className !== "" ? ` ${className}` : "");
}
