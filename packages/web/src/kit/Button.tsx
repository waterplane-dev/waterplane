import { forwardRef, type ButtonHTMLAttributes } from "react";
import { keyClass, type KeyVariant } from "./keyClass";

/**
 * THE `.key` button: the app's one fat, 46×44 tap target (`styles/`), with the sheet's one primary
 * verb (`primary`, the solid accent fill: "tap here next") and the destructive one (`danger`) as
 * variants. It is a plain `<button>` and renders EXACTLY the DOM its call sites wrote by hand —
 * the migration (docs/plans/ui-kit-components.md, P1) is render-neutral, so every rule below is
 * about reproducing a string or an attribute order byte for byte.
 *
 * The class string is `keyClass(variant, className)` (`keyClass.ts`, node-tested in kit.test.mjs):
 * `"key"`, then `" " + variant` when a variant is given, then `" " + className` whenever className
 * is NOT undefined — an EMPTY className still adds its space. That is deliberate: ~70 call sites
 * wrote `` `key ${on ? "active" : ""}` ``, which renders `"key "` when off, and a
 * `filter(Boolean).join(" ")` would drop that space and change the DOM. So a migrator only ever
 * deletes the leading `key ` and keeps the rest of the expression verbatim:
 *   `"key"`                     → no className
 *   `"key primary pair-wide"`   → variant="primary" className="pair-wide"
 *   `"key rh-verb"`             → className="rh-verb"
 *   `` `key ${c ? "on" : ""}` `` → className={c ? "on" : ""}       (still "key " when off)
 * `variant` is used ONLY when `primary`/`danger` is the literal SECOND token of a static string;
 * anywhere else (`key usage-key ${hot ? "danger" : ""}`) it stays in className, verbatim.
 *
 * Attribute ORDER is part of the DOM too (outerHTML serialises attributes in the order they were
 * set, and React 18 sets them in props-iteration order — `setInitialDOMProperties`' `for…in`).
 * `className` is therefore written FIRST, the rest follow in the call site's own order. That
 * matches every site where no DOM attribute precedes `className` (handlers, `key` and `ref` are
 * not attributes). A site with `type`/`data-hint` before `className` stays a raw `<button>`.
 *
 * No `type` default (Hard rule 2): no `type` prop → no `type` attribute, exactly as before; a
 * `<button>` with no type inside a `<form>` still submits, as it did. No `disabled` branch either
 * (`Unavailable.tsx`: what cannot run says why in words).
 *
 * `link-btn` buttons are not `.key` and are not this component.
 */
export type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  /** The second class token: the sheet's one primary verb, or the destructive one. */
  variant?: KeyVariant;
};

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button({ variant, className, ...rest }, ref) {
  return <button className={keyClass(variant, className)} {...rest} ref={ref} />;
});
