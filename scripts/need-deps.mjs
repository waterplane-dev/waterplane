// Every build starts here (`npm run build:shared`). On a fresh clone without `npm ci`, the
// first thing to fail is the shell looking for `tsc` — "'tsc' is not recognized…" on
// Windows, "tsc: command not found" elsewhere, localized either way — which names neither
// the cause nor the fix. Say both.
import { existsSync } from "node:fs";

if (!existsSync("node_modules/typescript/package.json")) {
  console.error("[need-deps] dependencies are not installed — run `npm ci`, then run this again.");
  process.exit(1);
}
