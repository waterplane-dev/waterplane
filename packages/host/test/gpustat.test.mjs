/**
 * GPU stat parsing (`host.ts`'s `parseGpuIoreg`), off a real `ioreg -r -d 1 -c
 * IOAccelerator` dump. Degrades to `null` on a miss — never a 0 standing in
 * for "unreadable" (this repo's rule for every heuristic here).
 */
import { test } from "node:test";
import assert from "node:assert/strict";

const { parseGpuIoreg } = await import("../dist/host.js");

const oneAccelerator = (perf) => `
+-o AGXAcceleratorG16X  <class AGXAcceleratorG16X, id 0x100000561, registered, matched, active, busy 0 (803 ms), retain 73>
    {
      "PerformanceStatistics" = {${perf}}
      "model" = "Apple M4 Max"
    }
`;

const REAL_PERF = `"In use system memory (driver)"=0,"Alloc system memory"=53615984640,"Tiler Utilization %"=0,"Renderer Utilization %"=12,"Device Utilization %"=37,"In use system memory"=46891352064`;

test("reads utilization and system-wide memory in use off a real dump", () => {
  assert.deepEqual(parseGpuIoreg(oneAccelerator(REAL_PERF)), { pct: 37, memInUse: 46891352064 });
});

test("the driver-only memory figure is a different key and never matched", () => {
  // "In use system memory (driver)" must not satisfy the "In use system
  // memory" pattern — it is a different, much smaller number, and it is
  // printed FIRST in the real dump, right before the real key.
  const perf = `"In use system memory (driver)"=0,"Device Utilization %"=5`;
  assert.equal(parseGpuIoreg(oneAccelerator(perf)), null); // no "In use system memory" key at all here
});

test("two accelerators ⇒ null, never a composite of the wrong two devices", () => {
  // A dGPU+iGPU or Mac Pro box prints one PerformanceStatistics block per
  // device. Reading the two keys independently over the whole dump could pair
  // one device's utilization with the OTHER device's memory figure — a number
  // no device actually reports. Ambiguous ⇒ absent, same as none.
  const two = oneAccelerator(REAL_PERF) + oneAccelerator(`"Device Utilization %"=1,"In use system memory"=1024`);
  assert.equal(parseGpuIoreg(two), null);
});

test("no accelerator, empty text, or garbage ⇒ null, never a guessed 0", () => {
  for (const t of ["", "no gpu here", "{}"]) {
    assert.equal(parseGpuIoreg(t), null);
  }
});
