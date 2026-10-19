/**
 * The 800-line EARLY WARNING shared by the shape tests: files that are still under their hard cap but
 * long enough that the next feature should split them rather than grow them. It only PRINTS — a warning
 * that can fail is just a lower cap. `hostshape` and `webshape` call `warnLongFiles` at the top level.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

export const WARN_LINES = 800;

const lines = (text) => text.split("\n").length - (text.endsWith("\n") ? 1 : 0);

/** Source files (not tests, not build output) under `dir` longer than `over` lines, longest first. */
export function longFiles(dir, over = WARN_LINES) {
  const out = [];
  const walk = (d) => {
    for (const name of readdirSync(d)) {
      if (name === "node_modules" || name === "dist" || name.startsWith(".")) continue;
      const p = join(d, name);
      if (statSync(p).isDirectory()) { walk(p); continue; }
      if (!/\.(m?[jt]sx?|css)$/.test(name) || /\.test\./.test(name)) continue;
      const n = lines(readFileSync(p, "utf8"));
      if (n > over) out.push({ rel: relative(dir, p), n });
    }
  };
  walk(dir);
  return out.sort((a, b) => b.n - a.n);
}

/** Print the early warning for `dir`; never throws on a long file. */
export function warnLongFiles(label, dir, over = WARN_LINES) {
  const files = longFiles(dir, over);
  if (!files.length) return files;
  console.log(`# EARLY WARNING (${label}): ${files.length} file(s) over ${over} lines — split before they grow:`);
  for (const f of files) console.log(`#   ${f.n}  ${f.rel}`);
  return files;
}
