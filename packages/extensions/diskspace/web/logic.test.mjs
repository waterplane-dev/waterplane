/**
 * The disk-space sheet's words and sums (`logic.ts`, read straight off the TypeScript): decimal
 * sizes, an unknown size never summed as 0, the delete and clean-all questions carrying the size and
 * what puts it back, and the result and large-file lines.
 *
 *     node --test packages/extensions/diskspace/web/logic.test.mjs
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { barTotals, byWeight, cleanAllAsk, codeButton, codeLine, codeParts, deleteAsk, entrySize, grouped, splitLabel, volumeBar, largeLine, resultLine, scanLine, sideLine, sizeText, total, totalText, volumeLine, wslVolumeLine } from "./logic.ts";

const ago = (ts) => `@${ts}`;
const e = (o = {}) => ({ id: "cache:0123456789abcdef", kind: "temp", group: "Gradle", label: "~/.gradle/caches", sizeKb: 4_100_000, regen: "Gradle downloads again.", ...o });

test("sizes are decimal, like Finder", () => {
  assert.equal(sizeText(342_773), "351 MB");
  assert.equal(sizeText(449_218_750), "460 GB");
  assert.equal(sizeText(4_100_000), "4.2 GB");
  assert.equal(sizeText(0), "0 B");
  assert.equal(volumeLine({ path: "/", freeKb: 342_773, totalKb: 449_218_750 }), "351 MB free of 460 GB (0%)");
  assert.equal(volumeLine(null), "Free space could not be read.");
});

test("an unknown size is said, and a total over it is a floor — never a 0 summed in", () => {
  assert.equal(entrySize({ sizeKb: null }), "size unknown");
  assert.equal(entrySize({ sizeKb: 1000, partial: true }), "at least 1.0 MB");
  const t = total([{ sizeKb: 1000 }, { sizeKb: null }, { sizeKb: 2000 }]);
  assert.deepEqual(t, { kb: 3000, unknown: 1, partial: true });
  assert.equal(totalText(t), "at least 3.1 MB (1 more of unknown size)");
  assert.equal(totalText(total([{ sizeKb: 1000 }])), "1.0 MB");
});

test("the delete question names the size, when it was measured and what puts it back", () => {
  const q = deleteAsk(e(), 5, ago);
  assert.equal(q.title, "Delete ~/.gradle/caches?");
  assert.equal(q.lines[0], "4.2 GB by the scan @5.");
  assert.ok(q.lines.includes("What puts it back: Gradle downloads again."));
  assert.match(q.lines.at(-1), /not moved to the Trash/);
  assert.equal(q.confirmLabel, "Delete 4.2 GB");
  const u = deleteAsk(e({ sizeKb: null, sizeNote: "size unknown — du did not finish within 120 s" }), 5, ago);
  assert.match(u.lines[0], /^Its size is unknown \(size unknown — du did not finish/);
  assert.equal(u.confirmLabel, "Delete");
  const o = deleteAsk(e({ id: "ollama:0123456789abcdef", group: "Ollama", label: "qwen3:30b", note: "Same ID as qwen3:latest: one copy on disk" }), 5, ago);
  assert.ok(o.lines.includes("Same ID as qwen3:latest: one copy on disk"));
  assert.match(o.lines.at(-1), /ollama rm/);
});

test("clean all lists the total and the rows", () => {
  const rows = Array.from({ length: 12 }, (_, i) => e({ id: `cache:${String(i).padStart(16, "0")}`, label: `~/c${i}`, sizeKb: 1000 }));
  rows.push(e({ id: "build:ffffffffffffffff", label: "~/dev/x/build", sizeKb: null }));
  const q = cleanAllAsk(rows);
  assert.equal(q.title, "Clean all temporary — at least 12 MB (1 more of unknown size)?");
  assert.match(q.lines[0], /^13 folders, at least 12 MB/);
  assert.ok(q.lines.includes("~/c0 — 1.0 MB"));
  assert.ok(q.lines.includes("and 3 more"));
  assert.equal(q.confirmLabel, "Delete at least 12 MB");
});

test("result, scan and large-file lines", () => {
  assert.equal(resultLine({ id: "x", label: "~/a", at: 1, ok: true, sizeKb: 4_100_000, freeDeltaKb: 3_900_000 }), "Deleted ~/a — 4.2 GB by the scan; free space rose by 4.0 GB.");
  assert.match(resultLine({ id: "x", label: "~/a", at: 1, ok: true, sizeKb: null, freeDeltaKb: 0 }), /did not rise \(a Time Machine local snapshot/);
  assert.equal(resultLine({ id: "x", label: "~/a", at: 1, ok: false, sizeKb: 1, freeDeltaKb: null, error: "is a symlink" }), "Could not delete ~/a: is a symlink");
  const base = { scanning: false, scanStartedAt: null, scan: null, large: null, deleting: [], results: [] };
  assert.equal(scanLine(base, 0, ago), "Not scanned yet.");
  assert.match(scanLine({ ...base, scanning: true, scanStartedAt: 0, scan: { at: 7 } }, 30_000, ago), /^Scanning — started 30 s ago\. The lists below are from the scan @7\.$/);
  assert.match(largeLine(null, 0, 120, ago), /stopped after 120 s/);
  assert.equal(largeLine({ at: 3, running: false, tookMs: 120_000, stoppedAfterS: 120, found: 60, items: Array(50).fill({}) }, 0, 120, ago),
    "60 files over 500 MB in 120 s, the biggest 50 listed — stopped after 120 s, so the list is partial (@3).");
  assert.match(largeLine({ at: 0, running: true, tookMs: null, stoppedAfterS: null, found: 0, items: [] }, 12_000, 120, ago), /^Searching — started 12 s ago/);
});

test("grouped keeps first-seen order", () => {
  const g = grouped([e({ group: "A" }), e({ group: "B" }), e({ group: "A" })]);
  assert.deepEqual(g.map(([k, v]) => [k, v.length]), [["A", 2], ["B", 1]]);
});

test("ollama tags sharing an ID are one copy: a total counts it once", () => {
  const t = total([{ sizeKb: 9_000_000, copy: "a" }, { sizeKb: 9_000_000, copy: "a" }, { sizeKb: 1000, copy: "b" }]);
  assert.equal(t.kb, 9_001_000);
});

test("biggest group first, biggest row first, unknown size last", () => {
  const rows = [
    e({ id: "a", group: "npm", sizeKb: 10 }),
    e({ id: "b", group: "Gradle", sizeKb: 5 }), e({ id: "c", group: "Gradle", sizeKb: null }), e({ id: "d", group: "Gradle", sizeKb: 50 }),
  ];
  assert.deepEqual(byWeight(rows).map(([g, l]) => [g, l.map((r) => r.id)]), [["Gradle", ["d", "b", "c"]], ["npm", ["a"]]]);
});

test("a path label splits at its last folder; a sentence or a tag stays whole", () => {
  assert.deepEqual(splitLabel("~/.gradle/wrapper/dists"), ["~/.gradle/wrapper/", "dists"]);
  assert.deepEqual(splitLabel("org/name"), ["org/", "name"]);
  assert.deepEqual(splitLabel("qwen3:30b"), ["", "qwen3:30b"]);
  assert.deepEqual(splitLabel("/private/tmp/claude-501 — sessions idle over a day"), ["", "/private/tmp/claude-501 — sessions idle over a day"]);
  assert.deepEqual(codeParts("`npm ci` in that folder"), [["npm ci", true], [" in that folder", false]]);
});

test("the volume bar splits the used part only when the slices fit inside it", () => {
  const v = { path: "/", freeKb: 10, totalKb: 100 };
  const b = volumeBar(v, 20, 30);
  assert.equal(b.usedPct, 90); assert.equal(b.tempPct, 20); assert.equal(b.modelPct, 30); assert.equal(b.low, false);
  const over = volumeBar(v, 60, 60);
  assert.equal(over.tempPct, 0); assert.equal(over.modelPct, 0);
  assert.equal(volumeBar({ path: "/", freeKb: 5, totalKb: 100 }, 0, 0).low, true);
  assert.equal(volumeBar(null, 0, 0), null);
});

test("wsl: the header bar's slices are only the rows on the disk the bar is (C:), never Linux-side rows", () => {
  const row = (side, kb) => ({ id: "cache:0123456789abcdef", kind: "temp", group: "g", label: "l", sizeKb: kb, regen: "r", ...(side ? { side } : {}) });
  const temp = [row("wsl", 40), row("windows", 7)], models = [row("wsl", 100), row("windows", 3)];
  assert.deepEqual(barTotals({ profile: "wsl", wslVolume: { path: "/", freeKb: 1, totalKb: 2 }, temp, models }), { tempKb: 7, modelKb: 3 });
  assert.deepEqual(barTotals({ profile: "wsl", temp, models }), { tempKb: 40, modelKb: 100 }, "no Windows drive found (field omitted): the bar is the Linux side");
  assert.deepEqual(barTotals({ profile: "wsl", wslVolume: null, temp, models }), { tempKb: 7, modelKb: 3 }, "C: found, inside reading failed: the bar is still C:");
  assert.deepEqual(barTotals({ profile: "mac", temp: [row(undefined, 5)], models: [row(undefined, 6)] }), { tempKb: 5, modelKb: 6 });
});

test("wsl: which disk a delete frees is said on the row, the question, clean all and the receipt — never that the Windows drive rose", () => {
  const base = { id: "cache:0123456789abcdef", kind: "temp", group: "Python in WSL", label: "~/.cache/pip", sizeKb: 1e6, regen: "pip downloads it again." };
  assert.match(sideLine("wsl"), /inside WSL only.*compacted/);
  assert.match(sideLine("windows"), /Windows drive directly/);
  assert.equal(sideLine(undefined), null);
  assert.ok(deleteAsk({ ...base, side: "wsl" }, 5, ago).lines.some((l) => /inside WSL only/.test(l)));
  assert.ok(!deleteAsk(base, 5, ago).lines.some((l) => /WSL/.test(l)), "a Mac row says nothing about WSL");
  assert.ok(cleanAllAsk([{ ...base, side: "wsl" }]).lines.some((l) => /compacted/.test(l)));
  assert.ok(!cleanAllAsk([base]).lines.some((l) => /compacted/.test(l)));

  const r = { id: base.id, label: base.label, at: 1, ok: true, sizeKb: 1e6, freeDeltaKb: 9e5 };
  const wsl = resultLine({ ...r, side: "wsl" });
  assert.match(wsl, /free space inside WSL rose by/);
  assert.match(wsl, /Windows gets this space back only after the WSL disk is compacted/);
  assert.doesNotMatch(wsl, /Windows drive rose/);
  assert.match(resultLine({ ...r, side: "windows" }), /free space on the Windows drive rose by/);
  assert.doesNotMatch(resultLine({ ...r, freeDeltaKb: 0 }, "linux"), /Time Machine/, "no Time Machine on Linux");
  assert.match(resultLine({ ...r, freeDeltaKb: 0 }), /Time Machine/);
  const temp = resultLine({ ...r, side: "windows", removed: 5, skipped: 2, freeDeltaKb: null });
  assert.match(temp, /5 removed, 2 in use and skipped/);
  assert.match(resultLine({ ...r, ok: false, error: "all 2 in use", removed: 0, skipped: 2 }), /Could not delete .*\(0 removed, 2 in use and skipped\)/);
});

test("wsl: the header names its disk, the second line is the WSL side, and the large-file line says what it did not search", () => {
  assert.match(volumeLine({ path: "/mnt/c", freeKb: 1e6, totalKb: 4e6, label: "C:" }), /^C: /);
  assert.doesNotMatch(volumeLine({ path: "/", freeKb: 1e6, totalKb: 4e6 }), /:/);
  assert.equal(wslVolumeLine(undefined), null);
  assert.match(wslVolumeLine(null), /could not be read/);
  assert.match(wslVolumeLine({ path: "/home", freeKb: 1e6, totalKb: 4e6, label: "inside WSL" }), /^Inside WSL: .* free of .*compacted/);
  const l = { at: 1, running: false, tookMs: 1000, stoppedAfterS: null, found: 0, items: [], note: "The Windows drive was not searched." };
  assert.match(largeLine(l, 2, 120, ago), /The Windows drive was not searched\.$/);
});

test("the code-root walk says it is still looking, why it waits for a tap on a Windows drive, and when it last looked", () => {
  const c = (o = {}) => ({ code: { root: "C:/dev", onTap: true, running: false, startedAt: null, at: null, tookMs: null, notes: [], ...o } });
  assert.equal(codeLine({}, 0, ago), null, "an older host: no line");
  assert.match(codeLine(c(), 0, ago), /^A scan does not look for build output and node_modules under C:\/dev: folders on the Windows drive are slow to read from inside WSL/);
  assert.match(codeLine(c(), 0, ago), /Tap look for them/);
  assert.equal(codeButton(c()), "look for them", "the line names the button as drawn");
  assert.match(codeLine(c({ running: true }), 0, ago), /^Looking for .* next/);
  assert.equal(codeLine(c({ running: true, startedAt: 1000 }), 61_000, ago), "Still looking for build output and node_modules under C:/dev — started 60 s ago. Everything else listed here is already measured.");
  assert.equal(codeButton(c({ running: true, startedAt: 1000 })), null, "no second start while it runs — the line says it runs");
  assert.match(codeLine(c({ at: 5, tookMs: 1_500_000 }), 0, ago), /^Looked for .* @5, took 25 min\. A scan does not repeat it .* tap look again/);
  assert.equal(codeButton(c({ at: 5 })), "look again");
  const mac = { code: { root: "~/dev", onTap: false, running: false, startedAt: null, at: 5, tookMs: 4000, notes: [] } };
  assert.equal(codeLine(mac, 0, ago), "Looked for build output and node_modules under ~/dev @5, took 4 s.");
  assert.equal(codeButton(mac), null, "on a Mac every scan walks it");
  // While the walk runs the rest is already measured, so the scan line does not say the lists are old.
  assert.equal(scanLine({ scanning: true, phase: "code", scanStartedAt: 0, scan: { at: 1 }, deleting: [], results: [], large: null }, 10, ago), null);
  assert.match(scanLine({ scanning: true, phase: "fast", scanStartedAt: 0, scan: { at: 1 }, deleting: [], results: [], large: null }, 10, ago), /from the scan @1/);
});
