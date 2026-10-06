/**
 * What a background shell is DOING, in words — the pure half of the "shells"
 * feature (host reader: `packages/host/src/shells.ts`).
 *
 * A `SessionShell` is three raw readings (`cpuMs`/`cpuMovedAt`, `outputAt`,
 * `workers`) and this file is what turns them into a bucket and a sentence,
 * the same way `clihealth.ts` turns a run of misses into a rollup. Nothing
 * here reads a clock of its own — `now` is always a parameter — so the phone
 * and any test can pin a bucket without a live process to poll.
 *
 * The vocabulary is deliberately never "hung"/"stuck"/"dead" (CLAUDE.md): a
 * shell that has been quiet for a day may be exactly what was asked for (an
 * emulator, a dev server) or may be a loop that can never end on its own
 * (`selfMatchOf`) — in neither case does this app know it is BROKEN, only
 * that it is quiet, and the words say only that.
 */
import type { SessionShell } from "./wire/session.js";

/** How long a shell may go without its CPU moving or its output growing and
 *  still read as "working" — ten minutes, generous the same way
 *  `WATERPLANE_AGENT_STALE_MS` is: a shell doing real work inside a slow build can
 *  go quiet for minutes at a stretch with nothing wrong. */
export const SHELL_QUIET_MS = 10 * 60_000;

/**
 * Which of four states a shell is in right now.
 *
 *   working — it has real workers, and its CPU moved or its output grew
 *             within `quietMs`.
 *   waiting — no real workers under it (`workers === 0`): a loop that only
 *             sleeps between checks. This wins over `working` even when the
 *             wrapper's OWN cpu ticked moments ago — a real polling loop
 *             (`until … ; do sleep 10; done`) spends a few ms of CPU on every
 *             pass around its `sleep`/`pgrep`, every couple of minutes, and
 *             asking "did the CPU move within ten minutes" answered `working`
 *             for a shell that has never once had anything running under it.
 *   quiet   — no recent movement, and it DOES have workers: something is
 *             running under it that has not been seen to move.
 *   unknown — no reading has EVER moved (`cpuMovedAt` and `outputAt` both
 *             absent) — the honest state for a shell seen only once, before
 *             there is anything to compare against.
 *
 * `unknown` is checked first and wins outright: neither `working` nor
 * `waiting` can be answered with no data at all.
 */
export function shellBucket(
  sh: SessionShell, now: number, quietMs: number = SHELL_QUIET_MS,
): "working" | "waiting" | "quiet" | "unknown" {
  if (sh.cpuMovedAt === undefined && sh.outputAt === undefined) return "unknown";
  if (sh.workers === 0) return "waiting";
  const movedAt = Math.max(sh.cpuMovedAt ?? 0, sh.outputAt ?? 0);
  return now - movedAt < quietMs ? "working" : "quiet";
}

function fmtDuration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (d > 0) return h > 0 ? `${d}d ${h}h` : `${d}d`;
  if (h > 0) return m > 0 ? `${h}h ${m}m` : `${h}h`;
  if (m > 0) return `${m}m`;
  return `${sec}s`;
}

/** `pgrep -f "…"` / `pgrep -f '…'`, both quote styles, over a LITERAL pattern
 *  (no `$`/regex metacharacters — see `selfMatchOf`). */
const PGREP_RE = /pgrep\s+-f\s+(?:"([^"]*)"|'([^']*)')/g;
const REGEX_SPECIAL_RE = /[$^.*+?()[\]{}|\\]/;

/**
 * The exit condition this shell is waiting on is `pgrep -f` over a pattern
 * that is — by construction — already part of THIS process's own command
 * line, so the search can never come back empty.
 *
 * The mechanism: the CLI runs the whole script as one `/bin/zsh -c '…'`
 * argument, which is what `ps` shows as this process's command. `pgrep -f`
 * matches a pattern against every process's FULL command line, this one
 * included — and the pattern text sits right there, quoted, as the argument
 * to the very `pgrep -f` call that is testing for it. A loop built as
 * `until … ! pgrep -f "X" …; do sleep …; done` can therefore never see
 * "nothing matches", because it always matches itself.
 *
 * `$`/regex metacharacters in the pattern withhold the claim on purpose: with
 * a real anchor or wildcard in play, whether the pattern still matches the
 * surrounding text is a real regex question this heuristic does not attempt,
 * and asserting self-match anyway would be a wrong number, not an absent one.
 */
export function selfMatchOf(command: string): boolean {
  return selfMatchPattern(command) !== null;
}

/** The literal pattern `selfMatchOf` found, for the sentence that names it.
 *  Null exactly when `selfMatchOf` is false. */
export function selfMatchPattern(command: string): string | null {
  PGREP_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = PGREP_RE.exec(command))) {
    const pat = m[1] ?? m[2] ?? "";
    if (pat && !REGEX_SPECIAL_RE.test(pat)) return pat;
  }
  return null;
}

/** Long-running-by-design processes: quiet is the point, not a concern. Every
 *  entry is matched as a case-insensitive substring, so `--watch` catches
 *  `nodemon --watch` and `npm run dev` catches the wrapper script that runs
 *  it either. */
const SERVER_LIKE_WORDS = [
  "emulator", "qemu", "vite", "webpack", "next dev", "npm run dev", "serve",
  "--watch", "tail -f", "firebase emulators", "nodemon", "uvicorn --reload", "expo start",
];

export function serverLikeOf(command: string): boolean {
  const lower = command.toLowerCase();
  return SERVER_LIKE_WORDS.some((w) => lower.includes(w));
}

/**
 * One plain sentence for a shell — never "hung"/"stuck"/"dead" (CLAUDE.md).
 *
 * `foreground` outranks everything: this is not a background shell at all,
 * only the running turn's own command wearing the same `ps` shape.
 * `serverLike` outranks the bucket: a quiet emulator is not a concern and the
 * words say so instead of reading as one. `selfMatch` outranks the bucket the
 * same way — a self-matching wait loop gets its own sentence naming the
 * pattern regardless of what bucket the CPU/output reading would otherwise
 * put it in, because "waiting in a loop" is true but leaves out the one fact
 * that matters: it will never end.
 */
export function shellWords(sh: SessionShell, now: number): string {
  if (sh.foreground) return "a command this turn is running";
  const age = fmtDuration(now - sh.startedAt);
  if (sh.serverLike) return `long-running by design · ${age}`;
  if (sh.selfMatch) {
    const pat = selfMatchPattern(sh.command);
    if (pat) return `waits for "${pat}" to end — its own command line matches that pattern, so this never ends`;
  }
  const bucket = shellBucket(sh, now);
  if (bucket === "unknown") return "can't tell yet";
  if (bucket === "working") {
    const movedAt = Math.max(sh.cpuMovedAt ?? 0, sh.outputAt ?? 0);
    return `running · ${age} · CPU moved ${fmtDuration(now - movedAt)} ago`;
  }
  if (bucket === "waiting") return `waiting in a loop · ${age} · only sleeps between checks`;
  return `quiet ${age} · no CPU and no output`;
}

export interface ShellsSummary {
  working: number;
  waiting: number;
  quiet: number;
  unknown: number;
  /** Wrappers that are the running turn's OWN command, not background shells
   *  at all — never folded into the four buckets above or into `total`,
   *  which is a count of background shells only. */
  foreground: number;
  total: number;
}

/** Never counts `unknown` as `quiet` — a shell this app has not watched long
 *  enough to have an opinion about is not the same claim as one it watched go
 *  silent. Never counts a `foreground` shell into any bucket or into `total`
 *  either — it is not a background shell a person could act on from here. */
export function shellsSummary(list: SessionShell[], now: number, quietMs: number = SHELL_QUIET_MS): ShellsSummary {
  const s: ShellsSummary = { working: 0, waiting: 0, quiet: 0, unknown: 0, foreground: 0, total: 0 };
  for (const sh of list) {
    if (sh.foreground) { s.foreground++; continue; }
    s[shellBucket(sh, now, quietMs)]++;
    s.total++;
  }
  return s;
}

/** "1 shell · quiet", "3 shells · 2 waiting" — the chip text. Names the most
 *  notable bucket only (quiet, then waiting, then unknown, then working, the
 *  order a person would want flagged first), never every count at once. */
export function shellsChipText(s: ShellsSummary): string {
  const noun = s.total === 1 ? "shell" : "shells";
  const base = `${s.total} ${noun}`;
  if (!s.total) return base;
  const order: (keyof Omit<ShellsSummary, "total">)[] = ["quiet", "waiting", "unknown", "working"];
  const top = order.find((k) => s[k] > 0);
  if (!top) return base;
  const word = top === "working" ? "running" : top;
  return s.total === 1 ? `${base} · ${word}` : `${base} · ${s[top]} ${word}`;
}

/** description if present, else the first couple of words of the command —
 *  for `shellCloseWords`' list. */
function shellLabel(sh: SessionShell): string {
  if (sh.description) return sh.description;
  const words = sh.command.trim().split(/\s+/).slice(0, 3).join(" ");
  return words || "shell";
}

/**
 * One sentence for a close/stop confirm: "stops 3 background shells —
 * emulator, 2 wait loops".
 *
 * `workers === 0` stands in for "wait loop" here rather than the time-based
 * bucket, deliberately — there is no `now` on this signature, because a close
 * confirm is about what WILL be stopped, not how long each has been quiet.
 * Real workers get named individually (their own label); the rest are folded
 * into one count, so a fan-out of ten idle wrapper shells does not bury the
 * one that is actually running something. A `foreground` shell is left out
 * entirely — closing the session ends the turn (and it) anyway, and it was
 * never a background shell this sentence is about.
 */
export function shellCloseWords(summary: ShellsSummary, list: SessionShell[]): string {
  if (!summary.total) return "";
  const labels: string[] = [];
  let waitLoops = 0;
  for (const sh of list) {
    if (sh.foreground) continue;
    if (sh.workers === 0) { waitLoops++; continue; }
    labels.push(shellLabel(sh));
  }
  if (waitLoops) labels.push(waitLoops === 1 ? "1 wait loop" : `${waitLoops} wait loops`);
  const noun = summary.total === 1 ? "background shell" : "background shells";
  return `stops ${summary.total} ${noun}${labels.length ? ` — ${labels.join(", ")}` : ""}`;
}
