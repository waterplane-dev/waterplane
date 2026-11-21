/**
 * The demo desktop's machine readings — what the strip under the status bar draws (CPU and its
 * line, GPU, memory available), as `localrt.sample` frames with no runner and no model.
 *
 * The owner's phone shows that strip on every screen; demo films without it were not the app.
 * Samples sit on a fixed 5 s grid (the real host's poll) and every value is a pure function of
 * the grid slot — no randomness, so a repaint or a second watch never moves a reading. The first watch on a desk back-fills
 * the last two minutes so the line has a shape at once; a renewal sends only the slots since.
 */
import type { LocalRuntimeSample } from "@waterplane/shared";
import type { Desk } from "./model.ts";

const STEP_MS = 5_000;
const BACKFILL = 24;
const GB = 1024 ** 3;
const MEM_TOTAL = 64 * GB;

const sentUpTo = new WeakMap<Desk, number>();

/** One reading at grid slot `k`: a CPU that breathes between ~12% and ~38%, memory near 18 GB free. */
export function machineSample(k: number): LocalRuntimeSample {
  const cpu = 25 + 9 * Math.sin(k / 3) + 4 * Math.sin(k / 1.7);
  const avail = 18.2 * GB + 0.6 * GB * Math.sin(k / 5);
  return {
    at: k * STEP_MS,
    models: [],
    reachable: false,
    cpuPct: Math.round(cpu),
    memTotal: MEM_TOTAL,
    memFree: Math.round(avail),
    gpuPct: k % 7 === 0 ? 3 : 0,
  };
}

/** The samples this desk has not sent yet, oldest first: a back-fill on the first watch. */
export function machineSamples(desk: Desk, now: number): LocalRuntimeSample[] {
  const last = Math.floor(now / STEP_MS);
  const from = Math.max(sentUpTo.get(desk) ?? -Infinity, last - BACKFILL + 1);
  sentUpTo.set(desk, last + 1);
  const out: LocalRuntimeSample[] = [];
  for (let k = from; k <= last; k++) out.push(machineSample(k));
  return out;
}
