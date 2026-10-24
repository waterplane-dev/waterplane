export type HintTone = "warn" | "mono";
export type TagTone = "ok" | "danger" | "coding";

/** `form-hint`, then `" " + tone`, then `" " + className` when it is non-empty — an EMPTY one adds
 *  nothing (like keyClass), so the "form-hint " that `form-hint ${bad ? "warn" : ""}` rendered is gone. */
export function hintClass(tone?: HintTone, className?: string): string {
  return "form-hint" + (tone ? ` ${tone}` : "") + (className ? ` ${className}` : "");
}

/** The same for the `tag` chip: `tag`, `tag ok`, `tag danger`, `tag coding`, then the call site's own. */
export function tagClass(tone?: TagTone, className?: string): string {
  return "tag" + (tone ? ` ${tone}` : "") + (className ? ` ${className}` : "");
}

/** `set-note`, then `" " + className` when it is non-empty (an EMPTY one adds nothing). */
export function noteClass(className?: string): string {
  return "set-note" + (className ? ` ${className}` : "");
}
