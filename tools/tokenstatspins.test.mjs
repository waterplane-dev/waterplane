/**
 * Pins for moving the token statistics screen (docs/notes/token-stats-architecture.md).
 *
 * The screen is 3268 lines that are about to be cut into files and moved into an extension. A
 * copy-then-delete move can DUPLICATE a site, and some of what it holds is ORDER: a hook list is
 * behaviour (LimitWindows' mount-once re-scrape, TokenStatsBody's week-seeding effect). Everything
 * here is read as TEXT over `packages/web/src` and every extension's `web/` folder, and is
 * FILE-AGNOSTIC where it can be — a function is found by name wherever it lives, so the same
 * assertions hold before the move, after each cut, and after the last. Moving a pinned site edits
 * the map in the same commit.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname;
const SRC = join(ROOT, "packages", "web", "src");
const EXT = join(ROOT, "packages", "extensions");

function walk(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { recursive: true })
    .filter((f) => /\.(ts|tsx)$/.test(f) && !/node_modules/.test(f))
    .map((f) => join(dir, f));
}
const extWeb = existsSync(EXT)
  ? readdirSync(EXT, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => join(EXT, e.name, "web"))
  : [];
const FILES = [...walk(SRC), ...extWeb.flatMap(walk)]
  .filter((f) => !/\.test\./.test(f))
  .map((f) => ({ rel: relative(ROOT, f).replace(/^packages\//, ""), text: readFileSync(f, "utf8") }));

/** count of a literal substring per file, only files with a non-zero count. */
function counts(needle) {
  const out = {};
  for (const f of FILES) {
    const n = f.text.split(needle).length - 1;
    if (n) out[f.rel] = n;
  }
  return out;
}

// ── P1: where a usage re-scrape is sent ──────────────────────────────────────
test("P1: `usage.refresh` is sent from exactly these sites", () => {
  assert.deepEqual(counts('t: "usage.refresh"'), {
    "web/src/App.tsx": 1,
    "web/src/sdk/ledgers.ts": 2,
  });
});

// ── P2: the four host reads and the phone's own caches ───────────────────────
test("P2: each ledger read is made once, and the caches are touched only by sdk/ledgers and offlineCache", () => {
  for (const call of ["api.tokenStats(", "api.usageLog(", "api.tokenWindows("]) {
    assert.deepEqual(counts(call), { "web/src/sdk/ledgers.ts": 1 }, call);
  }
  const READ_SITE = {
    "ledgers.tokenStats.read(": "TokenStatsSheet.tsx",
    // A contributed ledger view's document (`LedgerViewDef`), one `GuestRead` per view.
    "ledgers.viewDoc(": "TokenStatsSheet.tsx",
    "ledgers.usageLog(": "LimitWindows.tsx",
    "ledgers.tokenWindows(": "TokenStatsBody.tsx",
  };
  // Outside the screen: the week-share calibration (features/tokens) folds ONE
  // cell per `/usage` reading so a turn's cost can read as a share of the week.
  const ALSO = { "ledgers.tokenWindows(": { "web/src/features/tokens/actions.ts": 1 } };
  for (const [call, file] of Object.entries(READ_SITE)) {
    assert.deepEqual(counts(call), { [`extensions/token-stats/web/${file}`]: 1, ...ALSO[call] }, call);
  }
  const cache = {};
  for (const f of FILES) {
    const n = [...f.text.matchAll(/\b(getTokenStatsAt|putTokenStats|getLedgerDocAt|putLedgerDoc)\b/g)].length;
    if (n) cache[f.rel] = n;
  }
  assert.deepEqual(Object.keys(cache).sort(), ["web/src/offlineCache.ts", "web/src/sdk/ledgers.ts"]);
});

// ── P3: hook order of the three stateful components ──────────────────────────
/** The hook calls of `function <name>(`, in source order, wherever it is defined. */
function hooksOf(name) {
  const hits = FILES.filter((f) => new RegExp(`^(export )?function ${name}\\b`, "m").test(f.text));
  assert.equal(hits.length, 1, `${name} must be defined in exactly one file, found ${hits.map((h) => h.rel)}`);
  const lines = hits[0].text.split("\n");
  const i = lines.findIndex((l) => new RegExp(`^(export )?function ${name}\\b`).test(l));
  let j = i + 1;
  while (j < lines.length && lines[j] !== "}") j++;
  const body = lines.slice(i, j + 1).join("\n").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  return { text: body, hooks: [...body.matchAll(/\b(use[A-Z]\w*)\s*(?:<(?:[^<>]|<[^<>]*>)*>)?\(/g)].map((m) => m[1]) };
}

/** Measured on HEAD 88b155a (comments stripped; a generic `useX<T>(` counts). */
const HOOKS = {
  TokenStatsSheet: [
    // 2026-10-04: the second ledger's read moved into `GuestRead` (one per contributed view); its
    // answers lift into `reads`, and `onRead` is the stable setter handed to each.
    "useState", "useRemoteResource", "useState", "useState",
  ],
  GuestRead: [
    "useRemoteResource", "useEffect",
  ],
  LimitWindows: [
    "useEffect", "useRemoteResource",
  ],
  TokenStatsBody: [
    // Local-model split: the first useState + useMemo are `allModels` and the
    // Anthropic-only cut (`localSplit.ts`), ahead of everything that reads `doc`.
    "useState", "useMemo",
    // WP6: the fourth useState is the generic backend-ledger tab (`extraId`).
    // 2026-10-02: the useRemoteResource after it is the local runner's ledger (`/api/localusage`),
    // read beside `extraId` because whether its tab exists depends on the answer.
    "useState", "useState", "useState", "useRemoteResource", "useState", "useCallback", "useState", "useState", "useState", "useState",
    "useState", "useState", "useState", "useBoxWidth", "useMemo", "useEffect", "useMemo", "useMemo",
    "useMemo", "useMemo", "useMemo", "useMemo", "useMemo", "useMemo", "useMemo", "useMemo", "useMemo",
    "useMemo", "useMemo", "useMemo", "useMemo", "useMemo", "useMemo", "useRemoteResource", "useMemo",
    "useMemo", "useMemo",
  ],
};

test("P3: TokenStatsSheet, LimitWindows and TokenStatsBody call their hooks in the HEAD order", () => {
  for (const [name, want] of Object.entries(HOOKS)) assert.deepEqual(hooksOf(name).hooks, want, name);
});

test("P3: LimitWindows' re-scrape effect stays mount-once", () => {
  assert.match(hooksOf("LimitWindows").text, /onRefresh\(true\);[\s\S]*?\}, \[\]\);/);
});

// ── P4: resource keys ────────────────────────────────────────────────────────
test("P4: each resource key is written once across the viewer", () => {
  for (const key of [
    "`tokenstats:${fresh}`",
    "`ledgerview:${def.id}:${fresh}`",
    "`usagelog:${usage?.checkedAt ?? 0}`",
    "`tokenwindows:${",
  ]) {
    const c = counts(key);
    assert.equal(Object.values(c).reduce((a, b) => a + b, 0), 1, `${key}: ${JSON.stringify(c)}`);
  }
});

// ── P5: the wrapper and the door ─────────────────────────────────────────────
test("P5: the explain action is tracked once, the sheet closes itself twice, App still reads the usage store", () => {
  const sum = (c) => Object.values(c).reduce((a, b) => a + b, 0);
  assert.equal(sum(counts('"action:tokens.explainCost"')), 1);
  assert.equal(sum(counts('nav.close("tokens")')), 2);
  assert.match(FILES.find((f) => f.rel === "web/src/App.tsx").text, /\buseUsage\(\)/);
  const routing = readFileSync(join(SRC, "routing.ts"), "utf8");
  const persisted = /export const PERSISTED_OVERLAYS[^[]*\[([^\]]*)\]/.exec(routing)?.[1] ?? "";
  assert.match(persisted, /"tokens"/);
});
