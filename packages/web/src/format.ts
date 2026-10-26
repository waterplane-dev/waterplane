/**
 * Display formatting: the small pure functions that turn a timestamp, a byte
 * string or a repo name into something a phone screen can show.
 *
 * They were spread through the top of `App.tsx` and shared nothing with it but
 * proximity. Here they are testable and, more to the point, out of the file
 * everything else in the app also lives in.
 *
 * Two deliberate quirks worth keeping:
 *  - `ago` ROUNDS while `dur` FLOORS. "5m ago" reads better rounded; an elapsed
 *    counter that jumps to "1h" at 30 minutes reads as a bug.
 *  - `usageTitle` always carries the RESET instant with the percentage. A
 *    percentage alone cannot be acted on — 90% of the 5-hour window with twelve
 *    minutes left is a coffee, the same number with four hours left is a plan
 *    change.
 */
import { NO_REPO_COLORS, repoHueIn, type RepoColors } from "@waterplane/shared";
import type { SessionInfo, UsageInfo } from "@waterplane/shared";
import type React from "react";

export const baseName = (p: string) => p.split(/[/\\]/).filter(Boolean).pop() || p;

/**
 * A file size, DECIMAL — the same 1000-based units the host prints
 * (`host/main.ts`'s own `fmtSize`) and the same ones the phone's file manager
 * and the Downloads notification show for the file this app just saved.
 *
 * There were FIVE byte formatters in this package and they disagreed, so one
 * artifact rendered three different sizes depending on which screen you were
 * looking at: `fmtSize` verbatim in `BuildSheet`, `PullSheet` and `FilesSheet`
 * (decimal, "KB"), `ArchiveSheet`'s `size` (BINARY, also spelled "KB"), and
 * `uploadScale`'s `fmtBytes` (binary, "kB"). The last one is the reason this is
 * a consolidation and not a tidy-up: `persist.ts` exported a DIFFERENT function
 * under that same name `fmtBytes`, so which of the two a file got was decided
 * by which module it happened to import from — a rename in either would have
 * been silently absorbed by the other.
 *
 * Binary units are still right for one thing, and it is not a file: see
 * `fmtStorage`.
 */
export const fmtSize = (b: number): string =>
  b >= 1e9 ? `${(b / 1e9).toFixed(1)} GB`
  : b >= 1e6 ? `${(b / 1e6).toFixed(1)} MB`
  : b >= 1e3 ? `${Math.round(b / 1e3)} KB`
  : `${b} B`;

/**
 * A STORAGE figure, BINARY — for `navigator.storage.estimate()` alone, which
 * reports in binary units; showing its quota in decimal would misreport the
 * browser's own number back to the user. Named apart from `fmtSize` on purpose:
 * the two are not interchangeable, and the old pair proved that sharing a name
 * across two modules is how they get swapped by accident.
 */
export function fmtStorage(n: number | undefined): string {
  if (n == null) return "—";
  const units = ["B", "KB", "MB", "GB"];
  let v = n, i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${v >= 10 || i === 0 ? Math.round(v) : v.toFixed(1)} ${units[i]}`;
}

/**
 * The accent HUE for a repo name — same repo, same hue, everywhere (group
 * headers, session rows, the tab strip), so repos are told apart at a glance
 * while scrolling.
 *
 * A hue and not a colour, deliberately. It used to return the whole
 * `hsl(h 65% 60%)`, and 60% lightness is a value picked for a near-black page:
 * on the white panel light mode paints, the same string is between 2.3:1 and
 * 3:1 for most hues — a repo name nobody can read. Saturation and lightness are
 * therefore `--repo-sat` / `--repo-lit` in `styles.css`, stated once per theme,
 * and this function contributes only the part that is a fact about the NAME.
 * The side benefit is that a theme switch needs no re-render: the same inline
 * style resolves to a different colour by itself.
 *
 * **The angle itself is `shared/repocolor.ts`'s now**, and this is a thin read
 * of the CONFIG that module defines: a hue out of a ring chosen for separation,
 * or the one a person pinned. The old body — `hash * 137.508 % 360` — spread
 * consecutive inputs and nothing else, so two repo names landed 9° apart about
 * as readily as 100°, which in a tab strip 34 px tall is one colour.
 *
 * The config is held HERE as a module value rather than passed in, because
 * every call site is a `style=` in the middle of a render and none of them has
 * any business knowing about a settings store. `repoColors.ts` is the one
 * writer (it also owns the re-render), and the fallback is the default ring —
 * so a module that loads before the store, or a test importing this file
 * alone, still gets a stable colour rather than none.
 */
let colorCfg: RepoColors = NO_REPO_COLORS;
/** `repoColors.ts` only: the config every `repoHue` below reads. */
export function setRepoColorCfg(cfg: RepoColors): void { colorCfg = cfg; }
export function repoHue(name: string): number { return repoHueIn(name, colorCfg); }

/** Inline style carrying the repo hue as a CSS var (consumed in styles.css). */
export function repoAccentStyle(name: string): React.CSSProperties {
  const h = repoHue(name);
  // Both, on purpose. `--repo-hue` is the raw number, and `--repo-accent` is
  // the colour built from it — written here as a string that still contains
  // `var()`, so the saturation and lightness are resolved from the CASCADE when
  // the property is finally used, not now. That is what makes one inline style
  // correct in both themes with no re-render, while leaving `--repo-accent`
  // genuinely UNSET on rows that name no repo, which is what the
  // `var(--repo-accent, transparent)` fallbacks throughout `styles.css`
  // depend on to stay uncoloured.
  return {
    "--repo-hue": `${h}`,
    "--repo-accent": `hsl(${h} var(--repo-sat) var(--repo-lit))`,
  } as React.CSSProperties;
}

/**
 * Compact "how long ago" label — the ONE of these in the app.
 *
 * There were eight: `ArchiveSheet`, `HistorySheet`, `FilesSheet`, `LimitSheet`,
 * `SearchSheet`, `QuestionsSheet`, `ScheduleSheet` and `UsageSheet` each wrote
 * their own, differing in whether they rounded or floored and in where they
 * stopped counting. Nothing breaks when eight of these disagree, which is
 * exactly why they stayed disagreeing: two screens showing the same instant as
 * "59m ago" and "1h ago" reads as two different instants, and there is no test
 * that can notice.
 *
 * The month tier is the archive's doing: a conversation log is routinely months
 * old, and "412d ago" is a number nobody converts. `agoText` in
 * `useRemoteResource.ts` is deliberately NOT this function — it takes a
 * DURATION and phrases it for a staleness sentence ("4 min ago", "just now"),
 * where this takes an INSTANT and phrases it for a row.
 */
export function ago(ts: number): string {
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.round(h / 24);
  if (d < 60) return `${d}d ago`;
  return `${Math.round(d / 30)}mo ago`;
}


/**
 * How long a session has been inactive, in ms — the metric the bulk-close
 * "only the stale ones" option filters on. An EXITED session counts as
 * infinitely inactive (there is no process left to interrupt). A running one is
 * measured from `idleSince` (set when the CLI went quiet / finished its turn,
 * and also set while it sits parked on a prompt); a turn in flight, or a
 * session that has never gone idle, counts as active (0).
 */
export function inactiveMs(s: SessionInfo): number {
  if (!s.running) return Infinity;
  if (s.turnActive) return 0;
  // `lastTurnAt` FIRST: it is when the CLI last wrote a turn, read off its own
  // log, so it survives a host restart. `idleSince` is stamped by the daemon
  // four seconds after any output, and a tmux re-attach repaints every pane —
  // which made every session on a restarted host read as "quiet since just now"
  // and the bulk-close cutoffs useless on exactly the hosts that need them.
  if (s.lastTurnAt) return Date.now() - s.lastTurnAt;
  return s.idleSince ? Date.now() - s.idleSince : 0;
}

/**
 * Whether `inactiveMs`'s answer for this session is actually READ off
 * something, rather than a restart artifact standing in for it. Measured on
 * the live host: 10 of 107 running sessions have no `claudeSessionId`, so the
 * host correctly publishes no `lastTurnAt` for them — and the fallback,
 * `idleSince`, is stamped by the tmux re-attach repaint on every host
 * restart. A session quiet for days then reads as "quiet since just now",
 * silently exempting it from a "only inactive > 1h" cutoff.
 *
 * `inactiveMs` itself stays as it is on purpose — the number it returns is
 * CONSERVATIVE (it never closes something active) and that is the right
 * failure mode for a destructive filter. This function exists only so the
 * bulk-close dialog can say what it does not know, instead of stating a count
 * as if it had measured everyone. It cannot tell an honest `idleSince` from a
 * restart-stamped one — the client has no way to — so it does not try: any
 * running, non-mid-turn session with no `lastTurnAt` is UNKNOWN.
 */
export function inactivityKnown(s: SessionInfo): boolean {
  if (!s.running) return true; // exited ⇒ Infinity, a real answer
  if (s.turnActive) return true; // mid-turn ⇒ 0, a real answer
  return s.lastTurnAt != null;
}

// Elapsed since a start time, compact ("45s" / "12m" / "3h" / "2d"). No "ago".
export function dur(ms: number): string {
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}

/** "just now" / "4 min ago" / "2 h ago" / "3 d ago". */
export function agoText(ms: number): string {
  if (ms < 45_000) return "just now";
  const m = Math.round(ms / 60_000);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h} h ago`;
  return `${Math.round(h / 24)} d ago`;
}

/**
 * An elapsed SPAN between two instants (`to` defaults to now), floored to the
 * second and never past minutes: "45s" / "2m 5s". Distinct from `dur` on
 * purpose — that one counts up from a start to hours and days with no seconds
 * after the minute; this is a build run's stopwatch.
 */
export function durSpan(from: number, to?: number): string {
  const s = Math.max(0, Math.round(((to ?? Date.now()) - from) / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return `${m}m ${s % 60}s`;
}

/** A local-only unique id: `<prefix>_<time>_<counter>`. `crypto.randomUUID` is
 *  unavailable over plain-http Tailscale (not a secure context), and these only
 *  have to be unique on this phone. One counter serves every prefix. */
let idSeq = 0;
export function seqId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}_${(idSeq++).toString(36)}`;
}

/** Drop ANSI escapes (CSI + OSC window titles) and turn bare CRs into newlines,
 *  so tool output does not render as garbage in a log pane. */
const ANSI = /\x1b(?:\[[0-9;?]*[ -/]*[@-~]|\][^\x07\x1b]*(?:\x07|\x1b\\))/g;
export const stripAnsi = (s: string): string => s.replace(ANSI, "").replace(/\r(?!\n)/g, "\n");

/** `v` held inside [lo, hi]. */
export const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));

export function b64ToStr(b64: string): string {
  return new TextDecoder().decode(Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)));
}

/** The bare local time, "3:05 PM" — no weekday however far off. */
export const clock = (ts: number): string => new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

/** "3:05 PM"-style local time for schedule chips; adds the weekday ("Tue 3:05 PM")
 *  once the moment is >20h out so a far-off time can't read as today's. */
export function hhmm(ts: number): string {
  const t = clock(ts);
  if (ts - Date.now() > 20 * 3600e3) return `${new Date(ts).toLocaleDateString([], { weekday: "short" })} ${t}`;
  return t;
}

/** "1 build" / "3 builds"; `many` for irregular plurals. */
export const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;

/** Compact "how long until" — the countdown half of a reset readout. */
export function until(ts: number): string {
  const s = Math.round((ts - Date.now()) / 1000);
  if (s <= 0) return "now";
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return m % 60 ? `${h}h ${m % 60}m` : `${h}h`;
  return `${Math.floor(h / 24)}d ${h % 24}h`;
}

/**
 * Tooltip shared by every usage readout: both windows, each with WHEN it
 * resets. A percentage on its own can't be acted on — 90% of the 5-hour window
 * with twelve minutes left on it is a coffee, the same number with four hours
 * left is a plan change — so the reset instant travels with the number
 * everywhere the number is shown. Absent (the screen didn't say, or the weekly
 * one named no date) simply prints nothing rather than a guessed day.
 */
export function usageTitle(u: UsageInfo | null): string {
  const win = (label: string, pct: number | null | undefined, reset: number | null | undefined) =>
    `${label} ${pct != null ? `${pct}%` : "?"}${reset ? ` · resets ${hhmm(reset)} (in ${until(reset)})` : ""}`;
  return `Claude usage — ${win("5-hour session", u?.sessionPct, u?.sessionResetAt)}`
    + ` · ${win("week", u?.weeklyPct, u?.weeklyResetAt)}`
    + `${u?.checkedAt ? ` · checked ${ago(u.checkedAt)}` : ""}`;
}


// info.model may be a launch alias ("opus") or, once the host reads the running
// model back from the transcript, a full id ("claude-opus-4-8"). Drop the noisy

/**
 * An INSTANT, stated absolutely and as briefly as it can be stated without
 * becoming ambiguous — "14:32" today, "Wed 14:32" inside the last week,
 * "6 Sep 14:32" before that, with the year once the year differs.
 *
 * `ago` is not a substitute for it, which is the whole reason this exists: a
 * list of five identically-named build runs, every one of them labelled with a
 * duration ("17s · 2 artifacts") and nothing else, cannot be read at all — the
 * rows differ only in an ordering the reader has to take on trust. "3h ago"
 * fixes that for today and stops helping the moment two rows land in the same
 * bucket, which for builds of the same command is the normal case. An absolute
 * stamp never collides with itself.
 *
 * It is deliberately NOT `hhmm`: that one phrases a moment in the FUTURE (it
 * adds a weekday once a scheduled time is far enough out that it could be
 * mistaken for today's), and it stops at a weekday because nothing is scheduled
 * a year out. This one looks backwards, where a month and a year are ordinary.
 */
export function when(ts: number): string {
  const d = new Date(ts);
  const now = new Date();
  const t = d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  if (d.toDateString() === now.toDateString()) return t;
  const days = (now.getTime() - ts) / 86400e3;
  // A weekday alone is only unambiguous inside a six-day window — "Wed" seven
  // days back is this Wednesday to every reader.
  if (days >= 0 && days < 6) return `${d.toLocaleDateString([], { weekday: "short" })} ${t}`;
  const date = d.toLocaleDateString([], {
    day: "numeric",
    month: "short",
    ...(d.getFullYear() !== now.getFullYear() ? { year: "numeric" } : {}),
  });
  return `${date} ${t}`;
}

/**
 * Whether a session has a CONVERSATION in it, or is an empty shell somebody
 * opened and never typed into.
 *
 * Three answers, not two, for `inactivityKnown`'s reason: the dangerous one
 * here is calling a week-old conversation "never started" on a bulk-close
 * button, so the question is only ANSWERED where a first turn would certainly
 * have left a mark.
 *
 *  - `started` — something is positively on the record: a turn in flight, a
 *    dated turn in the CLI's own log, a prompt in the host's history, or a
 *    context reading (the gauge only prints once the window has something in
 *    it).
 *  - `fresh`   — none of that AND the conversation id is known, which is the
 *    case that makes the absence a measurement: a fresh claude session is
 *    launched with `--session-id`, so the id is known up front and the log is
 *    simply not there yet.
 *  - `unknown` — none of that and NO id. That is what a `--continue` / `pick`
 *    resume looks like before the daemon has matched a log to it: the
 *    conversation exists, nothing about it is readable yet, and it must not be
 *    counted as empty.
 */
export type ConvoStart = "started" | "fresh" | "unknown";

export function convoStart(s: SessionInfo): ConvoStart {
  if (s.turnActive) return "started";
  if (s.lastTurnAt != null) return "started";
  if (s.firstPrompt || s.lastPrompt) return "started";
  if (s.contextUsedTok != null || s.contextLeft != null) return "started";
  if ((s.contextSpark?.pts?.length ?? 0) > 0) return "started";
  return s.claudeSessionId || s.backendSessionId ? "fresh" : "unknown";
}

/**
 * Compact token + cost formatting for the metering display (`metered … calls
 * · … tok · $…`) and the header's context-window chip.
 *
 * NOT `@waterplane/shared`'s `fmtTok`/`fmtUsd`, and deliberately not swapped for them
 * in this move: those round tokens to whole `k` (`1234` → `1k`, here `1.2k`)
 * and give cents from `$0.01` up (here from `$1`), so swapping would change
 * what these two screens say. Lifted from `App.tsx` unchanged.
 */
export const fmtTok = (n: number) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}k` : String(n));
export const fmtUsd = (n: number) => (n >= 1 ? `$${n.toFixed(2)}` : n > 0 ? `$${n.toFixed(4)}` : "$0");
