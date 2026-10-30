/**
 * Local-day arithmetic stays in ONE module (design review 2026-10-30 W1).
 *
 * `t + n * DAY_MS` and `(b - a) / DAY_MS` are wrong on a 23 h or 25 h day. It was fixed three times one
 * site at a time (4165230b, fa6779e5, 63a174c9) and survived in each neighbour. A local day is stepped
 * with `addLocalDays` and counted with `localDaysBetween` (`packages/shared/src/calday.ts`). This test
 * reads the chart and token-stats web code as text and refuses DAY_MS / 86400000 / 864e5 next to an
 * arithmetic operator (comments stripped; string literals are NOT, so a quoted snippet is still checked) unless the line is in ALLOWED with the reason it
 * is a real millisecond duration. Known gap: an alias (`WEEK_MS = 7 * 24 * HOUR_MS`) is invisible to the
 * regex. Adding to ALLOWED is a decision, not a fix.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const DIRS = ["packages/web/src/kit/chart", "packages/extensions/token-stats/web"];
const UNIT = String.raw`(?:\bDAY_MS\b|\b86_?400_?000\b|\b864e5\b)`;
const ARITH = new RegExp(String.raw`[-+*/]\s*${UNIT}|${UNIT}\s*[-+*/%]`);

/** file (relative to repo) -> [snippet that must appear on the line, reason it is a duration] */
const ALLOWED = {
  "packages/web/src/kit/chart/chartFmt.ts": [["spanMs < 14 * 86_400_000", "a span-length threshold for label detail, not a date step"]],
  "packages/web/src/kit/chart/stats/splotUsage.ts": [
    ["6 * HOUR_MS, 12 * HOUR_MS, DAY_MS, 2 * DAY_MS, 7 * DAY_MS", "candidate tick widths in ms, matched against a ms span"],
    ["Math.round(step / DAY_MS)", "converts a chosen tick width to a whole day count; walked with setDate"],
    ["back * 7 * DAY_MS", "a rate-limit window is 168 elapsed hours long, not seven calendar days"],
    ["end - 7 * DAY_MS", "same: the window's length in elapsed time"],
  ],
  "packages/extensions/token-stats/web/usageCut.ts": [["7 * DAY_MS", "the weekly rate-limit window's length in elapsed ms"]],
};

function files(dir) {
  const out = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...files(p));
    else if (/\.tsx?$/.test(e.name) && !/\.test\./.test(e.name)) out.push(p);
  }
  return out;
}

function code(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " ")).split("\n").map((l) => l.replace(/\/\/.*$/, ""));
}

test("no DAY_MS / 86400000 arithmetic for local days in chart and token-stats web code", () => {
  const bad = [];
  for (const d of DIRS) {
    for (const f of files(join(ROOT, d))) {
      const rel = relative(ROOT, f);
      const allow = ALLOWED[rel] ?? [];
      code(readFileSync(f, "utf8")).forEach((line, i) => {
        if (!ARITH.test(line)) return;
        if (allow.some(([snip]) => line.includes(snip))) return;
        bad.push(`${rel}:${i + 1}: ${line.trim()}`);
      });
    }
  }
  assert.deepEqual(bad, [], "step local days with addLocalDays / count with localDaysBetween (shared/calday.ts), or allow-list a true ms duration with a reason");
});

test("every ALLOWED entry still matches a line (the list cannot rot)", () => {
  for (const [rel, entries] of Object.entries(ALLOWED)) {
    const lines = code(readFileSync(join(ROOT, rel), "utf8"));
    for (const [snip] of entries) assert.ok(lines.some((l) => l.includes(snip) && ARITH.test(l)), `${rel}: "${snip}" no longer present`);
  }
});
