export type HintTone = "warn" | "mono";
export type TagTone = "ok" | "danger" | "coding";

/** `form-hint`, then `" " + tone`, then `" " + className` whenever className is not undefined — an
 *  EMPTY one keeps its space, because `form-hint ${bad ? "warn" : ""}` always rendered "form-hint ". */
export function hintClass(tone?: HintTone, className?: string): string {
  return "form-hint" + (tone ? ` ${tone}` : "") + (className !== undefined ? ` ${className}` : "");
}

/** The same for the `tag` chip: `tag`, `tag ok`, `tag danger`, `tag coding`, then the call site's own. */
export function tagClass(tone?: TagTone, className?: string): string {
  return "tag" + (tone ? ` ${tone}` : "") + (className !== undefined ? ` ${className}` : "");
}
