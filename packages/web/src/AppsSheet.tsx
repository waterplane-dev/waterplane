import { useEffect, useState } from "react";
import { BellRing, Boxes, CloudOff, History, ListChecks, PackageCheck, PackagePlus, Pencil, RotateCw, Settings, Smartphone, X } from "lucide-react";
import {
  deviceLabel, filterInstallLog, installLogLine, installLogSummary, installTitle,
  type InstallLogEntry,
} from "@waterplane/shared";

import { SheetHead } from "./Sheet";
import { Empty } from "./Empty";
import { track } from "./usage";
import { showToast } from "./toast";
import { pulls, type PullRecord } from "./pull";
import {
  appInstallVerb, appRows, appsSummary, appStateText, buildsOf, isPlayBuild, NO_INSTALL, QUIET_INSTALL_RULES, quietOwnerText,
  quietVerdict, readyApps, snoozeText, toggleAllow, type InstallSources,
  type AppRow, type InstallCaps,
} from "./installPolicy";
import {
  installSources, installStatus, nativeInstall, nativeInstallSupported, openInstallSettings,
  readInstallAllow, writeInstallAllow,
} from "./nativeInstall";
import { deviceName, installLogState, setDeviceName, subscribeInstallLog, type InstallLogState } from "./installLog";
import { deviceId } from "./link";
import { hhmm, when } from "./format";
import { takeAppsPane, type AppsPane } from "./appsPane";

/**
 * **Your own apps, and which of them install themselves.**
 *
 * The switch used to live only on a downloaded row in Downloads, and that is
 * two things wrong at once. A setting reachable only from the transfer that
 * happened to bring the file is a setting you cannot SURVEY — the list exists,
 * the sheet even counted it ("2 apps install themselves"), and there was
 * nowhere the count opened. And an app whose builds have since been deleted had
 * no row at all, which is exactly the app somebody wants to switch OFF.
 *
 * So the list is its own screen, over `installPolicy.ts`'s union of the
 * allow-list and the builds still on the phone, and Downloads' count opens it —
 * a count on a control is a filter (`CLAUDE.md`), never a number to re-derive.
 *
 * **It keeps no state of its own.** The list is `waterplane.installAllow` (synced,
 * mirrored into the shell by `writeInstallAllow`) and the builds are `pull.ts`'s
 * records. The row toggle in Downloads stays: deciding in the moment, on the
 * build you are looking at, is a different act from surveying — and both write
 * the one store.
 *
 * Every platform refusal here is a SENTENCE with the Settings screen beside it,
 * never a dimmed switch (`Unavailable.tsx`).
 */
export function AppsSheet({ onClose, onOpenDownloads }: {
  onClose: () => void;
  onOpenDownloads: () => void;
}) {
  const [records, setRecords] = useState<PullRecord[]>([]);
  // `null` = still asking the phone. NOT `NO_INSTALL`, which is a positive
  // answer ("this device cannot install apps") and was the first thing this
  // screen said on every cold start — and this sheet is one of the restored
  // overlays, so cold start is exactly when it is read.
  const [caps, setCaps] = useState<InstallCaps | null>(null);
  const [allow, setAllow] = useState<string[]>(() => readInstallAllow());
  // The desktop's log of what every phone installed. Held here rather than
  // fetched: it arrives unprompted on `hello` and again whenever any device
  // reports, so a second phone's install shows up on this screen while it is
  // open (`installLog.ts`).
  const [log, setLog] = useState<InstallLogState>(() => installLogState());
  const [pane, setPane] = useState<AppsPane>(takeAppsPane);
  // The phone's own name, held HERE rather than in the log pane: the pane
  // unmounts when you flip to `apps`, and a half-typed name is typed words
  // (`CLAUDE.md` — never overwrite, and never quietly drop, what somebody
  // typed).
  const [naming, setNaming] = useState(false);
  const [nameDraft, setNameDraft] = useState(() => deviceName());
  /** The log cut to one package or one device. A count on a control is a filter
   *  (`CLAUDE.md`), so both the app row's install count and a device chip open
   *  exactly what they counted. */
  const [cut, setCut] = useState<{ pkg?: string; deviceId?: string }>({});
  useEffect(() => subscribeInstallLog(setLog), []);

  useEffect(() => pulls.subscribe(setRecords), []);
  // Asked of the phone every time this opens: "install unknown apps" is granted
  // in Settings and taken back there, so a remembered answer is a stale one —
  // and this screen is where somebody comes after granting it.
  useEffect(() => {
    let live = true;
    void installStatus().then((r) => { if (live) setCaps(r.caps); });
    return () => { live = false; };
  }, []);

  const known = caps ?? NO_INSTALL;
  const rows = appRows(buildsOf(records), allow, known, log.doc.entries);

  // Who owns each app's updates, as the phone records it — the reason an app
  // with auto-install on can still ask on every build. Re-read when the set of
  // apps changes and after an install lands; unknown stays unknown.
  const [sources, setSources] = useState<InstallSources | null>(null);
  const [rulesOpen, setRulesOpen] = useState(false);
  const pkgKey = rows.map((r) => `${r.pkg}:${r.install ?? ""}`).join(",");
  useEffect(() => {
    let live = true;
    void installSources(rows.map((r) => r.pkg)).then((s) => { if (live) setSources(s); });
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pkgKey]);
  const ready = readyApps(rows);
  const shownRows = pane === "ready" ? ready : rows;

  const flip = (pkg: string) => {
    const next = toggleAllow(allow, pkg);
    setAllow(next);
    writeInstallAllow(next);
    track("action:apps.allow");
    showToast(next.includes(pkg)
      ? "new builds of it will install by themselves"
      : "new builds of it will wait for a tap");
  };

  return (
    <div className="sheet">
      <SheetHead title={<><Boxes size={16} /> Apps</>} onClose={onClose} />

      {/* Two questions, two panes: what WILL install itself, and what already
          did. The log's count rides on its own tab, because it is the answer to
          "did the other phone get it too" and that is worth seeing without
          opening anything. */}
      <div className="segmented">
        <button className={`seg ${pane === "ready" ? "on" : ""}`}
          onClick={() => { setPane("ready"); track("action:apps.pane.ready"); }}>
          <BellRing size={14} /> ready{ready.length ? ` · ${ready.length}` : ""}
        </button>
        <button className={`seg ${pane === "apps" ? "on" : ""}`}
          onClick={() => { setPane("apps"); track("action:apps.pane.apps"); }}>
          <Boxes size={14} /> apps{rows.length ? ` · ${rows.length}` : ""}
        </button>
        <button className={`seg ${pane === "log" ? "on" : ""}`}
          onClick={() => { setPane("log"); setCut({}); track("action:apps.pane.log"); }}>
          <History size={14} /> installed{log.doc.total ? ` · ${log.doc.total}` : ""}
        </button>
      </div>

      <div className="sheet-scroll">
      {pane === "log" ? (
        <InstallLogPane log={log} cut={cut} onCut={setCut}
          naming={naming} draft={nameDraft} onNaming={setNaming} onDraft={setNameDraft} />
      ) : (
      <>
        <div className="form-hint">
          {caps === null ? "Asking this phone what it will allow…" : appsSummary(rows, caps)}
          {caps !== null && nativeInstallSupported() && !caps.canInstall && (
            <> <button className="key" title="open the phone's install-unknown-apps setting"
              onClick={() => {
                track("action:apps.settings");
                void openInstallSettings().catch(() => showToast("this phone has no screen for that switch"));
              }}><Settings size={14} /> allow it</button></>
          )}
        </div>
        {caps?.supported && !isPlayBuild(caps) && (
          <div className="form-hint dim">
            <button className="key" onClick={() => { setRulesOpen((o) => !o); track("action:apps.rules.quiet"); }}>
              <ListChecks size={14} /> {rulesOpen ? "hide" : "when"} a build installs without asking
            </button>
            {rulesOpen && (
              <ol className="quiet-rules">
                {QUIET_INSTALL_RULES.map((r) => <li key={r}>{r}</li>)}
              </ol>
            )}
          </div>
        )}
        <div className="form-hint dim">
          Which repo sends builds to this phone at all is the auto-download rule, per repo.{" "}
          <button className="key" onClick={() => { track("action:apps.rules"); onOpenDownloads(); }}>downloads</button>
        </div>

        {/* The ready pane is a CUT of the apps list and says so, with one tap
            back to all of it. */}
        {pane === "ready" && rows.length > 0 && (
          <div className="form-hint">
            {ready.length} of {rows.length} app{rows.length === 1 ? "" : "s"} · a build here that has not gone on,
            newest first — the same ones the phone notified you about, swiped away or put off included{" "}
            <button className="key" onClick={() => setPane("apps")}><X size={14} /> show all</button>
          </div>
        )}
        <div className="list">
          {pane === "ready" && rows.length > 0 && ready.length === 0 && (
            <Empty>Every build on this phone is installed. A new one lands here, and in a notification, when it arrives.</Empty>
          )}
          {rows.length === 0 && (
            <Empty>
              No app here yet. Download a build — an APK a repo drops in its outbox — and it gets a row,
              with the switch that decides whether the next one installs by itself.
            </Empty>
          )}
          {shownRows.map((row) => (
            <AppItem key={row.pkg} row={row} caps={known}
              ownerNote={isPlayBuild(known) ? null : quietOwnerText(row.label, quietVerdict(row.pkg, sources))} onFlip={() => flip(row.pkg)}
              logged={log.doc.entries.filter((e) => e.pkg === row.pkg).length}
              onOpenLog={() => { setPane("log"); setCut({ pkg: row.pkg }); track("action:apps.rowlog"); }} />
          ))}
        </div>
      </>
      )}
      </div>
    </div>
  );
}

/** One app. The label is the app's own; the package is under it, because that
 *  is what the switch is really about — three repos here all build
 *  `app-debug.apk`, and the file name can never say which app a row is. */
function AppItem({ row, caps, ownerNote, onFlip, logged, onOpenLog }: {
  row: AppRow; caps: InstallCaps; ownerNote: string | null; onFlip: () => void; logged: number; onOpenLog: () => void;
}) {
  const verb = appInstallVerb(row, caps);
  const state = appStateText(row);
  const snoozed = snoozeText(row, Date.now(), hhmm);
  // The Google Play build has no auto-install: no switch is drawn and the row
  // tap flips nothing — `row.note` says why (`playAutoText`), never a grey switch.
  const play = isPlayBuild(caps);
  return (
    <div className="row-wrap pull-row">
      <button className="row grow" title={row.pkg} onClick={play ? undefined : onFlip}>
        <span className="row-title">
          {row.allowed ? <PackageCheck size={12} /> : <PackagePlus size={12} />} {row.label}
        </span>
        <span className="row-sub mono">{row.pkg}{row.version ? ` · ${row.version}` : ""}</span>
        {/* The repo, always: the label is the app's own and the package is
            what the switch keys on, but the repo is what a person recognises —
            and the only name the Downloads rows and the log share with it. */}
        <span className="row-sub">{row.repo ? `from ${row.repo}` : "no repo recorded for it on this phone or in the log"}</span>
        <span className="row-sub">{row.note}</span>
        {ownerNote && <span className="row-sub warn">{ownerNote}</span>}
        {state && <span className={`row-sub ${row.install === "failed" ? "warn" : "dim"}`}>{state}</span>}
        {snoozed && <span className="row-sub dim">{snoozed}</span>}
      </button>
      {/* Labelled, and under the text: two package glyphs side by side are not
          two verbs anybody can tell apart, and there is no hover on a phone to
          ask with (`.pull-acts` in `styles.css`). */}
      <div className="row-acts pull-acts">
        {verb && (
          <button className="key primary" title={verb.label}
            onClick={() => {
              track("action:apps.install");
              void nativeInstall(verb.id).catch((e: unknown) =>
                showToast(e instanceof Error ? e.message : "could not start the install"));
            }}>
            {row.install === "failed" ? <RotateCw size={16} /> : <PackagePlus size={16} />}
            {row.install === "failed" ? "retry install" : `install ${row.version || "this build"}`}
          </button>
        )}
        {!play && (
          <button className={`key ${row.allowed ? "active" : ""}`}
            title={row.allowed ? `stop installing ${row.label} by itself` : `always install ${row.label}`}
            onClick={onFlip}><PackageCheck size={16} /> auto-install: {row.allowed ? "on" : "off"}</button>
        )}
        {/* How often this app has actually landed, on any phone. A COUNT ON A
            CONTROL, so it opens the log cut to exactly these rows rather than
            leaving a number for the reader to go and re-derive. */}
        {/* What the log holds about this app — installs AND failures, because
            that is what the tap opens. A count that says "3 installs" and opens
            four rows is the two-copies-of-the-edge failure `CLAUDE.md` names. */}
        {logged > 0 && (
          <button className="key" title={`everything the log holds about ${row.label}, on every phone`}
            onClick={onOpenLog}><History size={16} /> {logged} logged</button>
        )}
      </div>
    </div>
  );
}

/**
 * **What actually installed, on which phone, and when.**
 *
 * The screen the whole log exists for: there is one desktop and there may be
 * several phones, and a build that installed itself overnight on one of them
 * leaves no trace anywhere a person looks. The entries come from the HOST
 * (`host/installlog.ts`) — every device reports to it and it broadcasts — so
 * this list is the fleet, not this phone.
 *
 * It reads and does nothing else. No install is started from here, no
 * allow-list is touched: it is an account of what already happened
 * (`CLAUDE.md`).
 */
function InstallLogPane({ log, cut, onCut, naming, draft, onNaming, onDraft }: {
  log: InstallLogState;
  cut: { pkg?: string; deviceId?: string };
  onCut: (c: { pkg?: string; deviceId?: string }) => void;
  naming: boolean;
  draft: string;
  onNaming: (on: boolean) => void;
  onDraft: (v: string) => void;
}) {
  const { doc, toldAt, live } = log;
  const mine = deviceId();
  const shown = filterInstallLog(doc.entries, cut);
  const filtered = !!(cut.pkg || cut.deviceId);
  const cutName = cut.pkg
    ? (doc.entries.find((e) => e.pkg === cut.pkg)?.label || cut.pkg)
    : deviceLabel(doc.devices.find((d) => d.id === cut.deviceId) ?? { id: cut.deviceId ?? "" });
  const save = () => { setDeviceName(draft); onNaming(false); showToast("this phone is named"); };

  return (
    <>
      <div className="form-hint">
        {/* "Nothing has installed itself yet" is an ANSWER, and this phone has
            one only if the desktop has ever told it. Never been told is its own
            sentence — the rule `localState.ts` states about every cached list:
            an empty list is a claim. */}
        {toldAt === undefined
          ? "The desktop keeps this log, and has not told this phone yet."
          : installLogSummary(doc)}
        {!live && (
          <> <span className="warn">
            <CloudOff size={12} /> {toldAt === undefined
              ? " no connection to the desktop."
              : ` the desktop is not reachable — this is what it said ${when(toldAt)}.`}
          </span></>
        )}
      </div>

      {/* Naming THIS phone. Not a synced setting: it is the one preference whose
          entire job is to be different on each device, and a synced copy would
          have the second phone overwrite the first one's name with its own. */}
      <div className="set-row">
        {naming ? (
          <>
            <input className="search" value={draft} autoFocus
              placeholder="what to call this phone"
              onChange={(e) => onDraft(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") save(); }} />
            <button className="key" onClick={save}>save</button>
            <button className="key" onClick={() => { onDraft(deviceName()); onNaming(false); }}><X size={14} /> cancel</button>
          </>
        ) : (
          <>
            <button className="key" onClick={() => { onDraft(deviceName()); onNaming(true); track("action:apps.name"); }}>
              <Pencil size={14} /> name this phone
            </button>
            <span className="set-note">
              This phone reports as <span className="mono">{deviceName() || deviceLabel({ id: mine })}</span>.
              A name makes the rows below readable when there is more than one device.
            </span>
          </>
        )}
      </div>

      {/* One chip per device that has ever reported. Each is a filter and says
          how many rows it opens — installs AND failures, since that is what the
          cut contains; a chip counting only the successes would open more rows
          than its own number. */}
      {doc.devices.length > 1 && (
        <div className="set-row">
          {doc.devices.map((d) => (
            <button key={d.id} className={`key ${cut.deviceId === d.id ? "active" : ""}`}
              title={d.failures
                ? `${d.installs} installed, ${d.failures} failed on ${deviceLabel(d)}`
                : `only what installed on ${deviceLabel(d)}`}
              onClick={() => onCut(cut.deviceId === d.id ? {} : { deviceId: d.id })}>
              <Smartphone size={14} /> {deviceLabel(d)}{d.id === mine ? " (this phone)" : ""} · {d.installs + d.failures}
            </button>
          ))}
        </div>
      )}

      {/* A filtered view SAYS what it is hiding, with one tap back to all of it. */}
      {filtered && (
        <div className="form-hint">
          {shown.length} of {doc.entries.length} · {cutName}{" "}
          <button className="key" onClick={() => onCut({})}><X size={14} /> show all</button>
        </div>
      )}

      <div className="list">
        {shown.length === 0 && (
          <Empty>
            {filtered
              ? "Nothing under this filter yet."
              : toldAt === undefined
                ? "The desktop has not told this phone what it holds. It sends the log the moment the link is up."
                : "No install has been reported yet. A build that installs itself on any phone paired with this desktop is logged here."}
          </Empty>
        )}
        {shown.map((e) => <InstallLogRow key={e.key} entry={e} mine={mine} />)}
      </div>
    </>
  );
}

/** One install. Three lines, because they are three different facts: WHAT
 *  (the app and the version it landed at), WHICH app exactly (the package —
 *  three repos here build `app-debug.apk`), and WHAT HAPPENED (who, when, and
 *  whether anybody tapped). */
function InstallLogRow({ entry, mine }: { entry: InstallLogEntry; mine: string }) {
  return (
    <div className="row-wrap">
      <div className="row grow" title={entry.file ? `${entry.file}${entry.repo ? ` · ${entry.repo}` : ""}` : undefined}>
        <span className="row-title">
          {entry.outcome === "installed" ? <PackageCheck size={12} /> : <X size={12} />} {installTitle(entry)}
        </span>
        <span className="row-sub mono">{entry.pkg}</span>
        <span className={`row-sub ${entry.outcome === "failed" ? "warn" : ""}`}>
          {installLogLine(entry, when)}
        </span>
        {(entry.repo || entry.file) && (
          // The FILE first and not dimmed: it is the one string the Downloads
          // row prints too, so it is how an install here is matched to a build
          // there.
          <span className="row-sub">
            {entry.file ?? ""}{entry.repo && entry.file ? " · " : ""}{entry.repo ? `from ${entry.repo}` : ""}
            {entry.deviceId === mine ? " · this phone" : ""}
          </span>
        )}
      </div>
    </div>
  );
}
