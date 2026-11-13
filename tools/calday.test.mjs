/**
 * Local-day arithmetic stays in ONE module (design review 2026-10-30 W1).
 *
 * `t + n * DAY_MS` and `(b - a) / DAY_MS` are wrong on a 23 h or 25 h day. It was fixed three times one
 * site at a time (4165230b, fa6779e5, 63a174c9) and survived in each neighbour, and the first ratchet
 * (784ecb1e) covered only the chart and token-stats code, so 39 more sites stayed unguarded until the
 * widening that added this scope. A local day is stepped with `addLocalDays`, counted with
 * `localDaysBetween` and recurred with `nextLocalOccurrence` (`packages/shared/src/calday.ts`).
 *
 * SCOPE: every .ts/.tsx/.mts/.mjs file under `packages/` (vscode `webview`, vault `cli`, app scripts and any
 * future directory included, so a new folder cannot be a hole) — read as text from the git-tracked files (so another
 * session's untracked work is not judged; outside a git checkout it walks the directories instead).
 * Tests, `dist`, `node_modules` and `calday.ts` itself are out. DAY_MS / 86400000 / 864e5 next to an
 * arithmetic operator is refused, and so is a product of literal factors that makes whole days
 * (`24 * 60 * 60 * 1000`, `24 * 3600e3`, `7 * 24 * HOUR_MS`, `1000 * 60 * 60 * 24`; `HOUR_MS`/`MIN_MS` count as factors,
 * a variable factor is ignored) wherever it stands, a bare constant definition included (comments stripped; string literals are NOT, so a quoted snippet is
 * still checked) unless the line is in ALLOWED with the reason it is not local-day stepping: a real
 * elapsed duration (TTL, age threshold, a 168 h rate window, a span length, ms -> display rounding), or
 * UTC-day maths on UTC keys ("UTC days have 24 h").
 *
 * PRIVATE EXTENSIONS: the public snapshot omits some (deploy/public-allowlist.txt), and a test that read
 * them broke two releases (dc12d52f). So an ALLOWED entry for a file that is ABSENT is skipped, never a
 * failure; one whose file IS present but whose snippet is gone is a stale allowance and still fails.
 * An extension's own allowances live in `packages/extensions/<id>/calday-allow.json` (same shape, keys inside
 * that folder) and are merged below: a public file never names a private extension (tools/publictree.test.mjs).
 * Known gap: an alias is only seen where it is DEFINED (`WEEK_MS = 7 * 24 * HOUR_MS` is flagged and allow-listed as an
 * elapsed window, so `t + WEEK_MS` elsewhere is invisible), and a factor held in a variable or a parenthesis
 * (`(24 * 60) * 60 * 1000`) is not multiplied out. Adding to ALLOWED is a decision, not a fix.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const UNIT = String.raw`(?:\bDAY_MS\b|\b86_?400_?000\b|\b864e5\b)`;
const ARITH = new RegExp(String.raw`[-+*/]\s*${UNIT}|${UNIT}\s*[-+*/%]`);

/**
 * A `*` chain of literals / known unit names whose product is a whole number of days (>= 1 d, two or more known factors).
 * Unknown identifiers in the chain (`n * 24 * 3600 * 1000`) are skipped; a chain right after `/` is a quotient, not a product.
 */
const OPERAND = String.raw`(?:[A-Za-z_$][\w$.]*|\d[\d_]*(?:\.\d+)?(?:e\d+)?)`;
const CHAIN = new RegExp(String.raw`(?<![\w$.)\]/]\s*/\s*)(?<![\w$.)\]])${OPERAND}(?:\s*\*\s*${OPERAND})+`, "g");
const UNIT_MS = { HOUR_MS: 3.6e6, HOUR: 3.6e6, MINUTE_MS: 6e4, MIN_MS: 6e4, SECOND_MS: 1e3, SEC_MS: 1e3 };
function dayProduct(line) {
  for (const m of line.matchAll(CHAIN)) {
    let product = 1, known = 0;
    for (const raw of m[0].split("*")) {
      const o = raw.trim();
      if (/^\d/.test(o)) { product *= Number(o.replace(/_/g, "")); known++; } else if (o in UNIT_MS) { product *= UNIT_MS[o]; known++; }
    }
    if (known >= 2 && product >= 86_400_000 && product % 86_400_000 === 0) return true;
  }
  return false;
}
const flagged = (line) => ARITH.test(line) || dayProduct(line);

/** Source this ratchet reads: everything tracked under packages/ (src, webview, cli, helper scripts, each extension's halves) minus OUT. */
const SCOPE = [/^packages\//];
const EXT = /\.(?:tsx?|mts|mjs)$/;
const OUT = /(?:^|\/)(?:node_modules|dist|test|tests|fixtures)\/|\.test\.|^packages\/shared\/src\/calday\.ts$/;
const inScope = (rel) => rel.startsWith("packages/") && EXT.test(rel) && !OUT.test(rel) && SCOPE.some((re) => re.test(rel));

/** file (relative to repo) -> [snippet that must appear on the line, reason it is a duration] */
const ALLOWED = {
  "packages/web/src/kit/chart/chartFmt.ts": [["spanMs < 14 * 86_400_000", "a span-length threshold for label detail, not a date step"]],
  "packages/web/src/kit/chart/stats/splotUsage.ts": [
    ["6 * HOUR_MS, 12 * HOUR_MS, DAY_MS, 2 * DAY_MS, 7 * DAY_MS", "candidate tick widths in ms, matched against a ms span"],
    ["Math.round(step / DAY_MS)", "converts a chosen tick width to a whole day count; walked with setDate"],
    ["back * 7 * DAY_MS", "a rate-limit window is 168 elapsed hours long, not seven calendar days"],
    ["end - 7 * DAY_MS", "same: the window's length in elapsed time"],
  ],
  "packages/host/src/agentclass.ts": [["base - i * 7 * 86_400_000", "UTC days have 24 h: Monday-UTC week keys, printed with toISOString"]],
  "packages/host/src/pricefetch.ts": [
    ["const DAY_MS = 24 * 3_600_000;", "elapsed age of a price read and of unpriced tokens, never a calendar step"],
    ["PRICE_GAP_RECENT_MS = 7 * DAY_MS", "a week of elapsed time before old unpriced tokens stop asking"],
    ["PRICE_STALE_MS = 7 * DAY_MS", "a read over a week of elapsed time old is called stale"],
  ],
  "packages/host/src/doctor.ts": [["Math.floor((expiry - Date.now()) / 86_400_000)", "certificate validity left, elapsed"]],
  "packages/host/src/lantls.ts": [
    ["VALID_DAYS * DAY_MS", "certificate validity is an elapsed span"],
    ["RENEW_DAYS * DAY_MS", "certificate renewal threshold, elapsed"],
  ],
  "packages/host/src/peers/routes.ts": [["to - from > 8 * 86_400_000", "a span-length limit on a requested range"]],
  "packages/shared/src/exposure.ts": [
    ["Math.round(ms / DAY_MS)", "ms -> display rounding of an elapsed age"],
    ["2 * DAY_MS", "a staleness threshold, elapsed"],
  ],
  "packages/shared/src/healthindex/readings.ts": [["t - dow * 86_400_000", "UTC days have 24 h: t is a UTC midnight and the result is printed with toISOString"]],
  "packages/shared/src/healthindex/score.ts": [["/ DAY_MS", "UTC days have 24 h: both ends are `YYYY-MM-DDT00:00:00Z`"]],
  "packages/shared/src/healthindex/vs.ts": [
    ["weeks * 7 * DAY_MS", "UTC days have 24 h: week keys parsed as UTC midnights"],
    ["(nowT - t) / (7 * DAY_MS)", "UTC days have 24 h: week keys parsed as UTC midnights"],
  ],
  "packages/shared/src/sweep.ts": [
    ['"7d": 7 * 86_400_000', "file-age cut-offs, elapsed"],
    ['"30d": 30 * 86_400_000', "file-age cut-offs, elapsed"],
    ['"90d": 90 * 86_400_000', "file-age cut-offs, elapsed"],
    ['"365d": 365 * 86_400_000', "file-age cut-offs, elapsed"],
  ],
  "packages/vscode/src/data/summary.ts": [["HEADLINE_DAYS * 86_400_000", "how stale a scan may be, elapsed"]],
  "packages/web/src/features/tokens/logic.ts": [["WEEK_MS = 7 * 86_400_000", "the weekly rate-limit window: 168 elapsed hours"]],
  "packages/web/src/healthAskPrompts.ts": [["(b - a) / (7 * 86_400_000)", "weeks between two health-index readings (UTC week keys / elapsed), rounded"]],
  "packages/web/src/periodWords.ts": [
    ["READ_MAX_MS = 35 * DAY_MS", "the longest reading to trust, an elapsed span"],
    ["lenMs: 30 * DAY_MS", "a rolling 30-day billing window is 720 elapsed hours"],
  ],
  "packages/web/src/sessionTabs.ts": [["SHARED_OPENS_TTL_MS = 30 * 86_400_000", "a TTL, elapsed"]],
  "packages/web/src/updateSnooze.ts": [
    ["Math.round(ms / 86_400_000)", "ms -> display rounding of an elapsed snooze length"],
    ["ms >= 2 * 86_400_000", "plural for the same elapsed snooze length"],
    ['ms: 24 * 60 * 60 * 1000, label: "1d"', "a snooze option's length, elapsed"],
    ["ms < 24 * 60 * 60 * 1000", "hours-vs-days display cut-off for an elapsed snooze length"],
  ],
  // Literal-factor spellings (24 * 60 * 60 * 1000 and kin): every one below is an elapsed duration, TTL, retention age or window length.
  "packages/host/src/auth.ts": [["TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000", "a token TTL, elapsed"]],
  "packages/host/src/autopull.ts": [
    ["MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000", "an age threshold, elapsed"],
    ["CATCHUP_AGE_MS = 24 * 60 * 60 * 1000", "an age threshold, elapsed"],
  ],
  "packages/host/src/burnwatch.ts": [["CAL_LOOKBACK_MS = 8 * 24 * HOUR", "a lookback span over weekly rate-limit windows, elapsed"]],
  "packages/host/src/healthwatch.ts": [["HEALTH_REFRESH_MS = 7 * 24 * 60 * 60_000", "a refresh interval, elapsed"]],
  "packages/host/src/intents/clock.ts": [["return plain - 24 * 60 * 60_000", "the search floor is widened by one turn of the clock (<= a day of elapsed time) only to make an occurrence visible; intentVerdict does the zone arithmetic"]],
  "packages/host/src/launchfiles.ts": [["LAUNCH_DIR_MAX_AGE_MS = 7 * 24 * 3600_000", "a directory age threshold, elapsed"]],
  "packages/host/src/peers/jobs.ts": [["KEEP_CLOSED_MS = 30 * 24 * 3600_000", "a retention age, elapsed"]],
  "packages/host/src/peers/serve.ts": [["PEER_WORKTREE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000", "a worktree age threshold, elapsed"]],
  "packages/host/src/prs.ts": [["let askedMs = 24 * 3600_000", "a lookback span in elapsed ms"]],
  "packages/host/src/push.ts": [["PUSH_KEY_REFUSAL_SPAN_MS = 24 * 60 * 60_000", "a span over which refusals are counted, elapsed"]],
  "packages/host/src/routes/apistats.ts": [["COST_WINDOW_MAX_MS = 35 * 24 * 3_600_000", "a span-length limit on a requested range"]],
  "packages/host/src/sessionbudget.ts": [
    ["WEEK_WINDOW_MS = 7 * 24 * 3_600_000", "the weekly rate-limit window: 168 elapsed hours"],
    ['"h" ? 3_600_000 : 24 * 3_600_000', "parses a typed '1d' budget window into an elapsed span"],
  ],
  "packages/host/src/sessions/knobs.ts": [
    ["LIMIT_GIVEUP_MS", "a give-up age after a limit hit, elapsed"],
    ["ORPHAN_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000", "an age threshold, elapsed"],
  ],
  "packages/host/src/updates/checker.ts": [["CHECK_EVERY_MS = 24 * 3_600_000", "a polling interval, elapsed"]],
  "packages/host/src/usagelog.ts": [["USAGELOG_RETAIN_MS", "a retention age, elapsed"]],
  "packages/host/src/usagesources.ts": [["KEPT_UNNAMED_MAX_MS = 24 * 3_600_000", "an age threshold, elapsed"]],
  "packages/host/src/weekburn.ts": [["SAMPLES_LOOKBACK_MS = WEEKBURN_MEASURE_MS + 24 * 3_600_000", "a lookback span of elapsed time"]],
  "packages/shared/src/clihealth/healthcatalog.ts": [["forgetMs: 30 * 24 * 3600_000", "how long a signal is remembered, elapsed"]],
  "packages/shared/src/clihealth/healththresholds.ts": [["SIGNAL_FORGET_MS = 24 * 3600_000", "how long a signal is remembered, elapsed"]],
  "packages/shared/src/intent/row.ts": [["HELD_MAX_MS = 24 * 60 * 60_000", "a hold cap, elapsed"]],
  "packages/shared/src/pad.ts": [["PAD_TOMB_TTL_MS = 30 * 24 * 60 * 60 * 1000", "a tombstone TTL, elapsed"]],
  "packages/shared/src/weekburn.ts": [
    ["WEEKBURN_MEASURE_MS = 14 * 24 * HOUR", "a measuring span over rate-limit windows, elapsed"],
    ["WEEKBURN_FALLBACK_LEAD_MS = 24 * HOUR", "a lead time before a window reset, elapsed"],
    ["WEEKBURN_NUDGE_LEAD_MS = 24 * HOUR", "a lead time before a window reset, elapsed"],
  ],
  "packages/vscode/src/data/sessionlist.ts": [["WINDOW_MS = 24 * 60 * 60_000", "a recency window, elapsed"]],
  "packages/vscode/src/statusbar.ts": [["AGE_IN_TEXT_MS = 24 * 3_600_000", "an age threshold for display, elapsed"]],
  "packages/web/src/CliHealthSheet.tsx": [["REARM_RECENT_MS = 24 * 3600_000", "an age threshold, elapsed"]],
  "packages/web/src/core/Banners.tsx": [
    ["INSECURE_SNOOZE_MS = 7 * 24 * 60 * 60 * 1000", "a snooze length, elapsed"],
    ["SETUP_SNOOZE_MS = 7 * 24 * 60 * 60 * 1000", "a snooze length, elapsed"],
  ],
  "packages/web/src/core/launcher/closeModel.ts": [['"1d": 24 * 3600e3', "close-by-age cut-offs, elapsed"]],
  "packages/web/src/demo/host/demohttp.ts": [["to - from <= 35 * 24 * 3_600_000", "a span-length limit on a requested range"]],
  "packages/web/src/demo/host/ledger.ts": [
    ["WEEK_MS = 7 * 24 * HOUR", "demo ledger: the weekly rate-limit window, 168 elapsed hours"],
    ["RETAIN_MS = LEDGER_DAYS * 24 * HOUR", "demo ledger: a retention span, elapsed"],
  ],
  "packages/web/src/demo/scenarios/first-look.ts": [["const DAY = 24 * HOUR", "demo fixture: offsets for fake timestamps"]],
  "packages/web/src/demo/scenarios/garden.ts": [["const DAY = 24 * HOUR", "demo fixture: offsets for fake timestamps"]],
  "packages/web/src/gitCounts.ts": [["BEHIND_STALE_MS = 24 * 60 * 60_000", "a staleness threshold, elapsed"]],
  "packages/web/src/link/linkDoc.ts": [["WINDOW_MAX_MS = 24 * 60 * 60_000", "a span-length limit, elapsed"]],
  "packages/web/src/pull/pullConsts.ts": [["KEEP_DONE_MS = 7 * 24 * 60 * 60 * 1000", "a retention age, elapsed"]],
  "packages/web/src/resumeRoute.ts": [["RESUME_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000", "an age threshold, elapsed"]],
  "packages/web/src/scheduleWeekPlot.ts": [["WEEK_MS = 7 * 24 * 3600e3", "the weekly rate-limit window: 168 elapsed hours"]],
  "packages/web/src/stow.ts": [["STOW_KEEP_MS = 7 * 24 * 3600_000", "a retention age, elapsed"]],
};

// Each extension's allowances, from its own folder: present only where the extension is.
const EXT_DIR = join(ROOT, "packages/extensions");
for (const id of existsSync(EXT_DIR) ? readdirSync(EXT_DIR) : []) {
  const f = join(EXT_DIR, id, "calday-allow.json");
  if (!existsSync(f)) continue;
  for (const [rel, entries] of Object.entries(JSON.parse(readFileSync(f, "utf8")))) {
    assert.ok(rel.startsWith(`packages/extensions/${id}/`), `${f}: ${rel} is outside its own extension`);
    ALLOWED[rel] = entries;
  }
}

/** Tracked files under packages/ (so an untracked file of another session is not judged); a plain walk outside a checkout. */
function sourceFiles() {
  try {
    return execFileSync("git", ["ls-files", "-z", "--", "packages"], { cwd: ROOT, encoding: "utf8", maxBuffer: 64 << 20 })
      .split("\0").filter((f) => f && inScope(f) && existsSync(join(ROOT, f)));
  } catch {
    const out = [];
    const walk = (rel) => {
      for (const e of readdirSync(join(ROOT, rel), { withFileTypes: true })) {
        const r = `${rel}/${e.name}`;
        if (e.isDirectory()) { if (e.name !== "node_modules" && e.name !== "dist") walk(r); } else if (inScope(r)) out.push(r);
      }
    };
    walk("packages");
    return out;
  }
}

function code(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " ")).split("\n").map((l) => l.replace(/\/\/.*$/, ""));
}

test("no DAY_MS / 86400000 arithmetic for local days anywhere in package source", () => {
  const bad = [];
  for (const rel of sourceFiles()) {
    const allow = ALLOWED[rel] ?? [];
    code(readFileSync(join(ROOT, rel), "utf8")).forEach((line, i) => {
      if (!flagged(line)) return;
      if (allow.some(([snip]) => line.includes(snip))) return;
      bad.push(`${rel}:${i + 1}: ${line.trim()}`);
    });
  }
  assert.deepEqual(bad, [], "step local days with addLocalDays / count with localDaysBetween / recur with nextLocalOccurrence (shared/calday.ts), or allow-list a true ms duration or UTC-day step with a reason");
});

test("every ALLOWED entry whose file is present still matches a line (the list cannot rot)", () => {
  for (const [rel, entries] of Object.entries(ALLOWED)) {
    if (!existsSync(join(ROOT, rel))) continue; // a private extension the public snapshot omits
    const lines = code(readFileSync(join(ROOT, rel), "utf8"));
    for (const [snip] of entries) assert.ok(lines.some((l) => l.includes(snip) && flagged(l)), `${rel}: "${snip}" no longer present`);
  }
});

test("the detector sees day steps written as literal factors, and not other products", () => {
  for (const line of [
    "export const f = (t) => t + 24 * 60 * 60 * 1000;",
    "t - 24*3600*1000",
    "t + 1000 * 60 * 60 * 24",
    "t + n * 24 * 3600e3",
    "t + 3 * 24 * HOUR_MS",
    "const x = 60 * 60_000 * 24;",
  ]) assert.ok(flagged(line), line);
  for (const line of [
    "const h = 60 * 60 * 1000;",
    "const x = 5 * 60_000;",
    "const s = 24 * 60 * 60; // seconds",
    "const q = ms / 1000 * 60 * 60 * 24;",
    "const w = 4 * HOUR_MS;",
  ]) assert.ok(!flagged(line), line);
});
