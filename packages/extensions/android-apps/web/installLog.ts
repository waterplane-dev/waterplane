/**
 * **What installed itself, on which phone** — the client half of the install log.
 *
 * The asymmetry this exists for: **there is one desktop and there may be many
 * phones.** A build produced on the host is fetched by every device whose
 * allow-list names its package and installed by each of them with the app
 * closed — so the only record of an install is a row in the phone that did it,
 * and "which version of what is on which device" is a question no single device
 * can answer. The host keeps the log (`host/installlog.mts`); this module is how
 * a phone tells it, and how a screen reads it back.
 *
 * Transport (`shared/wire.mts`): `plugin.call` both ways round. The phone's report goes up in
 * idempotent CHUNKS (`chunkReport`: a call carries 64 KB), the host answers a report with a receipt
 * and NEVER the document, and tells every phone "it changed" with one tiny push — on which the phone
 * PULLS the log (`log`). No log travels in a push.
 *
 * Three rules, each of which is the whole reason a line of this file exists:
 *
 *  - **A report is a re-statement, not an event.** The install worth logging is
 *    the one that happened at 3 a.m. with the tunnel down, which means the
 *    report cannot be sent when it happens. So the phone sends EVERYTHING it
 *    still holds, on every connect, and the host merges on a key the phone can
 *    reproduce. Nothing is queued and nothing carries an ackId — the delivery
 *    is already idempotent, and a queued copy would only repeat what the next
 *    connect says anyway.
 *  - **The phone's own clock, or nothing.** `installedAt` comes off the shell.
 *    A shell too old to stamp it sends no `at` at all rather than the moment the
 *    page happened to notice, which would put "installed at breakfast" in the
 *    log for something that landed overnight.
 *  - **It decides nothing.** No install is started here, no allow-list is
 *    touched, nothing is refused. It is an account of what already happened
 *    (`CLAUDE.md`: nothing applies itself).
 *
 * Who calls it: the manifest's `boot` (`startInstallLog`) and `pushes` — never only a mounted sheet:
 * `App.tsx` returns early once per overlay, so a store mounted inside it is missing from whichever
 * sheet somebody writes next. Nothing here needs a component: `records` is an argument, never read
 * from a hook.
 */
import {
  core, deviceId, deviceModel, deviceName, isExtensionEnabled, pluginClient, setDeviceName, watchConnStatus,
  watchExtensionEnabled, watchPullRecords, type PullRecord,
} from "@waterplane/sdk";
import {
  chunkReport, installReportFrom,
  type AndroidAppsMethods, type InstallReporter, type InstallReportRow,
} from "../shared/wire.mts";
import { loadCachedLog, setLog, type InstallLogState } from "./state.ts";

const client = pluginClient<AndroidAppsMethods>("android-apps");

export type { InstallLogState };

// ── this device ──────────────────────────────────────────────────────

/**
 * What this phone is called in the log: the one name pairing holds too (`deviceName`, core's
 * `LS.deviceName`), else nothing — and the log then falls back to the model and finally to a
 * shortened id (`deviceLabel`), never to a blank.
 */
export function logDeviceName(): string {
  return deviceName();
}

/** Name this phone — the name pairing uses as well (`setDeviceName`), so there is one name, not two. */
export function setLogDeviceName(name: string, records: readonly PullRecord[]): void {
  setDeviceName(name);
  // Re-report at once: the name rides on every entry, so the log can show the
  // new one the moment it is typed rather than after the next install.
  void reportInstalls(records, true);
}

export { deviceModel };

// ── reporting ────────────────────────────────────────────────────────

/** This phone's download rows in the shape the shared fold reads. A mapping,
 *  never a second set of rules: which rows count is `installReportFrom`'s
 *  judgement and is pinned by its own test. */
export function reportRows(records: readonly PullRecord[]): InstallReportRow[] {
  return records.map((r) => ({
    id: r.item.id,
    name: r.item.name,
    repo: r.item.repoName,
    pkg: r.pkg,
    label: r.pkgLabel,
    version: r.pkgVersion,
    install: r.install,
    installError: r.installError,
    installedAt: r.installedAt,
    installAuto: r.installAuto,
  }));
}

/** What the last report said, so an unchanged one is not re-sent on every
 *  repaint of the download queue. The HOST is idempotent either way; this is
 *  only about not spending the link on news nobody has. */
let lastSent = "";

/**
 * Tell the desktop what this phone has installed.
 *
 * Silent with no socket: the next connect re-sends everything, which is the
 * whole design. `force` is for the moments where the payload is unchanged but
 * the RECIPIENT is new — a reconnect, where the host may be a different
 * desktop, or one that has been restarted onto an empty store.
 */
export async function reportInstalls(records: readonly PullRecord[], force = false): Promise<void> {
  if (core().conn.status !== "open") return;
  const id = deviceId();
  if (!id || id === "unknown") return;   // a report nobody can attribute is not one
  const entries = installReportFrom(reportRows(records));
  if (!entries.length && !force) return;
  const name = logDeviceName();
  const model = deviceModel();
  const device: InstallReporter = { id, ...(name ? { name } : {}), ...(model ? { model } : {}) };
  const wire = JSON.stringify({ device, entries });
  if (!force && wire === lastSent) return;
  lastSent = wire;
  // Chunks one after another: a union by entry key, so a failed middle chunk costs nothing the next
  // report does not repair. A chunk that errors stops the rest and forgets `lastSent` — it was not told.
  for (const chunk of chunkReport(device, entries)) {
    const res = await client.call("report", chunk);
    if (!res.ok) { lastSent = ""; return; }
  }
}

// ── reading ──────────────────────────────────────────────────────────

let reading: Promise<void> | null = null;
/** Pull the log (idempotent, joined while one is in flight). Silent with no socket. */
export function readInstallLog(): Promise<void> {
  loadCachedLog();
  if (core().conn.status !== "open") return Promise.resolve();
  if (reading) return reading;
  reading = client.read("log", undefined).then((res) => {
    if (res.ok && Array.isArray(res.result?.entries)) setLog(res.result);
  }).finally(() => { reading = null; });
  return reading;
}

/** The host's one push, `changed`: the log moved, so read it again. */
export function onChanged(): void { void readInstallLog(); }

/**
 * A new socket is a new conversation, and possibly a different desktop — one restarted, or restored
 * from a backup that predates last night's installs. So the whole history goes again, unconditionally:
 * that is what makes an install that happened with the tunnel down eventually land. Then the log is read.
 */
export function onConnected(records: readonly PullRecord[]): void {
  lastSent = "";
  void reportInstalls(records, true).then(() => readInstallLog());
}

/**
 * Attach the log to the link, from the manifest's `boot` — once, for the page's life, with no sheet
 * mounted (the job core's `main.tsx` did before the cutover). Reports and reads only while the
 * extension is ON: with it off the host has no `report` to answer. A connect (or the switch coming on
 * while connected) re-sends everything and reads the log; a download row changing re-reports.
 * Returns the cleanup.
 */
export function startInstallLog(): () => void {
  // The cache first, before any watcher can fire: here and not in a render, because it may set the store.
  loadCachedLog();
  let records: readonly PullRecord[] = [];
  let open = false;
  let on = isExtensionEnabled("android-apps");
  const unRecords = watchPullRecords((r) => { records = r; if (open && on) void reportInstalls(r); });
  const unStatus = watchConnStatus((s) => {
    const was = open;
    open = s === "open";
    if (open && !was && on) onConnected(records);
  });
  const unOn = watchExtensionEnabled("android-apps", (v) => {
    const was = on;
    on = v;
    if (on && !was && open) onConnected(records);
  });
  return () => { unRecords(); unStatus(); unOn(); };
}
