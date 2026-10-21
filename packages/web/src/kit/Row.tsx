import { createElement, type ButtonHTMLAttributes, type HTMLAttributes } from "react";
import { rowClass, rowPartClass, type RowKind } from "./rowClass";

/**
 * THE list row: the `.row` / `.row grow` / `.row-wrap` wrapper and the `.row-title` / `.row-sub`
 * parts inside it. Like `Button`, each renders EXACTLY the DOM its call sites wrote by hand
 * (docs/plans/ui-kit-components.md, P3), so every rule here is about reproducing a class string or
 * an attribute order byte for byte.
 *
 * - `Row` — `kind` picks the class (none → `row`, `"grow"` → `row grow`, `"wrap"` → `row-wrap`);
 *   `as="button"` for a tappable row (no `type` default: a call site that wrote none gets none).
 *   No `className` prop: `kind` is the only way to the class, so nothing can replace `row`.
 *   `className` is written FIRST, then the call site's props in its own order, so a site with a
 *   DOM attribute (`type`, `data-*`) before `className` stays a raw element. A row that
 *   interleaves other elements between its title and sub is just children: nothing here orders them.
 * - `RowTitle` / `RowSub` — the `<span>` (or, `as="div"`, the `<div>`) with the part's class, then
 *   `" " + className` whenever className is not undefined (an EMPTY one keeps its space, as
 *   `row-sub ${bad ? "warn" : ""}` always rendered `"row-sub "`; `rowClass.ts`, node-tested).
 */
export type RowProps =
  | ({ as?: "div"; kind?: RowKind } & Omit<HTMLAttributes<HTMLDivElement>, "className">)
  | ({ as: "button"; kind?: RowKind } & Omit<ButtonHTMLAttributes<HTMLButtonElement>, "className">);

export function Row({ as = "div", kind, ...rest }: RowProps) {
  return createElement(as, { className: rowClass(kind), ...rest });
}

export type RowPartProps = { as?: "span" | "div" } & HTMLAttributes<HTMLElement>;

export function RowTitle({ as = "span", className, ...rest }: RowPartProps) {
  return createElement(as, { className: rowPartClass("row-title", className), ...rest });
}

export function RowSub({ as = "span", className, ...rest }: RowPartProps) {
  return createElement(as, { className: rowPartClass("row-sub", className), ...rest });
}
