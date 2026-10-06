import { execFileSync } from "node:child_process";
import { fstatSync, readdirSync, readFileSync, readlinkSync } from "node:fs";

/**
 * Why a PTY could not be allocated — the sentence, not the errno.
 *
 * Every session and every build in this app is a pseudo-terminal, and the
 * kernel caps how many of those exist AT ONCE, system-wide: `kern.tty.ptmx_max`
 * on macOS (511 by default), `kernel.pty.max` on Linux. Past the cap, opening
 * `/dev/ptmx` fails and node-pty throws its own message and nothing else:
 *
 *     Error: posix_spawnp failed.
 *
 * That string names the syscall wrapper and not one fact anybody can act on.
 * Measured here, the table filled to 511/511 and the phone showed four repos
 * failing to open a session, an APK build failing, and four `no session` marks
 * — six symptoms of ONE cause, none of them saying which. Worse, the process
 * holding 287 of the 511 was an orphaned scratch script belonging to nobody:
 * the fix was `kill`, and no screen in the app could have suggested it.
 *
 * So: when a spawn throws, ASK the kernel how full the table is and say so.
 *
 * ── Rules ─────────────────────────────────────────────────────────────
 *
 * **Only on the failure path.** The count costs an `lsof` walk of every process
 * on macOS (~1 s, measured). It runs when a spawn has ALREADY failed, never per
 * spawn, and the answer is cached for `COUNT_TTL_MS` so N simultaneous failures
 * — a fan-out into thirteen repos is exactly that — ask once between them.
 *
 * **It degrades to the raw message, never to a wrong number.** Same rule the
 * TUI heuristics live under: an unreadable `sysctl`, an `lsof` that times out,
 * an unrecognised platform all fall through to `String(err)`. A confident
 * "the pty table is full" on a spawn that actually failed because the binary
 * was missing is worse than the errno it replaced.
 *
 * **The count is SYSTEM-WIDE, deliberately.** The obvious cheap version counts
 * this host's own PTYs, and in the case that motivated the module the host held
 * 143 of 511 and was not the problem at all. A number that can only ever accuse
 * ourselves would have pointed at the wrong process.
 */

const COUNT_TTL_MS = 10_000;

/** node-pty's message plus the errnos an exhausted pty table actually raises. */
const PTY_ERRORS = /posix_spawnp failed|forkpty|openpt|EAGAIN|ENXIO|EMFILE|ENFILE/i;

let maxCache: number | null | undefined;      // undefined = not asked yet
let countCache: { at: number; n: number | null } | null = null;

function sysctlNum(name: string): number | null {
  try {
    const out = execFileSync("sysctl", ["-n", name], { encoding: "utf8", timeout: 2000, stdio: ["ignore", "pipe", "ignore"] });
    const n = Number(out.trim());
    return Number.isFinite(n) && n > 0 ? n : null;
  } catch { return null; }
}

function procNum(path: string): number | null {
  try {
    const n = Number(readFileSync(path, "utf8").trim());
    return Number.isFinite(n) && n >= 0 ? n : null;
  } catch { return null; }
}

/** The cap on concurrent pseudo-terminals, or null if we cannot read it.
 *  A boot constant, so it is cached for the life of the process. */
export function ptyMax(): number | null {
  if (maxCache === undefined) {
    maxCache = process.platform === "darwin" ? sysctlNum("kern.tty.ptmx_max")
      : process.platform === "linux" ? procNum("/proc/sys/kernel/pty/max")
      : null;
  }
  return maxCache;
}

/** How many pseudo-terminals are open right now, system-wide, or null.
 *  Linux answers from `/proc` for free; macOS has no counter, so it costs an
 *  `lsof` walk — hence the TTL, and hence failure-path-only callers. */
export function ptyOpen(): number | null {
  if (countCache && Date.now() - countCache.at < COUNT_TTL_MS) return countCache.n;
  let n: number | null = null;
  if (process.platform === "linux") {
    n = procNum("/proc/sys/kernel/pty/nr");
  } else if (process.platform === "darwin") {
    try {
      // One line per open handle on the multiplexer, plus lsof's header.
      const out = execFileSync("lsof", ["/dev/ptmx"], { encoding: "utf8", timeout: 8000, stdio: ["ignore", "pipe", "ignore"] });
      const lines = out.split("\n").filter((l) => l.trim().length > 0);
      n = Math.max(0, lines.length - 1);
    } catch { n = null; }
  }
  countCache = { at: Date.now(), n };
  return n;
}

/** Does this error look like a pty that could not be allocated? */
export function looksLikePtyExhaustion(err: unknown): boolean {
  const msg = err instanceof Error ? (err.message || String(err)) : String(err);
  return PTY_ERRORS.test(msg);
}

/**
 * What to SAY about a failed pty spawn.
 *
 * Returns the raw message unless the error looks like pty exhaustion AND the
 * kernel confirms the table is genuinely full — the count is evidence, so an
 * error that merely matches the pattern while capacity remains keeps its own
 * words rather than being relabelled with a guess.
 */
export function spawnFailure(err: unknown): string {
  const raw = err instanceof Error ? (err.message || String(err)) : String(err);
  if (!looksLikePtyExhaustion(err)) return raw;
  const max = ptyMax();
  const open = ptyOpen();
  if (max === null || open === null) return raw;
  if (open < max) return raw;
  return exhaustionSentence(open, max);
}

/** The wording, lifted out so it can be asserted: a machine with headroom can
 *  never reach this branch through `spawnFailure`, which is the whole point of
 *  the evidence rule above and would otherwise leave the sentence untested. */
export function exhaustionSentence(open: number, max: number): string {
  const knob = process.platform === "darwin" ? "kern.tty.ptmx_max" : "kernel.pty.max";
  return `no pseudo-terminals left — ${open} of ${max} in use system-wide (${knob}). `
    + `Every session and build needs one: close some sessions, or raise the cap.`;
}

/**
 * The pseudo-terminals THIS process holds open, by side — or null.
 *
 * `ptyOpen()` is system-wide on purpose (it must be able to accuse someone
 * else); this is the other half, and it is what makes a leak in OUR process
 * visible: measured 2026-09-25, node-pty 1.1.0's macOS spawn leaked one
 * `/dev/ptmx` and the child's slave fd into the PARENT on every spawn, so the
 * daemon held 248 masters for 67 live sessions and the table ran dry. A healthy
 * host holds one master per live PTY; `masters` far past that is a leak.
 *
 * Cheap enough to answer on request (one readdir + an fstat per fd, no
 * subprocess), unlike the system-wide count. `slaves` counts slave-side fds —
 * this process should hold NONE. Unknown platform or unreadable table ⇒ null,
 * never a guess.
 */
export function ownPtys(): { masters: number; slaves: number } | null {
  try {
    let masters = 0, slaves = 0;
    if (process.platform === "darwin") {
      // Major 15 = ptmx/master side, 16 = ttys/slave side (`ls -l /dev/ptmx`).
      for (const name of readdirSync("/dev/fd")) {
        const fd = Number(name);
        if (!Number.isInteger(fd)) continue;
        let rdev: number;
        try { rdev = fstatSync(fd).rdev; } catch { continue; }
        const major = (rdev >>> 24) & 0xff;
        if (major === 15) masters++;
        else if (major === 16) slaves++;
      }
      return { masters, slaves };
    }
    if (process.platform === "linux") {
      for (const name of readdirSync("/proc/self/fd")) {
        let target: string;
        try { target = readlinkSync(`/proc/self/fd/${name}`); } catch { continue; }
        if (target === "/dev/ptmx" || target.startsWith("/dev/pts/ptmx")) masters++;
        else if (/^\/dev\/pts\/\d+$/.test(target)) slaves++;
      }
      return { masters, slaves };
    }
    return null;
  } catch { return null; }
}
