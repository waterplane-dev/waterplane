import { createElement, type HTMLAttributes } from "react";
import { hintClass, type HintTone } from "./hintClass";

/**
 * THE one-line note under a control: `form-hint`, optionally `warn` or `mono` (`tone`). Renders
 * EXACTLY the DOM its call sites wrote by hand (docs/plans/ui-kit-components.md, P5): `div` unless
 * `as="span"`, class string from `hintClass` (node-tested), `className` first then the call site's
 * props in its own order — a site with a DOM attribute before `className` stays a raw element.
 * `className` appends after the tone; an EMPTY one keeps its space, as the templates it replaces did.
 */
export type HintProps = { as?: "div" | "span"; tone?: HintTone } & HTMLAttributes<HTMLElement>;

export function Hint({ as = "div", tone, className, ...rest }: HintProps) {
  return createElement(as, { className: hintClass(tone, className), ...rest });
}
