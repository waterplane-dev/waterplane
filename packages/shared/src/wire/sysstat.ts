/**
 * **What the DESKTOP is doing, beyond the model runner** — the `top` half of the
 * local-runtime readout, on the wire.
 *
 * ── Why this exists ─────────────────────────────────────────────────────────
 *
 * The runner readout answered "what is loaded" and, for the machine itself, one
 * CPU percentage and one free-memory figure. On a 64 GB desktop holding NO local
 * model at all that read "memory free 1.1 GB", which is alarming, unactionable
 * and — as a description of the machine — very nearly meaningless: `os.freemem()`
 * on macOS counts genuinely untouched pages only, so a healthy Mac with a warm
 * file cache reports almost nothing free for ever. The question it provokes
 * ("then WHO has it?") had no answer anywhere in this app.
 *
 * So this carries the four things `top` would have told somebody standing at the
 * desktop: the CPU split, where the memory actually went, which programs are
 * holding it, and how hot the box is running.
 *
 * ── The rules ───────────────────────────────────────────────────────────────
 *
 *  • **Every section is OPTIONAL and absent means "this host has no reader for
 *    it"** — never a zero. A Linux daemon has no `vm_stat`, a Mac has no
 *    `/sys/class/thermal`, and a host one version behind has none of this at
 *    all. A 0°C CPU and a 0-byte page cache are both plausible-looking lies.
 *
 *  • **`cpu` needs two readings, so the FIRST sample of a watch has none.**
 *    Utilization is a delta over an interval; the alternative — load average
 *    divided by cores, which is what the old `cpuPct` is — is a queue-length
 *    figure that reads far above 100% on a busy build and is not what anybody
 *    means by "CPU %". Both travel, worded apart, rather than one replacing the
 *    other.
 *
 *  • **The slow readers carry their OWN timestamp.** Processes and temperature
 *    are sampled on a longer cadence than the 5 s poll (a full `ps` is ~30 ms of
 *    the daemon that pumps every PTY), so a sample can repeat a reading taken
 *    seconds earlier. The phone says the age rather than presenting a stale row
 *    as current — the same rule the whole local-runtime strip exists to keep.
 *
 *  • **Process rows are GROUPED BY PROGRAM, and RSS is not additive.** Twelve
 *    renderer processes under one browser is the answer to "who has my memory";
 *    twelve rows named the same thing is not. And resident-set size counts a
 *    shared page once per process holding it, so the column sums to more than
 *    the machine has — `rssSumBytes` travels so the phone can say that out loud
 *    instead of letting somebody add the rows up themselves.
 */

/**
 * The CPU split over the interval between two readings — what `top` shows, not
 * what the load average says.
 *
 * Percentages are of TOTAL core-time (all cores together), so `userPct +
 * sysPct + idlePct` is ~100 whatever the core count. `cores` is per logical
 * core, busy (non-idle) percent, in the OS's own order.
 */
export interface CpuBusy {
  userPct: number;
  sysPct: number;
  idlePct: number;
  /** Busy percent per logical core, same interval. Empty where the platform
   *  reports no per-core times. */
  cores: number[];
  /** How long the split covers, ms. A number, because a "37%" over four
   *  seconds and over four minutes are different claims. */
  spanMs: number;
}

/**
 * Where the memory went.
 *
 * Every field is optional because the two platforms with readers here describe
 * memory differently and neither translates cleanly into the other's words.
 * macOS gives the Activity Monitor split (app / wired / compressed, and a file
 * cache that is reclaimable on demand); Linux gives `MemAvailable`, which is the
 * kernel's own estimate and has no app/wired equivalent worth inventing.
 */
export interface MemBreakdown {
  /** Anonymous memory programs asked for, minus what is purgeable. macOS. */
  appBytes?: number;
  /** Kernel memory that cannot be paged out. macOS. */
  wiredBytes?: number;
  /** What the memory compressor is occupying. macOS. NOT the same as the
   *  volume stored in it — that is bigger, and it is the compressor's win. */
  compressedBytes?: number;
  /** File-backed pages: the page cache. **Reclaimable**, which is the whole
   *  reason this field exists — it is the memory that "free" is missing. */
  cachedBytes?: number;
  /** What is genuinely in use (macOS: app + wired + compressed). */
  usedBytes?: number;
  /** What a new program could get without anything being paged out — free plus
   *  what the OS would reclaim. On Linux this is the kernel's `MemAvailable`;
   *  on macOS it is total minus used. Always ≫ `LocalRuntimeSample.memFree`. */
  availableBytes?: number;
  /** Swap in use, and how big the swap file is allowed to get. A swap file
   *  that is nearly full is the single most actionable number on this screen. */
  swapUsedBytes?: number;
  swapTotalBytes?: number;
  /** Which reader produced this, so the phone can word the caption for the
   *  right operating system rather than describing macOS's memory model on a
   *  Linux desktop. */
  source: "vm_stat" | "meminfo";
}

/** One program's total, folded across every process running it. */
export interface ProcRow {
  /** The program's name — the executable's basename, never its path. */
  name: string;
  /** Resident set size, summed over the processes below. Counts shared pages
   *  once per process, so this is an upper bound, never an exact footprint. */
  rssBytes: number;
  /** CPU percent, summed. Can exceed 100 — that is several cores, and it is
   *  what `top` shows too. */
  cpuPct: number;
  /** How many processes were folded into this row. */
  procs: number;
  /** The pid, and only when there is exactly one process — a pid printed
   *  beside a fold of twelve would name whichever one happened to be first. */
  pid?: number;
}

/** The process table, capped, with the two orderings that answer a question. */
export interface ProcSnapshot {
  /** When the table was read — its OWN clock, which may be older than the
   *  sample carrying it (the cadence is slower than the poll). */
  at: number;
  /** Biggest by memory, then biggest by CPU. Two lists, not one sorted twice:
   *  the answer to "who has the RAM" and "what is making the fans spin" are
   *  usually different programs. */
  byMem: ProcRow[];
  byCpu: ProcRow[];
  /** How many processes are running in total (before the cap). */
  count: number;
  /** Every process's RSS added up. Deliberately shipped: it is far larger than
   *  the machine's memory (shared pages, counted per process) and saying so is
   *  the only way to stop the rows being added up as if they were a budget. */
  rssSumBytes: number;
  /** How many rows each list holds at most. */
  cap: number;
}

/** One fan, as the sensor names it. */
export interface FanRow {
  label: string;
  rpm: number;
}

/** Temperature and fans, where this host has any way to read them. */
export interface Thermal {
  /** Its own clock, for `ProcSnapshot.at`'s reason. */
  at: number;
  cpuTempC?: number;
  gpuTempC?: number;
  /** Empty means "read, and this machine reports no fans" — a fanless Mac, a
   *  VM. Absent thermals entirely is a different fact and is `thermalNote`. */
  fans: FanRow[];
  /** Which reader answered (`smctemp`, `istats`, `sysfs`, or the command named
   *  by `WATERPLANE_SMC_BIN`). Shown, because a third-party sensor tool's numbers are
   *  its own and this app is not vouching for them. */
  source: string;
}

/**
 * One disk (a mounted volume), as `df` would have told you — but read with
 * `statfs`, so no subprocess and no parsing of `df`'s per-platform columns.
 *
 * Folded by DEVICE: the home folder, the code root and the state dir usually
 * sit on one volume, and three identical rows would say that badly. `holds`
 * names what of this app's lives there, which is the reason a person is
 * looking at a disk on this screen at all.
 */
export interface DiskVolume {
  /** What the row is called: `home` for the volume holding the home folder,
   *  else the volume's own name (`/Volumes/<name>`) or its mount point. */
  name: string;
  /** What was asked of the OS — a mount point, or a folder on the volume. */
  path: string;
  /** What lives here, in words (`home (~)`, `repos (~/dev)`, …). Empty for a
   *  volume holding none of it — an external drive, a second disk. */
  holds: string[];
  totalBytes: number;
  /** What a non-root program could still write. On APFS this leaves out
   *  PURGEABLE space (local snapshots, iCloud copies), so Finder can say more
   *  is free than this — the phone says so rather than pick a side. */
  availBytes: number;
}

/** The disks, on the slow cadence (a stuck network mount must not stall the poll). */
export interface DiskSnapshot {
  /** Its own clock, for `ProcSnapshot.at`'s reason. */
  at: number;
  volumes: DiskVolume[];
}

/**
 * The machine, as one sample. Rides on `LocalRuntimeSample.sys`.
 *
 * `loadavg`, `cores` and `uptimeSec` duplicate `HostStat` on purpose: that is a
 * one-shot HTTP read behind a different route, and a watched stream that has to
 * be joined against a separate request to be readable is a stream that will be
 * rendered without it.
 */
export interface SysStat {
  at: number;
  uptimeSec: number;
  loadavg: [number, number, number];
  cores: number;
  cpu?: CpuBusy;
  mem?: MemBreakdown;
  procs?: ProcSnapshot;
  thermal?: Thermal;
  /**
   * Why there is no `thermal` — a SENTENCE, present only when the reading is
   * absent, and never both. On macOS the SMC sensors are root-only
   * (`powermetrics`), and a daemon that spawns `claude` has no business
   * prompting for a password, so this says which small helper would fill the
   * row in. A blank space with no explanation reads as a bug in this app.
   */
  thermalNote?: string;
  /**
   * Why there is no `procs`. Absent when there is a table (never both), and
   * present when the reader was switched off (`WATERPLANE_SYSSTAT_PROCS=0`) or
   * failed — "nobody is running anything" is not a thing this can mean.
   */
  procsNote?: string;
  /** The disks and how full they are. Absent on a host that predates it. */
  disks?: DiskSnapshot;
  /** Why there is no `disks` — never both, as `thermalNote`. */
  disksNote?: string;
}
