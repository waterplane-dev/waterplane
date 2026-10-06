/**
 * **The machine, the way `top` would have told you** — the half of the
 * local-runtime readout that is not about models at all.
 *
 * ── Why this exists ─────────────────────────────────────────────────────────
 *
 * The runner sheet said "memory free 1.1 GB of 64.0 GB" on a desktop holding NO
 * local model, and had nothing to say about who had the other 62.9 GB. Both
 * halves of that were bad: `os.freemem()` on macOS counts untouched pages only,
 * so a healthy Mac with a warm file cache reports nearly nothing free for ever
 * — and the question it provokes ("held by WHAT?") was unanswerable anywhere in
 * this app. `cpuPct` had the same shape of problem: it is the one-minute load
 * average over the core count, which is a QUEUE LENGTH, not utilization, and
 * reads well past 100% on a busy build.
 *
 * So this reads the four things somebody standing at the desktop would have
 * looked at: the CPU split, where the memory actually went, which programs are
 * holding it, and how hot the box is running.
 *
 * ── What is measured, and what is deliberately absent ───────────────────────
 *
 * Measured: `os.cpus()` tick deltas (pure node, no subprocess), `vm_stat` +
 * `sysctl vm.swapusage` on macOS, `/proc/meminfo` on Linux, `ps -Ao` for the
 * process table, `/sys/class/thermal` + `/sys/class/hwmon` for Linux sensors,
 * `statfs` per volume for the disks (home, the code root, the state dir, then
 * `/Volumes/*` or `/proc/mounts`), folded by device.
 *
 * **Temperature and fan speed on macOS are ABSENT by default, and that is not
 * an oversight.** Measured on this desktop: `powermetrics` is the only Apple
 * tool that reads the SMC and it answers `powermetrics must be invoked as the
 * superuser`; `--samplers smc` does not even exist on Apple Silicon. A daemon
 * whose whole job is spawning `claude` has no business prompting for a root
 * password, and `sudo -n` in a poll loop is a password prompt waiting to
 * happen on a machine where the timestamp has expired. So the reading is absent
 * with a SENTENCE naming the two small helpers that would fill it in
 * (`smctemp`, `istats`) and the `WATERPLANE_SMC_BIN` escape hatch — this repo's rule
 * is that a heuristic degrades to absent, and the corollary nobody writes down
 * is that an absence a person cannot explain reads as a bug in the app.
 *
 * ── Cost of the poll itself ─────────────────────────────────────────────────
 *
 * This runs inside `localrt.ts`'s 5 s watch, in the process that pumps every
 * PTY, so the two expensive readers are on a SLOWER cadence of their own
 * (`WATERPLANE_SYSSTAT_SLOW_MS`, 15 s) and cached in between: a full `ps -A` measured
 * 31 ms over 793 processes here, and a thermal helper is another subprocess.
 * The cached rows carry their OWN timestamp so the phone can say how old they
 * are rather than presenting a 14-second-old table as current.
 */
import os from "node:os";
import { lstat, readFile, readdir, stat, statfs } from "node:fs/promises";
import type {
  CpuBusy, DiskSnapshot, DiskVolume, FanRow, MemBreakdown, ProcRow, ProcSnapshot, SysStat, Thermal,
} from "@waterplane/shared";
import { ROOT, env } from "./env.js";
import { BRAND, envName } from "@waterplane/shared";
import { hostStateDir } from "./branddirs.js";
import { execFileP as pexecFile } from "./proc.js";

/** How many rows each process list carries. Enough to answer "who has my
 *  memory" — the tail of a 793-process table is noise, and every row is bytes
 *  on a tunnel this app spends its life apologising for. */
export const PROC_CAP = 8;

/** How often the expensive readers (the process table, the thermal helper) may
 *  actually run, against the 5 s poll that asks for them. Floored for
 *  `localRtPollMs`'s reason: a hand-edited `1` turns a readout into a load
 *  generator, and this one spawns `ps -A`. */
const SLOW_FLOOR_MS = 5_000;
export function sysStatSlowMs(): number {
  const n = Number(env("SYSSTAT_SLOW_MS"));
  return Number.isFinite(n) && n > 0 ? Math.max(SLOW_FLOOR_MS, n) : 15_000;
}

/** The process table names every program running on the desktop, which is more
 *  than some people want on a phone screen. Off ⇒ the section says it was
 *  switched off, never that nothing is running. */
export const procListEnabled = (): boolean => env("SYSSTAT_PROCS") !== "0";

// ────────────────────────────────────────────────────────────────────────────
// CPU — a delta, so the first reading of a watch has none
// ────────────────────────────────────────────────────────────────────────────

/** One core's cumulative tick counts, as `os.cpus()` reports them. */
export interface CoreTicks { user: number; nice: number; sys: number; idle: number; irq: number }

/**
 * The CPU split between two cumulative readings.
 *
 * Pure, and exported, because this is the one number on the screen that is
 * easy to compute plausibly and wrongly: ticks are CUMULATIVE since boot, so
 * subtracting the wrong pair, or folding `nice` and `irq` into neither bucket,
 * produces a figure that looks reasonable and is not utilization.
 *
 * Returns null — never zeroes — when the pair cannot be a delta: a different
 * core count (a VM resized, or the arrays simply disagree), no elapsed ticks at
 * all (two reads inside one tick period), or a counter that went backwards.
 */
export function cpuBusyFrom(
  prev: readonly CoreTicks[], next: readonly CoreTicks[], spanMs: number,
): CpuBusy | null {
  if (!prev.length || prev.length !== next.length || !(spanMs > 0)) return null;
  let user = 0, sys = 0, idle = 0, total = 0;
  const cores: number[] = [];
  for (let i = 0; i < next.length; i++) {
    const a = prev[i], b = next[i];
    // `nice` is user time and `irq` is system time — they belong in a bucket,
    // not dropped, or a machine running a `nice`d build reads as idle.
    const du = (b.user - a.user) + (b.nice - a.nice);
    const ds = (b.sys - a.sys) + (b.irq - a.irq);
    const di = b.idle - a.idle;
    if (du < 0 || ds < 0 || di < 0) return null; // a counter reset; a delta here would be enormous
    const dt = du + ds + di;
    if (dt <= 0) { cores.push(0); continue; }
    user += du; sys += ds; idle += di; total += dt;
    cores.push(Math.round(((du + ds) / dt) * 100));
  }
  if (total <= 0) return null;
  const pct = (n: number) => Math.round((n / total) * 1000) / 10;
  return { userPct: pct(user), sysPct: pct(sys), idlePct: pct(idle), cores, spanMs: Math.round(spanMs) };
}

/** What `os.cpus()` said last time, so the next call has something to subtract
 *  from. Module-level for `clihealth.ts`'s reason — the alternative is
 *  threading a sampler object through every call site to hold two numbers. */
let prevTicks: { at: number; cores: CoreTicks[] } | null = null;

function readCpuBusy(now: number): CpuBusy | null {
  const cores = os.cpus().map((c) => ({ ...c.times }));
  const prev = prevTicks;
  prevTicks = { at: now, cores };
  if (!prev) return null; // the FIRST reading of a process has no interval to describe
  return cpuBusyFrom(prev.cores, cores, now - prev.at);
}

// ────────────────────────────────────────────────────────────────────────────
// Memory — two operating systems that describe it differently
// ────────────────────────────────────────────────────────────────────────────

/**
 * Parse `vm_stat`'s text dump into the Activity Monitor split.
 *
 * Exported so the arithmetic is pinned with no Mac, `parseGpuIoreg`'s reason.
 *
 * The page size is read from the HEADER, never assumed: it is 4096 on Intel and
 * 16384 on Apple Silicon, and hard-coding either turns every figure here into a
 * number that is wrong by 4× on half the fleet.
 *
 * `usedBytes` follows Activity Monitor: app (anonymous minus purgeable) + wired
 * + what the compressor OCCUPIES. Not what is STORED in the compressor — that
 * is the bigger number, and counting it as used would be counting the
 * compressor's win as a cost.
 */
export function parseVmStat(text: string, memTotal: number): MemBreakdown | null {
  const page = /page size of (\d+) bytes/.exec(text);
  if (!page) return null;
  const sz = Number(page[1]);
  if (!Number.isFinite(sz) || sz <= 0) return null;
  const pages = (label: string): number | null => {
    const m = new RegExp(`^${label}:\\s+(\\d+)\\.?\\s*$`, "m").exec(text);
    return m ? Number(m[1]) : null;
  };
  const anon = pages("Anonymous pages");
  const purgeable = pages("Pages purgeable");
  const wired = pages("Pages wired down");
  const comp = pages("Pages occupied by compressor");
  const fileBacked = pages("File-backed pages");
  if (anon == null || wired == null || comp == null) return null;
  const app = Math.max(0, anon - (purgeable ?? 0)) * sz;
  const wiredBytes = wired * sz;
  const compressedBytes = comp * sz;
  const usedBytes = app + wiredBytes + compressedBytes;
  return {
    appBytes: app,
    wiredBytes,
    compressedBytes,
    ...(fileBacked == null ? {} : { cachedBytes: fileBacked * sz }),
    usedBytes,
    // Clamped at zero rather than allowed to go negative: the two figures come
    // from different syscalls taken microseconds apart, and a "-0.1 GB
    // available" is a rendering bug in the making, not a fact.
    availableBytes: Math.max(0, memTotal - usedBytes),
    source: "vm_stat",
  };
}

/** Parse `sysctl -n vm.swapusage`: `total = 10240.00M  used = 8990.75M  free = …`.
 *  The suffix is the unit and is read, never assumed — a machine with a 2 G
 *  swap file prints `G`, and reading that as megabytes understates it 1024×. */
export function parseSwapUsage(text: string): { used: number; total: number } | null {
  const num = (label: string): number | null => {
    const m = new RegExp(`${label}\\s*=\\s*([\\d.]+)([KMGT])`, "i").exec(text);
    if (!m) return null;
    const mult = { k: 2 ** 10, m: 2 ** 20, g: 2 ** 30, t: 2 ** 40 }[m[2].toLowerCase()] ?? 1;
    const n = Number(m[1]);
    return Number.isFinite(n) ? Math.round(n * mult) : null;
  };
  const total = num("total"), used = num("used");
  return total == null || used == null ? null : { used, total };
}

/**
 * Parse `/proc/meminfo`.
 *
 * Linux has no app/wired/compressed split worth inventing, so those fields stay
 * ABSENT and the phone words the caption off `source`. What it does have is
 * `MemAvailable`, which is the kernel's own estimate of what a new program
 * could get — a better number than anything derivable here, and the reason this
 * reader does not try to reconstruct macOS's vocabulary.
 */
export function parseMemInfo(text: string): MemBreakdown | null {
  const kb = (label: string): number | null => {
    const m = new RegExp(`^${label}:\\s+(\\d+) kB`, "m").exec(text);
    return m ? Number(m[1]) * 1024 : null;
  };
  const total = kb("MemTotal");
  if (total == null) return null;
  const avail = kb("MemAvailable");
  const cached = kb("Cached"), buffers = kb("Buffers");
  const swapTotal = kb("SwapTotal"), swapFree = kb("SwapFree");
  return {
    ...(cached == null ? {} : { cachedBytes: cached + (buffers ?? 0) }),
    ...(avail == null ? {} : { usedBytes: Math.max(0, total - avail), availableBytes: avail }),
    ...(swapTotal == null || swapFree == null ? {} : {
      swapUsedBytes: Math.max(0, swapTotal - swapFree), swapTotalBytes: swapTotal,
    }),
    source: "meminfo",
  };
}

async function readMem(memTotal: number): Promise<MemBreakdown | null> {
  if (process.platform === "darwin") {
    const [vm, swap] = await Promise.all([
      pexecFile("vm_stat", [], { timeout: 1500 }).then((r) => r.stdout).catch(() => null),
      // Its own catch: a swap figure is worth having without the breakdown and
      // vice versa, and one failing reader must not blank the other.
      pexecFile("sysctl", ["-n", "vm.swapusage"], { timeout: 1500 }).then((r) => r.stdout).catch(() => null),
    ]);
    const base = vm ? parseVmStat(vm, memTotal) : null;
    const sw = swap ? parseSwapUsage(swap) : null;
    if (!base) return sw ? { source: "vm_stat", swapUsedBytes: sw.used, swapTotalBytes: sw.total } : null;
    return sw ? { ...base, swapUsedBytes: sw.used, swapTotalBytes: sw.total } : base;
  }
  if (process.platform === "linux") {
    const text = await readFile("/proc/meminfo", "utf8").catch(() => null);
    return text ? parseMemInfo(text) : null;
  }
  return null;
}

/** The memory reader alone — for the local runner's ledger (`localusage.ts`),
 *  which samples the machine only while a model is resident and has no use
 *  for the process table or the thermals. Never throws; null = no reader. */
export function sampleMemory(): Promise<MemBreakdown | null> {
  return readMem(os.totalmem()).catch(() => null);
}

// ────────────────────────────────────────────────────────────────────────────
// The process table
// ────────────────────────────────────────────────────────────────────────────

/**
 * Parse `ps -Ao pid=,rss=,pcpu=,comm=` and FOLD BY PROGRAM.
 *
 * Grouping is the feature, not a tidy-up: the honest answer to "what is holding
 * 30 GB" on a desktop is usually one browser wearing twelve renderer processes,
 * and twelve identical rows say that badly while pushing everything else off a
 * phone screen. `procs` carries the count; `pid` survives only where the fold
 * is a single process, because a pid printed beside a fold of twelve names
 * whichever one `ps` happened to print first.
 *
 * `comm` is a PATH on macOS and a short name on Linux, so the name is the
 * basename either way. RSS is in KiB (`ps` reports KiB on both platforms) and
 * **counts shared pages once per process** — `rssSumBytes` in the snapshot
 * exists so the phone can say that rather than let somebody total the column.
 */
export function parsePsTable(text: string, cap = PROC_CAP): Omit<ProcSnapshot, "at"> {
  const byName = new Map<string, ProcRow>();
  let count = 0;
  let rssSumBytes = 0;
  for (const line of text.split("\n")) {
    const m = /^\s*(\d+)\s+(\d+)\s+([\d.]+)\s+(.+?)\s*$/.exec(line);
    if (!m) continue;
    const pid = Number(m[1]);
    const rss = Number(m[2]) * 1024;
    const cpu = Number(m[3]);
    const raw = m[4];
    if (!Number.isFinite(rss) || !Number.isFinite(cpu)) continue;
    const name = raw.slice(raw.lastIndexOf("/") + 1) || raw;
    count++;
    rssSumBytes += rss;
    const row = byName.get(name);
    if (row) {
      row.rssBytes += rss;
      row.cpuPct = Math.round((row.cpuPct + cpu) * 10) / 10;
      row.procs++;
      delete row.pid; // no longer one process, so no pid can stand for it
    } else {
      byName.set(name, { name, rssBytes: rss, cpuPct: Math.round(cpu * 10) / 10, procs: 1, pid });
    }
  }
  const rows = [...byName.values()];
  const top = (key: "rssBytes" | "cpuPct") =>
    [...rows].sort((a, b) => b[key] - a[key] || b.rssBytes - a.rssBytes).slice(0, cap);
  return { byMem: top("rssBytes"), byCpu: top("cpuPct"), count, rssSumBytes, cap };
}

async function readProcs(): Promise<{ snap: ProcSnapshot } | { note: string }> {
  if (!procListEnabled()) {
    return { note: `The process list is switched off on this desktop (${envName("SYSSTAT_PROCS")}=0).` };
  }
  if (process.platform === "win32") {
    return { note: `No process reader for ${process.platform} — this one reads \`ps\`.` };
  }
  try {
    const { stdout } = await pexecFile("ps", ["-Ao", "pid=,rss=,pcpu=,comm="],
      { timeout: 4000, maxBuffer: 8 * 1024 * 1024 });
    const parsed = parsePsTable(stdout);
    if (!parsed.count) return { note: "`ps` answered, and nothing could be read out of it." };
    return { snap: { at: Date.now(), ...parsed } };
  } catch (e) {
    // The runner's own words, `evictLocalModel`'s rule: there is no richer
    // vocabulary for "why" than what the OS already said.
    return { note: `The process list could not be read: ${e instanceof Error ? e.message : String(e)}` };
  }
}

// ────────────────────────────────────────────────────────────────────────────
// Temperature and fans
// ────────────────────────────────────────────────────────────────────────────

/**
 * The sentence a macOS desktop gets instead of a temperature.
 *
 * Exported and pinned because it is the whole feature on this platform: an
 * empty row with no explanation reads as a broken app, and this repo's rule
 * that a reading degrades to absent only works when the absence is legible.
 */
export const MAC_THERMAL_NOTE =
  "macOS keeps the SMC sensors behind root — `powermetrics` refuses to run without sudo, and a " +
  "daemon that spawns your CLI should not be asking for a password. Install `smctemp` or `istats` " +
  `(or point ${envName("SMC_BIN")} at a command that prints {"cpuTempC":…,"fanRpm":[…]}) and this fills in.`;

/** Parse the first finite number out of a helper's stdout. Deliberately
 *  shape-agnostic: `smctemp` and `istats` each print a bare figure, sometimes
 *  with a unit and sometimes not, and a strict format would be this app
 *  asserting something about a third-party tool's output it cannot keep true. */
export function firstNumber(text: string): number | null {
  const m = /-?\d+(?:\.\d+)?/.exec(text);
  if (!m) return null;
  const n = Number(m[0]);
  return Number.isFinite(n) ? n : null;
}

/** Every finite number in a helper's stdout, for a fan list. */
export function allNumbers(text: string): number[] {
  return [...text.matchAll(/-?\d+(?:\.\d+)?/g)].map((m) => Number(m[0])).filter((n) => Number.isFinite(n));
}

/**
 * Parse whatever `WATERPLANE_SMC_BIN` printed. JSON, because the escape hatch is for
 * somebody wiring up their own sensor and a named shape is the only thing this
 * can validate. Any missing field is absent, never zero; a body that is not
 * JSON at all answers null and the note stands.
 */
export function parseSmcJson(text: string): Omit<Thermal, "at" | "source"> | null {
  let body: unknown;
  try { body = JSON.parse(text); } catch { return null; }
  const o = body as { cpuTempC?: unknown; gpuTempC?: unknown; fanRpm?: unknown; fans?: unknown };
  if (!o || typeof o !== "object") return null;
  const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
  const fans: FanRow[] = [];
  if (Array.isArray(o.fanRpm)) {
    o.fanRpm.forEach((v, i) => {
      const n = num(v);
      if (n != null) fans.push({ label: `fan ${i + 1}`, rpm: Math.round(n) });
    });
  }
  if (Array.isArray(o.fans)) {
    for (const f of o.fans as { label?: unknown; rpm?: unknown }[]) {
      const n = num(f?.rpm);
      if (n != null) fans.push({ label: typeof f?.label === "string" && f.label ? f.label : `fan ${fans.length + 1}`, rpm: Math.round(n) });
    }
  }
  const cpu = num(o.cpuTempC), gpu = num(o.gpuTempC);
  if (cpu == null && gpu == null && !fans.length) return null;
  return { ...(cpu == null ? {} : { cpuTempC: cpu }), ...(gpu == null ? {} : { gpuTempC: gpu }), fans };
}

/** Linux's sensors, straight out of sysfs — no subprocess, no helper to
 *  install. `temp` is millidegrees; a zone with no `type` is still a reading
 *  and gets a generic label rather than being dropped. */
async function readLinuxThermal(): Promise<Thermal | null> {
  const zones = await readdir("/sys/class/thermal").catch(() => null);
  const fans: FanRow[] = [];
  // A box prints one zone per component and the phone has room for a number,
  // not a table of twelve. A zone that NAMES itself as the processor wins; with
  // none, the hottest zone is the honest stand-in for "how hot is it in there".
  let named: number | undefined;
  let hottest: number | undefined;
  for (const z of zones ?? []) {
    if (!z.startsWith("thermal_zone")) continue;
    const raw = await readFile(`/sys/class/thermal/${z}/temp`, "utf8").catch(() => null);
    const n = raw == null ? null : firstNumber(raw);
    if (n == null) continue;
    const c = Math.round((n / 1000) * 10) / 10;
    const type = (await readFile(`/sys/class/thermal/${z}/type`, "utf8").catch(() => ""))?.trim();
    if (/cpu|pkg|x86|soc/i.test(type ?? "") && (named == null || c > named)) named = c;
    if (hottest == null || c > hottest) hottest = c;
  }
  const cpuTempC = named ?? hottest;
  const hwmons = await readdir("/sys/class/hwmon").catch(() => null);
  for (const h of hwmons ?? []) {
    const files = await readdir(`/sys/class/hwmon/${h}`).catch(() => null);
    for (const f of files ?? []) {
      if (!/^fan\d+_input$/.test(f)) continue;
      const raw = await readFile(`/sys/class/hwmon/${h}/${f}`, "utf8").catch(() => null);
      const rpm = raw == null ? null : firstNumber(raw);
      if (rpm == null || rpm <= 0) continue;
      const label = (await readFile(`/sys/class/hwmon/${h}/${f.replace("_input", "_label")}`, "utf8").catch(() => ""))?.trim();
      fans.push({ label: label || f.replace("_input", ""), rpm: Math.round(rpm) });
    }
  }
  if (cpuTempC == null && !fans.length) return null;
  return { at: Date.now(), ...(cpuTempC == null ? {} : { cpuTempC }), fans, source: "sysfs" };
}

/** Helpers that are NOT there stay not there — a spawn per poll for a binary
 *  nobody installed is a subprocess this readout would pay for ever. Memoized
 *  INCLUDING the failure, `ocdb.ts`'s rule for its driver. */
const helperMissing = new Set<string>();

async function runHelper(bin: string, args: string[]): Promise<string | null> {
  if (helperMissing.has(bin)) return null;
  try {
    const { stdout } = await pexecFile(bin, args, { timeout: 3000 });
    return stdout;
  } catch (e) {
    if ((e as { code?: string }).code === "ENOENT") helperMissing.add(bin);
    return null;
  }
}

async function readMacThermal(): Promise<Thermal | null> {
  const custom = env("SMC_BIN");
  if (custom) {
    const out = await runHelper(custom, []);
    const parsed = out == null ? null : parseSmcJson(out);
    if (parsed) return { at: Date.now(), ...parsed, source: custom };
  }
  // `smctemp` first: it is the one that still reads Apple Silicon's sensors.
  // Flags are asked one at a time on purpose — a failure of the fan read must
  // not cost the temperature, which is the reading people actually want.
  const cpu = firstNumberOrNull(await runHelper("smctemp", ["-c"]));
  const gpu = firstNumberOrNull(await runHelper("smctemp", ["-g"]));
  const fanOut = await runHelper("smctemp", ["-f"]);
  if (cpu != null || gpu != null) {
    const fans = (fanOut ? allNumbers(fanOut) : []).filter((n) => n > 0)
      .map((rpm, i) => ({ label: `fan ${i + 1}`, rpm: Math.round(rpm) }));
    return { at: Date.now(), ...(cpu == null ? {} : { cpuTempC: cpu }), ...(gpu == null ? {} : { gpuTempC: gpu }), fans, source: "smctemp" };
  }
  const icpu = firstNumberOrNull(await runHelper("istats", ["cpu", "temp", "--value-only"]));
  if (icpu != null) {
    const ifan = await runHelper("istats", ["fan", "speed", "--value-only"]);
    const fans = (ifan ? allNumbers(ifan) : []).filter((n) => n > 0)
      .map((rpm, i) => ({ label: `fan ${i + 1}`, rpm: Math.round(rpm) }));
    return { at: Date.now(), cpuTempC: icpu, fans, source: "istats" };
  }
  return null;
}

function firstNumberOrNull(text: string | null): number | null {
  return text == null ? null : firstNumber(text);
}

async function readThermal(): Promise<{ thermal: Thermal } | { note: string }> {
  if (process.platform === "linux") {
    const t = await readLinuxThermal();
    return t ? { thermal: t } : { note: "Nothing under /sys/class/thermal or /sys/class/hwmon on this host — a VM, or a kernel with no sensor drivers loaded." };
  }
  if (process.platform === "darwin") {
    const t = await readMacThermal();
    return t ? { thermal: t } : { note: MAC_THERMAL_NOTE };
  }
  return { note: `No temperature reader for ${process.platform}.` };
}

// ────────────────────────────────────────────────────────────────────────────
// Disks
// ────────────────────────────────────────────────────────────────────────────

/** One `statfs` answer, before folding. `dev` is `stat().dev` of the path —
 *  the one key that says two folders are on the same volume. */
export interface DiskProbe {
  path: string;
  name: string;
  /** What of this app's lives at `path`, in words; null for a bare mount. */
  holds: string | null;
  dev: number;
  totalBytes: number;
  availBytes: number;
}

/** Below this a volume with nothing of ours on it is a boot/EFI/recovery
 *  partition, not a disk anybody is asking about. */
const DISK_MIN_BYTES = 2 ** 30;
export const DISK_CAP = 8;

/**
 * Probes folded into rows: ONE row per device, its `holds` merged in probe
 * order, the volumes that hold something of ours first (in that order), then
 * the rest biggest first. A volume holding none of ours under 1 GiB is dropped.
 * A probe with no size (a pseudo filesystem) is dropped, never a 0-byte disk.
 */
export function foldDisks(probes: DiskProbe[], cap = DISK_CAP): DiskVolume[] {
  const byDev = new Map<number, DiskVolume>();
  for (const p of probes) {
    if (!(p.totalBytes > 0) || !Number.isFinite(p.availBytes)) continue;
    const row = byDev.get(p.dev);
    if (row) {
      if (p.holds && !row.holds.includes(p.holds)) row.holds.push(p.holds);
      continue;
    }
    byDev.set(p.dev, {
      name: p.name, path: p.path, holds: p.holds ? [p.holds] : [],
      totalBytes: p.totalBytes, availBytes: Math.max(0, Math.min(p.availBytes, p.totalBytes)),
    });
  }
  const rows = [...byDev.values()];
  const ours = rows.filter((r) => r.holds.length > 0);
  const rest = rows.filter((r) => r.holds.length === 0 && r.totalBytes >= DISK_MIN_BYTES)
    .sort((a, b) => b.totalBytes - a.totalBytes);
  return [...ours, ...rest].slice(0, cap);
}

/** `/proc/mounts` → the mount points of real block devices. Octal escapes
 *  (`\040` for a space) undone; snaps (squashfs loop mounts) left out. */
export function parseProcMounts(text: string): string[] {
  const out: string[] = [];
  for (const line of text.split("\n")) {
    const [src, mnt, fstype] = line.split(" ");
    if (!src?.startsWith("/dev/") || !mnt || fstype === "squashfs") continue;
    if (src.startsWith("/dev/loop")) continue;
    out.push(mnt.replace(/\\([0-7]{3})/g, (_, o: string) => String.fromCharCode(parseInt(o, 8))));
  }
  return out;
}

/** Paths whose `statfs` did not answer in time — a dead network mount.
 *  Never asked again this process: a libuv thread is already stuck on it. */
const diskHung = new Set<string>();
const DISK_TIMEOUT_MS = 2000;

async function probeDisk(path: string, name: string, holds: string | null): Promise<DiskProbe | null> {
  if (diskHung.has(path)) return null;
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<"hung">((res) => { timer = setTimeout(() => res("hung"), DISK_TIMEOUT_MS); });
  try {
    const read = Promise.all([statfs(path), stat(path)]);
    const r = await Promise.race([read, timeout]);
    if (r === "hung") { diskHung.add(path); read.catch(() => {}); return null; }
    const [fs, st] = r;
    return { path, name, holds, dev: Number(st.dev),
      totalBytes: fs.blocks * fs.bsize, availBytes: fs.bavail * fs.bsize };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

const tilde = (p: string, home: string) => (p === home ? "~" : p.startsWith(home + "/") ? "~" + p.slice(home.length) : p);

async function readDisks(): Promise<{ disks: DiskSnapshot } | { note: string }> {
  if (process.platform === "win32") return { note: `No disk reader for ${process.platform}.` };
  const home = os.homedir();
  const state = hostStateDir(ROOT);
  const ask: Array<Promise<DiskProbe | null>> = [
    probeDisk(home, "home", `home (${tilde(home, home)})`),
    probeDisk(ROOT, "repos", `repos (${tilde(ROOT, home)})`),
    probeDisk(state, `${BRAND.name} state`, `${BRAND.name} state (${tilde(state, home)})`),
  ];
  if (process.platform === "darwin") {
    // `/` is the sealed system snapshot on APFS; the volumes a person would
    // name are home's and whatever is mounted under /Volumes. The boot
    // volume's own entry there is a symlink to `/`, and is skipped.
    for (const n of (await readdir("/Volumes").catch(() => [] as string[]))) {
      if (n.startsWith(".") || n.startsWith("com.apple.")) continue;
      const p = `/Volumes/${n}`;
      const l = await lstat(p).catch(() => null);
      if (!l || l.isSymbolicLink() || !l.isDirectory()) continue;
      ask.push(probeDisk(p, n, null));
    }
  } else {
    ask.push(probeDisk("/", "/", null));
    const mounts = parseProcMounts(await readFile("/proc/mounts", "utf8").catch(() => ""));
    for (const m of mounts) if (m !== "/") ask.push(probeDisk(m, m, null));
  }
  const volumes = foldDisks((await Promise.all(ask)).filter((p): p is DiskProbe => p != null));
  return volumes.length
    ? { disks: { at: Date.now(), volumes } }
    : { note: "No volume answered `statfs` on this desktop." };
}

// ────────────────────────────────────────────────────────────────────────────
// The sample
// ────────────────────────────────────────────────────────────────────────────

/** The slow readers' last answers, reused until their cadence comes round.
 *  Cached WITH their own timestamps (inside the shapes), so a repeat is
 *  visibly a repeat rather than a fresh-looking stale row. */
let slow: {
  at: number;
  procs: { snap: ProcSnapshot } | { note: string };
  thermal: { thermal: Thermal } | { note: string };
  disks: { disks: DiskSnapshot } | { note: string };
} | null = null;

/**
 * One sample of the machine.
 *
 * Every section is independent and every failure is an ABSENT field (or, where
 * a person would otherwise be looking at an unexplained blank, a sentence).
 * Nothing here throws: this is called from the poll that feeds a readout, and a
 * thrown sensor read would take the model list down with it.
 */
export async function sampleSysStat(): Promise<SysStat> {
  const now = Date.now();
  const load = os.loadavg();
  const base: SysStat = {
    at: now,
    uptimeSec: Math.round(os.uptime()),
    loadavg: [load[0], load[1], load[2]],
    cores: os.cpus().length || 1,
  };
  const cpu = readCpuBusy(now);
  const mem = await readMem(os.totalmem()).catch(() => null);

  if (!slow || now - slow.at >= sysStatSlowMs()) {
    const [procs, thermal, disks] = await Promise.all([readProcs(), readThermal(), readDisks()]);
    slow = { at: now, procs, thermal, disks };
  }
  const p = slow.procs, t = slow.thermal, d = slow.disks;
  return {
    ...base,
    ...(cpu ? { cpu } : {}),
    ...(mem ? { mem } : {}),
    ..."snap" in p ? { procs: p.snap } : { procsNote: p.note },
    ..."thermal" in t ? { thermal: t.thermal } : { thermalNote: t.note },
    ..."disks" in d ? { disks: d.disks } : { disksNote: d.note },
  };
}
