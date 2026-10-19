/**
 * The web client's main stylesheet as ONE text, in cascade order.
 *
 * `packages/web/src/styles.css` is an index of `@import "./styles/NN-name.css";` lines and nothing else
 * (`tools/cssshape.test.mjs`). Tests that assert something about "the CSS" read it through here, so a
 * rule moving from one slice to another never changes what they see; the order is the index's own.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const WEB_SRC = join(dirname(fileURLToPath(import.meta.url)), "..", "packages", "web", "src");
export const STYLES_INDEX = join(WEB_SRC, "styles.css");
const IMPORT = /^@import\s+"([^"]+)";\s*$/gm;

/** Absolute paths of the slices `styles.css` imports, in cascade order. */
export function cssFiles(index = STYLES_INDEX) {
  const text = readFileSync(index, "utf8");
  return [...text.matchAll(IMPORT)].map((m) => join(dirname(index), m[1]));
}

/** Every slice, concatenated in cascade order (what the browser's cascade sees as `styles.css`). */
export function readAllCss(index = STYLES_INDEX) {
  return cssFiles(index).map((f) => readFileSync(f, "utf8")).join("");
}
