import { forwardRef, type InputHTMLAttributes } from "react";

/** The `class="search"` text input. Extra classes go in `className` ("grow", "mono"). */
export const SearchBox = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(
  function SearchBox({ className, ...rest }, ref) {
    return <input ref={ref} className={className ? `search ${className}` : "search"} {...rest} />;
  },
);
