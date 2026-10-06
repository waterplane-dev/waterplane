/**
 * Discover `claude` processes running on the host *outside* waterplane — i.e. ones
 * you started yourself in a terminal/tmux. Used for the "waterplane vs external"
 * session filter. We can't attach a PTY to someone else's TTY, so these are
 * shown read-only with a "resume here" affordance (opens a waterplane session in the
 * same directory with --continue).
 *
 * Linux reads `/proc` directly (cmdline, the `cwd` link, `stat`'s start time):
 * no `ps` flavour (busybox has no `lstart`) and no `lsof` needed. macOS keeps
 * `ps` + `lsof`. Both run under `LC_ALL=C` because the date parse is of the C
 * locale's shape. A missing tool is an empty list and ONE logged reason.
 */
import { readdir, readFile, readlink } from "node:fs/promises";
import type { ExternalSession } from "@waterplane/shared";
import { execFileP as pexec } from "./proc.js";


/** `ps` and `lsof` print dates and headings in the user's locale; every parse
 *  below is of the C locale's shape, so say so. */
const C_ENV = { ...process.env, LC_ALL: "C", LANG: "C" };

/** Linux's USER_HZ — fixed by the kernel ABI at 100 on every mainstream arch. */
const CLK_TCK = 100;

/** Why discovery is empty, said once per reason — never per poll. */
const said = new Set<string>();
function sayOnce(reason: string): void {
  if (said.has(reason)) return;
  said.add(reason);
  console.log(`[discover] external claude sessions not listed: ${reason}`);
}

export function looksLikeClaude(command: string): boolean {
  // argv0 (or any token) is the `claude` binary — match a path ending in
  // /claude or the bare word, not substrings like "claude-foo".
  return command.split(/\s+/).some((t) => t === "claude" || t.endsWith("/claude"));
}

export interface Candidate { pid: number; startedAt?: number; cwd?: string }

/** `ps -o pid=,lstart=,command=` under LC_ALL=C: `1234 Sat Oct  4 12:00:00 2026 claude …`.
 *  A line not in that shape is skipped — a localized date is no row, never a wrong time. */
export function parsePsLstart(stdout: string, own: number, managed: Set<number>): Candidate[] {
  const out: Candidate[] = [];
  for (const raw of stdout.split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    const m = /^(\d+)\s+(\w{3}\s+\w{3}\s+\d+\s+[\d:]+\s+\d{4})\s+(.*)$/.exec(line);
    if (!m) continue;
    const pid = Number(m[1]);
    if (pid === own || managed.has(pid)) continue;
    if (!looksLikeClaude(m[3])) continue;
    const t = Date.parse(m[2]);
    out.push({ pid, startedAt: Number.isNaN(t) ? undefined : t });
  }
  return out;
}

/** `starttime` (field 22, clock ticks after boot) of a `/proc/<pid>/stat` line.
 *  The comm field may hold spaces and parentheses, so count from the LAST `)`. */
export function parseProcStatStartTicks(stat: string): number | null {
  const close = stat.lastIndexOf(")");
  if (close < 0) return null;
  const f = stat.slice(close + 1).trim().split(/\s+/); // f[0] = state = field 3
  if (f.length <= 19) return null;
  const n = Number(f[19]);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

/** Boot time (epoch seconds) off `/proc/stat`'s `btime` line. */
export function parseBtime(procStat: string): number | null {
  const m = /^btime\s+(\d+)\s*$/m.exec(procStat);
  return m ? Number(m[1]) : null;
}

/** A process's start as epoch ms, or undefined when either input is unreadable. */
export function procStartMs(stat: string, procStat: string): number | undefined {
  const ticks = parseProcStatStartTicks(stat);
  const btime = parseBtime(procStat);
  if (ticks === null || btime === null) return undefined;
  return btime * 1000 + Math.round((ticks / CLK_TCK) * 1000);
}

/** A `/proc/<pid>/cmdline` (NUL-separated) as one command string. */
export function cmdlineText(raw: string): string {
  return raw.split("\0").filter(Boolean).join(" ");
}

async function discoverLinux(own: number, managed: Set<number>): Promise<Candidate[]> {
  let names: string[];
  try {
    names = await readdir("/proc");
  } catch {
    sayOnce("/proc is not readable");
    return [];
  }
  let procStat = "";
  try { procStat = await readFile("/proc/stat", "utf8"); } catch { /* start times absent */ }
  const out: Candidate[] = [];
  for (const n of names) {
    if (!/^\d+$/.test(n)) continue;
    const pid = Number(n);
    if (pid === own || managed.has(pid)) continue;
    try {
      const cmd = cmdlineText(await readFile(`/proc/${pid}/cmdline`, "utf8"));
      if (!looksLikeClaude(cmd)) continue;
      const cwd = await readlink(`/proc/${pid}/cwd`); // another user's process: EACCES → skipped
      let startedAt: number | undefined;
      try { startedAt = procStartMs(await readFile(`/proc/${pid}/stat`, "utf8"), procStat); } catch { /* absent */ }
      out.push({ pid, startedAt, cwd });
    } catch { /* raced away, or not ours */ }
  }
  return out;
}

async function cwdOfLsof(pid: number): Promise<string | null> {
  try {
    // lsof field output: lines pPID / fcwd / n<path>.
    const { stdout } = await pexec("lsof", ["-a", "-p", String(pid), "-d", "cwd", "-Fn"], { timeout: 2000, env: C_ENV });
    const line = stdout.split("\n").find((l) => l.startsWith("n"));
    return line ? line.slice(1) : null;
  } catch (e) {
    if ((e as NodeJS.ErrnoException)?.code === "ENOENT") sayOnce("lsof is not installed");
    return null;
  }
}

async function discoverPs(own: number, managed: Set<number>): Promise<Candidate[]> {
  try {
    const { stdout } = await pexec("ps", ["-axww", "-o", "pid=,lstart=,command="], {
      timeout: 3000, maxBuffer: 8 * 1024 * 1024, env: C_ENV,
    });
    return parsePsLstart(stdout, own, managed);
  } catch (e) {
    sayOnce((e as NodeJS.ErrnoException)?.code === "ENOENT" ? "ps is not installed" : "ps did not answer");
    return [];
  }
}

export async function discoverExternal(managed: Set<number>): Promise<ExternalSession[]> {
  const own = process.pid;
  const candidates = process.platform === "linux" ? await discoverLinux(own, managed) : await discoverPs(own, managed);

  // Resolve cwd for each (cap to avoid spawning too many probes), then
  // de-dupe by directory — you resume a *directory*, not a PID — keeping the
  // most recently started process per cwd. Newest first.
  const byCwd = new Map<string, ExternalSession>();
  for (const c of candidates.slice(0, 60)) {
    const cwd = c.cwd ?? (await cwdOfLsof(c.pid));
    if (!cwd) continue;
    const prev = byCwd.get(cwd);
    if (!prev || (c.startedAt ?? 0) > (prev.startedAt ?? 0)) byCwd.set(cwd, { pid: c.pid, cwd, startedAt: c.startedAt });
  }
  return [...byCwd.values()].sort((a, b) => (b.startedAt ?? 0) - (a.startedAt ?? 0));
}
