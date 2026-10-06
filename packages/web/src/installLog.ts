/**
 * **What installed itself, on which phone** — the client half of the install log.
 *
 * The asymmetry this exists for: **there is one desktop and there may be many
 * phones.** A build produced on the host is fetched by every device whose
 * allow-list names its package and installed by each of them with the app
 * closed — so the only record of an install is a row in the phone that did it,
 * and "which version of what is on which device" is a question no single device
 * can answer. The host keeps the log (`host/installlog.ts`); this module is how
 * a phone tells it, and how a screen reads it back.
 *
 * Three rules, each of which is the whole reason a line of this file exists:
 *
 *  - **A report is a re-statement, not an event.** The install worth logging is
 *    the one that happened at 3 a.m. with the tunnel down, which means the
 *    report cannot be sent when it happens. So the phone sends EVERYTHING it
 *    still holds, on every connect, and the host merges on a key the phone can
 *    reproduce. Nothing is queued and nothing carries an ackId — the delivery
 *    is already idempotent, and a queued copy would only repeat what the next
 *    `hello` says anyway.
 *  - **The phone's own clock, or nothing.** `installedAt` comes off the shell.
 *    A shell too old to stamp it sends no `at` at all rather than the moment the
 *    page happened to notice, which would put "installed at breakfast" in the
 *    log for something that landed overnight.
 *  - **It decides nothing.** No install is started here, no allow-list is
 *    touched, nothing is refused. It is an account of what already happened
 *    (`CLAUDE.md`: nothing applies itself).
 *
 * Attached from `main.tsx` beside `startLocalRtWatch`, whose shape this
 * follows: `App.tsx` returns early once per overlay, so a store mounted inside
 * it is missing from whichever sheet somebody writes next.
 */
import type { ClientMessage, HostMessage, InstallLogDoc, InstallReportRow } from "@waterplane/shared";
import { installReportFrom } from "@waterplane/shared";
import { deviceId } from "./link";
import { lsGet, lsJson, lsSet, lsSetJson, LS } from "./storage";
import { pulls, type PullRecord } from "./pull";

/** The transport, narrowed to what this store uses — `localRt.ts`'s
 *  arrangement, so the module never learns what a WebSocket is. */
export interface InstallLogSource {
  status: "connecting" | "open" | "closed";
  send(msg: ClientMessage): void;
  on(listener: (msg: HostMessage) => void): () => void;
}

const EMPTY: InstallLogDoc = { entries: [], devices: [], total: 0 };

/**
 * What this phone holds, and whether anybody ever told it.
 *
 * **`toldAt` is the whole reason this is a state rather than a document.** An
 * empty log and a log nobody has sent are opposite facts, and only one of them
 * is "nothing has installed itself". The cache exists for the same rule
 * `localState.ts` states about the build and schedule lists: a cold start with
 * the tunnel down must not answer a question it has not been told the answer
 * to.
 */
export interface InstallLogState {
  doc: InstallLogDoc;
  /** When the desktop last said this. Absent = it never has, on this phone. */
  toldAt?: number;
  /** Is the desktop reachable right now? The log lives there. */
  live: boolean;
}

let doc: InstallLogDoc = EMPTY;
let toldAt: number | undefined;
let src: InstallLogSource | null = null;
const listeners = new Set<(state: InstallLogState) => void>();

/** Read the cache once, at module load — before any socket exists, which is
 *  exactly the moment the screen may be opened. */
(() => {
  const raw = lsJson<{ doc?: InstallLogDoc; at?: number }>(LS.installLog, {});
  if (raw?.doc && Array.isArray(raw.doc.entries) && typeof raw.at === "number") {
    doc = raw.doc;
    toldAt = raw.at;
  }
})();

function state(): InstallLogState {
  return { doc, toldAt, live: src?.status === "open" };
}

function emit(): void {
  const s = state();
  for (const l of listeners) l(s);
}

/** Subscribe to the log. Fires immediately with what is held — which may be a
 *  cached copy, or nothing at all, and the state says which. */
export function subscribeInstallLog(cb: (state: InstallLogState) => void): () => void {
  listeners.add(cb);
  cb(state());
  return () => { listeners.delete(cb); };
}

export function installLogState(): InstallLogState { return state(); }

// ── this device ──────────────────────────────────────────────────────

/** What this phone is called in the log. Empty = nobody has named it, and the
 *  log then falls back to the model and finally to a shortened id
 *  (`shared/installlog.ts`'s `deviceLabel`) — never to a blank. */
export function deviceName(): string {
  return (lsGet(LS.deviceName) ?? "").trim();
}

export function setDeviceName(name: string): void {
  lsSet(LS.deviceName, name.trim().slice(0, 60));
  // Re-report at once: the name rides on every entry, so the log can show the
  // new one the moment it is typed rather than after the next install.
  reportInstalls();
}

/**
 * The phone's model, off the user agent.
 *
 * A best effort and labelled as one: Android puts the model in the UA
 * (`… Linux; Android 14; Pixel 8 Build/…`), and nothing else here does. A UA
 * this cannot read yields NOTHING rather than a guess — `deviceLabel` then says
 * `device a1b2c3`, which is honest, where "Mozilla" would not be.
 */
export function deviceModel(): string {
  const ua = typeof navigator === "undefined" ? "" : navigator.userAgent;
  const m = /Android[^;)]*;\s*([^;)]+?)(?:\s+Build\/[^;)]*)?\s*\)/.exec(ua);
  const model = (m?.[1] ?? "").trim();
  // "K" is what Chrome's UA reduction puts there when it refuses to say. A
  // one-letter model is not a model.
  return model.length > 1 ? model.slice(0, 60) : "";
}

// ── reporting ────────────────────────────────────────────────────────

/** This phone's download rows in the shape the shared fold reads. A mapping,
 *  never a second set of rules: which rows count is `installReportFrom`'s
 *  judgement and is pinned by its own test. */
function reportRows(records: readonly PullRecord[]): InstallReportRow[] {
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
 * Silent with no socket: the next `welcome` re-sends everything, which is the
 * whole design. `force` is for the moments where the payload is unchanged but
 * the RECIPIENT is new — a reconnect, where the host may be a different
 * desktop, or one that has been restarted onto an empty store.
 */
export function reportInstalls(force = false): void {
  if (!src || src.status !== "open") return;
  const id = deviceId();
  if (!id || id === "unknown") return;   // a report nobody can attribute is not one
  const entries = installReportFrom(reportRows(pulls.list()));
  if (!entries.length && !force) return;
  const device = {
    id,
    ...(deviceName() ? { name: deviceName() } : {}),
    ...(deviceModel() ? { model: deviceModel() } : {}),
  };
  const wire = JSON.stringify({ device, entries });
  if (!force && wire === lastSent) return;
  lastSent = wire;
  src.send({ t: "install.report", device, entries });
}

/**
 * Attach the store to the transport. Called once from `main.tsx`.
 *
 * Idempotent — a second call with the same singleton connection would register
 * a second listener and report twice.
 */
export function startInstallLog(source: InstallLogSource): void {
  if (src) return;
  src = source;
  source.on((msg) => {
    if (msg.t === "install.log") {
      doc = msg.doc;
      toldAt = Date.now();
      lsSetJson(LS.installLog, { doc, at: toldAt });
      emit();
      return;
    }
    // The socket's own status, which `ws.ts` announces as an `error` frame on a
    // reserved context. The screen says whether the desktop is reachable, and a
    // tunnel that drops while that screen is open must change what it says —
    // reading the status at render time only works if something else happens to
    // re-render.
    if (msg.t === "error" && msg.context === "__status") { emit(); return; }
    // A new socket is a new conversation, and possibly a different desktop —
    // one restarted, or restored from a backup that predates last night's
    // installs. So the whole history goes again, unconditionally: that is what
    // makes an install that happened with the tunnel down eventually land.
    if (msg.t === "welcome") { lastSent = ""; reportInstalls(true); }
  });
  // …and whenever a row changes. The install itself happens in the service with
  // the document frozen, so the transition this notices is usually one that
  // happened minutes ago — which is exactly why the report is a re-statement of
  // everything rather than an event about one row.
  pulls.subscribe(() => reportInstalls());
}
