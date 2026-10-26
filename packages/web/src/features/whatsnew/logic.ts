/**
 * What's new, pure: the row shape, the facts a row's state is read from, and
 * the few decisions the sheet and the launcher row make, and — at the foot —
 * the rows themselves (`RELEASES`). No React, no icons: `logic.test.mjs` pins
 * every sentence.
 *
 * **A fact not read is null, and a null fact draws no state line** — never a
 * guess: the row then shows its title, its line and its default door.
 */
import type { WeekBurnStatus } from "@waterplane/shared";
import type { SheetId } from "../../sdk";
import { APK_0_1_8, apkNeedWords, apkOk, cmpVersion, versionParts } from "../../apkGate.ts";
import { SHEET } from "../../sheetNames.ts";
import { plural } from "../../format.ts";

/** Where a row's verb goes. Every door opens a screen; none changes anything. */
export type Door =
  | { kind: "sheet"; id: SheetId }
  | { kind: "setting"; id: string }
  | { kind: "bell" }
  /** The whole feed, any earlier cut cleared. */
  | { kind: "feed" }
  | { kind: "feedCut"; ids: string[] }
  | { kind: "automationCut"; ids: string[]; label: string }
  | { kind: "git"; repoId: string }
  | { kind: "build"; repoId: string };

/** One failed pull, push or build still on a repo — a feed item the repo's red chip stands for. */
export interface Failure { id: string; repoId: string; repoName: string; verb: string; kind: "git" | "build" }

/** A schedule rule, as much of it as a state line reads. */
export interface Clock { id: string; enabled: boolean; nextAt: number | null; isBuild: boolean }

/** Everything already on the phone. null = not read (no state line). */
export interface HubFacts {
  now: number;
  needsYou: number | null;
  pushInfo: boolean | null;
  failures: Failure[] | null;
  /** The rule list; null when the phone holds none (an empty list is a claim this sheet does not make). */
  clocks: Clock[] | null;
  /** `GET /api/weekburn`, fresh reads only. */
  weekburn: WeekBurnStatus | null;
  /** The shell's "keep only the Downloads copy" switch; null = not asked or not held. */
  dropCopy: boolean | null;
  /** Running inside the Android shell. */
  native: boolean;
  /** The shell's `versionName`; null = not read yet (or no shell). */
  apk: string | null;
}

export interface RowState { text: string; door?: Door | null; verb?: string }

export interface NewThing {
  id: string;
  /** ≤ 4 words. */
  title: string;
  /** One sentence, ≤ 90 chars. */
  line: string;
  /** The shell's versionName must be at least this (`apkGate.ts`). */
  needsApk?: string;
  /** Which feature's own icon the sheet draws (mapped there: a lucide import is not pure). */
  icon: "bell" | "push" | "failed" | "automation" | "buildclock" | "downloads" | "burn" | "taps" | "sync";
  /** null = no default door (a row whose only door is the APK gate). */
  door: Door | null;
  verb: string | null;
  state?: (f: HubFacts) => RowState | null;
}

export interface Release { version: string; things: NewThing[] }

/** What a row draws: the state line (or none), and the one door with its verb (or none). */
export interface RowView { text: string | null; door: Door | null; verb: string | null }

export function rowView(t: NewThing, f: HubFacts): RowView {
  if (t.needsApk) {
    if (!f.native) return { text: "app only", door: null, verb: null };
    if (f.apk !== null && !apkOk(t.needsApk, f.apk)) {
      return { text: apkNeedWords(t.needsApk, f.apk), door: { kind: "sheet", id: "apps" }, verb: "get the APK" };
    }
    if (f.apk === null) return { text: null, door: t.door, verb: t.verb };
  }
  const s = t.state?.(f) ?? null;
  if (!s) return { text: null, door: t.door, verb: t.verb };
  const door = s.door === undefined ? t.door : s.door;
  return { text: s.text, door, verb: door ? (s.verb ?? t.verb) : null };
}

/** "0.1.8" out of "v0.1.8-dev"; "" when unreadable. */
export function normVersion(v: string | null | undefined): string {
  return v ? versionParts(v).join(".") : "";
}

/** The release with rows for this desktop version, or null. */
export function releaseFor(releases: readonly Release[], version: string | null | undefined): Release | null {
  const v = normVersion(version);
  return (v && releases.find((r) => cmpVersion(r.version, v) === 0)) || null;
}

/** Which release the sheet opens on: the desktop's, else the newest. */
export function pickRelease(releases: readonly Release[], version: string | null | undefined): Release | null {
  return releaseFor(releases, version) ?? releases[0] ?? null;
}

/** Same reading as onboard's `neverRanSession` (features may not import each other). */
export function isFreshPhone(f: { sessions: number; recent: number; closed: number }): boolean {
  return f.sessions === 0 && f.recent === 0 && f.closed === 0;
}

/**
 * When the desktop's version has no rows, the sheet falls back to the newest release: say so.
 * Null when the desktop's version has rows, or the host has not said its version.
 */
export function fallbackNote(releases: readonly Release[], desktop: string | null | undefined): string | null {
  const v = normVersion(desktop);
  if (!v || releaseFor(releases, v) || !releases[0]) return null;
  return `Nothing written for ${v} yet — below is ${releases[0].version}.`;
}

/** The one-time launcher row's release: the desktop's version has rows and this phone has not been told. */
export function announce(releases: readonly Release[], desktop: string | null | undefined, seen: string, fresh = false): Release | null {
  if (fresh) return null; // a phone that never ran a session has nothing "new" to be told
  const r = releaseFor(releases, desktop);
  return r && normVersion(desktop) !== normVersion(seen) ? r : null;
}

/** Rows this phone's shell is too old for (0 in a browser or before the shell answered). */
export function apkShort(r: Release, f: Pick<HubFacts, "native" | "apk">): number {
  if (!f.native || f.apk === null) return 0;
  return r.things.filter((t) => t.needsApk && !apkOk(t.needsApk, f.apk!)).length;
}

/** "waterplane 0.1.8 is on the desktop · 8 new things, 2 need the new APK". */
export function launcherLine(app: string, r: Release, f: Pick<HubFacts, "native" | "apk">): string {
  const n = r.things.length;
  const short = apkShort(r, f);
  return `${app} ${r.version} is on the desktop · ${n} new thing${n === 1 ? "" : "s"}${short ? `, ${short} need${short === 1 ? "s" : ""} the new APK` : ""}`;
}

/**
 * The failure items as repos and verbs, from their attention keys (`git:<repo>:<verb>`,
 * `build:<repo>:<buildId>`). An item whose key does not parse is left out of the words AND the cut.
 */
export function failuresOf(items: readonly { id: string; key?: string }[], repoName: (repoId: string) => string | null): Failure[] {
  const out: Failure[] = [];
  for (const n of items) {
    const m = /^(git|build):(.+):([^:]+)$/.exec(n.key ?? "");
    if (!m) continue;
    const kind = m[1] as "git" | "build";
    out.push({ id: n.id, repoId: m[2], repoName: repoName(m[2]) ?? m[2], verb: kind === "git" ? m[3] : "build", kind });
  }
  return out;
}

/** "3h", "2d 4h", "40m" — how long until, from a handed-in `now` (format.ts `until` reads Date.now(), which a pure test cannot pin). */
export function inShort(ms: number): string {
  const m = Math.max(0, Math.round(ms / 60_000));
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  const d = Math.floor(h / 24);
  return h % 24 ? `${d}d ${h % 24}h` : `${d}d`;
}

// ── The rows ─────────────────────────────────────────────────────────────
// Hand-written per release. Not the CHANGELOG (prose, not in the bundle): each
// row is one new thing, the state it reads off facts this phone already holds,
// and the door to the exact place. Newest release first; the sheet keeps the
// current and the previous one.

// Handed-in-free but kept local: format.ts `when` is a past-looking readout ("Wed" for days back); this is a future one.
const weekday = (ts: number) => {
  const d = new Date(ts);
  return `${d.toLocaleDateString([], { weekday: "short" })} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
};

export const RELEASES: readonly Release[] = [
  {
    version: "0.1.8",
    things: [
      {
        id: "bell-needs-you", icon: "bell", title: "Bell = needs you",
        line: "Only what needs you counts on the bell and buzzes; information stays in the feed.",
        door: { kind: "feed" }, verb: "open the feed",
        state: (f) => f.needsYou === null ? null
          : f.needsYou > 0
            ? { text: `${f.needsYou} need${f.needsYou === 1 ? "s" : ""} you`, door: { kind: "bell" }, verb: f.needsYou === 1 ? "open it" : `open those ${f.needsYou}` }
            : { text: "nothing needs you" },
      },
      {
        id: "push-info", icon: "push", title: "Push information too",
        line: "Receipts (a push that went through, a new file) push only when this is on.",
        door: { kind: "setting", id: "notif-info-push" }, verb: "change it",
        state: (f) => f.pushInfo === null ? null : { text: f.pushInfo ? "on" : "off" },
      },
      {
        id: "repo-failures", icon: "failed", title: "Failures on the repo",
        line: "A failed pull, push or build stays as a red chip on that repo until fixed or done.",
        door: { kind: "feed" }, verb: "open the feed",
        state: (f) => {
          const x = f.failures;
          if (x === null) return null;
          if (!x.length) return { text: "nothing has failed", door: null };
          if (x.length === 1) {
            const one = x[0];
            return { text: `${one.repoName} ${one.verb} failed`, door: { kind: one.kind, repoId: one.repoId }, verb: one.kind === "git" ? "open git" : "open build" };
          }
          const names = x.slice(0, 3).map((y) => `${y.repoName} ${y.verb}`).join(", ") + (x.length > 3 ? ", …" : "");
          return { text: `${x.length} failed: ${names}`, door: { kind: "feedCut", ids: x.map((y) => y.id) }, verb: `see those ${x.length}` };
        },
      },
      {
        id: "automation", icon: "automation", title: `${SHEET.automation} (was Schedules)`,
        line: "Clocks above, and a foot for what runs on its own without one.",
        door: { kind: "sheet", id: "schedule" }, verb: `open ${SHEET.automation}`,
        state: (f) => {
          if (!f.clocks?.length) return null;
          const next = f.clocks.filter((c) => c.enabled && c.nextAt !== null).map((c) => c.nextAt!).sort((a, b) => a - b)[0];
          return next === undefined ? { text: "nothing armed" } : { text: `next one fires in ${inShort(next - f.now)}` };
        },
      },
      {
        id: "build-clock", icon: "buildclock", title: "Builds on a clock",
        line: "“run on a clock” sits in a build entry's editor; the entry then shows its clock.",
        door: { kind: "sheet", id: "schedule" }, verb: `open ${SHEET.automation}`,
        state: (f) => {
          if (!f.clocks?.length) return null;
          const ids = f.clocks.filter((c) => c.isBuild).map((c) => c.id);
          if (!ids.length) return { text: "none yet" };
          return {
            text: `${plural(ids.length, "build")} on a clock`,
            door: { kind: "automationCut", ids, label: "builds on a clock" },
            verb: ids.length === 1 ? "see it" : `see those ${ids.length}`,
          };
        },
      },
      {
        id: "downloads-once", icon: "downloads", title: "Downloads kept once", needsApk: APK_0_1_8,
        line: "A file in the phone's Downloads is not kept a second time inside the app.",
        door: { kind: "sheet", id: "pull" }, verb: "downloads",
        state: (f) => f.dropCopy === null ? null : { text: f.dropCopy ? "on" : "off" },
      },
      {
        id: "weekburn", icon: "burn", title: SHEET.weekburn,
        line: "Pick repos to spend the week's leftover budget on; picking is the approval.",
        door: { kind: "sheet", id: "weekburn" }, verb: "open the burn",
        state: (f) => {
          const w = f.weekburn;
          if (!w || !w.available) return null;
          if (w.pickedThisWeek && w.prefs.repos.length) {
            return { text: `${w.prefs.repos.length} picked${w.plan ? ` · starts ${weekday(w.plan.startAt)}` : ""}` };
          }
          return { text: `nothing picked${w.weeklyResetAt ? ` · resets in ${inShort(w.weeklyResetAt - f.now)}` : ""}` };
        },
      },
      {
        id: "shade-taps", icon: "taps", title: "Taps from the shade", needsApk: APK_0_1_8,
        line: "A notification tap opens the screen it is about, never the bare launcher.",
        door: null, verb: null,
        state: () => ({ text: "in this APK" }),
      },
    ],
  },
  {
    version: "0.1.6",
    things: [
      {
        id: "repo-sync", icon: "sync", title: "Sync every repo",
        line: "Pull, push or sync every repo from one tap.",
        door: { kind: "sheet", id: "reposync" }, verb: "open it",
      },
    ],
  },
];
