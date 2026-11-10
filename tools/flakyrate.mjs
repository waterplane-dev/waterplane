/**
 * `node tools/flakyrate.mjs` — ONE number for the repo-health sheet (`flakyRate` in
 * `.waterplane-shared/health.json`): of the last 50 `run-e2e` runs on this desktop, the
 * percentage in which a script failed beside its siblings but passed when re-run alone.
 *
 * Source: `e2e-runs.jsonl` beside `e2e-flakes.jsonl` in the cache dir (`XDG_CACHE_HOME` or
 * `~/.cache`, then the brand slug) — one line per finished run, `{at, scripts, failed,
 * flaky}`, appended by `scripts/run-e2e.mjs`. It is machine state, not commit state, so the
 * reading is taken at HEAD only. Runs from before that line existed are not in it, and fewer
 * than MIN_RUNS lines is too few to call a rate: the reading is absent (exit 1, reason on
 * stderr), never 0. `E2E_RUNS_FILE` overrides the path (tests).
 *
 * The slug is written out, not imported: this must run without `npm run build:shared`.
 * `tools/flakyrate.test.mjs` pins it against `BRAND.slug`.
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { BRAND } from "@waterplane/shared";

export const SLUG = BRAND.slug;
export const WINDOW = 50;
export const MIN_RUNS = 10;

export function parseRuns(text) {
  const runs = [];
  for (const line of text.split("\n")) {
    try {
      const r = JSON.parse(line);
      if (r && typeof r.flaky === "number" && r.flaky >= 0) runs.push(r);
    } catch { /* a torn or foreign line */ }
  }
  return runs;
}
/** Percentage (one decimal) of the last WINDOW runs with a flake, or null when too few. */
export function flakyRate(runs) {
  const last = runs.slice(-WINDOW);
  if (last.length < MIN_RUNS) return null;
  return Math.round((last.filter((r) => r.flaky > 0).length / last.length) * 1000) / 10;
}

function main() {
  const file = process.env.E2E_RUNS_FILE || join(process.env.XDG_CACHE_HOME || join(homedir(), ".cache"), SLUG, "e2e-runs.jsonl");
  let text;
  try { text = readFileSync(file, "utf8"); } catch { console.error(`no run history yet (${file} does not exist)`); process.exit(1); }
  const runs = parseRuns(text);
  const rate = flakyRate(runs);
  if (rate === null) { console.error(`only ${runs.length} logged runs; ${MIN_RUNS} are needed for a rate`); process.exit(1); }
  console.log(rate);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
