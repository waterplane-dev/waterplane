/**
 * The `updates` overlay: waterplane itself and the plugins from waterplane-dev, as rows.
 *
 * With something due it opens on EXACTLY those rows (`cutRows`, fed by shared `updatesDue` like the
 * count on the door and the banner) and says "n of N" with a clear. Clearing shows every row plus
 * Add by URL. Nothing here applies itself: each button asks first.
 */
import { useEffect, useState } from "react";
import { Download, Puzzle } from "lucide-react";
import { useCore, useStore } from "../../sdk";
import { SheetHead } from "../../Sheet";
import { Empty } from "../../Empty";
import { Button, FilterBar, Hint, RowSub, Tag } from "../../kit";
import { SetNote } from "../../SettingsKit";
import { AddByUrl, ApplyNote, AvailableRowView, CheckedLine, MaturityTag, SelfRow } from "./UpdatesParts";
import { askStatus, updatePlugin } from "./updatesActions";
import { ORG, availableRows, cutRows, cutWords, dueCount, dueKeys, sourceWords, untaggedWords } from "./logic";
import type { UpdateRow } from "./logic";
import { updatesStatus } from "./store";
import { BRAND, pluginMaturity } from "@waterplane/shared";

export function UpdatesSheet() {
  const c = useCore();
  const status = useStore(updatesStatus);
  const [all, setAll] = useState(false);
  useEffect(() => { askStatus(); }, []);
  const n = dueCount(status);
  const filtered = !all && n > 0;
  const { shown, total } = cutRows(status, filtered);

  return (
    <div className="sheet">
      <SheetHead title={<><Download size={16} style={{ verticalAlign: "-3px", marginRight: 4 }} />Updates</>} onClose={() => c.nav.close("updates")} />
      <Hint>{BRAND.displayName} on the desktop, and plugins from {ORG}. A check only looks; nothing installs until you confirm.</Hint>
      <CheckedLine status={status} />
      {filtered && <FilterBar onClear={() => setAll(true)} clearLabel="show all">{cutWords(shown.length, total)}</FilterBar>}
      <div className="list hist">
        <Empty empty={!status}>The desktop has not reported its updates yet.</Empty>
        {status && shown.map((r) => <RowView key={r.key} r={r} />)}
        {status && !filtered && <AddByUrl />}
      </div>
    </div>
  );
}

function RowView({ r }: { r: UpdateRow }) {
  const status = useStore(updatesStatus);
  if (!status) return null;
  if (!("entry" in r)) return <SelfRow status={status} />;
  const e = r.entry;
  if (!e.installed) {
    const row = availableRows({ ...status, catalog: [e] })[0];
    return row ? <AvailableRowView r={row} /> : null;
  }
  const inst = e.installed;
  const due = dueKeys(status).has(e.repo);
  return (
    <div className="plugin-sec">
      <div className="plugin-head">
        <Puzzle size={14} /> <b>{e.name}</b> <RowSub>{inst.ref ?? `v${inst.version}`}{due && e.latest ? ` → ${e.latest.ref}` : ""}</RowSub>
        {untaggedWords(e.latest) && <RowSub>{untaggedWords(e.latest)}</RowSub>}
        <MaturityTag m={pluginMaturity({ maturity: e.maturity })} />
        <Tag>{sourceWords(inst, e)}</Tag>
        {due && e.latest && <Button variant="primary" onClick={() => updatePlugin(inst.id, e.name, inst.ref, e.latest!.ref, { fromOrg: e.fromOrg === true, url: e.url })}><Download size={14} /> update</Button>}
      </div>
      {!due && <SetNote>{inst.source === "local" ? "Put there by hand — the manager never updates it." : "Up to date."}</SetNote>}
      {e.problems.map((w) => <SetNote key={w}>{w}</SetNote>)}
      <ApplyNote target={{ kind: "plugin-update", id: inst.id }} />
    </div>
  );
}
