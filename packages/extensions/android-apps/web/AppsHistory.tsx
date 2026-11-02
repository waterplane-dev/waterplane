import { CloudOff, PackageCheck, Pencil, Smartphone, X } from "lucide-react";
import { deviceId, useCore } from "@waterplane/sdk";
import { Button, Empty, Hint, Row, RowSub, RowTitle, SetLine, SetNote, when } from "@waterplane/kit";
import {
  deviceLabel, filterInstallLog, installLogLine, installLogSummary, installTitle,
  type InstallLogEntry,
} from "../shared/wire.mts";
import { logDeviceName, type InstallLogState } from "./installLog.ts";

/**
 * **What actually installed, on which phone, and when.**
 *
 * The screen the whole log exists for: there is one desktop and there may be
 * several phones, and a build that installed itself overnight on one of them
 * leaves no trace anywhere a person looks. The entries come from the HOST
 * (`host/installlog.mts`) — every device reports to it and it broadcasts — so
 * this list is the fleet, not this phone.
 *
 * It reads and does nothing else. No install is started from here, no
 * allow-list is touched: it is an account of what already happened
 * (`CLAUDE.md`).
 */
export function InstallLogPane({ log, live, cut, onCut, naming, draft, onNaming, onDraft, onName }: {
  log: InstallLogState;
  /** Is the desktop reachable right now? The log lives there (the sheet reads the socket). */
  live: boolean;
  cut: { pkg?: string; deviceId?: string };
  onCut: (c: { pkg?: string; deviceId?: string }) => void;
  naming: boolean;
  draft: string;
  onNaming: (on: boolean) => void;
  onDraft: (v: string) => void;
  /** Save the typed name for this phone (the sheet re-reports with it). */
  onName: (name: string) => void;
}) {
  const say = useCore().say;
  const { doc, toldAt } = log;
  const mine = deviceId();
  const shown = filterInstallLog(doc.entries, cut);
  const filtered = !!(cut.pkg || cut.deviceId);
  const cutName = cut.pkg
    ? (doc.entries.find((e) => e.pkg === cut.pkg)?.label || cut.pkg)
    : deviceLabel(doc.devices.find((d) => d.id === cut.deviceId) ?? { id: cut.deviceId ?? "" });
  const save = () => { onName(draft); onNaming(false); say.toast("this phone is named"); };

  return (
    <>
      <Hint>
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
      </Hint>

      {/* Naming THIS phone. Not a synced setting: it is the one preference whose
          entire job is to be different on each device, and a synced copy would
          have the second phone overwrite the first one's name with its own. */}
      <SetLine>
        {naming ? (
          <>
            <input className="search" value={draft} autoFocus
              placeholder="what to call this phone"
              onChange={(e) => onDraft(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") save(); }} />
            <Button onClick={save}>save</Button>
            <Button onClick={() => { onDraft(logDeviceName()); onNaming(false); }}><X size={14} /> cancel</Button>
          </>
        ) : (
          <>
            <Button onClick={() => { onDraft(logDeviceName()); onNaming(true); say.track("action:apps.name"); }}>
              <Pencil size={14} /> name this phone
            </Button>
            <SetNote as="span">
              This phone reports as <span className="mono">{logDeviceName() || deviceLabel({ id: mine })}</span>.
              A name makes the rows below readable when there is more than one device.
            </SetNote>
          </>
        )}
      </SetLine>

      {/* One chip per device that has ever reported. Each is a filter and says
          how many rows it opens — installs AND failures, since that is what the
          cut contains; a chip counting only the successes would open more rows
          than its own number. */}
      {doc.devices.length > 1 && (
        <SetLine>
          {doc.devices.map((d) => (
            <Button key={d.id} className={cut.deviceId === d.id ? "active" : ""}
              title={d.failures
                ? `${d.installs} installed, ${d.failures} failed on ${deviceLabel(d)}`
                : `only what installed on ${deviceLabel(d)}`}
              onClick={() => onCut(cut.deviceId === d.id ? {} : { deviceId: d.id })}>
              <Smartphone size={14} /> {deviceLabel(d)}{d.id === mine ? " (this phone)" : ""} · {d.installs + d.failures}
            </Button>
          ))}
        </SetLine>
      )}

      {/* A filtered view SAYS what it is hiding, with one tap back to all of it. */}
      {filtered && (
        <Hint>
          {shown.length} of {doc.entries.length} · {cutName}{" "}
          <Button onClick={() => onCut({})}><X size={14} /> show all</Button>
        </Hint>
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
    <Row kind="wrap">
      <Row kind="grow" title={entry.file ? `${entry.file}${entry.repo ? ` · ${entry.repo}` : ""}` : undefined}>
        <RowTitle>
          {entry.outcome === "installed" ? <PackageCheck size={12} /> : <X size={12} />} {installTitle(entry)}
        </RowTitle>
        <RowSub className="mono">{entry.pkg}</RowSub>
        <RowSub className={entry.outcome === "failed" ? "warn" : undefined}>
          {installLogLine(entry, when)}
        </RowSub>
        {(entry.repo || entry.file) && (
          // The FILE first and not dimmed: it is the one string the Downloads
          // row prints too, so it is how an install here is matched to a build
          // there.
          <RowSub>
            {entry.file ?? ""}{entry.repo && entry.file ? " · " : ""}{entry.repo ? `from ${entry.repo}` : ""}
            {entry.deviceId === mine ? " · this phone" : ""}
          </RowSub>
        )}
      </Row>
    </Row>
  );
}
