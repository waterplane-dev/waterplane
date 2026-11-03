/**
 * Windows-wide CPU for a host that runs inside WSL2.
 *
 * Inside the VM `/proc/stat` (and so `os.cpus()` and the load average) only
 * describes the VM's own load; Task Manager shows the whole machine, so the
 * phone read far LOWER than the desktop beside it. Here ONE long-running
 * `powershell.exe` (WSL interop) prints the machine's utilisation every
 * couple of seconds; we keep the newest line. No process is spawned per poll.
 *
 * It reads the WMI perf class (`Win32_PerfFormattedData_*`), whose class and
 * property names are English on every locale — unlike `typeperf`'s counter
 * paths, which are localised. `Processor Information` `PercentProcessorUtility`
 * is what Task Manager's CPU graph uses; the older `PercentProcessorTime` is
 * the fallback. A line that is not a number in range is DROPPED, and a reading
 * older than STALE_MS is ABSENT: the caller then falls back to the VM's own
 * figure and says so. Never a wrong number.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { isWsl } from "./ocrlocal.js";

export const WIN_CPU_STALE_MS = 15_000;
const RETRY_MS = 60_000;
const INTERVAL_S = 2;

/** One line of the child's output → percent busy, or null. Accepts `12.5`; a
 *  comma decimal, text, blank or an out-of-range value is null. Utility may
 *  exceed 100 on a turbo-boosted core, so up to 200 is clamped, beyond is null. */
export function parseCpuLine(line: string): number | null {
  const s = line.trim();
  if (!/^\d{1,3}(\.\d+)?$/.test(s)) return null;
  const n = Number(s);
  if (!Number.isFinite(n) || n < 0 || n > 200) return null;
  return Math.min(100, n);
}

const SCRIPT = [
  "$ErrorActionPreference='SilentlyContinue';",
  "$c=[cultureinfo]::InvariantCulture;",
  "while($true){",
  "$v=$null;",
  "$u=Get-CimInstance Win32_PerfFormattedData_Counters_ProcessorInformation -Filter \"Name='_Total'\";",
  "if($u -and $u.PercentProcessorUtility -ne $null){$v=$u.PercentProcessorUtility}",
  "else{$p=Get-CimInstance Win32_PerfFormattedData_PerfOS_Processor -Filter \"Name='_Total'\";if($p){$v=$p.PercentProcessorTime}}",
  "if($v -ne $null){[Console]::Out.WriteLine(([double]$v).ToString('0.0',$c))}",
  `Start-Sleep -Seconds ${INTERVAL_S}}`,
].join("");

let latest: { pct: number; at: number } | null = null;
let child: ChildProcess | null = null;
let failedAt = 0;
let wsl: boolean | null = null;

const detectWsl = (): boolean => (wsl ??= process.platform === "linux" && isWsl());

function start(): void {
  try {
    let buf = "";
    const c = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", SCRIPT], {
      stdio: ["ignore", "pipe", "ignore"], windowsHide: true,
    });
    child = c;
    c.stdout!.setEncoding("utf8");
    c.stdout!.on("data", (d: string) => {
      buf += d;
      let i: number;
      while ((i = buf.indexOf("\n")) >= 0) {
        const pct = parseCpuLine(buf.slice(0, i));
        buf = buf.slice(i + 1);
        if (pct !== null) latest = { pct, at: Date.now() };
      }
    });
    const dead = () => { if (child === c) { child = null; failedAt = Date.now(); } };
    c.on("error", dead);
    c.on("exit", dead);
  } catch {
    failedAt = Date.now();
  }
}

/** Stop the child (shutdown). */
export function stopWindowsCpu(): void {
  const c = child;
  child = null;
  try { c?.kill(); } catch { /* already gone */ }
}

process.on("exit", stopWindowsCpu);

/** The newest Windows-wide reading, or null (not WSL, interop missing, child
 *  dead, or reading stale). Starts the child lazily on first call. */
export function windowsCpuNow(now = Date.now()): { pct: number; at: number } | null {
  if (!detectWsl()) return null;
  if (!child && now - failedAt >= RETRY_MS) start();
  if (!latest || now - latest.at > WIN_CPU_STALE_MS) return null;
  return latest;
}
