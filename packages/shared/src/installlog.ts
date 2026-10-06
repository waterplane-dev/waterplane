/**
 * **The install log's rules** — cleaning a report, merging it into the store,
 * and the sentences both ends say about it.
 *
 * Pure, so the host's store and the phone's screen cannot disagree about what
 * an entry means, and so the merge — the one part that can silently lose or
 * duplicate a person's history — is pinned by `node --test` with no daemon.
 *
 * Everything here is written against ONE assumption: **a report is a
 * re-statement of what a phone still holds, not a stream of events.** A phone
 * re-sends its whole install history on every connect, because the install it
 * most needs to report is the one that happened while the tunnel was down. So
 * merging is keyed and idempotent, and a hundred reconnects add nothing.
 */
import type {
  InstallDevice, InstallLogDoc, InstallLogEntry, InstallOutcome, InstallReportEntry, InstallReporter,
} from "./wire/install.js";

export type { InstallDevice, InstallLogDoc, InstallLogEntry, InstallOutcome, InstallReportEntry, InstallReporter };

/** How many installs the host keeps. Two phones updating four apps a day reach
 *  this in about two months, which is longer than anybody asks "when did this
 *  land" about. Oldest goes first. */
export const INSTALL_LOG_CAP = 500;

/** Caps on the strings an entry carries. None of them is a sentence a person
 *  typed — they are package names, labels and installer errors — so clipping is
 *  the right answer where refusing would lose the whole row. */
const MAX_ID = 128;
const MAX_TEXT = 120;
const MAX_ERROR = 300;
/** Entries one report may carry. A phone holds at most a couple of hundred
 *  download rows; past this something is wrong and the store is not the place
 *  to find out. */
export const MAX_REPORT_ENTRIES = 300;

/** How far ahead of the host a phone's clock may be before its `at` stops
 *  being usable. Generous: two devices that have both synced are within
 *  seconds, and the failure this catches is not skew, it is a clock that is
 *  wrong by months. */
const CLOCK_SLACK_MS = 10 * 60 * 1000;



 
const CTRL = /[\x00-\x1f\x7f]/g;

const str = (v: unknown, cap: number): string =>
  (typeof v === "string" ? v : "").replace(CTRL, " ").trim().slice(0, cap);

/** A real, whole, positive instant — or absent. A clock nobody could read is
 *  never rounded to "now": the whole point of `at` is that it is the phone's
 *  own, and a substituted one would be a wrong number wearing a right one's
 *  name. */
function when(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) && v > 0 ? Math.floor(v) : undefined;
}

/** A build number, or absent. `0` is refused on both paths — a `versionCode`
 *  of zero is not a build, and two thresholds for one field in the module that
 *  exists so the ends cannot disagree is how they start disagreeing. */
function count(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) && v > 0 ? Math.floor(v) : undefined;
}

/** The identity of one install. The `at` is in it on purpose: installing the
 *  same build twice is two things that happened, and a key that folded them
 *  together would lose the second. A shell that cannot say when falls to `0`,
 *  which folds its re-installs into one row — the honest consequence of not
 *  knowing, rather than a row per reconnect. */
export function installKey(deviceId: string, pullId: string, at?: number): string {
  // JSON rather than `a:b:c`. Neither half is shape-checked — a device id is
  // whatever the reporter sent — and with a bare separator `("a:b", "c")` and
  // `("a", "b:c")` are the same key, which is one phone's install landing on
  // another phone's row and being re-attributed to it.
  return JSON.stringify([deviceId, pullId, at ?? 0]);
}

/**
 * One reported entry, cleaned — or null where it is not an install.
 *
 * A row is dropped, never repaired, when it has no package or no recognisable
 * outcome: an entry that cannot say WHAT was installed is not a log line, it is
 * a gap pretending to be one.
 */
export function cleanInstallEntry(
  raw: unknown,
  reporter: InstallReporter,
  reportedAt: number,
): InstallLogEntry | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const outcome = r.outcome === "installed" || r.outcome === "failed" ? (r.outcome as InstallOutcome) : null;
  if (!outcome) return null;
  const pkg = str(r.pkg, MAX_ID);
  if (!pkg) return null;
  const pullId = str(r.pullId, MAX_ID);
  if (!pullId) return null;
  const deviceId = str(reporter.id, MAX_ID);
  if (!deviceId) return null;
  // An install is reported AFTER it happened, so an `at` past the moment the
  // host was told is provably not this install's instant — a phone whose clock
  // is a year fast, or a field that arrived in the wrong unit. Dropped rather
  // than clamped: the module's own rule is absent over a wrong number, and the
  // entry then says *reported*, which is true. The slack absorbs ordinary skew
  // between two devices that both believe their clocks.
  const claimed = when(r.at);
  const at = claimed !== undefined && claimed > reportedAt + CLOCK_SLACK_MS ? undefined : claimed;
  const entry: InstallLogEntry = {
    key: installKey(deviceId, pullId, at),
    deviceId,
    pullId,
    pkg,
    outcome,
    reportedAt,
  };
  // Tri-state on purpose: absent is "nobody recorded which way it went", and
  // `false` is the positive claim that a person tapped. See `wire/install.ts`.
  if (typeof r.auto === "boolean") entry.auto = r.auto;
  const name = str(reporter.name, MAX_TEXT);
  if (name) entry.deviceName = name;
  const model = str(reporter.model, MAX_TEXT);
  if (model) entry.deviceModel = model;
  const label = str(r.label, MAX_TEXT);
  if (label) entry.label = label;
  const version = str(r.version, MAX_TEXT);
  if (version) entry.version = version;
  const code = count(r.code);
  if (code !== undefined) entry.code = code;
  const file = str(r.file, MAX_TEXT);
  if (file) entry.file = file;
  const repo = str(r.repo, MAX_TEXT);
  if (repo) entry.repo = repo;
  const error = str(r.error, MAX_ERROR);
  if (error && outcome === "failed") entry.error = error;
  if (at !== undefined) entry.at = at;
  return entry;
}

/** The slice of a phone's download row a report is built from. Named here
 *  rather than taken as `PullRecord` so the fold below is pure and testable
 *  with no browser — and so the two judgements in it are pinned rather than
 *  buried in a module that imports IndexedDB. */
export interface InstallReportRow {
  id: string;
  /** The file it arrived as. */
  name?: string;
  repo?: string;
  pkg?: string;
  label?: string;
  version?: string;
  code?: number;
  install?: string;
  installError?: string;
  installedAt?: number;
  /** Absent where the shell never recorded it — carried through as absent, not
   *  flattened to `false` (`wire/install.ts` says why). */
  installAuto?: boolean;
}

/**
 * Every install a phone still has a record of, as report entries.
 *
 * Two judgements, both of which are the point:
 *
 *  - **Only a TERMINAL outcome is reported.** `asked` is the system installer
 *    waiting for a person — it may wait for hours and may never be answered —
 *    and a log that recorded it would be claiming an install that has not
 *    happened. `installing` is the same claim in the present tense.
 *  - **A row with no package is dropped.** The log's whole subject is WHICH app,
 *    and three repos on this desktop build a file called `app-debug.apk`.
 */
export function installReportFrom(rows: readonly InstallReportRow[]): InstallReportEntry[] {
  const out: InstallReportEntry[] = [];
  for (const r of rows) {
    if (r.install !== "installed" && r.install !== "failed") continue;
    if (!r.pkg || !r.id) continue;
    const entry: InstallReportEntry = {
      pullId: r.id,
      pkg: r.pkg,
      outcome: r.install,
    };
    if (typeof r.installAuto === "boolean") entry.auto = r.installAuto;
    if (r.label) entry.label = r.label;
    if (r.version) entry.version = r.version;
    const code = count(r.code);
    if (code !== undefined) entry.code = code;
    if (r.name) entry.file = r.name;
    if (r.repo) entry.repo = r.repo;
    if (r.installError) entry.error = r.installError;
    if (r.installedAt) entry.at = r.installedAt;
    out.push(entry);
  }
  return out;
}

/** When an entry HAPPENED, for sorting and for the device's own clock. The
 *  install's instant where the phone could say, else the moment it was
 *  reported — and every sentence that prints this says which it is. */
export function entryAt(e: InstallLogEntry): number {
  return e.at ?? e.reportedAt;
}

/**
 * Fold a report into the store.
 *
 * **Re-reporting is not re-recording.** An entry already held keeps its
 * original `reportedAt` — that is the moment the host first heard about it, and
 * rewriting it on every reconnect would make a week-old install look like it
 * happened at the last handshake. What a repeat MAY do is fill in facts that
 * were absent the first time (the phone learnt the app's label, or got a name
 * of its own), because absent is not a claim and an improvement is not a
 * conflict.
 *
 * Returns the new list plus what actually changed, so a caller can decide
 * whether anything is worth persisting or broadcasting.
 */
export function mergeInstallLog(
  existing: readonly InstallLogEntry[],
  incoming: readonly InstallLogEntry[],
  cap = INSTALL_LOG_CAP,
): { entries: InstallLogEntry[]; added: number; updated: number } {
  const by = new Map<string, InstallLogEntry>();
  for (const e of existing) by.set(e.key, e);
  let added = 0;
  let updated = 0;
  for (const e of incoming) {
    const had = by.get(e.key);
    if (!had) { by.set(e.key, e); added++; continue; }
    const merged: InstallLogEntry = { ...e, reportedAt: had.reportedAt };
    // Anything the old copy knew and the new one does not is KEPT: a phone that
    // has since forgotten the app's label must not erase it from the history.
    for (const k of ["deviceName", "deviceModel", "label", "version", "file", "repo"] as const) {
      if (merged[k] === undefined && had[k] !== undefined) merged[k] = had[k];
    }
    // The failure's words travel only onto a failure. On a key with no `at` — an
    // older shell, where a retry folds onto the same row — a failed install
    // followed by a successful one would otherwise come out `installed` still
    // carrying "no space", which is the one thing `cleanInstallEntry` refuses to
    // build in the first place.
    if (merged.error === undefined && had.error !== undefined && merged.outcome === "failed") {
      merged.error = had.error;
    }
    if (merged.auto === undefined && had.auto !== undefined) merged.auto = had.auto;
    if (merged.code === undefined && had.code !== undefined) merged.code = had.code;
    if (merged.at === undefined && had.at !== undefined) merged.at = had.at;
    if (!sameEntry(had, merged)) { by.set(e.key, merged); updated++; }
  }
  return { entries: evict([...by.values()], cap), added, updated };
}

/**
 * Cut the log to size — and this is the one place a client's clock must not be
 * allowed to decide anything.
 *
 * **Eviction is by `reportedAt`, which is the HOST's own stamp**; display order
 * is by `entryAt`, which prefers the install's own instant. Sorting the cut by
 * `entryAt` let a phone whose clock is a year fast hold the top of the log for
 * a year, so the rows that aged out were every other device's real history —
 * and a report can mint a new key per entry, so this was reachable by accident
 * as well as on purpose.
 *
 * **Then an equal share per device, and the remainder by recency.** Recency
 * alone lets one busy phone crowd out a phone that installs something once a
 * month, and the whole subject of this log is the fleet rather than its loudest
 * member — but a reserved share must not cost anything when there is only one
 * device, which is the ordinary case.
 */
function evict(all: InstallLogEntry[], cap: number): InstallLogEntry[] {
  const display = (a: InstallLogEntry, b: InstallLogEntry) => entryAt(b) - entryAt(a);
  if (all.length <= cap) return [...all].sort(display);
  const byRecency = [...all].sort((a, b) => b.reportedAt - a.reportedAt);
  const devices = new Set(byRecency.map((e) => e.deviceId)).size;
  const reserve = Math.max(1, Math.floor(cap / devices));
  const taken = new Map<string, number>();
  const kept: InstallLogEntry[] = [];
  const rest: InstallLogEntry[] = [];
  for (const e of byRecency) {
    const n = taken.get(e.deviceId) ?? 0;
    if (n < reserve) { taken.set(e.deviceId, n + 1); kept.push(e); } else rest.push(e);
  }
  // Whatever the shares did not spend goes by recency, so one phone on its own
  // still gets the whole cap: the share only ever costs the loudest device, and
  // only while a quieter one has history it would otherwise have pushed out.
  for (const e of rest) {
    if (kept.length >= cap) break;
    kept.push(e);
  }
  return kept.sort(display);
}

function sameEntry(a: InstallLogEntry, b: InstallLogEntry): boolean {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]) as Set<keyof InstallLogEntry>;
  for (const k of keys) if (a[k] !== b[k]) return false;
  return true;
}

/**
 * The devices, derived from the entries.
 *
 * Derived rather than stored for one reason: a device list kept beside the log
 * can disagree with it — a phone whose entries all aged out would linger as a
 * row claiming installs nobody can see. The newest entry's name wins, because a
 * rename should show up as the name that phone has NOW.
 */
export function installDevices(entries: readonly InstallLogEntry[]): InstallDevice[] {
  const by = new Map<string, InstallDevice>();
  // Newest first, so the first sighting of a device is the freshest name.
  for (const e of [...entries].sort((a, b) => entryAt(b) - entryAt(a))) {
    const cur = by.get(e.deviceId);
    if (!cur) {
      by.set(e.deviceId, {
        id: e.deviceId,
        ...(e.deviceName ? { name: e.deviceName } : {}),
        ...(e.deviceModel ? { model: e.deviceModel } : {}),
        lastAt: entryAt(e),
        installs: e.outcome === "installed" ? 1 : 0,
        failures: e.outcome === "failed" ? 1 : 0,
      });
      continue;
    }
    if (e.outcome === "installed") cur.installs++; else cur.failures++;
    if (cur.name === undefined && e.deviceName) cur.name = e.deviceName;
    if (cur.model === undefined && e.deviceModel) cur.model = e.deviceModel;
  }
  return [...by.values()].sort((a, b) => b.lastAt - a.lastAt);
}

/** What to call a device on screen: the name somebody gave it, then the model
 *  the browser admitted to, then the id — which says nothing, so it is last and
 *  is shortened, because twelve hex characters is not a name. */
export function deviceLabel(d: { id: string; name?: string; model?: string }): string {
  return d.name || d.model || `device ${d.id.slice(0, 6)}`;
}

/** The same question about an ENTRY, whose device fields are a snapshot of what
 *  that phone called itself at the time. */
export function entryDeviceLabel(e: InstallLogEntry): string {
  return deviceLabel({ id: e.deviceId, name: e.deviceName, model: e.deviceModel });
}

/** What was installed, as one name: the app's own label with the version it
 *  landed at. The package is NOT in it — three repos here build `app-debug.apk`
 *  and the package is what tells them apart, so it is its own line on screen
 *  rather than glued into this one. */
export function installTitle(e: InstallLogEntry): string {
  const name = e.label || e.pkg;
  return e.version ? `${name} ${e.version}` : name;
}

/**
 * The sentence for one entry.
 *
 * Says WHEN honestly: an install the phone timed is said as a time, and one it
 * could not is said as *reported*, which is a claim about the log rather than
 * about the install. Says WHO by name. Says whether anybody tapped.
 */
export function installLogLine(e: InstallLogEntry, fmt: (ms: number) => string): string {
  const who = entryDeviceLabel(e);
  // No clause at all where nobody recorded which way it went. "on a tap" is a
  // claim about a person, and a shell older than the field would have had every
  // unattended overnight install described as something somebody did by hand.
  const how = e.auto === undefined ? "" : e.auto ? " by itself" : " on a tap";
  const verb = e.outcome === "installed" ? "installed" : "failed to install";
  const stamp = e.at !== undefined ? fmt(e.at) : `reported ${fmt(e.reportedAt)}`;
  const tail = e.outcome === "failed" && e.error ? ` — ${e.error}` : "";
  return `${verb}${how} on ${who} · ${stamp}${tail}`;
}

/** The one line above the log. Counts devices as well as installs, because the
 *  whole reason this exists is that there is more than one phone. */
export function installLogSummary(doc: InstallLogDoc): string {
  const n = doc.entries.length;
  if (!n) return "Nothing has installed itself yet. An app on a phone's allow-list is logged here the moment a build lands on it.";
  const devices = doc.devices.length;
  const failed = doc.entries.filter((e) => e.outcome === "failed").length;
  const head = `${n} install${n === 1 ? "" : "s"} on ${devices} device${devices === 1 ? "" : "s"}`;
  return failed ? `${head} · ${failed} failed.` : `${head}.`;
}

/** The log cut to one device, or to one package. A count on a control is a
 *  filter (`CLAUDE.md`), so the screen that prints "3 on this phone" has to be
 *  able to open exactly those three. */
export function filterInstallLog(
  entries: readonly InstallLogEntry[],
  filter: { deviceId?: string; pkg?: string },
): InstallLogEntry[] {
  return entries.filter((e) =>
    (!filter.deviceId || e.deviceId === filter.deviceId)
    && (!filter.pkg || e.pkg === filter.pkg));
}
