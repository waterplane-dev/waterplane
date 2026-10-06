/**
 * The desktop's numbers as a person reads them (`sysStat.ts`).
 *
 * `node --test` runs this straight over the TypeScript, `backlogFilter.ts`'s
 * arrangement. What is pinned here is the set of ways this section can be
 * confidently wrong:
 *
 *  • a bar drawn past the end of the machine it describes;
 *  • a slice nobody measured drawn as a 0-byte segment, which reads as a
 *    measurement of zero rather than as an absent reader;
 *  • the caption leading with "free", which is the figure that said 1.1 GB
 *    about a desktop with 33 GB going spare and started this whole change;
 *  • a pid printed beside a fold of twenty-three processes.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  cpuSplitText, loadText, memNote, memSlices, procFoldText, rssSumText, slowAgeSec, swapText, tempText,
  uptimeText,
} from "./sysStat.ts";

const GB = 2 ** 30;
const TOTAL = 64 * GB;

const MAC = {
  appBytes: 28 * GB, wiredBytes: 4 * GB, compressedBytes: 0.7 * GB, cachedBytes: 14 * GB,
  usedBytes: 32.7 * GB, availableBytes: 31.3 * GB,
  swapUsedBytes: 8.8 * GB, swapTotalBytes: 10 * GB, source: "vm_stat",
};

test("the bar adds up to the whole machine, and ends in what is available", () => {
  const s = memSlices(MAC, TOTAL);
  assert.deepEqual(s.map((x) => x.key), ["app", "wired", "compressed", "cached", "available"]);
  const sum = s.reduce((n, x) => n + x.bytes, 0);
  assert.equal(sum, TOTAL);
  assert.ok(Math.abs(s.reduce((n, x) => n + x.pct, 0) - 100) < 0.5);
  assert.equal(s.at(-1).key, "available");
});

test("a slice nobody measured is not drawn at all", () => {
  const s = memSlices({ appBytes: 8 * GB, source: "vm_stat" }, TOTAL);
  // No wired, no compressed, no cached — absent readers, not zero-width
  // segments that read as measurements of nothing.
  assert.deepEqual(s.map((x) => x.key), ["app", "available"]);
  assert.equal(memSlices(undefined, TOTAL).length, 0);
  assert.equal(memSlices(MAC, 0).length, 0);
});

test("parts that overshoot the total are clamped, never drawn past the end", () => {
  const s = memSlices({ appBytes: 60 * GB, wiredBytes: 30 * GB, cachedBytes: 30 * GB, source: "vm_stat" }, TOTAL);
  assert.equal(s.reduce((n, x) => n + x.bytes, 0), TOTAL);
  assert.ok(s.every((x) => x.pct <= 100));
  assert.equal(s.find((x) => x.key === "available"), undefined); // nothing left over is nothing drawn
});

test("Linux gets one 'in use' slice, never macOS's vocabulary invented for it", () => {
  const s = memSlices({ usedBytes: 12 * GB, cachedBytes: 17 * GB, availableBytes: 19 * GB, source: "meminfo" }, 32 * GB);
  assert.deepEqual(s.map((x) => x.key), ["used", "cached", "available"]);
  assert.equal(s[0].bytes, 12 * GB);
});

test("the caption leads with AVAILABLE and says what free actually counts", () => {
  const note = memNote(MAC, 1.1 * GB);
  assert.match(note, /available/);
  assert.match(note, /1\.1 GB/); // the number that provoked the question is named, not hidden
  assert.match(note, /nothing has touched/);
  assert.match(memNote({ ...MAC, source: "meminfo" }, 1 * GB), /MemAvailable/);
  assert.equal(memNote(undefined, 0), null);
});

test("swap is said only where there is a swap file, with its share", () => {
  assert.match(swapText(MAC), /8\.8 GB of 10\.0 GB swap in use \(88%\)/);
  assert.equal(swapText({ source: "vm_stat" }), null);
  assert.equal(swapText({ swapTotalBytes: 0, swapUsedBytes: 0, source: "vm_stat" }), null);
});

test("the CPU sentence names its interval — 37% over 4s and over 4m are different claims", () => {
  const t = cpuSplitText({ userPct: 9.1, sysPct: 5.6, idlePct: 85.3, cores: [], spanMs: 5000 });
  assert.match(t, /15% busy over the last 5s/);
  assert.match(t, /9% running programs/);
  assert.match(t, /6% in the kernel/);
  assert.equal(cpuSplitText(undefined), null);
});

test("the load average is described against the cores, never as a percentage", () => {
  const t = loadText({ at: 0, uptimeSec: 60, loadavg: [9.8, 5.9, 5.5], cores: 16 });
  assert.match(t, /load 9\.80 · 5\.90 · 5\.50/);
  assert.match(t, /against 16 cores/);
});

test("a fold says how many processes; only a single process says a pid", () => {
  assert.equal(procFoldText({ name: "claude", rssBytes: 1, cpuPct: 1, procs: 23 }), "23 processes");
  assert.equal(procFoldText({ name: "logd", rssBytes: 1, cpuPct: 1, procs: 1, pid: 529 }), "pid 529");
});

test("the process column is explained as overlapping, not as a budget", () => {
  const t = rssSumText(88 * GB, TOTAL);
  assert.match(t, /88\.0 GB of a 64\.0 GB machine/);
  assert.match(t, /must not be added up/);
});

test("a slow reading's age is said only once it is worth saying", () => {
  assert.equal(slowAgeSec(1000, 3000), null); // 2s: noise
  assert.equal(slowAgeSec(1000, 15000), 14);
});

test("an absent temperature stays absent — no dash, no 0°C", () => {
  assert.equal(tempText(undefined), null);
  assert.equal(tempText(Number.NaN), null);
  assert.equal(tempText(61.4), "61°C");
});

test("uptime picks the biggest unit that still says something", () => {
  assert.equal(uptimeText(301639), "3d 11h");
  assert.equal(uptimeText(7300), "2h 1m");
  assert.equal(uptimeText(90), "1m");
  assert.equal(uptimeText(5), "1m");
});

// ── Disks ────────────────────────────────────────────────────────────────────
import { diskLow, diskSize, diskText, diskUsedPct } from "./sysStat.ts";

test("disk sizes switch to TB at 1000 GB and free leads the sentence", () => {
  assert.equal(diskSize(30.9 * GB), "30.9 GB");
  assert.equal(diskSize(2048 * GB), "2.00 TB");
  assert.equal(diskText({ name: "home", path: "/", holds: [], totalBytes: 460 * GB, availBytes: 29 * GB }),
    "29.0 GB free of 460.0 GB");
});

test("a disk bar never draws past the volume", () => {
  assert.equal(diskUsedPct({ name: "x", path: "/", holds: [], totalBytes: 10, availBytes: 12 }), 0);
  assert.equal(diskUsedPct({ name: "x", path: "/", holds: [], totalBytes: 10, availBytes: -5 }), 100);
  assert.equal(diskUsedPct({ name: "x", path: "/", holds: [], totalBytes: 0, availBytes: 0 }), 0);
});

test("nearly full by either measure: 10 GB on any disk, 5% on a big one", () => {
  const v = (t, a) => ({ name: "x", path: "/", holds: [], totalBytes: t * GB, availBytes: a * GB });
  assert.equal(diskLow(v(460, 30)), false);
  assert.equal(diskLow(v(460, 9)), true);
  assert.equal(diskLow(v(4000, 150)), true);   // 3.75%
  assert.equal(diskLow(v(4000, 300)), false);  // 7.5%
});
