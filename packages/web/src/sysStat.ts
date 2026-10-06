/**
 * **The desktop's own numbers, as things a person can read** — the pure half of
 * the system readout the local-runtime sheet draws (`wire/sysstat.ts` is the
 * shape, `host/sysstat.ts` the measurement).
 *
 * Here rather than inside the sheet for this app's usual reason: every rule
 * below is one a screenshot cannot be argued with about, and all of them are
 * ways this readout can be confidently wrong.
 *
 *  • **"Free" is not the interesting number and never was.** The sheet used to
 *    say `memory free 1.1 GB of 64.0 GB` about a machine with 33 GB available,
 *    because `os.freemem()` on macOS counts untouched pages only. The slices
 *    below are what the memory is DOING; `availableBytes` is what a new program
 *    could actually get, and it is the figure the sentence leads with.
 *
 *  • **A slice that was not measured is not drawn.** No 0-byte "compressed" row
 *    on a Linux host, no empty segment in the bar — an absent reader produces
 *    an absent slice, the same rule the whole feature runs on.
 *
 *  • **The bar always adds up to the machine.** Slices are drawn against
 *    `memTotal`, with the remainder as one explicit "available" segment, so the
 *    picture cannot imply the machine is fuller (or emptier) than it is. A
 *    breakdown whose parts overshoot the total — two syscalls microseconds
 *    apart — is CLAMPED, never drawn past the end.
 *
 *  • **Process rows are a fold, and RSS is not a budget.** `procFoldText` says
 *    how many processes a row is, and `rssSumText` exists so the screen can say
 *    out loud that the column sums past the machine's memory (shared pages are
 *    counted once per process holding them) rather than leaving somebody to add
 *    it up and conclude their desktop is overcommitted.
 */
import type { CpuBusy, DiskVolume, MemBreakdown, ProcRow, SysStat } from "@waterplane/shared";

/** One segment of the memory bar. `tone` names a CSS class, never a colour. */
export interface MemSlice {
  key: string;
  label: string;
  bytes: number;
  /** Share of the machine's total memory, 0-100. */
  pct: number;
  tone: "app" | "wired" | "compressed" | "cached" | "available";
  /** What this slice IS, in one clause, for the row under the bar. */
  what: string;
}

const gb = (b: number) => `${(Math.max(0, b) / 2 ** 30).toFixed(1)} GB`;

/**
 * The memory bar, left to right, ending in what is actually available.
 *
 * Returns an empty list when there is nothing measured to draw — never a single
 * grey bar standing for "unknown", which reads as a machine with no memory.
 */
export function memSlices(mem: MemBreakdown | undefined, memTotal: number): MemSlice[] {
  if (!mem || !(memTotal > 0)) return [];
  const out: MemSlice[] = [];
  const add = (key: string, label: string, bytes: number | undefined, tone: MemSlice["tone"], what: string) => {
    if (bytes == null || !(bytes > 0)) return; // absent, or nothing in it — not a zero-width segment
    // Clamped against what is left: the parts come from counters read
    // microseconds apart and may momentarily exceed the whole, and a bar drawn
    // past its own end is a picture of a machine that does not exist.
    const room = memTotal - out.reduce((n, s) => n + s.bytes, 0);
    if (room <= 0) return;
    out.push({ key, label, bytes: Math.min(bytes, room), pct: 0, tone, what });
  };
  if (mem.appBytes != null || mem.wiredBytes != null || mem.compressedBytes != null) {
    // macOS's own split, in Activity Monitor's order.
    add("app", "app memory", mem.appBytes, "app", "what programs asked for and are using");
    add("wired", "wired", mem.wiredBytes, "wired", "kernel memory that cannot be paged out");
    add("compressed", "compressed", mem.compressedBytes, "compressed",
      "what the memory compressor occupies — it is holding more than this");
  } else if (mem.usedBytes != null) {
    // Linux has no app/wired/compressed split worth inventing, so "in use" is
    // one slice: total minus what the kernel says is available.
    add("used", "in use", mem.usedBytes, "app", "what programs are using, as the kernel counts it");
  }
  add("cached", "cached files", mem.cachedBytes, "cached",
    "the file cache: in use, and handed back the moment something needs it");
  const drawn = out.reduce((n, s) => n + s.bytes, 0);
  const avail = Math.max(0, memTotal - drawn);
  if (avail > 0) {
    out.push({ key: "available", label: "available", bytes: avail, pct: 0, tone: "available",
      what: "free, plus everything the OS would reclaim on demand" });
  }
  return out.map((s) => ({ ...s, pct: Math.round((s.bytes / memTotal) * 1000) / 10 }));
}

/**
 * The one sentence under the bar. Leads with what is AVAILABLE, because that is
 * the number the old readout got wrong, and names the reader's operating system
 * rather than describing macOS's memory model on a Linux box.
 */
export function memNote(mem: MemBreakdown | undefined, memFree: number): string | null {
  if (!mem) return null;
  const avail = mem.availableBytes;
  const mac = mem.source === "vm_stat";
  const lead = avail == null
    ? "This is what the operating system says the memory is doing."
    : `About ${gb(avail)} is available — free memory (${gb(memFree)}) is only the part nothing has touched at all.`;
  const rest = mac
    ? " Cached files are memory in use that is handed straight back when something needs it, so a machine reading as nearly full is normal and not a problem by itself."
    : " `MemAvailable` is the kernel's own estimate of what a new program could get without anything being paged out.";
  return lead + rest;
}

/** Swap, said only when there IS a swap file. A nearly-full one is the single
 *  most actionable number on this screen, so the share is stated, not implied. */
export function swapText(mem: MemBreakdown | undefined): string | null {
  if (!mem || mem.swapTotalBytes == null || !(mem.swapTotalBytes > 0)) return null;
  const used = mem.swapUsedBytes ?? 0;
  const pct = Math.round((used / mem.swapTotalBytes) * 100);
  return `${gb(used)} of ${gb(mem.swapTotalBytes)} swap in use (${pct}%)`;
}

/**
 * The CPU split as a sentence — and the reason both numbers are on screen.
 *
 * `cpuPct` (load average over cores) and this are different questions: one is
 * how long the queue is, the other is how much of the machine is busy. A build
 * can sit at 100% busy with a load of 2, or a load of 30 with the CPU idle and
 * everything waiting on disk.
 */
export function cpuSplitText(cpu: CpuBusy | undefined): string | null {
  if (!cpu) return null;
  const span = cpu.spanMs >= 1000 ? `${Math.round(cpu.spanMs / 1000)}s` : `${cpu.spanMs}ms`;
  return `${Math.round(cpu.userPct + cpu.sysPct)}% busy over the last ${span} — ${cpu.userPct.toFixed(0)}% running programs, ${cpu.sysPct.toFixed(0)}% in the kernel, ${cpu.idlePct.toFixed(0)}% idle.`;
}

/** How a load average relates to this machine — a count of cores, not a
 *  percentage, because that is what it is. */
export function loadText(sys: SysStat | undefined): string | null {
  if (!sys) return null;
  const [a, b, c] = sys.loadavg;
  return `load ${a.toFixed(2)} · ${b.toFixed(2)} · ${c.toFixed(2)} over 1, 5 and 15 minutes, against ${sys.cores} cores`;
}

/** What a folded process row is. One process says its pid; a fold says how
 *  many, and never a pid that would name whichever one came first. */
export function procFoldText(row: ProcRow): string {
  return row.procs === 1 ? `pid ${row.pid ?? "?"}` : `${row.procs} processes`;
}

/** Why the process column adds up to more than the machine holds. */
export function rssSumText(sum: number, memTotal: number): string {
  return `Every process together holds ${gb(sum)} of a ${gb(memTotal)} machine — resident size counts a ` +
    `shared page once for each process holding it, so these rows overlap and must not be added up as a budget.`;
}

/** How old a slow reading is, said only when it is meaningfully older than the
 *  sample carrying it. Below the threshold the age is noise; above it, it is
 *  the difference between a readout and a claim. */
export function slowAgeSec(readAt: number, sampleAt: number): number | null {
  const s = Math.round((sampleAt - readAt) / 1000);
  return s >= 5 ? s : null;
}

/** Temperature, as a string, with its unit. Absent stays absent — there is no
 *  "—" and no 0°C. */
export function tempText(c: number | undefined): string | null {
  return c == null || !Number.isFinite(c) ? null : `${Math.round(c)}°C`;
}

/** Uptime, roughly, in the biggest unit that still says something. */
export function uptimeText(sec: number): string {
  const d = Math.floor(sec / 86400);
  if (d >= 1) return `${d}d ${Math.floor((sec % 86400) / 3600)}h`;
  const h = Math.floor(sec / 3600);
  if (h >= 1) return `${h}h ${Math.floor((sec % 3600) / 60)}m`;
  return `${Math.max(1, Math.floor(sec / 60))}m`;
}

/** Bytes in the unit a disk is sold in: TB from 1000 GB up, else GB. */
export function diskSize(b: number): string {
  const g = Math.max(0, b) / 2 ** 30;
  return g >= 1000 ? `${(g / 1024).toFixed(2)} TB` : `${g.toFixed(1)} GB`;
}

/** Share of the volume in use, 0-100 — what the bar draws. Clamped: a
 *  reading where free exceeds the volume is two counters apart, not a disk. */
export function diskUsedPct(v: DiskVolume): number {
  if (!(v.totalBytes > 0)) return 0;
  const used = Math.min(v.totalBytes, Math.max(0, v.totalBytes - v.availBytes));
  return Math.round((used / v.totalBytes) * 1000) / 10;
}

/** Under this much free a disk is worth a sentence: a build, a model pull or
 *  the swap file growing is what fills the last of it. */
export const DISK_LOW_PCT = 5;
export const DISK_LOW_BYTES = 10 * 2 ** 30;

/** True when the volume is nearly full, by EITHER measure: under 10 GB on any
 *  disk, or under 5% — 200 GB of a 4 TB disk is a disk that is filling up. */
export function diskLow(v: DiskVolume): boolean {
  return v.totalBytes > 0 && (v.availBytes < DISK_LOW_BYTES || v.availBytes / v.totalBytes * 100 < DISK_LOW_PCT);
}

/** "30.9 GB free of 460.4 GB", the row's sentence. Free leads, as memory's does. */
export function diskText(v: DiskVolume): string {
  return `${diskSize(v.availBytes)} free of ${diskSize(v.totalBytes)}`;
}
