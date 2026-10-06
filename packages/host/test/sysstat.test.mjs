/**
 * The desktop's own numbers (`sysstat.ts`), over real dumps taken from the
 * machine this feature was written on.
 *
 * Every assertion here is a way the readout can be plausibly and wrongly right:
 * a page size assumed rather than read (4× out on half the fleet), a swap
 * suffix ignored (1024× out), a CPU delta taken off cumulative counters as if
 * they were rates, and a process table that reads twenty-three `claude`
 * processes as twenty-three programs.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

const {
  cpuBusyFrom, firstNumber, parseMemInfo, parsePsTable, parseSmcJson, parseSwapUsage, parseVmStat,
} = await import("../dist/sysstat.js");

// A real `vm_stat` head from an Apple Silicon desktop (16 KiB pages).
const VM_STAT = `Mach Virtual Memory Statistics: (page size of 16384 bytes)
Pages free:                                  1046636.
Pages active:                                1391204.
Pages inactive:                              1297154.
Pages speculative:                            105978.
Pages throttled:                                   0.
Pages wired down:                             268737.
Pages purgeable:                               46737.
"Translation faults":                     4875997065.
Pages copy-on-write:                       607559897.
Pages zero filled:                        4453198745.
Pages reactivated:                          19817124.
Pages purged:                                5981720.
File-backed pages:                            920933.
Anonymous pages:                            1873403.
Pages stored in compressor:                   976414.
Pages occupied by compressor:                  46544.
`;

const GB = 2 ** 30;
const MEM_TOTAL = 68719476736; // 64 GiB

test("vm_stat: the page size is READ, never assumed", () => {
  const m = parseVmStat(VM_STAT, MEM_TOTAL);
  // 1,873,403 anonymous - 46,737 purgeable = 1,826,666 pages at 16 KiB.
  assert.equal(m.appBytes, (1873403 - 46737) * 16384);
  // 27.9 GiB. The same dump read as 4 KiB pages would say 7.0 GiB.
  assert.ok(m.appBytes / GB > 27 && m.appBytes / GB < 29);
  // A dump whose header says 4096 must produce a quarter of the bytes — proof
  // the number comes out of the header and is not a constant in this file.
  const intel = parseVmStat(VM_STAT.replace("16384 bytes", "4096 bytes"), MEM_TOTAL);
  assert.equal(intel.appBytes, m.appBytes / 4);
});

test("vm_stat: used is app + wired + what the compressor OCCUPIES", () => {
  const m = parseVmStat(VM_STAT, MEM_TOTAL);
  assert.equal(m.usedBytes, m.appBytes + m.wiredBytes + m.compressedBytes);
  // NOT "Pages stored in compressor" (976,414) — that is the volume it is
  // holding, and counting it as used would count the compressor's win as a cost.
  assert.equal(m.compressedBytes, 46544 * 16384);
  assert.equal(m.availableBytes, MEM_TOTAL - m.usedBytes);
  // The point of the whole section: ~33 GB available on a machine whose
  // `os.freemem()` reads 17 GB, and read 1.1 GB when this was written.
  assert.ok(m.availableBytes / GB > 30);
});

test("vm_stat: availability is clamped, never negative", () => {
  const m = parseVmStat(VM_STAT, 1 * GB); // a total smaller than the parts, as two counters can momentarily disagree
  assert.equal(m.availableBytes, 0);
});

test("vm_stat: a dump missing the keys is null, never a zeroed breakdown", () => {
  assert.equal(parseVmStat("Mach Virtual Memory Statistics: (page size of 16384 bytes)\n", MEM_TOTAL), null);
  assert.equal(parseVmStat(VM_STAT.replace(/page size of \d+ bytes/, "page size of ? bytes"), MEM_TOTAL), null);
});

test("swap: the unit suffix is read — G is not M", () => {
  const real = parseSwapUsage("vm.swapusage: total = 10240.00M  used = 8990.75M  free = 1249.25M  (encrypted)");
  assert.equal(real.total, Math.round(10240 * 2 ** 20));
  assert.equal(real.used, Math.round(8990.75 * 2 ** 20));
  const big = parseSwapUsage("total = 2.00G  used = 0.50G  free = 1.50G");
  assert.equal(big.total, 2 * GB);
  assert.equal(parseSwapUsage("nothing here"), null);
});

test("meminfo: MemAvailable is the kernel's own estimate and is not re-derived", () => {
  const m = parseMemInfo([
    "MemTotal:       32827180 kB",
    "MemFree:          311924 kB",
    "MemAvailable:   19004108 kB",
    "Buffers:          182364 kB",
    "Cached:         18122100 kB",
    "SwapTotal:       2097148 kB",
    "SwapFree:        1048576 kB",
  ].join("\n"));
  assert.equal(m.source, "meminfo");
  assert.equal(m.availableBytes, 19004108 * 1024);
  assert.equal(m.usedBytes, (32827180 - 19004108) * 1024);
  assert.equal(m.cachedBytes, (18122100 + 182364) * 1024);
  assert.equal(m.swapUsedBytes, (2097148 - 1048576) * 1024);
  // Linux has no app/wired/compressed split, and none is invented for it.
  assert.equal(m.appBytes, undefined);
  assert.equal(m.wiredBytes, undefined);
  assert.equal(m.compressedBytes, undefined);
});

test("ps: rows are folded BY PROGRAM, and a fold keeps no pid", () => {
  const table = [
    "    1  24960   0.3 /sbin/launchd",
    " 8123 4194304  12.5 /opt/homebrew/bin/claude",
    " 8124 4194304  18.2 /opt/homebrew/bin/claude",
    "  529  71504   0.5 /usr/libexec/logd",
  ].join("\n");
  const { byMem, byCpu, count, rssSumBytes } = parsePsTable(table);
  assert.equal(count, 4);
  assert.equal(byMem[0].name, "claude");
  assert.equal(byMem[0].procs, 2);
  assert.equal(byMem[0].rssBytes, 2 * 4194304 * 1024);
  assert.equal(byMem[0].cpuPct, 30.7);
  // A pid printed beside a fold of two would name whichever one `ps` happened
  // to print first.
  assert.equal(byMem[0].pid, undefined);
  assert.equal(byMem.find((r) => r.name === "logd").pid, 529);
  // The path is not the name — `comm` is a full path on macOS.
  assert.ok(byMem.every((r) => !r.name.includes("/")));
  assert.equal(byCpu[0].name, "claude");
  assert.equal(rssSumBytes, (24960 + 4194304 + 4194304 + 71504) * 1024);
});

test("ps: junk lines are skipped, not counted", () => {
  const { count } = parsePsTable("   1  24960   0.3 /sbin/launchd\nps: some warning\n\n");
  assert.equal(count, 1);
});

test("ps: the cap applies per list", () => {
  const rows = Array.from({ length: 20 }, (_, i) => `  ${i + 1}  ${(i + 1) * 100}   ${i}.0 prog${i}`).join("\n");
  const { byMem, byCpu, cap } = parsePsTable(rows, 3);
  assert.equal(cap, 3);
  assert.equal(byMem.length, 3);
  assert.equal(byCpu.length, 3);
  assert.equal(byMem[0].name, "prog19");
});

test("cpu: a delta over cumulative ticks, with nice and irq in a bucket", () => {
  const a = [{ user: 100, nice: 0, sys: 50, idle: 850, irq: 0 }];
  const b = [{ user: 200, nice: 50, sys: 100, idle: 1050, irq: 50 }];
  const c = cpuBusyFrom(a, b, 4000);
  // 150 user (100 + 50 nice), 100 sys (50 + 50 irq), 200 idle, 450 total.
  assert.equal(c.userPct, 33.3);
  assert.equal(c.sysPct, 22.2);
  assert.equal(c.idlePct, 44.4);
  assert.deepEqual(c.cores, [56]);
  assert.equal(c.spanMs, 4000);
});

test("cpu: no pair, no interval, a resize or a counter reset ⇒ null, never zeroes", () => {
  const a = [{ user: 100, nice: 0, sys: 50, idle: 850, irq: 0 }];
  assert.equal(cpuBusyFrom([], a, 1000), null);
  assert.equal(cpuBusyFrom(a, a.concat(a), 1000), null); // core count changed
  assert.equal(cpuBusyFrom(a, a, 1000), null); // no ticks elapsed at all
  assert.equal(cpuBusyFrom(a, [{ user: 0, nice: 0, sys: 0, idle: 0, irq: 0 }], 1000), null); // went backwards
  assert.equal(cpuBusyFrom(a, [{ user: 200, nice: 0, sys: 50, idle: 850, irq: 0 }], 0), null);
});

test("a sensor helper's output is read for its numbers, not its format", () => {
  assert.equal(firstNumber("56.2"), 56.2);
  assert.equal(firstNumber("CPU: 56.2°C\n"), 56.2);
  assert.equal(firstNumber("no reading"), null);
});

test("WATERPLANE_SMC_BIN: fields are absent, never zeroed, and junk is null", () => {
  const t = parseSmcJson('{"cpuTempC":61.5,"fanRpm":[1200,0,2400]}');
  assert.equal(t.cpuTempC, 61.5);
  assert.equal(t.gpuTempC, undefined);
  // A fan reading 0 is a STOPPED fan, which is a measurement — dropping it
  // would turn "the fans are off because the machine is cool" into silence.
  assert.deepEqual(t.fans.map((f) => f.rpm), [1200, 0, 2400]);
  assert.equal(parseSmcJson("not json"), null);
  assert.equal(parseSmcJson("{}"), null); // nothing readable ⇒ the note stands
});

// ── Disks ────────────────────────────────────────────────────────────────────
// Home, the code root and the state dir are usually ONE volume: three rows
// saying the same 30 GB free is the fold this exists to make.
const { foldDisks, parseProcMounts } = await import("../dist/sysstat.js");

test("disks fold by device, ours first, holds merged in order", () => {
  const G = 2 ** 30;
  const rows = foldDisks([
    { path: "/Users/a", name: "home", holds: "home (~)", dev: 1, totalBytes: 460 * G, availBytes: 29 * G },
    { path: "/Users/a/dev", name: "repos", holds: "repos (~/dev)", dev: 1, totalBytes: 460 * G, availBytes: 29 * G },
    { path: "/Volumes/Big", name: "Big", holds: null, dev: 2, totalBytes: 2000 * G, availBytes: 900 * G },
    { path: "/Volumes/EFI", name: "EFI", holds: null, dev: 3, totalBytes: 0.2 * G, availBytes: 0.1 * G },
    { path: "/proc", name: "/proc", holds: null, dev: 4, totalBytes: 0, availBytes: 0 },
  ]);
  assert.deepEqual(rows.map((r) => r.name), ["home", "Big"]);
  assert.deepEqual(rows[0].holds, ["home (~)", "repos (~/dev)"]);
  assert.deepEqual(rows[1].holds, []);
});

test("available is clamped to the volume, never past it", () => {
  const [r] = foldDisks([{ path: "/", name: "/", holds: "home (~)", dev: 1, totalBytes: 10, availBytes: 12 }]);
  assert.equal(r.availBytes, 10);
});

test("/proc/mounts keeps real block devices and unescapes spaces", () => {
  const text = [
    "/dev/nvme0n1p2 / ext4 rw,relatime 0 0",
    "proc /proc proc rw 0 0",
    "/dev/loop3 /snap/core/1 squashfs ro 0 0",
    "/dev/sdb1 /mnt/My\\040Disk ext4 rw 0 0",
  ].join("\n");
  assert.deepEqual(parseProcMounts(text), ["/", "/mnt/My Disk"]);
});
