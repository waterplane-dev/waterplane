import type { HTMLAttributes } from "react";
import { tagClass, type TagTone } from "./hintClass";

/**
 * THE small status chip: `<span className="tag …">`. `tone` is the three named looks (`ok`,
 * `danger`, `coding`); any other class a call site added (`tag-filter`, `oracle-…`, `${cls}`) goes
 * in `className`, appended after it — an EMPTY one keeps its space, as the templates it replaces did.
 * `className` is written first, then the call site's props in its own order.
 */
export type TagProps = { tone?: TagTone } & HTMLAttributes<HTMLSpanElement>;

export function Tag({ tone, className, ...rest }: TagProps) {
  return <span className={tagClass(tone, className)} {...rest} />;
}
