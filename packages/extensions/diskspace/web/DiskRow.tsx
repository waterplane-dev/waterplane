/**
 * The disk-space row in Settings › Tools: the free space the last scan read (and how old that is),
 * and the door into the sheet. Reading `state` is cheap — it never starts a scan; opening the sheet does.
 */
import { useEffect } from "react";
import { ChevronRight, HardDrive } from "lucide-react";
import { useConnStatus, useStore } from "@waterplane/sdk";
import { SetCustom, SetNote, ago, useNow } from "@waterplane/kit";
import { volumeLine } from "./logic.ts";
import { disk, openDisk, readState } from "./state.ts";

export function DiskRow() {
  const v = useStore(disk);
  const status = useConnStatus();
  useNow(30_000);
  useEffect(() => { if (status === "open") void readState(); }, [status]);
  const s = v.res?.ok ? v.res.result : null;
  const note = !v.res
    ? "Not asked yet."
    : !v.res.ok
      ? `The desktop did not answer: ${v.res.error}`
      : s?.scan
        ? `${volumeLine(s.scan.volume)} · scanned ${ago(s.scan.at)}${s.scanning ? " · scanning now" : ""}`
        : s?.scanning ? "Scanning now." : "Not scanned since the desktop's host started — opening it scans.";
  return (
    <SetCustom id="disk-space" label="disk space" icon={HardDrive}>
      <SetNote>{note}</SetNote>
      <button className="set-act" onClick={openDisk}>
        <span className="set-lbl">open disk space</span><ChevronRight size={16} className="set-go" />
      </button>
    </SetCustom>
  );
}
