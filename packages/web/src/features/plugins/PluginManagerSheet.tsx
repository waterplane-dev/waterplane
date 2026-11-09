/**
 * The `pluginManager` overlay: every plugin on one screen, a card each (controls on the item).
 *
 * Rows, filters and places are `managerLogic.ts`'s; this draws them. Filters sit ABOVE the list and
 * the count on a chip is exactly what its tap shows (`filterCounts`/`cutRows`, one bucketing function).
 * The on/off switch is `enablePlugin`, the same send path as Settings. A plugin that cannot be
 * switched says why in words (`Unavailable`), never a dimmed control. Detail settings and places
 * open ON TOP of the manager (Back returns to it); the Updates door closes it first, as before.
 */
import { useState } from "react";
import { AlertTriangle, CheckCircle2, Download, KeyRound, Puzzle, Settings as SettingsIcon } from "lucide-react";
import { useCore, useStore, featureManifests } from "../../sdk";
import type { CoreApi } from "../../sdk";
import { SheetHead } from "../../Sheet";
import { Empty } from "../../Empty";
import { Unavailable } from "../../Unavailable";
import { FilterBar, FilterChip, RowSub, chipText } from "../../kit";
import { SetNote, SetSwitch, SetWarn } from "../../SettingsKit";
import { openPluginSettings } from "../../settingsFocus";
import { enablePlugin } from "./actions";
import { FILTER_LABEL, MANAGER_FILTERS, cardPlaces, cutRows, filterCounts, filterNote, managerRows, shortenPaths } from "./managerLogic";
import type { ManagerFilter, ManagerPlace, ManagerRow } from "./managerLogic";
import { allPlugins, errors } from "./store";
import { openUpdates } from "./updatesActions";

export function PluginManagerSheet() {
  const c = useCore();
  const list = useStore(allPlugins);
  const [filter, setFilter] = useState<ManagerFilter>("all");
  const rows = managerRows(list, featureManifests());
  const counts = filterCounts(rows);
  const shown = cutRows(rows, filter);
  // Updates closes the manager first (its Back already lands on it); a place or Settings opens ON TOP, so Back is one step.
  const leave = (then: () => void) => { c.nav.close("pluginManager"); then(); };
  const over = (then: () => void) => then();
  return (
    <div className="sheet">
      <SheetHead title={<><Puzzle size={16} style={{ verticalAlign: "-3px", marginRight: 4 }} />Plugins</>} onClose={() => c.nav.close("pluginManager")} />
      <div className="set-doors plugin-mgr-pad">
        <button className="set-door" title="Add a plugin by its address, and update the ones you have" onClick={() => leave(openUpdates)}>
          <Download size={14} /> Add a plugin or update
        </button>
      </div>
      <Empty res={list === null && c.conn.status !== "open" ? { state: "offline" } : undefined} empty={list === null} thing="the plugin list">The desktop has not listed its plugins yet.</Empty>
      {list !== null && (
        <>
          <div className="fchips">
            {MANAGER_FILTERS.map((f) => (
              <FilterChip key={f} on={filter === f} clears={f !== "all"} onClick={() => setFilter(filter === f && f !== "all" ? "all" : f)}>
                {chipText(FILTER_LABEL[f], { count: counts[f] })}
              </FilterChip>
            ))}
          </div>
          {filter !== "all" && <FilterBar onClear={() => setFilter("all")} clearLabel="show all">{filterNote(shown.length, rows.length, filter)}</FilterBar>}
        </>
      )}
      <div className="list hist plugin-mgr">
        {shown.map((r) => <PluginCard key={r.key} r={r} over={over} core={c} />)}
      </div>
    </div>
  );
}

function PluginCard({ r, over, core }: { r: ManagerRow; over: (then: () => void) => void; core: CoreApi }) {
  const err = useStore(errors)[r.id];
  const places = cardPlaces(r);
  return (
    <div className="plugin-sec plugin-card">
      <div className="plugin-head">
        <b>{r.name}</b>
        {r.tags.length > 0 && <RowSub>{r.tags.join(" · ")}</RowSub>}
      </div>
      {r.summary && <SetNote>{r.summary}</SetNote>}
      {r.canSwitch
        ? <SetSwitch label={`use ${r.name}`} on={r.view.enabled} onChange={() => enablePlugin(r.view, !r.view.enabled)} />
        : r.fixedWhy && <Unavailable cants={[{ label: "switch", reason: r.fixedWhy }]} />}
      {err && <SetWarn icon={AlertTriangle}>{err}</SetWarn>}
      {r.error && <SetWarn icon={AlertTriangle}>{r.error}</SetWarn>}
      {r.status && r.state === "on" && (
        <SetWarn tone={r.status.tone === "bad" ? "bad" : "plain"} icon={r.status.tone === "ok" ? CheckCircle2 : AlertTriangle}>{shortenPaths(r.status.text)}</SetWarn>
      )}
      {r.needs.length > 0 && (
        <SetNote><KeyRound size={12} /> Needs {r.needs.map((n, i) => <span key={n}>{i > 0 && ", "}<code>{n}</code></span>)} set on the desktop.</SetNote>
      )}
      {places.length > 0 && (
        <div>
          <div className="plugin-mgr-h">Where to find it</div>
          <div className="set-doors">
            {places.map((p) => <Place key={p.key} p={p} over={over} core={core} />)}
          </div>
        </div>
      )}
      {r.hasSettings && (
        <div className="set-doors">
          <button className="set-door" title={`${r.name}: its settings`} onClick={() => over(() => openPluginSettings(r.id))}>
            <SettingsIcon size={14} /> Settings
          </button>
        </div>
      )}
    </div>
  );
}

function Place({ p, over, core }: { p: ManagerPlace; over: (then: () => void) => void; core: CoreApi }) {
  if (!p.open) return <RowSub>{p.text}</RowSub>;
  const why = p.unavailable?.(core) ?? null;
  if (why) return <RowSub>{p.text} — {why}</RowSub>;
  return <button className="set-door" title={`Open ${p.text}`} onClick={() => over(() => p.open!(core))}>{p.text}</button>;
}
