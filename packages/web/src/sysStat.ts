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
import type { CpuBusy, DiskVolume, MemBreakdown, ProcRow, SessionCpuRow, SysStat } from "@waterplane/shared";

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
  // Windows under WSL: Task Manager's one busy figure, no user/kernel split — never a "0% in the kernel".
  if (cpu.splitKnown === false) return `${Math.round(cpu.userPct)}% busy over the last ${span}, as Windows counts it (no split into programs and kernel).`;
  // WSL without the Windows reading: the Linux VM's own load, not the machine's.
  const vm = cpu.source === "wsl-vm" ? " Inside the WSL VM only — Windows programs are not in it." : "";
  return `${Math.round(cpu.userPct + cpu.sysPct)}% busy over the last ${span} — ${cpu.userPct.toFixed(0)}% running programs, ${cpu.sysPct.toFixed(0)}% in the kernel, ${cpu.idlePct.toFixed(0)}% idle.${vm}`;
}

/** How many programs, and how many sessions, the CPU row names. */
export const CPU_CULPRITS = 3;
/** How long a program or session that dropped out of the top stays listed. A
 *  list rebuilt from scratch every reading reorders and empties under the
 *  reader's eye; held, a name that was busy a moment ago is still there to tap. */
export const TOP_HOLD_MS = 30_000;

/** One entry of a held top list. `seenAt` is the reading that last had it in
 *  the top `n`; `inTop` is whether the CURRENT reading does; `current` whether
 *  the current reading has a row for it at all (a held row past the cap, or a
 *  session under 1%, has none — its `row` is then the last one seen). */
export interface HeldRow<T> { key: string; row: T; seenAt: number; inTop: boolean; current: boolean }

/**
 * The top `n` of `rows` (already busiest first), plus whatever was in the top
 * within `holdMs` and is not now — listed after, never interleaved, so the
 * leaders do not shuffle. Idempotent for one `at`: the caller may run it on
 * every render. `at` is the READING's clock (`procs.at`), not the phone's.
 */
export function holdTop<T>(prev: readonly HeldRow<T>[], rows: readonly T[], keyOf: (r: T) => string, at: number,
  n = CPU_CULPRITS, holdMs = TOP_HOLD_MS): HeldRow<T>[] {
  const top = rows.slice(0, n).map((row) => ({ key: keyOf(row), row, seenAt: at, inTop: true, current: true }));
  const inTop = new Set(top.map((h) => h.key));
  const now = new Map(rows.map((r) => [keyOf(r), r] as const));
  const held = prev
    .filter((h) => !inTop.has(h.key) && at - h.seenAt < holdMs)
    .map((h) => {
      const row = now.get(h.key);
      return { key: h.key, row: row ?? h.row, seenAt: h.seenAt, inTop: false, current: row != null };
    });
  return [...top, ...held];
}

/** "8s ago" for a held entry, from the reading's own clock. */
function leftAgo(h: HeldRow<unknown>, at: number): string {
  return `left the top ${CPU_CULPRITS} ${Math.max(0, Math.round((at - h.seenAt) / 1000))}s ago`;
}

/**
 * The top programs by CPU, as one line under the CPU row — always, not only
 * when the machine is hot (a list that appears at 80% and vanishes at 79% read
 * as broken). Folded by program like the table further down, and `top`'s
 * per-core percentages, so a row past 100% is several cores. A held entry says
 * it left the top and when. The table may be older than the busy figure
 * (slower cadence); `ageSec` says so rather than presenting it as the same instant.
 */
export function cpuCulpritsText(held: readonly HeldRow<ProcRow>[], at: number, ageSec: number | null = null): string | null {
  if (!held.length) return null;
  const items = held.map((h) => {
    const p = h.row;
    if (h.inTop) return `${p.name} ${p.cpuPct.toFixed(0)}%${p.procs > 1 ? ` (${p.procs} processes)` : ""}`;
    return h.current ? `${p.name} ${p.cpuPct.toFixed(0)}%, ${leftAgo(h, at)}` : `${p.name}, ${leftAgo(h, at)} (was ${p.cpuPct.toFixed(0)}%)`;
  });
  const age = ageSec != null && ageSec > 0 ? ` (process list read ${ageSec}s earlier)` : "";
  return `Using it most: ${items.join(" · ")}${age}.`;
}

/**
 * The sessions using the CPU — busiest first, at most `CPU_CULPRITS` plus the
 * held ones, each with the tab label the phone already knows. A session the
 * phone has no label for (closed since the reading) keeps its row, named as
 * such, rather than vanishing from the sum. A held session absent from the
 * reading is under 1% (the host leaves those out), and says so.
 */
export function topSessions(held: readonly HeldRow<SessionCpuRow>[], at: number, labelOf: (id: string) => string | undefined):
  { id: string; label: string; detail: string; held: boolean }[] {
  return held.map((h) => {
    const r = h.row;
    const pct = h.current ? `${r.cpuPct.toFixed(0)}%` : "under 1%";
    const detail = h.inTop
      ? `${pct} · mostly ${r.top}${r.procs > 1 ? ` · ${r.procs} processes` : ""}`
      : `${pct} · ${leftAgo(h, at)}`;
    return { id: r.sessionId, label: labelOf(r.sessionId) ?? "a session no longer open", detail, held: !h.inTop };
  });
}

/** How the two lists are made — one line, the rest folded. */
export const TOP_LISTS_LEAD = `Busiest ${CPU_CULPRITS} programs and sessions, from the desktop's process list.`;
export const TOP_LISTS_MORE =
  `A program is every process with that name added up; a session is every process it started — the CLI, ` +
  `its tools, builds and tests. Percentages are per core as top counts them, so 200% is two cores. ` +
  `One that drops out of the top ${CPU_CULPRITS} stays listed below the others for ${TOP_HOLD_MS / 1000} seconds, ` +
  `saying when it left, so the list does not jump between readings.`;

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
